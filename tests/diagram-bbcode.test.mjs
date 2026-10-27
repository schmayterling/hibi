import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import {
  testFormattedEngines as it,
  selectFormattedEngine,
} from './formatted-engine.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

it('Mermaid and BBCode edit, preview, and export without executing content', {
  timeout: 90000,
}, async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'hibi-diagrams-'))
  const profile = join(temp, 'profile')
  await mkdir(profile)
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ bbcode: true }),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(temp, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await selectFormattedEngine(app, page, t.formattedEngine ?? 'tiptap')
  page.on('pageerror', (error) => console.error(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') console.error(message.text())
  })
  page.setDefaultTimeout(15000)
  await waitForDocumentEditor(app, page)
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  const open = async (name, source, label) => {
    const path = join(temp, name)
    await writeFile(path, source)
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      })
    }, path)
    await pressShortcut(app, `${mod}+o`)
    if (label !== 'Markdown')
      await page
        .getByRole('textbox', { name: `${label} editor`, exact: true })
        .waitFor()
    await page
      .getByRole('button', { name: /^side-by-side$/i })
      .click()
      .catch(async (error) => {
        console.error((await page.locator('body').innerText()).slice(-4000))
        throw error
      })
    await page
      .getByRole('textbox', { name: `${label} editor`, exact: true })
      .waitFor()
  }
  await open(
    'diagram.mmd',
    `flowchart TD
  A0 --> A1 --> A2 --> A3 --> A4 --> A5 --> A6 --> A7 --> A8 --> A9 --> A10 --> A11 --> A12`,
    'Mermaid',
  )
  const diagram = page.locator('.format-content .mermaid-diagram > svg')
  await diagram.waitFor()
  // Diagram colors are theme variables: a colorscheme change restyles the drawn SVG.
  const colors = () =>
    diagram.evaluate((svg) => {
      const probe = document.createElement('span')
      probe.style.color = 'var(--surface)'
      document.body.append(probe)
      const surface = getComputedStyle(probe).color
      probe.remove()
      return {
        fill: getComputedStyle(svg.querySelector('.pele-node rect')).fill,
        surface,
      }
    })
  await page.emulateMedia({ colorScheme: 'light' })
  await page.waitForFunction(
    () => document.documentElement.dataset.appearance === 'light',
  )
  const light = await colors()
  assert.equal(light.fill, light.surface)
  await diagram.evaluate((svg) => {
    window.drawnDiagram = svg
  })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForFunction(
    () => document.documentElement.dataset.appearance === 'dark',
  )
  const dark = await colors()
  assert.equal(dark.fill, dark.surface)
  assert.notEqual(dark.fill, light.fill)
  assert.equal(
    await diagram.evaluate((svg) => svg === window.drawnDiagram),
    true,
  )
  const [darkSurface, darkBackground] = await page.evaluate(() =>
    ['--surface', '--background'].map((role) =>
      getComputedStyle(document.documentElement).getPropertyValue(role).trim(),
    ),
  )
  assert.equal(
    await diagram.evaluate((svg) => getComputedStyle(svg).maxHeight),
    '480px',
  )
  assert.ok((await diagram.boundingBox()).height <= 480)
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^mermaid$/i, exact: true }).click()
  const maxHeight = page.getByLabel(/^maximum height$/i, { exact: true })
  for (let index = 0; index < 6; index++) await maxHeight.press('ArrowLeft')
  assert.equal(await maxHeight.inputValue(), '240')
  await page.getByRole('button', { name: /^back to app$/i }).click()
  assert.equal(
    await diagram.evaluate((svg) => getComputedStyle(svg).maxHeight),
    '240px',
  )
  assert.ok((await diagram.boundingBox()).height <= 240)
  assert.equal(
    await page.getByRole('button', { name: /^normal$/i }).isDisabled(),
    true,
  )
  const exported = join(temp, 'diagram.html')
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
  }, exported)
  await page.getByRole('button', { name: /^Export HTML$/i }).click()
  await page.waitForFunction(
    () => !document.querySelector('.format-preview button')?.disabled,
  )
  for (let attempt = 0; attempt < 50; attempt++) {
    if (
      await readFile(exported).then(
        () => true,
        () => false,
      )
    )
      break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.deepEqual(
    await page
      .locator('.format-preview .document-notice:visible')
      .allTextContents(),
    [],
  )
  const exportedHtml = await readFile(exported, 'utf8')
  assert.match(exportedHtml, /max-height:240px/)
  // Exports bake the active colors into a self-contained image.
  const image = exportedHtml.match(
    /<img class="mermaid-diagram" alt="Mermaid diagram" src="(data:image\/svg\+xml,%3Csvg%20[^"]+)">/,
  )?.[1]
  assert.ok(image)
  const exportedSvg = decodeURIComponent(image.split(',')[1])
  assert.ok(exportedSvg.includes(`--pele-surface:${darkSurface}`))
  assert.ok(exportedSvg.includes(`background:${darkBackground}`))
  assert.doesNotMatch(exportedSvg, /<a\b|<image\b|<foreignObject|javascript:/i)
  assert.ok(
    await page.evaluate(async (source) => {
      const image = new Image()
      image.src = source
      await image.decode()
      return image.naturalWidth > 0 && image.naturalHeight > 0
    }, image),
  )
  await open(
    'post.bbcode',
    '[b]bold [i]nested[/i][/b]\n[code][b]literal[/b][/code]\n[url=javascript:alert(1)]unsafe[/url]\n<img src=x onerror="window.compromised=true">',
    'BBCode',
  )
  await page.locator('.bbcode-content strong em').waitFor()
  assert.equal(
    await page.locator('.bbcode-content strong').innerText(),
    'bold nested',
  )
  assert.equal(
    await page.locator('.bbcode-content pre').innerText(),
    '[b]literal[/b]',
  )
  assert.equal(
    await page.locator('.bbcode-content a').getAttribute('href'),
    null,
  )
  assert.equal(await page.locator('.bbcode-content img').count(), 0)
  assert.equal(await page.evaluate(() => window.compromised), undefined)
  await writeFile(
    join(temp, 'image.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aA3sAAAAASUVORK5CYII=',
      'base64',
    ),
  )
  await open('images.bbcode', '[img]image.png[/img]', 'BBCode')
  await page.locator('.bbcode-content img[src^="data:image/png"]').waitFor()
  await page.getByRole('button', { name: /^bold$/i, exact: true }).waitFor()
  const original =
    '_keep_\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\nuntouched _tail_\n'
  await open('notes.md', original, 'Markdown')
  await page.getByRole('button', { name: /^normal$/i }).click()
  await page.locator('.mermaid-block .mermaid-diagram > svg').waitFor()
  for (const message of ['Hello', 'Again']) {
    await page.getByRole('button', { name: /Edit Mermaid diagram/i }).click()
    const source = `sequenceDiagram\n  Alice->>Bob: ${message}`
    await page.getByLabel('Mermaid source', { exact: true }).fill(source)
    await page.getByRole('button', { name: /^Apply$/i }).click()
    const expected = original.replace('flowchart LR\n  A --> B', source)
    await waitForAsync(
      page,
      async (expected) =>
        (await window.hibi.getDocument()).markdown === expected,
      expected,
    )
    await clickMenu(app, 'Save')
    await waitForAsync(
      page,
      async () => !(await window.hibi.getDocument()).dirty,
    )
    assert.equal(await readFile(join(temp, 'notes.md'), 'utf8'), expected)
    await waitForDocumentEditor(app, page)
    await page
      .locator('.mermaid-block .mermaid-diagram > svg')
      .getByText(message)
      .waitFor()
  }
  await page
    .getByRole('button', { name: /^source view$/i, exact: true })
    .click()
  assert.match(
    await page.locator('.source-pane .cm-content').innerText(),
    /Alice->>Bob: Again/,
  )
})

