import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { build } from 'vite'
import { bundledColorschemes } from '../src/shared/color-palettes.ts'
import { COLOR_TOKENS } from '../src/shared/colorschemes.ts'
import { after, before, electron } from './electron.mjs'
import { selectFormattedEngine } from './formatted-engine.mjs'
import { pressShortcut } from './keyboard.mjs'

const image =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0MCIgaGVpZ2h0PSIyMCI+PHJlY3Qgd2lkdGg9IjQwIiBoZWlnaHQ9IjIwIiBmaWxsPSIjODg4Ii8+PC9zdmc+'

/**
 * Blocks both views render: tasks, entities, an alert, an HTML block and an
 * image. The image comes last: the rich editor draws an image alone in its
 * paragraph as a block without the paragraph's 1em bottom margin, while the
 * formatted view keeps the paragraph's spacing, as exports do.
 */
const note = `# Blocks parity

- [ ] buy milk
- [x] write the report
- [ ]

Fish &amp; chips &copy; 2026 for AT&amp;T.

> [!TIP] Remember
> Alerts keep their body text.

<div>
raw html block
</div>

Closing paragraph.

![a box](${image})
`

let app, folder, page, harness

const palette = (id) => {
  const scheme = bundledColorschemes.find((entry) => entry.id === id)
  return {
    id,
    appearance: scheme.appearance,
    css: `:root { color-scheme: ${scheme.appearance}; ${COLOR_TOKENS.map((key) => `--${key}: ${scheme.colors[key]};`).join(' ')} }`,
  }
}
const applyPalette = (target, scheme) =>
  target.evaluate(({ id, appearance, css }) => {
    let style = document.querySelector('style[data-test-palette]')
    if (!style) {
      style = document.createElement('style')
      style.dataset.testPalette = ''
      document.head.append(style)
    }
    style.textContent = css
    document.documentElement.dataset.colorscheme = id
    document.documentElement.dataset.appearance = appearance
  }, scheme)

before(
  async () => {
    folder = await mkdtemp(join(tmpdir(), 'hibi-formatted-blocks-preview-'))
    const bundle = join(folder, 'bundle')
    await build({
      configFile: false,
      logLevel: 'silent',
      define: { 'process.env.NODE_ENV': '"production"' },
      worker: { format: 'es' },
      build: {
        outDir: bundle,
        assetsInlineLimit: 0,
        lib: {
          entry: resolve('tests/fixtures/formatted-blocks.ts'),
          name: 'FormattedBlocksHarness',
          formats: ['iife'],
          fileName: () => 'harness.js',
          cssFileName: 'harness',
        },
      },
    })
    const html = join(bundle, 'index.html')
    await writeFile(
      html,
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="harness.css"></head><body><script src="harness.js"></script></body></html>',
    )
    const file = join(folder, 'notes', 'blocks.md')
    await mkdir(join(folder, 'notes'))
    await writeFile(file, note)
    app = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
    })
    page = await app.firstWindow()
    page.setDefaultTimeout(10000)
    await selectFormattedEngine(app, page, 'tiptap')
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      })
    }, file)
    await pressShortcut(
      app,
      process.platform === 'darwin' ? 'Meta+o' : 'Control+o',
    )
    await page.locator('.tiptap h1', { hasText: 'Blocks parity' }).waitFor()
    await page.locator('.tiptap .github-alert-title').waitFor()
    const size = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getContentSize(),
    )
    const next = app.waitForEvent('window')
    await app.evaluate(
      ({ BrowserWindow }, { path, size }) => {
        const window = new BrowserWindow({
          width: size[0],
          height: size[1],
          useContentSize: true,
          show: false,
          webPreferences: {
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            backgroundThrottling: false,
          },
        })
        void window.loadFile(path)
      },
      { path: html, size },
    )
    harness = await next
    harness.setDefaultTimeout(10000)
    await harness.waitForFunction(() =>
      Boolean(window.livePreview && window.formattedBlocks),
    )
  },
  { timeout: 120000 },
)

after(
  async () => {
    await app?.close()
    if (folder) await rm(folder, { recursive: true, force: true })
  },
  { timeout: 30000 },
)

