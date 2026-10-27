import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { selectFormattedEngine } from './formatted-engine.mjs'
import { pressShortcut, replaceSourceText } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

async function measureFindLayout(rich) {
  await rich.evaluate(
    (element) =>
      new Promise((resolve) => {
        element.cmTile.root.view.requestMeasure({
          read: () => null,
          write: resolve,
        })
      }),
  )
}

async function denseHighlights(_page, rich) {
  await measureFindLayout(rich)
  return rich.evaluate((element) => {
    const ranges = element.cmTile.root.view.visibleRanges
    return {
      count: element.querySelectorAll('.cm-searchMatch').length,
      units: ranges.reduce((sum, range) => sum + range.to - range.from, 0),
      // each edge can show a partial match and the query's lookaround margin.
      bound: ranges.reduce(
        (sum, range) =>
          sum + Math.ceil((range.to - range.from) / 'needle word '.length) + 4,
        0,
      ),
    }
  })
}

async function installFindWorkProbe(page) {
  await page.addInitScript(() => {
    window.findWork = {
      hold: true,
      held: [],
      blocked: new Set(),
      requests: [],
      lower: 0,
      normalized: 0,
      measuring: false,
    }
    const lower = String.prototype.toLowerCase,
      normalize = String.prototype.normalize
    String.prototype.toLowerCase = function (...args) {
      if (window.findWork.measuring) window.findWork.lower += this.length
      return lower.apply(this, args)
    }
    String.prototype.normalize = function (...args) {
      if (window.findWork.measuring) window.findWork.normalized += this.length
      return normalize.apply(this, args)
    }
    window.findWork.release = () => {
      window.findWork.hold = false
      for (const send of window.findWork.held.splice(0)) send()
    }
    window.Worker = new Proxy(window.Worker, {
      construct(target, args) {
        const worker = Reflect.construct(target, args)
        if (String(args[0]).includes('document.worker')) {
          const post = worker.postMessage.bind(worker)
          worker.postMessage = (message, ...rest) => {
            const request = message.message ?? message
            if (request.type === 'find') {
              window.findWork.requests.push({
                owner: message.owner ?? request.epoch,
                epoch: request.epoch,
                id: request.id,
                version: request.version,
                query: request.query,
                highlights: !!request.highlights,
              })
            }
            // Preserve FIFO for this logical owner, including cancellation while a find is held.
            const owner = message.owner ?? request.epoch
            if (
              window.findWork.hold &&
              (request.type === 'find' || window.findWork.blocked.has(owner))
            ) {
              window.findWork.blocked.add(owner)
              window.findWork.held.push(() => post(message, ...rest))
              return
            }
            return post(message, ...rest)
          }
        }
        return worker
      },
    })
  })
}

async function findWorkers(page) {
  const workers = page
    .workers()
    .filter((worker) => worker.url().includes('document.worker'))
  assert.ok(
    workers.length > 0,
    'measure established document workers, including shared owners',
  )
  for (const worker of workers)
    await worker.evaluate(() => {
      globalThis.findFoldWork = { lower: 0, normalized: 0 }
      const lower = String.prototype.toLowerCase,
        normalize = String.prototype.normalize
      String.prototype.toLowerCase = function (...args) {
        globalThis.findFoldWork.lower += this.length
        return lower.apply(this, args)
      }
      String.prototype.normalize = function (...args) {
        globalThis.findFoldWork.normalized += this.length
        return normalize.apply(this, args)
      }
    })
  return workers
}

async function foldWork(workers, reset = false) {
  const values = []
  for (const worker of workers)
    values.push(
      await worker.evaluate((reset) => {
        const result = { ...globalThis.findFoldWork }
        if (reset) globalThis.findFoldWork = { lower: 0, normalized: 0 }
        return result
      }, reset),
    )
  return values.reduce(
    (sum, value) => ({
      lower: sum.lower + value.lower,
      normalized: sum.normalized + value.normalized,
    }),
    { lower: 0, normalized: 0 },
  )
}

