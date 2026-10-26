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

/** Blocks inside quotes and lists: quote > code, list > code, quote > list, list > quote > code. */
const nested = `# Nested blocks

> ~~~js
> const nested = 42
> ~~~

- parent

  ~~~js
  const child = 7
  ~~~

> - quoted item
> - another item

- item with a quote

  > ~~~
  > const deep = 1
  > ~~~

> quoted words
> ***
> after the quoted rule

words before a rule
***
words after a rule

closing paragraph.
`

/** List markers alone on their lines: the rich view draws them beside the item's first block. */
const markers = `# Marker lines

-
  first under its marker
- second item

1.
   one under its marker
2. two

> -
>   quoted under its marker
> - quoted second

> 1.
>    quoted one under its marker
> 2. quoted two

> > -
> >   deep under its marker
> > - deep second

closing paragraph.
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
    await writeFile(join(folder, 'notes', 'nested.md'), nested)
    await writeFile(join(folder, 'notes', 'markers.md'), markers)
    app = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
    })
    page = await app.firstWindow()
    page.setDefaultTimeout(10000)
    await waitForDocumentEditor(app, page)
    await open(file, 'Formatted view parity')
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
/** Open a note in the app's rich view. */
async function open(file, title) {
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [path],
    })
  }, file)
  if (!harness)
    await pressShortcut(
      app,
      process.platform === 'darwin' ? 'Meta+o' : 'Control+o',
    )
  // The shortcut goes to the app window, not the harness window opened after it.
  else
    await app.evaluate(
      ({ BrowserWindow }, modifiers) => {
        const contents = BrowserWindow.getAllWindows().find(
          (window) =>
            !window.webContents.getURL().endsWith('/bundle/index.html'),
        ).webContents
        for (const type of ['keyDown', 'keyUp'])
          contents.sendInputEvent({ type, keyCode: 'O', modifiers })
      },
      [process.platform === 'darwin' ? 'meta' : 'control'],
    )
  await page.locator('.tiptap h1', { hasText: title }).waitFor()
}

after(
  async () => {
    await app?.close()
    if (folder) await rm(folder, { recursive: true, force: true })
  },
  { timeout: 30000 },
)

/** Computed styles and text geometry for matching elements in both editors. */
const sample = (target, selectors, title) =>
  target.evaluate(
    ({ selectors, title }) => {
      const root = [...document.querySelectorAll('.rich-pane')].find((pane) =>
        pane.querySelector(':is(h1, .hibi-lp-h1)')?.textContent.includes(title),
      )
      const pane = root.getBoundingClientRect()
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
          const element = [...root.querySelectorAll(selector)].find(
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
    },
    { selectors, title },
  )

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
  item: { selector: '.hibi-lp-list-item', text: 'first item' },
  nested: { selector: '.hibi-lp-list-item', text: 'nested item' },
  ordered: { selector: '.hibi-lp-list-ordered', text: 'two' },
  quote: { selector: '.hibi-lp-quote', text: 'A quote' },
  block: { selector: '.hibi-lp-codetext', text: 'const answer' },
  third: { selector: '.hibi-lp-h3', text: 'Third level' },
  closing: { selector: '.cm-line', text: 'Closing paragraph' },
  after: { selector: '.cm-line', text: 'After the rule' },
}

/** Compare a note in the rich view and the formatted view: styles, text positions and pixels. */
async function parity(title, doc, rich, formatted, name) {
  const richPane = page.locator('.rich-pane', {
    has: page.locator('.tiptap h1', { hasText: title }),
  })
  const pane = await richPane.evaluate((element) => {
    const box = element.getBoundingClientRect()
    return { width: box.width, height: box.height }
  })
  await harness.evaluate(
    ({ doc, pane }) => window.livePreview.mount(doc, pane),
    { doc, pane },
  )
  const report = []
  for (const id of ['hibi-light', 'hibi-dark']) {
    const scheme = palette(id)
    await applyPalette(page, scheme)
    await applyPalette(harness, scheme)
    await harness.evaluate(() => window.livePreview.settle())
    const before = await sample(page, rich, title)
    const after = await sample(harness, formatted, title)
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
      await richPane.screenshot({
        path: `test-results/live-preview-${name}-rich-${id}.png`,
      }),
      await harness.locator('.rich-pane').screenshot({
        path: `test-results/live-preview-${name}-formatted-${id}.png`,
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
}

test('the codemirror formatted view matches the rich view in light and dark', {
  timeout: 60000,
}, async () => {
  await parity('Formatted view parity', note, rich, formatted, 'parity')
})

test('blocks inside quotes and lists match the rich view in light and dark', {
  timeout: 60000,
}, async () => {
  await open(join(folder, 'notes', 'nested.md'), 'Nested blocks')
  await parity(
    'Nested blocks',
    nested,
    {
      title: { selector: '.tiptap h1', text: 'Nested blocks' },
      quotedCode: {
        selector: '.tiptap blockquote pre code',
        text: 'const nested',
      },
      parent: { selector: '.tiptap li p', text: 'parent' },
      childCode: { selector: '.tiptap li pre code', text: 'const child' },
      quotedItem: { selector: '.tiptap blockquote li', text: 'quoted item' },
      anotherItem: { selector: '.tiptap blockquote li', text: 'another item' },
      quoteItem: { selector: '.tiptap li p', text: 'item with a quote' },
      deepCode: {
        selector: '.tiptap li blockquote pre code',
        text: 'const deep',
      },
      quotedRule: {
        selector: '.tiptap blockquote p',
        text: 'after the quoted rule',
      },
      rule: { selector: '.tiptap p', text: 'words after a rule' },
      closing: { selector: '.tiptap p', text: 'closing paragraph' },
    },
    {
      title: { selector: '.hibi-lp-h1', text: 'Nested blocks' },
      quotedCode: { selector: '.hibi-lp-codetext', text: 'const nested' },
      parent: { selector: '.hibi-lp-list-item', text: 'parent' },
      childCode: { selector: '.hibi-lp-codetext', text: 'const child' },
      quotedItem: { selector: '.hibi-lp-list-item', text: 'quoted item' },
      anotherItem: { selector: '.hibi-lp-list-item', text: 'another item' },
      quoteItem: { selector: '.hibi-lp-list-item', text: 'item with a quote' },
      deepCode: { selector: '.hibi-lp-codetext', text: 'const deep' },
      quotedRule: { selector: '.hibi-lp-quote', text: 'after the quoted rule' },
      rule: { selector: '.cm-line', text: 'words after a rule' },
      closing: { selector: '.cm-line', text: 'closing paragraph' },
    },
    'nested',
  )
  // Quote markers inside code are hidden like the rich view's.
  const code = await harness.evaluate(() =>
    [...document.querySelectorAll('.hibi-lp-codeblock')].map(
      (line) => line.innerText,
    ),
  )
  assert.deepEqual(code, [
    'const nested = 42',
    'const child = 7',
    'const deep = 1',
  ])
})

test('list markers alone on their lines sit beside the item text as in the rich view', {
  timeout: 60000,
}, async () => {
  await open(join(folder, 'notes', 'markers.md'), 'Marker lines')
  await parity(
    'Marker lines',
    markers,
    {
      title: { selector: '.tiptap h1', text: 'Marker lines' },
      first: { selector: '.tiptap li', text: 'first under its marker' },
      second: { selector: '.tiptap li', text: 'second item' },
      one: { selector: '.tiptap ol li', text: 'one under its marker' },
      two: { selector: '.tiptap ol li', text: 'two' },
      quoted: {
        selector: '.tiptap blockquote li',
        text: 'quoted under its marker',
      },
      quotedSecond: {
        selector: '.tiptap blockquote li',
        text: 'quoted second',
      },
      quotedOne: {
        selector: '.tiptap blockquote ol li',
        text: 'quoted one under its marker',
      },
      quotedTwo: { selector: '.tiptap blockquote ol li', text: 'quoted two' },
      deep: {
        selector: '.tiptap blockquote blockquote li',
        text: 'deep under its marker',
      },
      deepSecond: {
        selector: '.tiptap blockquote blockquote li',
        text: 'deep second',
      },
      closing: { selector: '.tiptap p', text: 'closing paragraph' },
    },
    {
      title: { selector: '.hibi-lp-h1', text: 'Marker lines' },
      first: { selector: '.hibi-lp-list-item', text: 'first under its marker' },
      second: { selector: '.hibi-lp-list-item', text: 'second item' },
      one: { selector: '.hibi-lp-list-ordered', text: 'one under its marker' },
      two: { selector: '.hibi-lp-list-ordered', text: 'two' },
      quoted: {
        selector: '.hibi-lp-list-item',
        text: 'quoted under its marker',
      },
      quotedSecond: { selector: '.hibi-lp-list-item', text: 'quoted second' },
      quotedOne: {
        selector: '.hibi-lp-list-ordered',
        text: 'quoted one under its marker',
      },
      quotedTwo: { selector: '.hibi-lp-list-ordered', text: 'quoted two' },
      deep: { selector: '.hibi-lp-list-item', text: 'deep under its marker' },
      deepSecond: { selector: '.hibi-lp-list-item', text: 'deep second' },
      closing: { selector: '.cm-line', text: 'closing paragraph' },
    },
    'markers',
  )
})

test('typing beside a multi-line link destination edits the text', {
  timeout: 60000,
}, async () => {
  const errors = []
  const listen = (error) => errors.push(error.message)
  harness.on('pageerror', listen)
  const session = await harness.context().newCDPSession(harness)
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const typed = []
  for (const [doc, at] of [
    ['[label](\nhttps://example.com/\n)', 31],
    ['[label](\nhttps://example.com/\n)\n\nend', 31],
  ]) {
    await harness.evaluate(
      async ({ doc, at }) => {
        await window.livePreview.mount(doc, undefined, { editable: true })
        const view = window.livePreview.view()
        view.focus()
        view.dispatch({ selection: { anchor: at } })
        await window.livePreview.settle()
      },
      { doc, at },
    )
    await harness.keyboard.type('X')
    typed.push(
      await harness.evaluate(async () => {
        await window.livePreview.settle()
        return window.livePreview.view().state.doc.toString()
      }),
    )
  }
  harness.off('pageerror', listen)
  // Before, the input showed in the page but threw on mapping, leaving the
  // text unchanged, or landed in the paragraph after the link.
  assert.deepEqual(typed, [
    '[label](\nhttps://example.com/\n)X',
    '[label](\nhttps://example.com/\n)X\n\nend',
  ])
  assert.deepEqual(errors, [])
})

test('contributed layouts follow the document revision', {
  timeout: 60000,
}, async () => {
  const shown = await harness.evaluate(async () => {
    const preview = window.livePreview
    const remove = preview.showRevisions()
    try {
      await preview.mount('first paragraph\n\nsecond paragraph\n', {
        width: 800,
        height: 600,
      })
      const read = () =>
        [...document.querySelectorAll('.test-revision')].map(
          (node) => node.textContent,
        )
      const before = read()
      preview.setRevision(1)
      await preview.settle()
      return { before, after: read() }
    } finally {
      remove()
    }
  })
  // Before, the layout kept its widgets from the old revision.
  assert.deepEqual(shown, { before: ['0', '0'], after: ['1', '1'] })
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

test('links whose destination spans lines render on one line while mounting and scrolling', {
  timeout: 90000,
}, async () => {
  const errors = []
  const pageError = (error) => errors.push(error.message)
  const consoleError = (message) => {
    if (message.type() === 'error') errors.push(message.text())
  }
  harness.on('pageerror', pageError)
  harness.on('console', consoleError)
  try {
    for (const [doc, lines] of [
      ['[label](https://example.com/\n "title")\n\nend', ['label', 'end']],
      ['[label](\nhttps://example.com/\n)\n\nend', ['label', 'end']],
      ['[long\nlabel](https://example.com/)\n\nend', ['long label', 'end']],
      ['hello\n`` some\ncode ``\n\nend', ['hello some code', 'end']],
    ]) {
      const text = await harness.evaluate(async (doc) => {
        await window.livePreview.mount(doc, { width: 800, height: 600 })
        await window.livePreview.settle()
        return [...document.querySelectorAll('.cm-line')]
          .map((line) => line.textContent.replace(/\s+/g, ' ').trim())
          .filter(Boolean)
      }, doc)
      assert.deepEqual(text, lines, JSON.stringify(doc))
    }
    // Each scrolled viewport builds decorations for newly visible links.
    const shown = await harness.evaluate(async () => {
      const doc = Array.from(
        { length: 2000 },
        (_, i) => `para ${i} [link ${i}](\nhttps://example.com/${i}\n "t")`,
      ).join('\n\n')
      const preview = window.livePreview
      await preview.mount(doc, { width: 800, height: 600 })
      const view = preview.view()
      let links = 0
      for (let step = 1; step <= 20; step++) {
        view.dispatch({
          selection: { anchor: Math.floor((doc.length * step) / 20) },
          scrollIntoView: true,
        })
        await preview.settle()
        links += document.querySelectorAll('.hibi-lp-link').length
      }
      return links
    })
    assert.ok(shown > 20, `${shown}`)
    assert.deepEqual(errors, [])
  } finally {
    harness.off('pageerror', pageError)
    harness.off('console', consoleError)
  }
})

