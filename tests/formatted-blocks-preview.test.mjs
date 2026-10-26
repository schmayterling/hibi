import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test, { after, before } from 'node:test'
import { build } from 'vite'
import { bundledColorschemes } from '../src/shared/color-palettes.ts'
import { COLOR_TOKENS } from '../src/shared/colorschemes.ts'
import { electron, waitForDocumentEditor } from './electron.mjs'
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
      '<!doctype html><html lang="en"><head><link rel="stylesheet" href="harness.css"></head><body><script src="harness.js"></script></body></html>',
    )
    const file = join(folder, 'notes', 'blocks.md')
    await mkdir(join(folder, 'notes'))
    await writeFile(file, note)
    app = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
    })
    page = await app.firstWindow()
    page.setDefaultTimeout(10000)
    await waitForDocumentEditor(app, page)
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

test('toggling one of 20,000 tasks is one edit that redraws one checkbox', {
  timeout: 90000,
}, async () => {
  // Lists of 100 tasks: a single 20,000-item list is one giant block, which
  // the engine still redraws whole after each edit.
  const doc = Array.from(
    { length: 200 },
    (_, list) =>
      `## List ${list}\n\n${Array.from({ length: 100 }, (_, i) => `- [ ] task ${list * 100 + i}`).join('\n')}`,
  ).join('\n\n')
  const result = await harness.evaluate(async (doc) => {
    const preview = window.livePreview
    const { TaskWidget } = window.formattedBlocks
    await preview.mount(doc, { width: 800, height: 600 })
    const view = preview.view()
    const line = view.state.doc.toString().indexOf('- [ ] task 10005')
    preview.scrollTo(line)
    await preview.settle()
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
  }, doc)
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