async function openFind(t, markdown, instrument = false) {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-formatted-find-'))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(7000)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  if (instrument) await installFindWorkProbe(page)
  const rich = await selectFormattedEngine(app, page, 'codemirror')
  await page.getByRole('button', { name: 'Source view', exact: true }).click()
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  const source = page.getByRole('textbox', {
    name: 'Markdown editor',
    exact: true,
  })
  await replaceSourceText(page, source, markdown)
  await waitForAsync(
    page,
    async (markdown) => (await window.hibi.getDocument()).markdown === markdown,
    markdown,
  )
  await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
  await rich.waitFor()
  await rich.focus()
  await pressShortcut(app, `${mod}+f`)
  const input = page.getByRole('textbox', {
    name: 'Find in document',
    exact: true,
  })
  const bar = page.getByRole('search', { name: /find in document/i })
  const count = async (expected) => {
    try {
      await waitForAsync(
        page,
        (expected) =>
          document.querySelector('.find-bar output')?.textContent === expected,
        expected,
      )
    } catch (error) {
      t.diagnostic(
        JSON.stringify({
          expected,
          actual: await bar.locator('output').textContent(),
          query: await input.inputValue(),
        }),
      )
      throw error
    }
  }
  return { app, page, rich, source, input, bar, count }
}

test('formatted find matches rendered phrases across markdown marks and returns focus without editing', {
  timeout: 30000,
  todo: 'formatted gap find-001: formatted find must match rendered phrases across hidden marks',
}, async (t) => {
  const markdown = '# title\n\nhello **world** and hello world.\n\nHELLO world.'
  const { page, rich, input, bar, count } = await openFind(t, markdown)
  await input.fill('hello world')
  await count('1/3')
  assert.equal(
    await input.evaluate((element) => element === document.activeElement),
    true,
  )
  await input.press('Enter')
  await count('2/3')
  await input.press('Shift+Enter')
  await count('1/3')
  await input.press('Shift+Enter')
  await count('3/3')
  await page.getByRole('button', { name: 'Next match', exact: true }).click()
  await count('1/3')
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    markdown,
  )
  await input.press('Escape')
  await bar.waitFor({ state: 'hidden' })
  assert.equal(
    await rich.evaluate((element) => element === document.activeElement),
    true,
  )
})

test('formatted find folds unicode without shifting selected text and keeps offscreen matches visible', {
  timeout: 45000,
}, async (t) => {
  const filler = Array.from({ length: 120 }, (_, i) => `line ${i}`).join('\n\n')
  const markdown = `😀İ é ß ΟΔΟΣ οδος οδοσ;ΑΣΑ ΣΣ.\n\n${filler}\n\nlast needle`
  const { page, rich, input, bar, count } = await openFind(t, markdown)
  for (const query of ['ΟΔΟΣ', 'οδος', 'οδοσ']) {
    await input.fill(query)
    await count('1/3')
    await input.press('Enter')
    await count('2/3')
    await rich.locator('.cm-searchMatch-selected').waitFor()
    assert.equal(
      await rich.locator('.cm-searchMatch-selected').textContent(),
      'οδος',
    )
  }
  await input.fill('Σ')
  await count('1/6')
  await input.press('Enter')
  await count('2/6')
  await input.fill('last needle')
  await count('1/1')
  await page.waitForFunction(() => {
    const match = document.querySelector('.rich-pane .cm-searchMatch-selected')
    if (match?.textContent !== 'last needle') return false
    const box = match.getBoundingClientRect()
    const pane = match.closest('.rich-pane').getBoundingClientRect()
    return box.top >= pane.top && box.bottom <= pane.bottom
  })
  assert.equal(
    await input.evaluate((element) => element === document.activeElement),
    true,
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    markdown,
  )
  await input.fill('missing')
  await count('No results')
  assert.equal(
    await page
      .getByRole('button', { name: 'Next match', exact: true })
      .isDisabled(),
    true,
  )
  await input.press('Escape')
  await bar.waitFor({ state: 'hidden' })
  assert.equal(
    await rich.evaluate((element) => element === document.activeElement),
    true,
  )
})