test('a structural edit at the top of a 50 MiB note parses a bounded window and converges in idle slices', {
  timeout: 180000,
}, async () => {
  const unit = '# heading\n\nparagraph words\n\n- one\n- two\n\n> quote\n\n'
  // One parse step per transaction: each step reads a bounded range.
  const length = await harness.evaluate(async (unit) => {
    await window.livePreview.mount(
      unit.repeat(Math.ceil((50 * 1024 * 1024) / unit.length)),
      undefined,
      { slice: 0 },
    )
    return window.livePreview.view().state.doc.length
  }, unit)
  await harness.waitForFunction(() => document.querySelector('.hibi-lp-h1'))
  /** One transaction's parse work: a step never drains the rest of the note. */
  const step = (spec) =>
    harness.evaluate((spec) => {
      const preview = window.livePreview
      preview.reset()
      preview.view().dispatch(spec)
      return { ...preview.probe }
    }, spec)
  const bounded = (counts, label) => {
    assert.ok(
      counts.scannedUnits <= 160 * 1024,
      `${label} ${JSON.stringify(counts)}`,
    )
    assert.ok(
      counts.parsedUnits <= 64 * 1024,
      `${label} ${JSON.stringify(counts)}`,
    )
  }
  // Opening a fence makes the rest of the note one code block.
  const opened = await step({ changes: { from: 0, insert: '~~~\n' } })
  bounded(opened, 'open')
  await harness.waitForFunction(
    () =>
      document.querySelectorAll('.hibi-lp-codeblock').length > 5 &&
      !document.querySelector('.hibi-lp-h1'),
  )
  // A far jump scans toward the middle in idle slices; typing meanwhile stays bounded.
  await harness.evaluate(
    (middle) => {
      const view = window.livePreview.view()
      view.dispatch({ selection: { anchor: middle }, scrollIntoView: true })
    },
    Math.floor(length / 2),
  )
  const typed = []
  for (let key = 0; key < 5; key++)
    typed.push(await step({ changes: { from: 15 + key, insert: 'x' } }))
  for (const counts of typed) bounded(counts, 'type')
  await harness.waitForFunction(
    (middle) => {
      const view = window.livePreview.view()
      return [...document.querySelectorAll('.hibi-lp-codeblock')].some(
        (line) => Math.abs(view.posAtDOM(line) - middle) < 20000,
      )
    },
    Math.floor(length / 2),
    { timeout: 150000 },
  )
  const closed = await step({
    changes: { from: length + 9, insert: '\n~~~\n' },
  })
  bounded(closed, 'close')
  const unfenced = await step({ changes: { from: 0, to: 4 } })
  bounded(unfenced, 'unfence')
  console.log(JSON.stringify({ opened, typed: typed[0], closed, unfenced }))
})

