import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { renderedReplaceEdits } from '../src/shared/rendered-replace.ts'
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

// The rich editor highlights matches overlapping the lines on screen and about
// a screen of text, at least 2,000 characters, to each side.
async function denseHighlights(page, rich) {
  await measureFindLayout(rich)
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  )
  return rich.evaluate((element) => {
    const view = element.cmTile.root.view
    const box = element.getBoundingClientRect()
    const pane = element.closest('.rich-pane').getBoundingClientRect()
    const x =
      box.left + Number.parseFloat(getComputedStyle(element).paddingLeft) + 1
    const from = view.posAtCoords({ x, y: Math.max(box.top, pane.top) + 1 })
    const to = view.posAtCoords({ x, y: Math.min(box.bottom, pane.bottom) - 1 })
    const margin = Math.max(to - from, 2000)
    const window = {
      from: Math.max(0, from - margin),
      to: Math.min(view.state.doc.length, to + margin),
    }
    const starts = (positions) => ({
      count: positions.length,
      first: positions[0],
      last: positions.at(-1),
    })
    const overlaps = (start, range) =>
      start < range.to && start + 'needle'.length > range.from
    // The selected match stays highlighted outside the window.
    const [selected, near] = [true, false].map((selected) =>
      [...element.querySelectorAll('.cm-searchMatch')]
        .filter(
          (match) =>
            match.classList.contains('cm-searchMatch-selected') === selected,
        )
        .map((match) => view.posAtDOM(match, 0)),
    )
    const positions = [
      ...near,
      ...selected.filter((start) => overlaps(start, window)),
    ].sort((a, b) => a - b)
    const highlighted = starts(positions)
    const matches = [...view.state.doc.toString().matchAll(/needle/g)].map(
      (match) => match.index,
    )
    return {
      count: highlighted.count,
      units: highlighted.last + 'needle'.length - highlighted.first,
      highlighted,
      expected: starts(matches.filter((start) => overlaps(start, window))),
      selected: selected.length,
      // Every match on screen is highlighted.
      covered: matches
        .filter((start) => overlaps(start, { from, to }))
        .every((start) => positions.includes(start)),
      screen: to - from,
      // What CodeMirror renders around the screen, without what it keeps
      // around an off-screen selection.
      rendered: view.visibleRanges
        .filter((range) => range.from < to && range.to > from)
        .reduce((sum, range) => sum + range.to - range.from, 0),
      ranges: view.visibleRanges.map((range) => [range.from, range.to]),
    }
  })
}

// Scrolls the pane to a fraction of its height, then waits until CodeMirror
// stops correcting the position and what it renders.
async function scrollFormatted(rich, fraction) {
  await rich.evaluate((element, fraction) => {
    const pane = element.closest('.rich-pane')
    pane.scrollTop = fraction * (pane.scrollHeight - pane.clientHeight)
  }, fraction)
  let previous = null
  for (let attempt = 0; attempt < 20; attempt++) {
    await measureFindLayout(rich)
    const current = await rich.evaluate((element) =>
      JSON.stringify([
        element.closest('.rich-pane').scrollTop,
        element.cmTile.root.view.visibleRanges,
      ]),
    )
    if (current === previous) return
    previous = current
  }
  throw new Error('the formatted view kept moving after scrolling')
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

async function openFind(
  t,
  markdown,
  instrument = false,
  renderedProbe = false,
) {
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
  if (renderedProbe)
    await page.addInitScript((length) => {
      window.renderedFindReplies = []
      const observed = new WeakSet(),
        post = Worker.prototype.postMessage
      let config
      Worker.prototype.postMessage = function (message, ...rest) {
        const request = message.message ?? message
        if (request.type === 'boundaries') config = request.config
        if (request.type === 'find') {
          if (!observed.has(this)) {
            observed.add(this)
            this.addEventListener('message', ({ data }) => {
              const reply = data.message ?? data
              if (reply.type === 'find' && reply.mode === 'rendered')
                window.renderedFindReplies.push(reply)
            })
          }
          const editor = document.querySelector(
            '.rich-pane .hibi-formatted .cm-content',
          )
          const find = {
            ...request,
            ...window.renderedFindSelection,
            mode: 'rendered',
            replacement: 'X',
            config,
            prefix: config?.prefix ?? 0,
            viewport: {
              from: 0,
              to: editor?.cmTile?.root.view.state.doc.length ?? length,
            },
          }
          message = message.message ? { ...message, message: find } : find
        }
        return post.call(this, message, ...rest)
      }
    }, markdown.replace(/\r\n?/g, '\n').length)
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

test('rendered backend returns source provenance and replacement edits make one native undo step', {
  timeout: 30000,
}, async (t) => {
  const markdown = 'hello **world** and hello world.\n\nHELLO world.'
  const { app, page, rich, input, count } = await openFind(
    t,
    markdown,
    false,
    true,
  )
  await input.fill('hello world')
  await count('1/3')
  await waitForAsync(page, () =>
    window.renderedFindReplies.some((reply) => reply.location.total === 3),
  )
  const result = await page.evaluate(() => window.renderedFindReplies.at(-1))
  assert.equal(result.highlights.matches.length, 3)
  assert.deepEqual(result.highlights.matches[0].segments, [
    { from: 0, to: 6 },
    { from: 8, to: 13 },
  ])
  await input.fill('lo wo')
  await count('1/3')
  await waitForAsync(
    page,
    () => window.renderedFindReplies.at(-1)?.highlights.matches[0]?.from === 3,
  )
  const match = await page.evaluate(
    () => window.renderedFindReplies.at(-1).highlights.matches[0],
  )
  assert.deepEqual(match.segments, [
    { from: 3, to: 6 },
    { from: 8, to: 10 },
  ])
  await page.evaluate((match) => {
    window.renderedFindSelection = { from: match.from, to: match.to }
  }, match)
  await input.press('Enter')
  await waitForAsync(page, () =>
    window.renderedFindReplies.some(
      (reply) =>
        reply.replacement?.from === 3 &&
        reply.replacement.to === 10 &&
        !!reply.replacement.edits,
    ),
  )
  const prepared = await page.evaluate(
    () =>
      window.renderedFindReplies.findLast(
        (reply) =>
          reply.replacement?.from === 3 &&
          reply.replacement.to === 10 &&
          !!reply.replacement.edits,
      ).replacement,
  )
  const edits = renderedReplaceEdits(match, 'X', prepared)
  assert.ok(edits)
  await input.press('Escape')
  await rich.evaluate(
    (element, changes) => element.cmTile.root.view.dispatch({ changes }),
    edits,
  )
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.startsWith('helX**rld**'),
  )
  await rich.focus()
  await pressShortcut(app, `${mod}+z`)
  await waitForAsync(
    page,
    async (markdown) => (await window.hibi.getDocument()).markdown === markdown,
    markdown,
  )
})

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
  assert.ok(nearby.count > 1, JSON.stringify(nearby))
  assert.deepEqual(
    nearby.highlighted,
    nearby.expected,
    'highlights cover the rich editor window around the screen',
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
  // Reopening searches again from the restored selection, as the rich editor
  // does.
  await pressShortcut(app, `${mod}+f`)
  const selected = rich.locator('.cm-searchMatch-selected')
  await selected.waitFor()
  await count('1/10000')
  assert.equal(await selected.count(), 1)
  // Accepted difference: undo restores the selected match, so it stays the
  // current one, as in source view. The rich editor leaves a caret after it.
  await rich.evaluate((element) => element.focus())
  await page.keyboard.insertText('pin')
  await count('0/9999')
  await pressShortcut(app, `${mod}+z`)
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    dense,
  )
  await count('1/10000')
  assert.equal(await selected.count(), 1)
  assert.equal(await selected.textContent(), 'needle')
})