test('formatted dense find counts every match, bounds highlights, and preserves selection through edit and undo', {
  timeout: 60000,
}, async (t) => {
  const dense = 'needle word '.repeat(10000).trimEnd()
  const { app, page, rich, input, count } = await openFind(t, dense)
  await input.fill('NEEDLE')
  await count('1/10000')
  const nearby = await denseHighlights(page, rich)
  assert.ok(
    nearby.count > 1 && nearby.count <= nearby.bound,
    JSON.stringify(nearby),
  )
  assert.ok(
    nearby.units < dense.length / 2,
    'highlights cover only the rendered source window',
  )
  await input.press('Enter')
  await count('2/10000')
  assert.equal(
    await rich.locator('.cm-searchMatch-selected').textContent(),
    'needle',
  )
  await input.press('Shift+Enter')
  await count('1/10000')
  await input.press('Shift+Enter')
  await count('10000/10000')
  await input.press('Enter')
  await count('1/10000')
  await input.press('Escape')
  await page.keyboard.insertText('pin')
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    `pin${dense.slice(6)}`,
  )
  await pressShortcut(app, `${mod}+z`)
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    dense,
  )
  await pressShortcut(app, `${mod}+f`)
  await t.test(
    'undo restores matches without a current result',
    {
      todo: 'formatted gap find-002: undo must restore matches without a current find result',
    },
    async () => {
      await count('0/10000')
      assert.equal(await rich.locator('.cm-searchMatch-selected').count(), 0)
    },
  )
})

test('formatted find keeps highlights bounded when match count grows from ten thousand to one hundred thousand', {
  timeout: 60000,
}, async (t) => {
  const dense = 'needle word '.repeat(10000).trimEnd()
  const { app, page, rich, source, input, count } = await openFind(t, dense)
  await input.fill('needle')
  await count('1/10000')
  const nearby = await denseHighlights(page, rich)
  assert.ok(
    nearby.count > 1 && nearby.count <= nearby.bound,
    JSON.stringify(nearby),
  )
  assert.ok(
    nearby.units < dense.length / 2,
    'highlights cover only the rendered source window',
  )
  await input.press('Escape')
  await page.getByRole('button', { name: 'Source view', exact: true }).click()
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  const larger = 'needle word '.repeat(100000).trimEnd()
  await replaceSourceText(page, source, larger)
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    larger,
  )
  await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
  await rich.waitFor()
  await rich.focus()
  await pressShortcut(app, `${mod}+f`)
  await input.fill('needle')
  await count('1/100000')
  const more = await denseHighlights(page, rich)
  await t.test(
    'highlight count stays fixed when total matches grow',
    {
      todo: 'formatted gap find-006: increasing total matches must preserve the viewport highlight budget',
    },
    () => {
      assert.equal(more.count, nearby.count, JSON.stringify({ nearby, more }))
      assert.equal(
        more.units,
        nearby.units,
        'ten times as many matches stays within the same viewport budget',
      )
    },
  )
  t.diagnostic(JSON.stringify({ nearby, more }))
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    larger,
  )
})

test('formatted find reopens the existing query on a second shortcut without changing source', {
  timeout: 30000,
}, async (t) => {
  const markdown = '# title\n\nhello world and hello world.\n\nHELLO world.'
  const { app, page, rich, input, bar, count } = await openFind(t, markdown)
  await input.fill('hello world')
  await count('1/3')
  await rich.click()
  await pressShortcut(app, mod + '+f')
  assert.equal(await input.inputValue(), 'hello world')
  assert.equal(
    await input.evaluate((element) => element === document.activeElement),
    true,
  )
  await input.press('Enter')
  // Clicking the document moves the caret; continue from that live position.
  await page.waitForFunction(() => {
    const element = document.querySelector('.rich-pane .cm-content')
    const view = element.cmTile.root.view
    const { from, to } = view.state.selection.main
    return view.state.sliceDoc(from, to).toLowerCase() === 'hello world'
  })
  assert.equal(
    (
      await rich.locator('.cm-searchMatch-selected').textContent()
    ).toLowerCase(),
    'hello world',
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    markdown,
  )
  await input.press('Escape')
  await bar.waitFor({ state: 'hidden' })
  assert.equal(
    await rich.evaluate((element) => element === document.activeElement),
    true,
  )
})