test('formatting in a giant list stays drawn while an edit inside its window is reparsed', {
  timeout: 90000,
}, async () => {
  const doc = Array.from(
    { length: 20000 },
    (_, i) => `- item **${i}** text`,
  ).join('\n')
  // One parse step per transaction, so an edit's reparse spans several.
  await harness.evaluate(async (doc) => {
    const preview = window.livePreview
    await preview.mount(doc, { width: 800, height: 600 }, { slice: 0 })
    preview.scrollTo(preview.view().state.doc.line(10000).from)
  }, doc)
  await harness.waitForFunction(
    () => document.querySelectorAll('.hibi-lp-strong').length > 10,
  )
  await harness.waitForFunction(() => !window.livePreview.settling())
  const result = await harness.evaluate(() => {
    const preview = window.livePreview
    const view = preview.view()
    const before = document.querySelectorAll('.hibi-lp-strong').length
    const line = view.state.doc.line(10005)
    view.dispatch({ changes: { from: line.to, insert: ' **new**' } })
    return {
      before,
      after: document.querySelectorAll('.hibi-lp-strong').length,
      settling: preview.settling(),
    }
  })
  // The edit's reparse is unfinished, and what was drawn stays, mapped.
  assert.ok(result.settling, JSON.stringify(result))
  assert.ok(result.after >= result.before, JSON.stringify(result))
  // The reparse lands in idle slices with the edit formatted.
  await harness.waitForFunction(() =>
    [...document.querySelectorAll('.hibi-lp-strong')].some(
      (node) => node.textContent === 'new',
    ),
  )
  // Line breaks typed or pasted into hidden syntax while a reparse is
  // pending drop the replacements they split instead of throwing.
  await harness.waitForFunction(() => !window.livePreview.settling())
  const split = await harness.evaluate(() => {
    const preview = window.livePreview
    const view = preview.view()
    const errors = []
    for (const insert of ['\n', 'a\nb\nc']) {
      const line = view.state.doc.line(10006)
      try {
        // Between the hidden list marker and the space after it.
        view.dispatch({ changes: { from: line.from + 1, insert } })
      } catch (error) {
        errors.push(String(error))
      }
    }
    return { errors, settling: preview.settling() }
  })
  assert.deepEqual(split.errors, [], JSON.stringify(split))
  assert.ok(split.settling, JSON.stringify(split))
})

