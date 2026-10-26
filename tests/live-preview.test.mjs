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

const note = `# Formatted view parity

A paragraph with **bold**, *italic*, ~~struck~~, \`inline code\` and a [link](https://example.com/).
It continues on a second source line.

## Lists

- first item
- second item with *emphasis*
  - nested item
- third item

1. one
2. two
3. three

> A quote with **strong** text
> spanning two lines.

\`\`\`js
const answer = 42
function twice(value) {
  return value * 2
}
\`\`\`

### Third level

Closing paragraph.

---

After the rule.
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
    folder = await mkdtemp(join(tmpdir(), 'hibi-live-preview-'))
    const bundle = join(folder, 'bundle')
    await build({
      configFile: false,
      logLevel: 'silent',
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        outDir: bundle,
        assetsInlineLimit: 0,
        lib: {
          entry: resolve('tests/fixtures/live-preview.ts'),
          name: 'LivePreviewHarness',
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
    const file = join(folder, 'notes', 'parity.md')
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
    await page
      .locator('.tiptap h1', { hasText: 'Formatted view parity' })
      .waitFor()
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
    await harness.waitForFunction(() => Boolean(window.livePreview))
  },
  { timeout: 90000 },
)
after(
  async () => {
    await app?.close()
    if (folder) await rm(folder, { recursive: true, force: true })
  },
  { timeout: 30000 },
)

/** Computed styles and text geometry for matching elements in both editors. */
const sample = (target, selectors) =>
  target.evaluate((selectors) => {
    const pane = document.querySelector('.rich-pane').getBoundingClientRect()
    const textBox = (element, text) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const index = node.data.indexOf(text)
        if (index < 0) continue
        const range = document.createRange()
        range.setStart(node, index)
        range.setEnd(node, index + text.length)
        const box = range.getBoundingClientRect()
        return {
          left: box.left - pane.left,
          top: box.top - pane.top,
          height: box.height,
        }
      }
      return null
    }
    return Object.fromEntries(
      Object.entries(selectors).map(([key, { selector, text }]) => {
        const element = [...document.querySelectorAll(selector)].find(
          (candidate) => candidate.textContent.includes(text),
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
            backgroundColor: style.backgroundColor,
            textDecorationLine: style.textDecorationLine,
            letterSpacing: style.letterSpacing,
            // Highlighting splits text into spans; the first word is one text node.
            box: textBox(element, text.split(' ')[0]),
          },
        ]
      }),
    )
  }, selectors)

const rich = {
  title: { selector: '.tiptap h1', text: 'Formatted view parity' },
  paragraph: { selector: '.tiptap p', text: 'A paragraph with' },
  second: { selector: '.tiptap p', text: 'It continues' },
  bold: { selector: '.tiptap strong', text: 'bold' },
  italic: { selector: '.tiptap em', text: 'italic' },
  struck: { selector: '.tiptap s', text: 'struck' },
  code: { selector: '.tiptap p code', text: 'inline code' },
  link: { selector: '.tiptap a', text: 'link' },
  lists: { selector: '.tiptap h2', text: 'Lists' },
  item: { selector: '.tiptap li', text: 'first item' },
  nested: { selector: '.tiptap li li', text: 'nested item' },
  ordered: { selector: '.tiptap ol li', text: 'two' },
  quote: { selector: '.tiptap blockquote p', text: 'A quote' },
  block: { selector: '.tiptap pre code', text: 'const answer' },
  third: { selector: '.tiptap h3', text: 'Third level' },
  closing: { selector: '.tiptap p', text: 'Closing paragraph' },
  after: { selector: '.tiptap p', text: 'After the rule' },
}
const formatted = {
  title: { selector: '.hibi-lp-h1', text: 'Formatted view parity' },
  paragraph: { selector: '.cm-line', text: 'A paragraph with' },
  second: { selector: '.cm-line', text: 'It continues' },
  bold: { selector: '.hibi-lp-strong', text: 'bold' },
  italic: { selector: '.hibi-lp-em', text: 'italic' },
  struck: { selector: '.hibi-lp-strike', text: 'struck' },
  code: { selector: '.hibi-lp-code', text: 'inline code' },
  link: { selector: '.hibi-lp-link', text: 'link' },
  lists: { selector: '.hibi-lp-h2', text: 'Lists' },
  item: { selector: '.hibi-lp-list', text: 'first item' },
  nested: { selector: '.hibi-lp-list', text: 'nested item' },
  ordered: { selector: '.hibi-lp-list-ordered', text: 'two' },
  quote: { selector: '.hibi-lp-quote', text: 'A quote' },
  block: { selector: '.hibi-lp-codetext', text: 'const answer' },
  third: { selector: '.hibi-lp-h3', text: 'Third level' },
  closing: { selector: '.cm-line', text: 'Closing paragraph' },
  after: { selector: '.cm-line', text: 'After the rule' },
}

test('the codemirror formatted view matches the rich view in light and dark', {
  timeout: 60000,
}, async () => {
  const pane = await page.locator('.rich-pane').evaluate((element) => {
    const box = element.getBoundingClientRect()
    return { width: box.width, height: box.height }
  })
  await harness.evaluate(
    ({ note, pane }) => window.livePreview.mount(note, pane),
    { note, pane },
  )
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
      assert.ok(a && b, `${key}: ${JSON.stringify({ a, b })}`)
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
      await page
        .locator('.rich-pane')
        .screenshot({ path: `test-results/live-preview-rich-${id}.png` }),
      await harness
        .locator('.rich-pane')
        .screenshot({ path: `test-results/live-preview-formatted-${id}.png` }),
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
    // The same text at the same positions renders the same pixels.
    assert.ok(difference < 0.002, `${id}: ${difference}`)
  }
  // Text positions match the rich view within a pixel.
  const offsets = report.filter(
    (entry) =>
      entry.key !== 'pixels' &&
      (Math.abs(entry.dx) > 1 || Math.abs(entry.dy) > 1),
  )
  console.log(JSON.stringify(report.filter((entry) => entry.key === 'pixels')))
  assert.deepEqual(offsets, [], JSON.stringify(report))
})

test('a 50 MiB note renders and edits with viewport-bounded work', {
  timeout: 120000,
}, async () => {
  const opened = await harness.evaluate(async () => {
    const unit = [
      '# Heading one\n\n',
      'Plain paragraph text with **bold words**, *emphasis*, `code`, and a [link](https://example.com/path) inside it.\n\n',
      '- list item one with *style*\n- list item two\n  - nested item\n\n',
      '> a quote line with **strong** text\n\n',
      '```js\nconst x = 1\n```\n\n',
      '1. numbered\n2. numbered two\n\n',
    ].join('')
    const preview = window.livePreview
    preview.reset()
    await preview.mount(
      unit.repeat(Math.ceil((50 * 1024 * 1024) / unit.length)),
    )
    const view = preview.view()
    const result = {
      ...preview.probe,
      length: view.state.doc.length,
      lines: document.querySelectorAll('.cm-line').length,
    }
    // Jump to the middle: block scans reach it and only nearby chunks are parsed.
    window.middle = view.state.doc.lineAt(
      Math.floor(view.state.doc.length / 2),
    ).from
    view.dispatch({
      selection: { anchor: window.middle },
      scrollIntoView: true,
    })
    return result
  })
  assert.ok(opened.length > 50 * 1024 * 1024)
  assert.ok(opened.parsedUnits < 64 * 1024, JSON.stringify(opened))
  assert.ok(opened.lines < 400, JSON.stringify(opened))
  await harness.waitForFunction(
    () => {
      const view = window.livePreview.view()
      return [...document.querySelectorAll('.hibi-lp-heading')].some(
        (element) => Math.abs(view.posAtDOM(element) - window.middle) < 20000,
      )
    },
    undefined,
    { timeout: 90000 },
  )
  const edits = await harness.evaluate(async () => {
    const preview = window.livePreview
    const view = preview.view()
    await preview.settle()
    const edits = []
    for (let key = 0; key < 10; key++) {
      preview.reset()
      const at = view.state.selection.main.head
      view.dispatch({
        changes: { from: at, insert: 'x' },
        selection: { anchor: at + 1 },
      })
      await preview.settle()
      edits.push({
        ...preview.probe,
        lines: document.querySelectorAll('.cm-line').length,
      })
    }
    return edits
  })
  console.log(JSON.stringify({ opened, edits: edits.slice(0, 3) }))
  for (const edit of edits) {
    assert.ok(edit.parsedChunks <= 2, JSON.stringify(edit))
    assert.ok(edit.parsedUnits <= 4 * 4096, JSON.stringify(edit))
    assert.ok(edit.builtGroups <= 3, JSON.stringify(edit))
    assert.ok(edit.lines < 400, JSON.stringify(edit))
  }
})