/** Computed styles and the box of `text` for matching elements in one editor. */
const sample = (target, selectors) =>
  target.evaluate((selectors) => {
    const root = [...document.querySelectorAll('.rich-pane')].find((pane) =>
      pane
        .querySelector(':is(h1, .hibi-lp-h1)')
        ?.textContent.includes('Blocks parity'),
    )
    const pane = root.getBoundingClientRect()
    const relative = (box) => ({
      left: box.left - pane.left,
      top: box.top - pane.top,
      width: box.width,
      height: box.height,
    })
    const textBox = (element, text) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const index = node.data.indexOf(text)
        if (index < 0) continue
        const range = document.createRange()
        range.setStart(node, index)
        range.setEnd(node, index + text.length)
        return relative(range.getBoundingClientRect())
      }
      return null
    }
    return Object.fromEntries(
      Object.entries(selectors).map(([key, { selector, text }]) => {
        const element = [...root.querySelectorAll(selector)].find(
          (candidate) => !text || candidate.textContent.includes(text),
        )
        if (!element) return [key, null]
        const style = getComputedStyle(element)
        return [
          key,
          {
            fontFamily: style.fontFamily,
            fontSize: style.fontSize,
            fontWeight: style.fontWeight,
            fontStyle: style.fontStyle,
            color: style.color,
            letterSpacing: style.letterSpacing,
            box: text
              ? textBox(element, text)
              : relative(element.getBoundingClientRect()),
          },
        ]
      }),
    )
  }, selectors)

const rich = {
  title: { selector: '.tiptap h1', text: 'Blocks parity' },
  task: { selector: '.tiptap ul[data-type="taskList"] li p', text: 'buy milk' },
  done: { selector: '.tiptap ul[data-type="taskList"] li p', text: 'write' },
  box: { selector: '.tiptap input[type="checkbox"]' },
  entities: { selector: '.tiptap p', text: 'Fish' },
  afterEntity: { selector: '.tiptap p', text: 'chips' },
  lastEntity: { selector: '.tiptap p', text: 'AT&T' },
  alertTitle: { selector: '.tiptap .github-alert-title', text: 'Remember' },
  alertBody: { selector: '.tiptap .github-alert-body p', text: 'Alerts' },
  html: { selector: '.tiptap pre.hibi-literal-block code', text: '<div>' },
  image: { selector: '.tiptap .document-media img' },
  closing: { selector: '.tiptap p', text: 'Closing paragraph' },
}
const formatted = {
  title: { selector: '.hibi-lp-h1', text: 'Blocks parity' },
  task: { selector: '.cm-line', text: 'buy milk' },
  done: { selector: '.cm-line', text: 'write' },
  box: { selector: 'input.hibi-lp-task' },
  entities: { selector: '.cm-line', text: 'Fish' },
  afterEntity: { selector: '.cm-line', text: 'chips' },
  lastEntity: { selector: '.cm-line', text: 'AT' },
  alertTitle: { selector: '.hibi-lp-alert-title-text', text: 'Remember' },
  alertBody: { selector: '.cm-line', text: 'Alerts' },
  html: { selector: '.hibi-lp-codetext', text: '<div>' },
  image: { selector: '.document-media img' },
  closing: { selector: '.cm-line', text: 'Closing paragraph' },
}