test('formatted and raw source find retain their own counts, accent folding, replacement updates and close-button focus', {
  timeout: 60000,
}, async (t) => {
  const markdown = '# title\n\nhello **world** and hello world.\n\nHELLO world.'
  const { app, page, source, input, bar, count } = await openFind(t, markdown)
  await input.fill('hello world')
  await t.test(
    'formatted phrases still match across marks',
    {
      todo: 'formatted gap find-003: formatted phrase counts must include matches across marks',
    },
    async () => {
      await count('1/3')
    },
  )
  await input.press('Escape')
  await page.getByRole('button', { name: 'Source view', exact: true }).click()
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  await pressShortcut(app, mod + '+f')
  await t.test(
    'source find advances the current result after switching views',
    async () => {
      await count('1/2')
      await page.waitForFunction(
        () =>
          document.querySelectorAll('.source-pane .cm-searchMatch').length ===
          2,
      )
      await input.press('Enter')
      await count('2/2')
      assert.equal(
        await input.evaluate((element) => element === document.activeElement),
        true,
      )
    },
  )
  await input.fill('settings')
  await count('No results')
  assert.equal(
    await page
      .getByRole('button', { name: 'Next match', exact: true })
      .isDisabled(),
    true,
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    markdown,
  )
  const accents = Array.from(
    { length: 200 },
    (_, index) => index + ' café',
  ).join('\n')
  await replaceSourceText(page, source, accents)
  await input.fill('CAFE')
  await count('1/200')
  await input.press('Shift+Enter')
  await count('200/200')
  await input.press('Enter')
  await count('1/200')
  await replaceSourceText(page, source, 'last needle')
  await count('No results')
  assert.equal(
    await source.evaluate((element) => element === document.activeElement),
    true,
  )
  await input.fill('last needle')
  await count('1/1')
  await page.getByRole('button', { name: 'Close find', exact: true }).click()
  await bar.waitFor({ state: 'hidden' })
  assert.equal(
    await source.evaluate((element) => element === document.activeElement),
    true,
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    'last needle',
  )
})

test('formatted split find targets the focused source or editable formatted pane', {
  timeout: 45000,
}, async (t) => {
  const { app, page, rich, source, input, bar, count } = await openFind(
    t,
    'last needle',
  )
  await input.fill('last needle')
  await count('1/1')
  await input.press('Escape')
  await page.getByRole('button', { name: 'side-by-side', exact: true }).click()
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  await source.focus()
  await pressShortcut(app, mod + '+f')
  await count('1/1')
  await source.locator('.cm-searchMatch-selected').waitFor()
  assert.equal(await source.locator('.cm-searchMatch-selected').count(), 1)
  await input.press('Escape')
  assert.equal(
    await source.evaluate((element) => element === document.activeElement),
    true,
  )
  await rich.focus()
  await pressShortcut(app, mod + '+f')
  await count('1/1')
  await rich.locator('.cm-searchMatch-selected').waitFor()
  assert.equal(await rich.locator('.cm-searchMatch-selected').count(), 1)
  await t.test(
    'split formatted view is read-only',
    {
      todo: 'formatted gap split-003: split formatted view must remain read-only',
    },
    async () => {
      assert.equal(await rich.getAttribute('contenteditable'), 'false')
    },
  )
  await input.press('Escape')
  await bar.waitFor({ state: 'hidden' })
  assert.equal(
    await rich.evaluate((element) => element === document.activeElement),
    true,
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    'last needle',
  )
})