test('formatted find keeps highlights bounded when match count grows from ten thousand to one hundred thousand', {
  timeout: 60000,
}, async (t) => {
  const dense = 'needle word '.repeat(10000).trimEnd()
  const { app, page, rich, source, input, count } = await openFind(t, dense)
  await input.fill('needle')
  await count('1/10000')
  const nearby = await denseHighlights(page, rich)
  assert.ok(nearby.count > 1, JSON.stringify(nearby))
  assert.deepEqual(
    nearby.highlighted,
    nearby.expected,
    'highlights cover the rich editor window around the screen',
  )
  const scrolled = []
  for (const fraction of [0.2, 0.7]) {
    await scrollFormatted(rich, fraction)
    scrolled.push(await denseHighlights(page, rich))
  }
  await scrollFormatted(rich, 0)
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
  for (const fraction of [0.2, 0.7]) {
    await scrollFormatted(rich, fraction)
    scrolled.push(await denseHighlights(page, rich))
  }
  t.diagnostic(JSON.stringify({ nearby, more, scrolled }))
  assert.deepEqual(more.highlighted, more.expected)
  assert.equal(more.count, nearby.count)
  assert.equal(
    more.units,
    nearby.units,
    'ten times as many matches stays within the same viewport budget',
  )
  // CodeMirror draws a wrapped line's visible part and a fixed margin of text
  // around it, so what it renders does not grow with the note.
  // The window stays put while the screen is inside it, so after scrolling
  // the highlights cover the screen and keep the selected match.
  for (const position of scrolled) {
    assert.equal(position.covered, true, JSON.stringify(position))
    assert.equal(position.selected, 1)
  }
  // Away from the note's start CodeMirror renders about 10,000 estimated
  // characters on both sides of the screen; its estimate runs up to a quarter
  // denser than this text, so that stays under ten screens of it.
  for (const { rendered, screen } of [nearby, more, ...scrolled])
    assert.ok(rendered <= 12 * screen, JSON.stringify({ rendered, screen }))
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
  // Accepted difference: the codemirror split pane stays editable.
  assert.equal(await rich.getAttribute('contenteditable'), 'true')
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
      // Code lines scroll sideways inside their block's box.
      const code = (
        selected[0].closest('.hibi-lp-codescroll') ??
        selected[0].closest('.hibi-lp-codeblock')
      )?.getBoundingClientRect()
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
        async () => {
          assert.ok(
            await rich.evaluate((element) => {
              const match = element.querySelector('.cm-searchMatch-selected')
              const line =
                match.closest('.hibi-lp-codescroll') ??
                match.closest('.hibi-lp-codeblock')
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