test('tasks, entities, alerts, html blocks and images match the rich view in light and dark', {
  timeout: 90000,
}, async () => {
  const richPane = page.locator('.rich-pane', {
    has: page.locator('.tiptap h1', { hasText: 'Blocks parity' }),
  })
  const pane = await richPane.evaluate((element) => {
    const box = element.getBoundingClientRect()
    return { width: box.width, height: box.height }
  })
  await harness.evaluate(
    ({ doc, pane }) => window.livePreview.mount(doc, pane),
    { doc: note, pane },
  )
  await harness.locator('.document-media img[src]').waitFor()
  const report = []
  for (const id of ['hibi-light', 'hibi-dark']) {
    const scheme = palette(id)
    await applyPalette(page, scheme)
    await applyPalette(harness, scheme)
    await harness.evaluate(() => window.livePreview.settle())
    const before = await sample(page, rich)
    const after = await sample(harness, formatted)
    for (const key of Object.keys(rich)) {
      const a = before[key],
        b = after[key]
      assert.ok(a?.box && b?.box, `${key}: ${JSON.stringify({ a, b })}`)
      if (!['box', 'image', 'lastEntity'].includes(key))
        for (const property of [
          'fontFamily',
          'fontSize',
          'fontWeight',
          'fontStyle',
          'color',
          'letterSpacing',
        ])
          assert.equal(b[property], a[property], `${id} ${key} ${property}`)
      report.push({
        id,
        key,
        dx: Math.round((b.box.left - a.box.left) * 10) / 10,
        dy: Math.round((b.box.top - a.box.top) * 10) / 10,
      })
    }
    const images = [
      await richPane.screenshot({
        path: `test-results/formatted-blocks-rich-${id}.png`,
      }),
      await harness.locator('.rich-pane').screenshot({
        path: `test-results/formatted-blocks-formatted-${id}.png`,
      }),
    ].map((image) => image.toString('base64'))
    const difference = await app.evaluate(({ nativeImage }, images) => {
      const [a, b] = images.map((image) =>
        nativeImage.createFromBuffer(Buffer.from(image, 'base64')),
      )
      const size = a.getSize()
      const other = b.getSize()
      if (size.width !== other.width || size.height !== other.height) return 1
      const left = a.toBitmap(),
        right = b.toBitmap()
      let changed = 0
      for (let i = 0; i < left.length; i += 4)
        if (
          Math.abs(left[i] - right[i]) > 8 ||
          Math.abs(left[i + 1] - right[i + 1]) > 8 ||
          Math.abs(left[i + 2] - right[i + 2]) > 8
        )
          changed++
      return changed / (left.length / 4)
    }, images)
    report.push({ id, key: 'pixels', difference })
    assert.ok(
      difference < 0.002,
      `${id}: ${difference} ${JSON.stringify(report)}`,
    )
  }
  const offsets = report.filter(
    (entry) =>
      entry.key !== 'pixels' &&
      (Math.abs(entry.dx) > 1 || Math.abs(entry.dy) > 1),
  )
  console.log(JSON.stringify(report.filter((entry) => entry.key === 'pixels')))
  assert.deepEqual(offsets, [], JSON.stringify(report))
})

test('20,000 images resolve only the media in view', {
  timeout: 90000,
}, async () => {
  const doc = Array.from(
    { length: 20000 },
    (_, i) => `![image ${i}](image-${i}.png)`,
  ).join('\n\n')
  const opened = await harness.evaluate(async (doc) => {
    const { media } = window.formattedBlocks
    const preview = window.livePreview
    media.requests.length = 0
    await preview.mount(doc, { width: 800, height: 600 })
    await preview.settle()
    await new Promise((resolve) => setTimeout(resolve))
    const opened = media.requests.length
    media.requests.length = 0
    const view = preview.view()
    window.middle = view.state.doc.lineAt(Math.floor(doc.length / 2))
    preview.scrollTo(window.middle.from)
    return opened
  }, doc)
  // A far jump formats once the block scan and parse reach the new viewport.
  await harness.waitForFunction(
    () => {
      const view = window.livePreview.view()
      return [...document.querySelectorAll('.document-media img[src]')].some(
        (image) => Math.abs(view.posAtDOM(image) - window.middle.from) < 2000,
      )
    },
    undefined,
    { timeout: 60000 },
  )
  const counts = await harness.evaluate(async (opened) => {
    const { media } = window.formattedBlocks
    await window.livePreview.settle()
    return {
      opened,
      scrolled: media.requests.length,
      middle: Number(/\d+/.exec(window.middle.text)?.[0]),
      indices: media.requests.map((source) => Number(/\d+/.exec(source)[0])),
      shown: document.querySelectorAll('.document-media img[src]').length,
    }
  }, opened)
  console.log(JSON.stringify({ ...counts, indices: counts.indices.length }))
  assert.ok(counts.opened > 0 && counts.opened < 200, JSON.stringify(counts))
  assert.ok(
    counts.scrolled > 0 && counts.scrolled < 200,
    JSON.stringify(counts),
  )
  // Only media around the new viewport resolve after the jump.
  for (const index of counts.indices)
    assert.ok(
      Math.abs(index - counts.middle) < 200,
      `${index} ${counts.middle}`,
    )
})