async function visibleFindRange(
  page,
  expected,
  startOnly = false,
  block = null,
) {
  await page.waitForFunction(
    ({ expected, startOnly, block }) => {
      const selected = [
        ...document.querySelectorAll('.rich-pane .cm-searchMatch-selected'),
      ]
      if (selected.map((node) => node.textContent).join('') !== expected)
        return false
      if (block && !selected[0].closest('.cm-line').textContent.includes(block))
        return false
      const rectangles = selected.flatMap((node) => {
        const range = document.createRange()
        range.selectNodeContents(node)
        return [...range.getClientRects()]
      })
      if (!rectangles.length) return false
      const pane = selected[0].closest('.rich-pane').getBoundingClientRect()
      const code = selected[0]
        .closest('.hibi-lp-codeblock')
        ?.getBoundingClientRect()
      const left = Math.max(pane.left, code?.left ?? pane.left)
      const right = Math.min(pane.right, code?.right ?? pane.right)
      const first = rectangles[0],
        last = rectangles.at(-1)
      return (
        first.left >= left &&
        first.left < right &&
        first.top >= pane.top &&
        (startOnly || (last.right <= right && last.bottom <= pane.bottom))
      )
    },
    { expected, startOnly, block },
  )
}

test('formatted find reveals top and bottom matches in either direction while the field keeps focus', {
  timeout: 45000,
}, async (t) => {
  const filler = Array.from({ length: 120 }, (_, i) => 'line ' + i).join('\n\n')
  const markdown = filler + '\n\nneedle top\n\n' + filler + '\n\nneedle bottom'
  const { page, input, count } = await openFind(t, markdown)
  await input.fill('needle')
  await count('1/2')
  for (const [key, expected] of [
    ['Enter', '2/2'],
    ['Enter', '1/2'],
    ['Shift+Enter', '2/2'],
  ]) {
    await input.press(key)
    await count(expected)
    await visibleFindRange(
      page,
      'needle',
      false,
      expected === '2/2' ? 'needle bottom' : 'needle top',
    )
    assert.equal(
      await input.evaluate((element) => element === document.activeElement),
      true,
    )
  }
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    markdown,
  )
})

for (const kind of ['code', 'wrapped', 'wide code start']) {
  test('formatted find reveals the full ' +
    kind +
    ' match within its scrolling containers', {
    timeout: 45000,
  }, async (t) => {
    const filler = Array.from({ length: 120 }, (_, i) => 'line ' + i).join(
      '\n\n',
    )
    const query =
      kind === 'wrapped'
        ? 'wrapped needle ' + 'word '.repeat(24) + 'end'
        : kind === 'code'
          ? 'needle'
          : 'needle' + 'x'.repeat(100)
    const body =
      kind === 'wrapped'
        ? query
        : '~~~\n' + 'code '.repeat(60) + query + '\n~~~'
    const markdown = filler + '\n\n' + body + '\n\n' + filler
    const { page, rich, input, count } = await openFind(t, markdown)
    if (kind !== 'code') await page.setViewportSize({ width: 480, height: 720 })
    await rich.evaluate((element) => {
      element.closest('.rich-pane').scrollTop = 0
    })
    await input.fill(query)
    await count('1/1')
    await visibleFindRange(page, query, kind === 'wide code start')
    if (kind === 'wide code start') {
      const geometry = await rich.evaluate((element) => {
        const match = element.querySelector('.cm-searchMatch-selected')
        const range = document.createRange()
        range.selectNodeContents(match)
        const rectangles = [...range.getClientRects()]
        const box = (rect) => [rect.left, rect.top, rect.right, rect.bottom]
        const ancestors = []
        for (
          let node = match;
          node && ancestors.length < 12;
          node = node.parentElement
        ) {
          const style = getComputedStyle(node)
          ancestors.push({
            node: node.tagName + '.' + node.className,
            box: box(node.getBoundingClientRect()),
            clientWidth: node.clientWidth,
            scrollWidth: node.scrollWidth,
            scrollLeft: node.scrollLeft,
            whiteSpace: style.whiteSpace,
            overflowWrap: style.overflowWrap,
            wordBreak: style.wordBreak,
            overflowX: style.overflowX,
          })
          if (node.matches('.rich-pane')) break
        }
        return {
          lineWrapping: element.cmTile.root.view.lineWrapping,
          rectangles: rectangles.length,
          first: box(rectangles[0]),
          last: box(rectangles.at(-1)),
          ancestors,
        }
      })
      t.diagnostic(
        JSON.stringify({ probe: 'find-wide-code-geometry', ...geometry }),
      )
      await t.test(
        'wide code scrolls horizontally with its start visible',
        {
          todo: 'formatted gap find-005: wide code matches must scroll horizontally with their start visible',
        },
        async () => {
          assert.ok(
            await rich.evaluate((element) => {
              const match = element.querySelector('.cm-searchMatch-selected')
              const line = match.closest('.hibi-lp-codeblock')
              const pane = element.closest('.rich-pane')
              return [
                line,
                pane,
                element.closest('.cm-editor').querySelector('.cm-scroller'),
              ].some((node) => node.scrollLeft > 0)
            }),
            'a wide code match scrolls horizontally while keeping its start visible',
          )
        },
      )
    }
    assert.equal(
      await input.evaluate((element) => element === document.activeElement),
      true,
    )
    assert.equal(
      (await page.evaluate(() => window.hibi.getDocument())).markdown,
      markdown,
    )
  })
}