test('ordered list numbers in a 20,000-item list come from cached item offsets', {
  timeout: 90000,
}, async () => {
  const doc = Array.from(
    { length: 20000 },
    (_, i) => `${i + 1}. item ${i}`,
  ).join('\n')
  await harness.evaluate(async (doc) => {
    await window.livePreview.mount(doc, { width: 800, height: 600 })
    const view = window.livePreview.view()
    view.dispatch({ selection: { anchor: doc.length }, scrollIntoView: true })
  }, doc)
  await harness.waitForFunction(() =>
    [...document.querySelectorAll('.hibi-lp-list-ordered')].some((line) =>
      line.textContent.includes('item 19999'),
    ),
  )
  const result = await harness.evaluate(async () => {
    const preview = window.livePreview
    const view = preview.view()
    // Count sibling reads through the node prototypes while the visible items restyle.
    let reads = 0
    const restore = []
    const tree = preview.tree()
    const at = view.state.doc.length
    for (const node of [tree.topNode, tree.resolveInner(at, -1)])
      for (
        let proto = Object.getPrototypeOf(node);
        proto;
        proto = Object.getPrototypeOf(proto)
      )
        for (const name of ['prevSibling', 'nextSibling']) {
          const descriptor = Object.getOwnPropertyDescriptor(proto, name)
          if (
            !descriptor?.get ||
            restore.some(([p, n]) => p === proto && n === name)
          )
            continue
          restore.push([proto, name, descriptor])
          Object.defineProperty(proto, name, {
            ...descriptor,
            get() {
              reads++
              return descriptor.get.call(this)
            },
          })
        }
    // Scrolling within the parsed window restyles items from cached offsets.
    preview.scrollTo(view.state.doc.line(19970).from)
    await preview.settle()
    await preview.settle()
    const scrolled = reads
    reads = 0
    // An edit rebuilds the window around the viewport, not the list before it.
    view.dispatch({ changes: { from: at, insert: 'x' } })
    await preview.settle()
    const edited = reads
    for (const [proto, name, descriptor] of restore)
      Object.defineProperty(proto, name, descriptor)
    const numbers = Object.fromEntries(
      [...document.querySelectorAll('.hibi-lp-list-ordered')].map((line) => [
        line.textContent.trim(),
        line.style.counterSet,
      ]),
    )
    return { scrolled, edited, numbers }
  })
  assert.equal(
    result.numbers['item 19999x'],
    'list-item 20000',
    JSON.stringify(result.numbers),
  )
  assert.equal(result.numbers['item 19990'], 'list-item 19991')
  // Before the cache, ten visible items near the end read about 200,000 siblings.
  assert.ok(result.scrolled < 1000, JSON.stringify(result.scrolled))
  assert.ok(result.edited < 10000, JSON.stringify(result.edited))
})