test('drawn media resolve again for a new revision without being redrawn', {
  timeout: 60000,
}, async () => {
  const result = await harness.evaluate(async () => {
    const { media, setRevision } = window.formattedBlocks
    const preview = window.livePreview
    await preview.mount(
      Array.from({ length: 5 }, (_, i) => `![image ${i}](image-${i}.png)`).join(
        '\n\n',
      ),
      { width: 800, height: 600 },
    )
    await preview.settle()
    await new Promise((resolve) => setTimeout(resolve))
    const images = [...document.querySelectorAll('.document-media img')]
    media.requests.length = 0
    media.revisions.length = 0
    setRevision(preview.view(), 7)
    await new Promise((resolve) => setTimeout(resolve))
    await preview.settle()
    return {
      revisions: media.revisions,
      requests: media.requests.length,
      kept: images.filter((image) => image.isConnected).length,
      images: images.length,
    }
  })
  assert.equal(result.images, 5)
  assert.deepEqual(result.revisions, [7, 7, 7, 7, 7])
  assert.equal(result.kept, 5)
})

test('a definition read in idle time turns a reference in view into a footnote', {
  timeout: 60000,
}, async () => {
  const opened = await harness.evaluate(async () => {
    const { footnoteScan } = window.formattedBlocks
    window.fullSlice = footnoteScan.slice
    // Opening reads one slice; the definition at the end is read in idle time.
    footnoteScan.slice = 4096
    const body = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n')
    await window.livePreview.mount(
      `See[^far].\n\n${body}\n\n[^far]: The end.`,
      { width: 800, height: 600 },
    )
    return {
      refs: document.querySelectorAll('.hibi-lp-footnote-ref').length,
      first: document.querySelector('.cm-line').textContent,
    }
  })
  try {
    assert.deepEqual(opened, { refs: 0, first: 'See[^far].' })
    await harness.waitForFunction(
      () =>
        document.querySelector('.hibi-lp-footnote-ref')?.textContent === 'far',
      undefined,
      { timeout: 30000 },
    )
  } finally {
    await harness.evaluate(() => {
      window.formattedBlocks.footnoteScan.slice = window.fullSlice
    })
  }
})

test("a 50 MiB note reads no footnote definitions until a reference is in view, then its start and what each idle slice's time allows", {
  timeout: 120000,
}, async () => {
  const counts = await harness.evaluate(async () => {
    const { footnoteScan } = window.formattedBlocks
    const held = []
    const idle = window.requestIdleCallback
    // Idle callbacks run only when released, with a set time remaining.
    window.requestIdleCallback = (callback) => held.push(callback)
    const release = async (remaining) => {
      const parsed = footnoteScan.parsed
      for (const callback of held.splice(0))
        callback({ didTimeout: false, timeRemaining: () => remaining })
      await new Promise(requestAnimationFrame)
      return footnoteScan.parsed - parsed
    }
    try {
      const unit = '# heading\n\nparagraph words\n\n- one\n- two\n\n> quote\n\n'
      const body = unit.repeat(Math.ceil((50 * 1024 * 1024) / unit.length))
      footnoteScan.parsed = 0
      await window.livePreview.mount(body, { width: 800, height: 600 })
      const plain = [footnoteScan.parsed, await release(50), await release(50)]
      await window.livePreview.mount(
        `See[^far].\n\n${body}\n\n[^far]: The end.`,
        { width: 800, height: 600 },
      )
      const opened = footnoteScan.parsed
      const slices = [await release(10), await release(10), await release(10)]
      const { rate, slice, window: size } = footnoteScan
      return { plain, opened, slices, rate, slice, size }
    } finally {
      window.requestIdleCallback = idle
    }
  })
  // Before, opening read the first 1 MiB and idle slices read 1 MiB each,
  // whether or not a reference was in view.
  assert.deepEqual(counts.plain, [0, 0, 0], JSON.stringify(counts))
  // A reference in view reads the note's start before the frame paints.
  assert.ok(
    counts.opened > 0 && counts.opened <= counts.slice / 16 + counts.size,
    JSON.stringify(counts),
  )
  // The first slice reads what 10 ms allow at the starting rate, up to the
  // end of the window it is in; later ones at the rate they measured.
  const [first, ...rest] = counts.slices
  assert.ok(
    first > 0 && first <= 10 * counts.rate + counts.size,
    JSON.stringify(counts),
  )
  for (const read of rest)
    assert.ok(
      read > 0 && read <= counts.slice + counts.size,
      JSON.stringify(counts),
    )
})