async function countedDenseFind(t) {
  const dense = 'needle word '.repeat(10000).trimEnd()
  const fixture = await openFind(t, dense, true)
  await fixture.input.fill('NEEDLE')
  await fixture.page.waitForFunction(() => window.findWork.held.length > 0)
  const workers = await findWorkers(fixture.page)
  await fixture.page.evaluate(() => window.findWork.release())
  await fixture.count('1/10000')
  const initial = await foldWork(workers, true)
  assert.ok(
    initial.lower >= dense.length && initial.normalized >= dense.length,
    'positive control measures a complete source scan in established document workers',
  )
  const owners = await fixture.page.evaluate(() => [
    ...new Set(
      window.findWork.requests
        .filter((request) => request.query.toLowerCase() === 'needle')
        .map((request) => request.owner),
    ),
  ])
  assert.ok(
    owners.length > 0 &&
      owners.every((owner) => typeof owner === 'string' && owner.length),
    'requests identify logical search owners, independent of physical worker sharing',
  )
  return { ...fixture, dense, workers, initial, owners }
}

test('formatted find selection-only moves reuse worker search work and keep renderer folding bounded', {
  timeout: 60000,
}, async (t) => {
  const { page, rich, input, count, dense, workers, owners } =
    await countedDenseFind(t)
  await page.evaluate(() => {
    window.findWork.lower = window.findWork.normalized = 0
    window.findWork.measuring = true
  })
  for (const [key, expected] of [
    ['Enter', '2/10000'],
    ['Shift+Enter', '1/10000'],
    ['Shift+Enter', '10000/10000'],
    ['Enter', '1/10000'],
  ]) {
    await input.press(key)
    await count(expected)
  }
  const measured = await foldWork(workers)
  const main = await page.evaluate(() => {
    window.findWork.measuring = false
    return {
      lower: window.findWork.lower,
      normalized: window.findWork.normalized,
      requests: window.findWork.requests,
    }
  })
  assert.ok(measured.lower < dense.length, JSON.stringify({ measured, owners }))
  assert.ok(
    measured.normalized < dense.length,
    JSON.stringify({ measured, owners }),
  )
  assert.ok(
    main.lower < dense.length && main.normalized < dense.length,
    JSON.stringify(main),
  )
  assert.equal(
    await rich.locator('.cm-searchMatch-selected').textContent(),
    'needle',
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    dense,
  )
})