const launchWithNote = async (t, prefix, addons, markdown, prepare) => {
  const temp = await mkdtemp(join(tmpdir(), prefix))
  const profile = join(temp, 'profile')
  await mkdir(profile)
  if (addons)
    await writeFile(join(profile, 'addons.json'), JSON.stringify(addons))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(temp, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await selectFormattedEngine(app, page, t.formattedEngine ?? 'tiptap')
  page.setDefaultTimeout(15000)
  await waitForDocumentEditor(app, page)
  await prepare?.(page)
  const note = join(temp, 'note.md')
  await writeFile(note, markdown)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, note)
  await pressShortcut(
    app,
    process.platform === 'darwin' ? 'Meta+o' : 'Control+o',
  )
  return { app, page }
}
it('Mermaid is on by default and keeps diagram links, images, and markup inert', {
  timeout: 60000,
}, async (t) => {
  const hostile = `\`\`\`mermaid
%%{init: {"securityLevel": "loose", "htmlLabels": true, "themeCSS": "svg { background: url(https://example.invalid/theme) }"}}%%
flowchart LR
  A["<img src=x onerror=window.compromised=1> Label"] --> B[Linked]
  A --> C@{ img: "https://example.invalid/image.png", label: "Picture", pos: "t", w: 60, h: 60 }
  click A call window.compromised(2)
  click B "javascript:window.compromised=3"
  click C href "https://example.invalid/page"
\`\`\`
`
  const { page } = await launchWithNote(
    t,
    'hibi-diagram-default-',
    null,
    hostile,
  )
  assert.equal(
    await page.evaluate(
      async () =>
        (await window.hibi.getAddonStates()).find(({ id }) => id === 'mermaid')
          ?.enabled,
    ),
    true,
  )
  const diagram = page.locator('.mermaid-block .mermaid-diagram > svg')
  await diagram.getByText('Label').waitFor()
  const markup = await diagram.evaluate((svg) => svg.outerHTML)
  assert.doesNotMatch(
    markup,
    /<a\b|<image\b|<foreignObject|<script|javascript:|\son[a-z]+=|url\(/i,
  )
  assert.doesNotMatch(markup, /<img|onerror/i)
  assert.equal(await page.evaluate(() => window.compromised), undefined)
})

test('tiptap: a note full of diagrams draws visible ones first, then idle slices that stop when Mermaid is disabled', {
  timeout: 90000,
}, async (t) => {
  const count = 120
  const diagrams = Array.from(
    { length: count },
    (_, index) =>
      `\`\`\`mermaid\nflowchart LR\n${Array.from(
        { length: 20 },
        (_, step) => `  N${step}[Probe ${index}-${step}] --> N${step + 1}`,
      ).join('\n')}\n\`\`\`\n`,
  ).join('\n')
  const { app, page } = await launchWithNote(
    t,
    'hibi-diagram-burst-',
    { mermaid: true },
    diagrams,
    (page) =>
      // Hold idle work so the test decides when each background pass runs.
      page.evaluate(() => {
        window.heldIdle = []
        window.requestIdleCallback = (callback) =>
          window.heldIdle.push(callback)
        window.releaseIdle = () => {
          for (const callback of window.heldIdle.splice(0))
            callback({ didTimeout: false, timeRemaining: () => 50 })
        }
        window.diagramDraws = 0
        new MutationObserver((records) => {
          for (const record of records)
            if (record.target.matches?.('.mermaid-diagram'))
              window.diagramDraws += [...record.addedNodes].filter(
                (node) => node.nodeName === 'svg',
              ).length
        }).observe(document.documentElement, {
          childList: true,
          subtree: true,
        })
      }),
  )
  const progress = () =>
    page.evaluate(() => {
      const figures = [
        ...document.querySelectorAll('.mermaid-block .mermaid-diagram'),
      ]
      const visible = figures.filter((figure) => {
        const box = figure.getBoundingClientRect()
        return box.bottom > 0 && box.top < innerHeight
      })
      return {
        drawn: figures.filter((figure) => figure.firstChild).length,
        visible: visible.length,
        pending: visible.filter((figure) => !figure.firstChild).length,
      }
    })
  await page.waitForFunction(
    (count) => document.querySelectorAll('.mermaid-block').length === count,
    count,
  )
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.mermaid-block .mermaid-diagram')].every(
      (figure) => {
        const box = figure.getBoundingClientRect()
        return figure.firstChild || box.bottom <= 0 || box.top >= innerHeight
      },
    ),
  )
  // Without idle time, only the diagrams on screen have drawn.
  const first = await progress()
  assert.ok(first.visible > 0 && first.drawn > 0, JSON.stringify(first))
  assert.equal(first.pending, 0)
  assert.ok(first.drawn < count, JSON.stringify(first))
  // One idle pass draws a slice within its budget, not the rest of the note.
  // The pass is requested after the next frame confirms nothing else is on screen.
  let second = first
  for (let turn = 0; turn < 20 && second.drawn === first.drawn; turn++) {
    await page.evaluate(() => {
      window.releaseIdle()
      return new Promise((resolve) => requestAnimationFrame(resolve))
    })
    await page.evaluate(() => window.releaseIdle())
    second = await progress()
  }
  assert.ok(
    second.drawn > first.drawn && second.drawn < count,
    JSON.stringify(second),
  )
  // Disabling Mermaid mid-way cancels every diagram still waiting to draw.
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
  await page.locator('#addon-mermaid').click()
  await page.waitForFunction(
    () => !document.querySelector('#addon-mermaid').checked,
  )
  await page.locator('.mermaid-block').first().waitFor({ state: 'detached' })
  const draws = await page.evaluate(() => window.diagramDraws)
  await page.getByRole('button', { name: /^back to app$/i }).click()
  for (let turn = 0; turn < 3; turn++)
    await page.evaluate(() => {
      window.releaseIdle()
      return new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      )
    })
  assert.equal(await page.evaluate(() => window.diagramDraws), draws)
  assert.equal(await page.locator('.tiptap pre').count(), count)
})