test('a footnote reference in a table cell resolves once its definition is read, in the cell and its editor', {
  timeout: 60000,
}, async () => {
  await harness.evaluate(() =>
    window.livePreview.mount(
      '| a | b |\n| --- | --- |\n| see[^cell] | x |\n\n[^cell]: In a table.\n',
      { width: 800, height: 600 },
      { editable: true },
    ),
  )
  // Before, a table's reference never started reading, and cells resolved
  // labels against a state without the index.
  await harness.waitForFunction(
    () =>
      document.querySelector('.hibi-lp-table .hibi-lp-footnote-ref')
        ?.textContent === 'cell',
    undefined,
    { timeout: 10000 },
  )
  await harness.locator('.hibi-lp-table td', { hasText: 'see' }).click()
  await harness.waitForFunction(
    () =>
      document.querySelector('.hibi-lp-cell-editor .hibi-lp-footnote-ref')
        ?.textContent === 'cell',
    undefined,
    { timeout: 10000 },
  )
})

test('footnote refresh keeps a focused table editor, its selection and undo history', {
  timeout: 60000,
}, async () => {
  const cdp = await harness.context().newCDPSession(harness)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await harness.evaluate(() => {
    window.savedIdle = window.requestIdleCallback
    window.savedCancelIdle = window.cancelIdleCallback
    window.requestIdleCallback = () => 1
    window.cancelIdleCallback = () => {}
  })
  try {
    for (const tag of ['th', 'td']) {
      await harness.evaluate(async () => {
        const { history, StateEffect } = window.formattedBlocks
        await window.livePreview.mount(
          '| read[^far] | header |\n| --- | --- |\n| read[^far] | other[^far] |\n\n' +
            'padding words\n\n'.repeat(10000) +
            '\n[^far]: end',
          { width: 800, height: 600 },
          // Finish syntax while idle callbacks are held for the definition reader.
          { editable: true, slice: 1000 },
        )
        window.livePreview.view().dispatch({
          effects: StateEffect.appendConfig.of(history()),
        })
      })
      await harness.locator(`.hibi-lp-table ${tag}`).first().click()
      const result = await harness.evaluate(async () => {
        const preview = window.livePreview
        const view = preview.view()
        const {
          readDefinitions,
          definitionsRead,
          formattedRefresh,
          undo,
          redo,
        } = window.formattedBlocks
        const dom = document.querySelector('.hibi-lp-cell-editor')
        const editor = view.constructor.findFromDOM(dom)
        const original = view.state.doc.toString()
        const at = editor.state.doc.toString().indexOf('read') + 1
        editor.dispatch({
          changes: { from: at, insert: '🌿' },
          selection: { anchor: at, head: at + 2 },
          userEvent: 'input.type',
        })
        editor.focus()
        const edited = view.state.doc.toString()
        const selection = editor.state.selection
        const retained = () =>
          dom.isConnected &&
          editor.hasFocus &&
          editor === view.constructor.findFromDOM(dom)
        const read = () => {
          for (let slices = 0; !definitionsRead(view.state); slices++) {
            if (slices > 100)
              throw new Error('Footnote reading did not finish.')
            view.dispatch({ effects: readDefinitions.of(65536) })
          }
          view.dispatch({ effects: formattedRefresh.of(null) })
        }
        read()
        const resolved = {
          focused: retained(),
          selection: editor.state.selection.eq(selection),
          source: view.state.doc.toString() === edited,
          references: document.querySelectorAll(
            '.hibi-lp-table .hibi-lp-footnote-ref',
          ).length,
          activeReference: dom.querySelector('.hibi-lp-footnote-ref')
            ?.textContent,
        }
        const undid = undo(view)
        await preview.settle()
        const undoSource = view.state.doc.toString() === original
        const redid = redo(view)
        await preview.settle()
        const redoSource = view.state.doc.toString() === edited
        const beforeRemoval = editor.state.selection
        const start = edited.lastIndexOf('[^far]:')
        view.dispatch({ changes: { from: start, to: view.state.doc.length } })
        read()
        const removed = {
          focused: retained(),
          selection: editor.state.selection.eq(beforeRemoval),
          references: document.querySelectorAll(
            '.hibi-lp-table .hibi-lp-footnote-ref',
          ).length,
        }
        view.dispatch({ changes: { from: start, insert: edited.slice(start) } })
        read()
        return {
          resolved,
          undid,
          undoSource,
          redid,
          redoSource,
          removed,
          restored: retained() && view.state.doc.toString() === edited,
          restoredReferences: document.querySelectorAll(
            '.hibi-lp-table .hibi-lp-footnote-ref',
          ).length,
        }
      })
      assert.deepEqual(
        result,
        {
          resolved: {
            focused: true,
            selection: true,
            source: true,
            references: 3,
            activeReference: 'far',
          },
          undid: true,
          undoSource: true,
          redid: true,
          redoSource: true,
          removed: { focused: true, selection: true, references: 0 },
          restored: true,
          restoredReferences: 3,
        },
        tag,
      )
      await harness.evaluate(() => {
        const view = window.livePreview.view()
        const { from, to } = view.state.selection.main
        window.expectedAfterKey =
          view.state.sliceDoc(0, from) + 'z' + view.state.sliceDoc(to)
      })
      await harness.keyboard.press('z')
      assert.equal(
        await harness.evaluate(
          () =>
            window.livePreview.view().state.doc.toString() ===
            window.expectedAfterKey,
        ),
        true,
        `${tag}: the next key reaches the cell`,
      )
    }
  } finally {
    await harness.evaluate(async () => {
      await window.livePreview.mount('')
      window.requestIdleCallback = window.savedIdle
      window.cancelIdleCallback = window.savedCancelIdle
    })
    await cdp.detach()
  }
})