test('formatted find moving to an adjacent match restyles highlights without rewriting rendered text', {
  timeout: 45000,
}, async (t) => {
  const dense = 'needle word '.repeat(10000).trimEnd()
  const { page, rich, input, count } = await openFind(t, dense)
  await input.fill('needle')
  await count('1/10000')
  await measureFindLayout(rich)
  await rich.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    const nodes = []
    while (walker.nextNode())
      nodes.push([walker.currentNode, walker.currentNode.data])
    window.findTextBefore = {
      text: element.textContent,
      nodes,
      lines: [...element.querySelectorAll('.cm-line')],
      ranges: element.cmTile.root.view.visibleRanges,
    }
    window.findTextChanges = []
    window.findTextObserver = new MutationObserver((records) =>
      window.findTextChanges.push(...records),
    )
    window.findTextObserver.observe(element, {
      attributes: true,
      attributeFilter: ['class'],
      attributeOldValue: true,
      characterData: true,
      characterDataOldValue: true,
      childList: true,
      subtree: true,
    })
  })
  await input.press('Enter')
  await count('2/10000')
  await measureFindLayout(rich)
  const { containers, ...changes } = await rich.evaluate((element) => {
    const records = [
      ...window.findTextChanges,
      ...window.findTextObserver.takeRecords(),
    ]
    window.findTextObserver.disconnect()
    const text = (node) =>
      node.nodeType === Node.TEXT_NODE ? node.data : (node.textContent ?? '')
    const label = (node) => {
      const target =
        node.nodeType === Node.TEXT_NODE ? (node.parentElement ?? node) : node
      return (target?.nodeName + '.' + (target?.className ?? '')).slice(0, 120)
    }
    const before = window.findTextBefore
    const counts = { attributes: 0, childList: 0, characterData: 0 }
    const units = {
      added: 0,
      removed: 0,
      characterBefore: 0,
      characterAfter: 0,
    }
    const targets = new Map()
    let changedCharacters = 0
    for (const record of records) {
      counts[record.type]++
      const target = record.type + ':' + label(record.target)
      targets.set(target, (targets.get(target) ?? 0) + 1)
      for (const node of record.addedNodes) units.added += text(node).length
      for (const node of record.removedNodes) units.removed += text(node).length
      if (record.type === 'characterData') {
        units.characterBefore += record.oldValue.length
        units.characterAfter += text(record.target).length
        if (record.oldValue !== text(record.target)) changedCharacters++
      }
    }
    return {
      containers: records
        .filter(
          (record) =>
            record.type === 'characterData' ||
            [...record.addedNodes, ...record.removedNodes].some(
              (node) => text(node).length,
            ),
        )
        .map((record) => record.type),
      counts,
      units,
      changedCharacters,
      targets: [...targets].sort((a, b) => b[1] - a[1]).slice(0, 8),
      samples: [
        ...records
          .filter((record) => record.type === 'characterData')
          .slice(0, 4),
        ...records.filter((record) => record.type === 'childList').slice(0, 4),
      ].map((record) => ({
        type: record.type,
        target: label(record.target),
        old: record.oldValue?.slice(0, 48),
        now:
          record.type === 'characterData'
            ? text(record.target).slice(0, 48)
            : undefined,
        added: [...record.addedNodes]
          .slice(0, 2)
          .map((node) => [label(node), text(node).length]),
        removed: [...record.removedNodes]
          .slice(0, 2)
          .map((node) => [label(node), text(node).length]),
      })),
      beforeUnits: before.text.length,
      afterUnits: element.textContent.length,
      sameText: before.text === element.textContent,
      beforeNodes: before.nodes.length,
      retainedNodes: before.nodes.filter(([node]) => element.contains(node))
        .length,
      retainedUnchangedUnits: before.nodes.reduce(
        (sum, [node, data]) =>
          sum +
          (element.contains(node) && node.data === data ? data.length : 0),
        0,
      ),
      beforeLines: before.lines.length,
      retainedLines: before.lines.filter((node) => element.contains(node))
        .length,
      beforeRangeCount: before.ranges.length,
      beforeRanges: before.ranges.slice(0, 8),
      afterRangeCount: element.cmTile.root.view.visibleRanges.length,
      afterRanges: element.cmTile.root.view.visibleRanges.slice(0, 8),
    }
  })
  t.diagnostic(
    JSON.stringify({
      probe: 'find-adjacent-text-dom',
      textContainerRecords: containers.length,
      ...changes,
    }),
  )
  await t.test('adjacent match preserves the visible text', () => {
    assert.equal(changes.sameText, true)
  })
  // CM moves decoration wrappers; every existing text node and line must survive unchanged.
  await t.test('adjacent match does not rewrite rendered text', () => {
    assert.equal(changes.counts.characterData, 0)
    assert.equal(changes.retainedNodes, changes.beforeNodes)
    assert.equal(changes.retainedUnchangedUnits, changes.beforeUnits)
    assert.equal(changes.retainedLines, changes.beforeLines)
    assert.equal(changes.afterRangeCount, changes.beforeRangeCount)
    assert.deepEqual(changes.afterRanges, changes.beforeRanges)
    assert.ok(changes.counts.childList > 0 || changes.counts.attributes > 0)
    // Two matching spans may each replace both decoration wrappers.
    assert.ok(changes.counts.childList <= 12, JSON.stringify(changes.counts))
    assert.ok(changes.units.added <= 4 * 'needle'.length)
    assert.ok(changes.units.removed <= 4 * 'needle'.length)
  })
  assert.equal(
    await rich.locator('.cm-searchMatch-selected').textContent(),
    'needle',
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    dense,
  )
})