test('codemirror: diagram work stays near the viewport and disabling it cancels pending drawings without changing source', {
  timeout: 90000,
}, async (t) => {
  t.formattedEngine = 'codemirror'
  const catalog = JSON.parse(
    await readFile('out/renderer/startup-bundle.json', 'utf8'),
  )
  const diagramChunk = catalog.find((chunk) =>
    chunk.modules.includes('src/addons/mermaid/render.ts'),
  )
  assert.ok(diagramChunk, 'the built catalog identifies the diagram scheduler')
  const count = 120
  const markdown = Array.from(
    { length: count },
    (_, index) =>
      `\`\`\`mermaid\nflowchart LR\n${Array.from(
        { length: 20 },
        (_, step) => `  N${step}[Probe ${index}-${step}] --> N${step + 1}`,
      ).join('\n')}\n\`\`\`\n`,
  ).join('\n')
  const { app, page } = await launchWithNote(
    t,
    'hibi-formatted-diagram-cancel-',
    { mermaid: true },
    markdown,
    (page) =>
      page.evaluate(() => {
        window.diagramDraws = 0
        new MutationObserver((records) => {
          for (const record of records)
            if (record.target.matches?.('.mermaid-diagram'))
              window.diagramDraws += [...record.addedNodes].filter(
                (node) => node.nodeName === 'svg',
              ).length
        }).observe(document.documentElement, { childList: true, subtree: true })
      }),
  )
  await waitForDocumentEditor(app, page)
  const rich = page.getByRole('textbox', {
    name: 'Document editor',
    exact: true,
  })
  // Read between fences, so the focused caret does not reveal the first diagram's source.
  await rich.evaluate((element) => {
    const view = element.cmTile.root.view
    const gap = view.state.doc.toString().indexOf('\n```\n') + 5
    view.dispatch({ selection: { anchor: gap } })
  })
  await page.locator('.rich-pane .mermaid-diagram > svg').first().waitFor()
  await page.waitForFunction(() => {
    const pane = document.querySelector('.rich-pane').getBoundingClientRect()
    const visible = [
      ...document.querySelectorAll('.rich-pane .mermaid-diagram'),
    ].filter((figure) => {
      const box = figure.getBoundingClientRect()
      return box.bottom > pane.top && box.top < pane.bottom
    })
    return visible.length > 0 && visible.every((figure) => figure.firstChild)
  })
  const progress = await page.evaluate(() => {
    const figures = [
      ...document.querySelectorAll('.rich-pane .mermaid-diagram'),
    ]
    const pane = document.querySelector('.rich-pane').getBoundingClientRect()
    const visible = figures.filter((figure) => {
      const box = figure.getBoundingClientRect()
      return box.bottom > pane.top && box.top < pane.bottom
    })
    return {
      mounted: figures.length,
      drawn: figures.filter((figure) => figure.firstChild).length,
      visible: visible.length,
      pending: visible.filter((figure) => !figure.firstChild).length,
    }
  })
  assert.ok(
    progress.drawn > 0 && progress.visible > 0,
    JSON.stringify(progress),
  )
  assert.equal(progress.pending, 0)
  // Offscreen source is virtualized rather than eagerly mounting every block.
  assert.ok(
    progress.mounted < count && progress.drawn < count,
    JSON.stringify(progress),
  )
  // Hold diagram work while editor layout and addon teardown keep running.
  await page.evaluate((diagramChunk) => {
    const nativeFrame = window.requestAnimationFrame.bind(window)
    window.nextDiagramFrame = () => new Promise(nativeFrame)
    window.heldFrames = []
    window.heldIdle = []
    window.holdNewDiagramWork = true
    const resumes = []
    for (const [request, cancel, queue] of [
      ['queueMicrotask', null, window.heldFrames],
      ['requestAnimationFrame', 'cancelAnimationFrame', window.heldFrames],
      ['requestIdleCallback', 'cancelIdleCallback', window.heldIdle],
    ]) {
      const nativeRequest = window[request].bind(window)
      const nativeCancel = cancel && window[cancel].bind(window)
      const callbacks = new Map()
      let holding = true
      let sequence = 1_000_000_000
      window[request] = (callback, ...options) => {
        const caller = new Error().stack.split('\n')[2]
        if (
          !holding ||
          !window.holdNewDiagramWork ||
          !caller?.includes(diagramChunk)
        )
          return nativeRequest(callback, ...options)
        const id = ++sequence
        const held = (value) => {
          if (!callbacks.delete(id)) return false
          callback.call(window, value)
          return true
        }
        held.options = options
        callbacks.set(id, held)
        queue.push(held)
        return id
      }
      if (cancel)
        window[cancel] = (id) => {
          const held = callbacks.get(id)
          if (!held) return nativeCancel(id)
          callbacks.delete(id)
          const index = queue.indexOf(held)
          if (index >= 0) queue.splice(index, 1)
          if (held.nativeId !== undefined) nativeCancel(held.nativeId)
        }
      resumes.push(() => {
        holding = false
        for (const held of queue.splice(0))
          held.nativeId = nativeRequest(held, ...held.options)
      })
    }
    window.resumeDiagramScheduling = () => {
      for (const resume of resumes) resume()
    }
    window.diagramControlTargets = []
    window.diagramInitialDrawn = [
      ...document.querySelectorAll('.rich-pane .mermaid-diagram'),
    ].filter((node) => node.querySelector('svg'))
    window.pendingDiagrams = (fresh = false) => {
      const pane = document.querySelector('.rich-pane').getBoundingClientRect()
      return [
        ...document.querySelectorAll('.rich-pane .mermaid-diagram'),
      ].filter((figure) => {
        const box = figure.getBoundingClientRect()
        return (
          !figure.firstChild &&
          box.width > 0 &&
          box.bottom > Math.max(0, pane.top) &&
          box.top < Math.min(innerHeight, pane.bottom) &&
          (!fresh || !window.diagramControlTargets.includes(figure))
        )
      })
    }
    window.watchPendingDiagrams = (fresh = false) => {
      window.diagramProbe?.observer.disconnect()
      const targets = window.pendingDiagrams(fresh)
      const probe = { targets, svgAdds: 0, controlled: 0, released: 0 }
      probe.observer = new MutationObserver((records) => {
        for (const record of records)
          probe.svgAdds += [...record.addedNodes].filter(
            (node) => node.nodeName === 'svg',
          ).length
      })
      for (const target of targets)
        probe.observer.observe(target, { childList: true })
      window.diagramProbe = probe
      return { pending: targets.length, held: window.heldFrames.length }
    }
    window.releaseDiagramFrame = async () => {
      const time = await window.nextDiagramFrame()
      const probe = window.diagramProbe
      const before =
        probe?.targets.filter((node) => node.querySelector('svg')).length ?? 0
      const callback = window.heldFrames.shift()
      const idle = !callback && window.heldIdle.shift()
      const released = callback
        ? callback(time)
        : (idle?.({ didTimeout: false, timeRemaining: () => 50 }) ?? false)
      if (probe && released) probe.released++
      // Keep real paints/resize delivery live while all newly queued app frames stay held.
      await window.nextDiagramFrame()
      if (probe)
        probe.controlled +=
          probe.targets.filter((node) => node.querySelector('svg')).length -
          before
    }
  }, diagramChunk.file)
  const diagnose = async (phase) =>
    t.diagnostic(
      'diagram frame fixture: ' +
        JSON.stringify(
          await page.evaluate((phase) => {
            const figures = [
              ...document.querySelectorAll('.rich-pane .mermaid-diagram'),
            ]
            return {
              phase,
              heldFrames: window.heldFrames.length,
              heldIdle: window.heldIdle.length,
              pending: window.pendingDiagrams(true).length,
              mounted: figures.length,
              drawn: figures.filter((node) => node.querySelector('svg')).length,
              controlTargets: window.diagramControlTargets.length,
              disabled:
                document.querySelector('#addon-mermaid')?.checked === false,
              samples: figures.slice(0, 8).map((node) => {
                const box = node.getBoundingClientRect()
                return {
                  empty: !node.firstChild,
                  width: box.width,
                  top: box.top,
                  bottom: box.bottom,
                }
              }),
            }
          }, phase),
        ),
    )
  const waitForPending = async (index, fresh = false) => {
    // One native editor scroll request into an existing gap; canonical text never changes.
    const gap = await rich.evaluate((element, index) => {
      const view = element.cmTile.root.view
      const closes = [...view.state.doc.toString().matchAll(/\n```\n/g)]
      const gap = closes[index - 1].index + 5
      view.dispatch({ selection: { anchor: gap }, scrollIntoView: true })
      return gap
    }, index)
    try {
      await waitForAsync(
        page,
        async ({ fresh, gap }) => {
          const ready = () => {
            const root = document.querySelector('.rich-pane .cm-content')
            const view = root.cmTile.root.view
            if (
              !view.visibleRanges.some(
                ({ from, to }) => from <= gap && to >= gap,
              )
            )
              return false
            // DOM reads do not flush CodeMirror's held measure callback.
            const { node } = view.domAtPos(gap)
            const line = (
              node.nodeType === 3 ? node.parentElement : node
            ).closest('.cm-line')
            const box = line?.getBoundingClientRect()
            const pane = root.closest('.rich-pane').getBoundingClientRect()
            return (
              box &&
              box.bottom > pane.top &&
              box.top < pane.bottom &&
              window.pendingDiagrams(fresh).length > 0 &&
              window.heldFrames.length > 0
            )
          }
          if (ready()) return true
          await window.releaseDiagramFrame()
          return ready()
        },
        { fresh, gap },
        { timeout: 15000 },
      )
    } catch (error) {
      await diagnose(fresh ? 'cancellation pending' : 'positive pending')
      throw error
    }
  }
  await waitForPending(80)
  const control = await page.evaluate(() => window.watchPendingDiagrams())
  assert.ok(control.pending > 0 && control.held > 0, JSON.stringify(control))
  await page.evaluate(() => {
    window.diagramControlTargets = window.diagramProbe.targets
  })
  let positive
  for (let turn = 0; turn < 20; turn++) {
    positive = await page.evaluate(async () => {
      await window.releaseDiagramFrame()
      const { released, controlled, svgAdds, targets } = window.diagramProbe
      return {
        released,
        controlled,
        svgAdds,
        pendingTargets: targets.length,
        held: window.heldFrames.length,
        heldIdle: window.heldIdle.length,
      }
    })
    if (positive.controlled > 0) break
  }
  t.diagnostic('diagram frame positive: ' + JSON.stringify(positive))
  assert.ok(
    positive.released > 0 && positive.controlled > 0 && positive.svgAdds > 0,
    'held scheduling work draws actual pending diagrams: ' +
      JSON.stringify(positive),
  )
  const afterFrames = await page.evaluate(
    () =>
      new Set([
        ...window.diagramInitialDrawn,
        ...window.diagramControlTargets.filter((node) =>
          node.querySelector('svg'),
        ),
      ]).size,
  )
  assert.ok(
    afterFrames > progress.drawn && afterFrames < count,
    String(afterFrames),
  )

  // Another untouched region must expose actual pending targets before disable.
  await waitForPending(40, true)
  const pending = await page.evaluate(() => window.watchPendingDiagrams(true))
  assert.ok(pending.pending > 0 && pending.held > 0, JSON.stringify(pending))
  t.diagnostic('diagram frame cancellation: ' + JSON.stringify(pending))
  const draws = await page.evaluate(() => window.diagramDraws)
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
  await page.locator('#addon-mermaid').click()
  await page.waitForFunction(
    () => !document.querySelector('#addon-mermaid').checked,
  )
  await page.getByRole('button', { name: /^back to app$/i }).click()
  await t.test('disabling cancels queued diagram work', async () => {
    try {
      // Polling cannot release the queued diagram work used by this proof.
      await waitForAsync(
        page,
        () => !document.querySelector('.rich-pane .mermaid-block'),
        undefined,
        { timeout: 15000 },
      )
      for (let turn = 0; turn < 3; turn++)
        await page.evaluate(async () => {
          const time = await window.nextDiagramFrame()
          for (const callback of window.heldFrames.splice(0)) callback(time)
          for (const callback of window.heldIdle.splice(0))
            callback({ didTimeout: false, timeRemaining: () => 50 })
          await window.nextDiagramFrame()
          await window.nextDiagramFrame()
        })
      assert.equal(await page.evaluate(() => window.diagramDraws), draws)
      assert.equal(await page.locator('.rich-pane .mermaid-block').count(), 0)
      assert.deepEqual(
        await page.evaluate(() => ({
          pendingTargets: window.diagramProbe.targets.length,
          svgAdds: window.diagramProbe.svgAdds,
          renderedAfterDisable: window.diagramProbe.targets.filter((node) =>
            node.querySelector('svg'),
          ).length,
        })),
        {
          pendingTargets: pending.pending,
          svgAdds: 0,
          renderedAfterDisable: 0,
        },
        'canceled targets stay empty even after their DOM detaches',
      )
    } catch (error) {
      await diagnose('disable detachment blocked')
      throw error
    } finally {
      // Restore scheduling even when cancellation itself fails.
      await page.evaluate(async () => {
        window.resumeDiagramScheduling()
        await window.nextDiagramFrame()
        await window.nextDiagramFrame()
      })
    }
  })
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    markdown,
  )
  await page.evaluate(() => window.diagramProbe.observer.disconnect())
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
  await page.waitForFunction(
    () => !document.querySelector('#addon-mermaid').checked,
  )
  await page.getByRole('button', { name: /^back to app$/i }).click()
})