test('toggling one of 20,000 tasks is one edit that redraws one checkbox', {
  timeout: 90000,
}, async () => {
  // Lists of 100 tasks: an edit in one 20,000-item list reparses the window
  // around the viewport, covered by the next test.
  const doc = Array.from(
    { length: 200 },
    (_, list) =>
      `## List ${list}\n\n${Array.from({ length: 100 }, (_, i) => `- [ ] task ${list * 100 + i}`).join('\n')}`,
  ).join('\n\n')
  await harness.evaluate(async (doc) => {
    const preview = window.livePreview
    await preview.mount(doc, { width: 800, height: 600 })
    preview.scrollTo(doc.indexOf('- [ ] task 10005'))
  }, doc)
  await harness.waitForFunction(
    () =>
      [...document.querySelectorAll('input.hibi-lp-task')].some(
        (box) =>
          box.getAttribute('aria-label') ===
          'Task item checkbox for task 10005',
      ),
    undefined,
    { timeout: 60000 },
  )
  const result = await harness.evaluate(async () => {
    const preview = window.livePreview
    const { TaskWidget } = window.formattedBlocks
    const view = preview.view()
    await preview.settle()
    const counts = { created: 0, updated: 0 }
    const proto = TaskWidget.prototype
    const toDOM = proto.toDOM,
      updateDOM = proto.updateDOM
    proto.toDOM = function (...args) {
      counts.created++
      return toDOM.apply(this, args)
    }
    proto.updateDOM = function (...args) {
      counts.updated++
      return updateDOM.apply(this, args)
    }
    const box = [...document.querySelectorAll('input.hibi-lp-task')].find(
      (candidate) =>
        candidate.getAttribute('aria-label') ===
        'Task item checkbox for task 10005',
    )
    const at = view.posAtDOM(box)
    preview.reset()
    // The edit the checkbox makes, dispatched past the read-only harness.
    view.dispatch({
      changes: { from: at + 1, to: at + 2, insert: 'x' },
      userEvent: 'input.toggle',
    })
    await preview.settle()
    proto.toDOM = toDOM
    proto.updateDOM = updateDOM
    return {
      ...counts,
      probe: { ...preview.probe },
      line: view.state.doc.lineAt(at).text,
      checked: box.checked,
      attached: box.isConnected,
      boxes: document.querySelectorAll('input.hibi-lp-task').length,
    }
  })
  console.log(JSON.stringify(result))
  assert.equal(result.line, '- [x] task 10005')
  // The toggled checkbox updates in place; the other visible ones keep their DOM.
  assert.ok(result.attached && result.checked, JSON.stringify(result))
  assert.equal(result.created, 0)
  assert.equal(result.updated, 1)
  assert.ok(result.boxes > 10 && result.boxes < 400, JSON.stringify(result))
  assert.ok(result.probe.parsedChunks <= 2, JSON.stringify(result.probe))
  assert.ok(result.probe.parsedUnits <= 4 * 4096, JSON.stringify(result.probe))
})