test('formatted find rescans edited source once and native history leaves navigation at the live source caret', {
  timeout: 60000,
}, async (t) => {
  const { app, page, rich, input, count, dense, workers, initial } =
    await countedDenseFind(t)
  await rich.focus()
  await page.keyboard.insertText('pin')
  await count('0/9999')
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    'pin' + dense.slice(6),
  )
  const edited = await foldWork(workers, true)
  assert.ok(
    edited.lower <= 2 * dense.length,
    JSON.stringify({ edited, initial }),
  )
  assert.ok(
    edited.normalized <= 2 * dense.length,
    JSON.stringify({ edited, initial }),
  )
  await pressShortcut(app, mod + '+z')
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    dense,
  )
  await count('1/10000')
  await rich.press('Home')
  for (let i = 0; i < 6; i++) await rich.press('ArrowRight')
  assert.equal(
    await rich.evaluate(
      (element) => element.cmTile.root.view.state.selection.main.head,
    ),
    6,
  )
  await input.focus()
  await input.press('Enter')
  await count('2/10000')
  assert.equal(
    await rich.locator('.cm-searchMatch-selected').textContent(),
    'needle',
  )
  assert.equal(
    await rich.evaluate(
      (element) => element.cmTile.root.view.state.selection.main.from,
    ),
    12,
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    dense,
  )
})

test('formatted find queues pending Enter moves without synchronously searching the note or moving the selection', {
  timeout: 45000,
}, async (t) => {
  const lines = Array.from({ length: 500 }, (_, i) => 'line ' + i)
  const markdown = [...lines, 'needle one', 'needle two', 'needle three'].join(
    '\n\n',
  )
  const { page, rich, input, count } = await openFind(t, markdown, true)
  // The historical pending case already selected the first match before its counting slices were held.
  await rich.evaluate(
    (element, from) =>
      element.cmTile.root.view.dispatch({
        selection: { anchor: from, head: from + 6 },
        scrollIntoView: true,
      }),
    markdown.indexOf('needle one'),
  )
  await input.fill('needle')
  await page.waitForFunction(() => window.findWork.held.length > 0)
  await count('Searching…')
  const before = await rich.evaluate((element) => {
    const { anchor, head } = element.cmTile.root.view.state.selection.main
    return { anchor, head }
  })
  await page.evaluate(() => {
    window.findWork.lower = window.findWork.normalized = 0
    window.findWork.measuring = true
  })
  try {
    await input.press('Enter')
    await input.press('Enter')
    const pending = await page.evaluate(() => {
      window.findWork.measuring = false
      return {
        lower: window.findWork.lower,
        normalized: window.findWork.normalized,
      }
    })
    assert.ok(
      pending.lower < 1000 && pending.normalized < 1000,
      JSON.stringify(pending),
    )
    assert.deepEqual(
      await rich.evaluate((element) => {
        const { anchor, head } = element.cmTile.root.view.state.selection.main
        return { anchor, head }
      }),
      before,
    )
    assert.equal(
      await input.evaluate((element) => element === document.activeElement),
      true,
    )
    assert.equal(
      await page.locator('.find-bar output').textContent(),
      'Searching…',
    )
    assert.equal(
      (await page.evaluate(() => window.hibi.getDocument())).markdown,
      markdown,
    )
  } finally {
    await page.evaluate(() => window.findWork.release())
  }
  await count('3/3')
  assert.equal(
    await rich.locator('.cm-searchMatch-selected').textContent(),
    'needle',
  )
})