test('toggling a task in one 20,000-item list keeps every checkbox in view', {
  timeout: 120000,
}, async () => {
  const doc = Array.from({ length: 20000 }, (_, i) => `- [ ] task ${i}`).join(
    '\n',
  )
  await harness.evaluate(async (doc) => {
    const preview = window.livePreview
    await preview.mount(doc, { width: 800, height: 600 })
    preview.scrollTo(preview.view().state.doc.line(10000).from)
  }, doc)
  await harness.waitForFunction(
    () =>
      [...document.querySelectorAll('input.hibi-lp-task')].some(
        (box) =>
          box.getAttribute('aria-label') ===
          'Task item checkbox for task 10005',
      ),
    undefined,
    { timeout: 60000 },
  )
  const sync = await harness.evaluate(async () => {
    const preview = window.livePreview
    const view = preview.view()
    const { TaskWidget } = window.formattedBlocks
    await preview.settle()
    window.counts = { created: 0, updated: 0 }
    const proto = TaskWidget.prototype
    window.restore = [proto.toDOM, proto.updateDOM]
    const [toDOM, updateDOM] = window.restore
    proto.toDOM = function (...args) {
      window.counts.created++
      return toDOM.apply(this, args)
    }
    proto.updateDOM = function (...args) {
      window.counts.updated++
      return updateDOM.apply(this, args)
    }
    window.boxes = [...document.querySelectorAll('input.hibi-lp-task')]
    window.toggled = window.boxes.find(
      (box) =>
        box.getAttribute('aria-label') === 'Task item checkbox for task 10005',
    )
    const at = view.posAtDOM(window.toggled)
    view.dispatch({
      changes: { from: at + 1, to: at + 2, insert: 'x' },
      userEvent: 'input.toggle',
    })
    return {
      boxes: window.boxes.length,
      kept: window.boxes.filter((box) => box.isConnected).length,
    }
  })
  // The edit's reparse keeps the window's checkboxes until it lands.
  assert.equal(sync.kept, sync.boxes, JSON.stringify(sync))
  await harness.waitForFunction(() => window.toggled.checked, undefined, {
    timeout: 60000,
  })
  const settled = await harness.evaluate(() => {
    const { TaskWidget } = window.formattedBlocks
    ;[TaskWidget.prototype.toDOM, TaskWidget.prototype.updateDOM] =
      window.restore
    return {
      ...window.counts,
      kept: window.boxes.filter((box) => box.isConnected).length,
      boxes: window.boxes.length,
    }
  })
  assert.equal(settled.kept, settled.boxes, JSON.stringify(settled))
  assert.equal(settled.created, 0, JSON.stringify(settled))
  assert.equal(settled.updated, 1, JSON.stringify(settled))
})
