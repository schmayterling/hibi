import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test, { after, before } from 'node:test'
import { build } from 'vite'
import { bundledColorschemes } from '../src/shared/color-palettes.ts'
import { COLOR_TOKENS } from '../src/shared/colorschemes.ts'
import { electron } from './electron.mjs'
import { selectFormattedEngine } from './formatted-engine.mjs'
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
      worker: { format: 'es' },
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
      // compare grayscale text in both compositing paths on every platform.
      args: [
        resolve('.'),
        '--disable-lcd-text',
        `--user-data-dir=${join(folder, 'profile')}`,
      ],
    })
    page = await app.firstWindow()
    page.setDefaultTimeout(10000)
    await selectFormattedEngine(app, page, 'tiptap')
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
        const nodes = []
        for (let node = walker.nextNode(); node; node = walker.nextNode())
          nodes.push(node)
        const index = nodes
          .map((node) => node.data)
          .join('')
          .indexOf(text)
        if (index < 0) return null
        const point = (offset) => {
          for (const node of nodes) {
            if (offset <= node.length) return [node, offset]
            offset -= node.length
          }
        }
        const range = document.createRange()
        range.setStart(...point(index))
        range.setEnd(...point(index + text.length))
        const box = range.getBoundingClientRect()
        return {
          width: box.width,
          left: box.left - pane.left,
          top: box.top - pane.top,
          height: box.height,
        }
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
              box: textBox(element, text),
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
  // The panes scroll alike: where scrollbars take space, as on Linux and
  // Windows, the app's thin scrollbar is in both screenshots.
  const scrolling = (target) =>
    target.evaluate((title) => {
      const pane = [...document.querySelectorAll('.rich-pane')].find((root) =>
        root.querySelector(':is(h1, .hibi-lp-h1)')?.textContent.includes(title),
      )
      const style = getComputedStyle(pane)
      return {
        overflowY: style.overflowY,
        scrollbarWidth: style.scrollbarWidth,
        scrollbarColor: style.scrollbarColor,
      }
    }, title)
  const report = []
  for (const id of ['hibi-light', 'hibi-dark']) {
    const scheme = palette(id)
    await applyPalette(page, scheme)
    await applyPalette(harness, scheme)
    await harness.evaluate(() => window.livePreview.settle())
    assert.deepEqual(await scrolling(harness), await scrolling(page), id)
    // A note that fits the pane is as tall in both views, so a scrollbar
    // shows in both screenshots or in neither. (The formatted view lays out
    // the lines it shows, so a longer note's height is not compared.)
    const height = (target) =>
      target.evaluate((title) => {
        const pane = [...document.querySelectorAll('.rich-pane')].find((root) =>
          root
            .querySelector(':is(h1, .hibi-lp-h1)')
            ?.textContent.includes(title),
        )
        return {
          pane: pane.clientHeight,
          note: pane
            .querySelector('.tiptap, .cm-content')
            .getBoundingClientRect().height,
        }
      }, title)
    const tall = { rich: await height(page), formatted: await height(harness) }
    if (tall.rich.note <= tall.rich.pane)
      assert.ok(
        Math.abs(tall.rich.note - tall.formatted.note) <= 1,
        `${id}: ${JSON.stringify(tall)}`,
      )
    const before = await sample(page, rich, title)
    const after = await sample(harness, formatted, title)
    for (const key of Object.keys(rich)) {
      const a = before[key],
        b = after[key]
      assert.ok(a?.box && b?.box, `${key}: ${JSON.stringify({ a, b })}`)
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
        dw: Math.round((b.box.width - a.box.width) * 10) / 10,
        dh: Math.round((b.box.height - a.box.height) * 10) / 10,
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
    const { difference, box } = await app.evaluate(
      ({ nativeImage }, images) => {
        const [a, b] = images.map((image) =>
          nativeImage.createFromBuffer(Buffer.from(image, 'base64')),
        )
        const size = a.getSize()
        const other = b.getSize()
        if (size.width !== other.width || size.height !== other.height)
          return { difference: 1, box: [size, other] }
        const left = a.toBitmap(),
          right = b.toBitmap()
        let changed = 0,
          box = null
        for (let i = 0; i < left.length; i += 4)
          if (
            Math.abs(left[i] - right[i]) > 8 ||
            Math.abs(left[i + 1] - right[i + 1]) > 8 ||
            Math.abs(left[i + 2] - right[i + 2]) > 8
          ) {
            changed++
            const x = (i / 4) % size.width,
              y = Math.floor(i / 4 / size.width)
            box = box
              ? [
                  Math.min(box[0], x),
                  Math.min(box[1], y),
                  Math.max(box[2], x),
                  Math.max(box[3], y),
                ]
              : [x, y, x, y]
          }
        return { difference: changed / (left.length / 4), box }
      },
      images,
    )
    // Where the screenshots differ, in their pixels: left, top, right, bottom.
    report.push({ id, key: 'pixels', difference, box })
  }
  console.log(JSON.stringify(report.filter((entry) => entry.key === 'pixels')))
  // keep the pixel gate strict; failures also report full phrase bounds.
  for (const { id, key, difference } of report)
    if (key === 'pixels')
      assert.ok(
        difference < 0.002,
        `${id}: ${difference} ${JSON.stringify(report)}`,
      )
  // full phrase bounds match the rich view within a pixel.
  const offsets = report.filter(
    (entry) =>
      entry.key !== 'pixels' &&
      [entry.dx, entry.dy, entry.dw, entry.dh].some(
        (value) => Math.abs(value) > 1,
      ),
  )
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

test('notes end as in the rich view, so both views scroll alike', {
  timeout: 120000,
}, async () => {
  // Zero, one and several final line breaks, and last blocks that paint or are replaced.
  const endings = {
    paragraph: 'tail',
    newline: 'tail\n',
    blank: 'tail\n\n',
    blanks: 'tail\n\n\n',
    paragraphs: 'tail\n\n\n\n',
    quote: '> tail',
    quoteBlank: '> tail\n\n',
    list: '- tail',
    fence: '```js\nconst tail = 1\n```',
    open: '```js\nconst tail = 1',
    table: '| tail | b |\n| - | - |\n| c | d |',
  }
  /** The note's height, where the block holding "tail" ends, and whether the pane scrolls. */
  const measure = (target, title) =>
    target.evaluate((title) => {
      const pane = [...document.querySelectorAll('.rich-pane')].find((root) =>
        root.querySelector(':is(h1, .hibi-lp-h1)')?.textContent.includes(title),
      )
      const note = pane.querySelector('.tiptap, .cm-content')
      const top = note.getBoundingClientRect().top
      const block = [...note.children].find((child) =>
        child.textContent.includes('tail'),
      )
      return {
        note: note.getBoundingClientRect().height,
        block: block.getBoundingClientRect().bottom - top,
        scrolls: pane.scrollHeight > pane.clientHeight,
      }
    }, title)
  for (const [name, ending] of Object.entries(endings)) {
    const title = `Ending ${name}`
    const doc = `# ${title}\n\n${ending}`
    const file = join(folder, 'notes', `ending-${name}.md`)
    await writeFile(file, doc)
    await open(file, title)
    const richPane = page.locator('.rich-pane', {
      has: page.locator('.tiptap h1', { hasText: title }),
    })
    const size = await richPane.evaluate((element) => {
      const box = element.getBoundingClientRect()
      return { width: box.width, height: box.height }
    })
    const mount = (height) =>
      harness.evaluate(({ doc, size }) => window.livePreview.mount(doc, size), {
        doc,
        size: { ...size, height },
      })
    await mount(size.height)
    const rich = await measure(page, title)
    const formatted = await measure(harness, title)
    const report = `${name}: ${JSON.stringify({ rich, formatted })}`
    assert.ok(Math.abs(rich.note - formatted.note) <= 1, report)
    // Space after the last block lies outside it, as a quote's bar shows.
    assert.ok(Math.abs(rich.block - formatted.block) <= 1, report)
    // Panes a little shorter than the note scroll; a little taller do not.
    const style = await richPane.getAttribute('style')
    const scrolling = { rich: [], formatted: [] }
    for (const height of [
      Math.floor(rich.note) - 2,
      Math.ceil(rich.note) + 2,
    ]) {
      await richPane.evaluate((element, height) => {
        Object.assign(element.style, {
          flex: 'none',
          height: `${height}px`,
          minHeight: '0',
        })
      }, height)
      await mount(height)
      scrolling.rich.push((await measure(page, title)).scrolls)
      scrolling.formatted.push((await measure(harness, title)).scrolls)
    }
    await richPane.evaluate((element, style) => {
      if (style === null) element.removeAttribute('style')
      else element.setAttribute('style', style)
    }, style)
    assert.deepEqual(scrolling.rich, [true, false], name)
    assert.deepEqual(scrolling.formatted, scrolling.rich, name)
  }
})

test('blank lines after the last block are laid out only where the view shows them', {
  timeout: 60000,
}, async () => {
  const doc = `# Blank tail\n\ntail${'\n'.repeat(10000)}`
  const lines = await harness.evaluate(async (doc) => {
    await window.livePreview.mount(doc, { width: 800, height: 600 })
    window.livePreview.scrollTo(doc.length)
    await window.livePreview.settle()
    const view = window.livePreview.view()
    const text = view.state.doc
    const read = text.line
    let calls = 0
    text.line = function (number) {
      calls++
      return read.call(this, number)
    }
    window.livePreview.refresh()
    delete text.line
    return calls
  }, doc)
  // The view shows a few dozen of the 10,000 blank lines.
  assert.ok(lines < 200, `${lines} line reads`)
  // Near the last block, the blank lines take the rich view's spacing.
  const heights = await harness.evaluate(async () => {
    window.livePreview.scrollTo(0)
    await window.livePreview.settle()
    return [...document.querySelectorAll('.cm-line')]
      .slice(3, 7)
      .map((line) => line.getBoundingClientRect().height)
  })
  assert.deepEqual(heights, [16, 28, 16, 28])
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

test('contributed layouts reuse document identity and follow revision and tab changes', {
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
      const initialLayouts = preview.revisionLayouts()
      preview.setRevision(0)
      await preview.settle()
      const unchangedLayouts = preview.revisionLayouts() - initialLayouts
      preview.setRevision(1)
      await preview.settle()
      const changedLayouts = preview.revisionLayouts() - initialLayouts
      const after = read()
      preview.setRevision(1, 'other-tab')
      await preview.settle()
      return {
        before,
        unchangedLayouts,
        changedLayouts,
        after,
        tabLayouts: preview.revisionLayouts() - initialLayouts,
      }
    } finally {
      remove()
    }
  })
  assert.deepEqual(shown, {
    before: ['0', '0'],
    unchangedLayouts: 0,
    changedLayouts: 2,
    after: ['1', '1'],
    tabLayouts: 4,
  })
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

test('after an idle moment, scrolling near the viewport parses nothing in its frames', {
  timeout: 90000,
}, async () => {
  // The paired benchmark's 575 kb prose: 100,000 words in paragraphs of 20.
  const words =
    'alpha beta gamma delta epsilon zeta eta theta iota kappa'.split(' ')
  const doc = Array.from(
    { length: 100000 },
    (_, i) => `${i ? (i % 20 === 0 ? '\n\n' : ' ') : ''}${words[i % 10]}`,
  ).join('')
  const result = await harness.evaluate(async (doc) => {
    const preview = window.livePreview
    const pane = document.querySelector('.rich-pane')
    // Earlier cases leave the pane scrolled; this note opens at its start.
    pane.scrollTop = 0
    await preview.mount(doc, { width: 1200, height: 800 })
    const view = preview.view()
    preview.reset()
    // Quiet once long idle periods pass without parse progress. Text ahead
    // is parsed meanwhile, and the viewport never shows unparsed text.
    let unparsedViewport = 0,
      calm = 0,
      last = ''
    while (calm < 3) {
      const remaining = await new Promise((resolve) =>
        requestIdleCallback((deadline) => resolve(deadline.timeRemaining())),
      )
      if (!preview.covered(view.viewport.from, view.viewport.to))
        unparsedViewport++
      const progress = JSON.stringify(preview.probe)
      calm = remaining >= 40 && progress === last ? calm + 1 : 0
      last = progress
    }
    const ahead = { ...preview.probe }
    const coveredAhead = preview.covered(
      view.viewport.from,
      Math.min(view.state.doc.length, view.viewport.to + 32 * 1024),
    )
    preview.reset()
    // 3600 px over twelve frames, as the paired benchmark scrolls.
    for (let frame = 1; frame <= 12; frame++) {
      pane.scrollTop = frame * 300
      await new Promise(requestAnimationFrame)
    }
    await preview.settle()
    return {
      length: view.state.doc.length,
      scrolled: pane.scrollTop,
      unparsedViewport,
      ahead,
      coveredAhead,
      scroll: { ...preview.probe },
    }
  }, doc)
  console.log(JSON.stringify(result))
  assert.equal(result.scrolled, 3600, JSON.stringify(result))
  assert.equal(result.unparsedViewport, 0, JSON.stringify(result))
  assert.equal(result.coveredAhead, true, JSON.stringify(result))
  // Idle-time parsing covers a bounded window around the viewport, not the note.
  assert.ok(result.ahead.parsedUnits <= 24 * 4096, JSON.stringify(result))
  assert.ok(result.length > 4 * 24 * 4096)
  assert.equal(result.scroll.parsedChunks, 0, JSON.stringify(result))
  assert.equal(result.scroll.parsedUnits, 0, JSON.stringify(result))
  assert.equal(result.scroll.scannedUnits, 0, JSON.stringify(result))
})

test('link reference definitions take no space and show only while the caret edits them', {
  timeout: 60000,
}, async () => {
  const session = await harness.context().newCDPSession(harness)
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const layout = (doc) =>
    harness.evaluate(async (doc) => {
      await window.livePreview.mount(
        doc,
        { width: 800, height: 600 },
        {
          editable: true,
        },
      )
      const lines = [...document.querySelectorAll('.cm-line')]
      return {
        text: lines
          .map((line) => line.textContent.trim())
          .filter(Boolean)
          .join('|'),
        tops: lines
          .filter((line) => line.textContent.trim())
          .map((line) => Math.round(line.getBoundingClientRect().top)),
      }
    }, doc)
  // Each note lays out as the one without its definitions.
  for (const [doc, plain] of [
    ['one\n\n[ref]: /x "t"\n\ntwo', 'one\n\ntwo'],
    ['# one\n[a]: /x\n[b]:\n  /y\n\ntwo', '# one\ntwo'],
    ['[ref]: /x\n\none\n\n> [q]: /y\n>\n> two', 'one\n\n> two'],
    ['one\n\ntwo\n\n[ref]: /x\n', 'one\n\ntwo\n'],
    // After a list marker, the item's text shows beside the marker.
    ['- [r]: /x\n\n  two', '- two'],
    ['1. [r]: /x\n\n   two', '1. two'],
    // Definitions after the first one in the item hide with it.
    ['- [a]: /x\n  [b]: /y\n\n  two', '- two'],
    ['- [a]: /x\n\n  [b]: /y\n\n  two', '- two'],
    ['1. [a]: /x\n   [a]: /y\n\n   two', '1. two'],
    ['> - [a]: /x\n>   [b]: /y\n>\n>   two', '> - two'],
  ]) {
    const shown = await layout(doc)
    const expected = await layout(plain)
    assert.equal(shown.text, expected.text, doc)
    assert.deepEqual(shown.tops, expected.tops, doc)
  }
  // Arrow keys stay on the last shown block before a trailing definition,
  // and a note of definitions alone keeps them hidden.
  for (const doc of ['body\n\n[r]: /x', '[r]: /x', '- [r]: /x\n\n  two']) {
    await harness.evaluate(async (doc) => {
      const preview = window.livePreview
      await preview.mount(doc, { width: 800, height: 600 }, { editable: true })
      const view = preview.view()
      view.focus()
      view.dispatch({ selection: { anchor: 0 } })
      await preview.settle()
    }, doc)
    const shown = []
    for (const key of ['ArrowDown', 'ArrowDown', 'ArrowUp', 'ArrowDown']) {
      await harness.keyboard.press(key)
      shown.push(
        await harness.evaluate(async () => {
          await window.livePreview.settle()
          return [...document.querySelectorAll('.cm-line')].some((line) =>
            line.textContent.includes('[r]'),
          )
        }),
      )
    }
    assert.deepEqual(shown, [false, false, false, false], doc)
  }
  const doc = 'one\n\n[ref]: /x\n\ntwo'
  const definition = { from: doc.indexOf('['), to: doc.indexOf('two') - 1 }
  const result = await harness.evaluate(async (doc) => {
    const preview = window.livePreview
    await preview.mount(doc, { width: 800, height: 600 }, { editable: true })
    const view = preview.view()
    view.focus()
    view.dispatch({ selection: { anchor: 0 } })
    await preview.settle()
    return {
      lines: [...document.querySelectorAll('.cm-line')].map((line) =>
        line.textContent.trim(),
      ),
    }
  }, doc)
  assert.ok(!result.lines.includes('[ref]: /x'), JSON.stringify(result))
  // Arrow keys step over the hidden lines.
  const heads = []
  for (let step = 0; step < 4; step++) {
    await harness.keyboard.press('ArrowDown')
    heads.push(
      await harness.evaluate(
        () => window.livePreview.view().state.selection.main.head,
      ),
    )
  }
  assert.ok(
    heads.every((head) => head < definition.from || head > definition.to),
    JSON.stringify({ heads, definition }),
  )
  assert.equal(heads.at(-1), doc.length)
  // A selection from the definition's first character shows it too.
  assert.equal(
    await harness.evaluate(async (from) => {
      const preview = window.livePreview
      preview.view().dispatch({ selection: { anchor: from, head: from + 5 } })
      await preview.settle()
      return [...document.querySelectorAll('.cm-line')].some(
        (line) => line.textContent.trim() === '[ref]: /x',
      )
    }, definition.from),
    true,
  )
  // A caret placed in the definition shows it, and typing stays in it.
  const typed = await harness.evaluate(async (at) => {
    const preview = window.livePreview
    const view = preview.view()
    view.dispatch({ selection: { anchor: at } })
    await preview.settle()
    const shown = [...document.querySelectorAll('.cm-line')].some(
      (line) => line.textContent.trim() === '[ref]: /x',
    )
    return { shown }
  }, doc.indexOf('/x') + 2)
  assert.equal(typed.shown, true)
  await harness.keyboard.type('yz')
  const shownLine = () =>
    harness.evaluate(async () => {
      await window.livePreview.settle()
      return [...document.querySelectorAll('.cm-line')].some(
        (line) => line.textContent.trim() === '[ref]: /xyz',
      )
    })
  assert.equal(await shownLine(), true)
  // Arrow keys move inside a shown definition without hiding it.
  await harness.keyboard.press('ArrowLeft')
  assert.equal(await shownLine(), true)
  /** Whether no line shows the definition. */
  const hidden = () =>
    ![...document.querySelectorAll('.cm-line')].some((line) =>
      line.textContent.includes('[ref]'),
    )
  await harness.evaluate(() => window.livePreview.view().contentDOM.blur())
  // Blur reaches the view after its focus handling settles, which can take
  // more than a frame under load: wait for the definition to hide.
  await harness.waitForFunction(hidden).catch((error) => {
    if (error.name !== 'TimeoutError') throw error
  })
  const after = {
    doc: await harness.evaluate(() =>
      window.livePreview.view().state.doc.toString(),
    ),
    hidden: await harness.evaluate(hidden),
  }
  assert.deepEqual(after, { doc: 'one\n\n[ref]: /xyz\n\ntwo', hidden: true })
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

test('reference links render the labels the note defines and keep their brackets otherwise', {
  timeout: 60000,
}, async () => {
  const doc = [
    'full [text][REF] end',
    'collapsed [Ref][] end',
    'shortcut [ref] end',
    'spaced [x][a\nb] end',
    '[**bold** words\non two lines][ref] end',
    'missing [nope] and [t][nope] and [**kept**][nope]',
    'inline [site](https://example.com/) end',
    // Labels match definitions trimmed and case folded, as navigation reads them.
    'padded [t][ A\tB ] end',
    'folded [ẞ] end',
  ].join('\n\n')
  const shown = await harness.evaluate(async (doc) => {
    const preview = window.livePreview
    preview.references.defined = new Set(['ref', 'a b', 'ss'])
    preview.references.titles = { ref: 'Go there' }
    preview.references.asked = []
    await preview.mount(doc, { width: 800, height: 600 }, { references: true })
    await preview.settle()
    return {
      lines: [...document.querySelectorAll('.cm-line')]
        .map((line) => line.textContent.replace(/\s+/g, ' ').trim())
        .filter(Boolean),
      roles: [
        ...new Set(
          [...document.querySelectorAll('.hibi-lp-link')].map((link) =>
            link.getAttribute('role'),
          ),
        ),
      ],
      // Titles of defined labels, as the rich view shows them, per line.
      titles: [...document.querySelectorAll('.cm-line')]
        .map((line) => line.querySelector('.hibi-lp-link'))
        .filter(Boolean)
        .map((link) => link.getAttribute('title')),
      // Link text per line, which a widget inside it may split.
      links: [...document.querySelectorAll('.cm-line')]
        .map((line) =>
          [...line.querySelectorAll('.hibi-lp-link')]
            .filter((link) => !link.parentElement.closest('.hibi-lp-link'))
            .map((link) => link.textContent)
            .join('')
            .replace(/\s+/g, ' '),
        )
        .filter(Boolean),
      strong: [...document.querySelectorAll('.hibi-lp-strong')].map(
        (node) => node.textContent,
      ),
      asked: [...preview.references.asked].sort(),
    }
  }, doc)
  assert.deepEqual(shown.lines, [
    'full text end',
    'collapsed Ref end',
    'shortcut ref end',
    'spaced x end',
    'bold words on two lines end',
    'missing [nope] and [t][nope] and [kept][nope]',
    'inline site end',
    'padded t end',
    'folded ẞ end',
  ])
  assert.deepEqual(shown.links, [
    'text',
    'Ref',
    'ref',
    'x',
    'bold words on two lines',
    'site',
    't',
    'ẞ',
  ])
  assert.deepEqual(shown.roles, ['link'])
  assert.deepEqual(shown.titles, [
    'Go there',
    'Go there',
    'Go there',
    null,
    'Go there',
    null,
    null,
    null,
  ])
  // Formatting inside a reference's text renders whether or not it resolves.
  assert.deepEqual(shown.strong, ['bold', 'kept'])
  // Each drawn label is asked about once, normalized as definitions are.
  assert.deepEqual(shown.asked, ['a b', 'nope', 'ref', 'ss'])
})

test('reference labels follow definition changes after an edit and ask only about drawn labels in a 50 MiB note', {
  timeout: 120000,
}, async () => {
  const changed = await harness.evaluate(async () => {
    const preview = window.livePreview
    preview.references.defined = new Set(['ref'])
    preview.references.asked = []
    await preview.mount('see [ref] here\n\nlast', undefined, {
      references: true,
      editable: true,
    })
    await preview.settle()
    const before = document.querySelectorAll('.hibi-lp-link').length
    // The definition goes away with an edit elsewhere in the note.
    preview.references.defined = new Set()
    const view = preview.view()
    view.dispatch({ changes: { from: view.state.doc.length, insert: '!' } })
    const until = (check) =>
      new Promise((resolve) => {
        const poll = () =>
          check() ? resolve(true) : requestAnimationFrame(poll)
        poll()
      })
    await until(() => !document.querySelector('.hibi-lp-link'))
    return {
      before,
      after: document.querySelectorAll('.hibi-lp-link').length,
      text: document.querySelector('.cm-line').textContent,
      asked: preview.references.asked,
    }
  })
  assert.deepEqual(changed, {
    before: 1,
    after: 0,
    text: 'see [ref] here',
    asked: ['ref', 'ref'],
  })
  const scale = await harness.evaluate(async () => {
    const preview = window.livePreview
    const unit = Array.from(
      { length: 50 },
      (_, i) => `Paragraph with [label ${i}][r${i}] and [r${i}] words.\n\n`,
    ).join('')
    preview.references.defined = new Set(
      Array.from({ length: 50 }, (_, i) => `r${i}`),
    )
    preview.references.asked = []
    const doc = unit.repeat(Math.ceil((50 * 1024 * 1024) / unit.length))
    // Earlier cases leave the pane scrolled; this note opens at its start.
    document.querySelector('.rich-pane').scrollTop = 0
    await preview.mount(doc, { width: 800, height: 600 }, { references: true })
    while (!document.querySelector('.hibi-lp-link')) await preview.settle()
    const opened = {
      length: preview.view().state.doc.length,
      asked: preview.references.asked.length,
      links: document.querySelectorAll('.hibi-lp-link').length,
    }
    const view = preview.view()
    view.dispatch({
      selection: { anchor: Math.floor(doc.length / 2) },
      scrollIntoView: true,
    })
    await preview.settle()
    await preview.settle()
    return {
      opened,
      scrolled: preview.references.asked.length,
      requested: preview.referenceWork.requested,
    }
  })
  assert.ok(scale.opened.length > 50 * 1024 * 1024)
  assert.ok(scale.opened.links > 0, JSON.stringify(scale))
  // Labels drawn on screen, at most the 50 distinct ones, never the note's.
  assert.ok(scale.opened.asked <= 50, JSON.stringify(scale))
  assert.ok(scale.scrolled <= 100, JSON.stringify(scale))
  // Layout hides labels on later lines over parsed text past the viewport
  // too, but only labels of lines drawn are asked about.
  const multiline = await harness.evaluate(async () => {
    const preview = window.livePreview
    preview.references.defined = { has: () => true }
    preview.references.asked = []
    const drawn = new Set()
    const observer = new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes)
          for (const [, number] of (node.textContent ?? '').matchAll(
            /link (\d+)/g,
          ))
            drawn.add(number)
    })
    observer.observe(document.body, { childList: true, subtree: true })
    const count = Math.ceil((50 * 1024 * 1024) / 40)
    const doc = Array.from(
      { length: count },
      (_, i) => `Paragraph [link ${i}][label\n${i}] words.`,
    ).join('\n\n')
    // The case before leaves the pane scrolled to the middle of its note.
    document.querySelector('.rich-pane').scrollTop = 0
    await preview.mount(doc, { width: 800, height: 600 }, { references: true })
    while (!document.querySelector('.hibi-lp-link')) await preview.settle()
    await preview.settle()
    observer.disconnect()
    const asked = preview.references.asked
    return {
      length: doc.length,
      asked: asked.length,
      drawn: drawn.size,
      undrawn: asked.filter((label) => !drawn.has(label.split(' ')[1])).length,
    }
  })
  assert.ok(multiline.length > 50 * 1024 * 1024)
  assert.ok(multiline.asked > 0, JSON.stringify(multiline))
  assert.equal(multiline.undrawn, 0, JSON.stringify(multiline))
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

test('heading names and outer link wrappers stay mapped through a pending reparse', {
  timeout: 90000,
}, async () => {
  const doc = Array.from(
    { length: 20000 },
    (_, i) => `- ## pre[**fix ${i}**](b.md)ed`,
  ).join('\n')
  const cdp = await harness.context().newCDPSession(harness)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await harness.evaluate(async (doc) => {
    const preview = window.livePreview
    await preview.mount(
      doc,
      { width: 800, height: 600 },
      {
        slice: 0,
        editable: true,
        history: true,
      },
    )
    preview.scrollTo(preview.view().state.doc.line(10000).from)
  }, doc)
  await harness
    .getByRole('heading', { name: 'prefix 9999ed', exact: true })
    .waitFor()
  await harness.waitForFunction(() => !window.livePreview.settling())
  const pending = await harness.evaluate(() => {
    const preview = window.livePreview
    const view = preview.view()
    const line = view.state.doc.line(10000)
    const at = line.from + line.text.indexOf('fix') + 3
    view.focus()
    view.dispatch({ selection: { anchor: at } })
    view.dispatch({ changes: { from: at, insert: 'x' } })
    const headings = [
      ...view.contentDOM.querySelectorAll('[role="heading"]'),
    ].filter((node) => node.textContent.includes('fixx 9999'))
    return {
      settling: preview.settling(),
      names: headings.map((node) => node.getAttribute('aria-label')),
      links: headings.map(
        (node) => node.querySelectorAll('[role="link"]').length,
      ),
    }
  })
  assert.ok(pending.settling, JSON.stringify(pending))
  assert.deepEqual(pending.names, ['prefixx 9999ed'])
  assert.deepEqual(pending.links, [1])
  await harness.waitForFunction(() => !window.livePreview.settling())
  assert.equal(
    await harness
      .getByRole('heading', { name: 'prefixx 9999ed', exact: true })
      .getByRole('link')
      .count(),
    1,
  )
  assert.ok(await harness.evaluate(() => window.livePreview.undo()))
  await harness.waitForFunction(() => !window.livePreview.settling())
  assert.equal(
    await harness.evaluate(() =>
      window.livePreview.view().state.doc.toString(),
    ),
    doc,
  )
  assert.equal(
    await harness
      .getByRole('heading', { name: 'prefix 9999ed', exact: true })
      .getByRole('link')
      .count(),
    1,
  )
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

test('code language changes reparse only the code on screen of a 50 MiB note', {
  timeout: 120000,
}, async () => {
  await harness.evaluate(async () => {
    const unit =
      '## Section\n\nWords between blocks.\n\n```js\nconst value = 1\n```\n\n```rust\nfn main() {}\n```\n\n'
    // A parse finishes in the transaction that starts it.
    await window.livePreview.mount(
      unit.repeat(Math.ceil((50 * 1024 * 1024) / unit.length)),
      { width: 800, height: 600 },
      { slice: Number.POSITIVE_INFINITY },
    )
    // Idle time parses ahead of the screen; held, it counts in no change.
    window.holdIdle = () => {
      const idle = window.requestIdleCallback
      window.requestIdleCallback = () => 0
      return () => {
        window.requestIdleCallback = idle
      }
    }
    window.codeKeywords = (text) =>
      [
        ...document.querySelectorAll('.hibi-lp-codeblock .hibi-token-keyword'),
      ].filter((token) => token.textContent === text).length
  })
  const keywords = (text, shown) =>
    harness.waitForFunction(
      ({ text, shown }) => window.codeKeywords(text) > 0 === shown,
      { text, shown },
    )
  // Work of one change: the parse it starts, without idle parsing ahead.
  const measure = (change) =>
    harness.evaluate(async (change) => {
      const preview = window.livePreview
      await preview.settle()
      const release = window.holdIdle()
      try {
        preview.reset()
        if (change === 'disable') preview.setCodeLanguage('javascript', false)
        else preview.hide(false)
        await preview.settle()
        return {
          ...preview.probe,
          keywords: window.codeKeywords('const'),
          blocks: document.querySelectorAll('.hibi-lp-codeblock').length,
        }
      } finally {
        release()
      }
    }, change)
  try {
    // A grammar that loads after the first parse reaches the parsed blocks.
    await keywords('fn', true)
    await keywords('const', true)
    const disabled = await measure('disable')
    // A hidden view waits: no parse and no change until it is shown.
    await harness.evaluate(() => window.livePreview.hide(true))
    await harness.waitForFunction(
      () =>
        getComputedStyle(document.querySelector('.rich-pane')).visibility ===
        'hidden',
    )
    const hidden = await harness.evaluate(async () => {
      const preview = window.livePreview
      await preview.settle()
      const release = window.holdIdle()
      try {
        preview.reset()
        preview.setCodeLanguage('javascript', true)
        await preview.settle()
        await preview.settle()
        return { ...preview.probe, keywords: window.codeKeywords('const') }
      } finally {
        release()
      }
    })
    const shown = await measure('show')
    // Code parsed before its language changed parses again when it returns to the screen.
    await harness.evaluate(() => {
      const preview = window.livePreview
      const { doc } = preview.view().state
      preview.scrollTo(doc.lineAt(Math.floor(doc.length / 2)).from)
    })
    await harness.waitForFunction(
      () =>
        window.livePreview.view().viewport.from > 1024 * 1024 &&
        window.codeKeywords('const') > 0,
    )
    await harness.evaluate(() =>
      window.livePreview.setCodeLanguage('javascript', false),
    )
    await keywords('const', false)
    await harness.evaluate(() => window.livePreview.scrollTo(0))
    await harness.waitForFunction(
      () =>
        window.livePreview.view().viewport.from === 0 &&
        window.codeKeywords('fn') > 0 &&
        window.codeKeywords('const') === 0,
    )
    console.log(JSON.stringify({ disabled, hidden, shown }))
    assert.equal(hidden.parsedUnits, 0, JSON.stringify(hidden))
    assert.equal(hidden.keywords, 0)
    assert.equal(disabled.keywords, 0)
    assert.ok(shown.keywords > 0, JSON.stringify(shown))
    // The code on screen and the chunks it straddles parse again, not the note.
    for (const result of [disabled, shown]) {
      assert.ok(result.blocks > 4, JSON.stringify(result))
      assert.ok(result.parsedChunks <= 4, JSON.stringify(result))
      assert.ok(result.parsedUnits <= 4 * 4096, JSON.stringify(result))
    }
  } finally {
    await harness.evaluate(() =>
      window.livePreview.setCodeLanguage('javascript', true),
    )
  }
})

test('a code language change inside one 50 MiB fence parses only the code on screen', {
  timeout: 240000,
}, async () => {
  // A worker indexing the note is covered in formatted-boundary-worker.
  await harness.evaluate(async () => {
    const line = 'const value = 1\n'
    await window.livePreview.mount(
      `\`\`\`js\n${line.repeat(Math.ceil((50 * 1024 * 1024) / line.length))}\`\`\`\n\nend\n`,
      { width: 800, height: 600 },
      { editable: true },
    )
    window.codeKeywords = () =>
      [
        ...document.querySelectorAll('.hibi-lp-codeblock .hibi-token-keyword'),
      ].filter((token) => token.textContent === 'const').length
    const preview = window.livePreview
    preview.scrollTo(preview.view().state.doc.length - 2048)
  })
  await harness.waitForFunction(
    () =>
      window.livePreview.view().viewport.from > 40 * 1024 * 1024 &&
      window.codeKeywords() > 0 &&
      !window.livePreview.settling(),
    undefined,
    { timeout: 90000 },
  )
  try {
    // Turning the language off and on again near the fence's far end keeps
    // the fence's known bounds: a scan of the lines on screen rather than of
    // the fence, and at most its window around the screen parses again.
    for (const enabled of [false, true]) {
      await harness.evaluate(async (enabled) => {
        const preview = window.livePreview
        await preview.settle()
        preview.reset()
        preview.setCodeLanguage('javascript', enabled)
      }, enabled)
      await harness.waitForFunction(
        (enabled) =>
          window.codeKeywords() > 0 === enabled &&
          !window.livePreview.settling(),
        enabled,
      )
      const result = await harness.evaluate(() => window.livePreview.probe)
      const label = JSON.stringify({ enabled, ...result })
      console.log(label)
      assert.ok(result.scannedUnits <= 16 * 1024, label)
      assert.ok(result.parsedUnits <= 2 * 64 * 1024, label)
    }
  } finally {
    await harness.evaluate(() =>
      window.livePreview.setCodeLanguage('javascript', true),
    )
  }
})

test('selecting the whole note includes the hidden fences at its ends', {
  timeout: 30000,
}, async () => {
  const code = '```js\nconst answer = 42\n```'
  // Select-all covers the text after hidden metadata, as the frontmatter view's Mod-a does.
  for (const metadata of ['', '---\ntitle: test\n---\n\n']) {
    const doc = metadata + code
    const result = await harness.evaluate(
      async ({ doc, metadata }) => {
        const preview = window.livePreview
        await preview.mount(
          doc,
          { width: 800, height: 600 },
          { editable: true, frontmatter: !!metadata },
        )
        const view = preview.view()
        view.dispatch({
          selection: { anchor: metadata.length, head: doc.length },
        })
        const all = view.state.selection.main
        // A caret left on the hidden closing fence still moves beside it.
        view.dispatch({ selection: { anchor: doc.length } })
        return {
          all: [all.anchor, all.head],
          caret: view.state.selection.main.head,
        }
      },
      { doc, metadata },
    )
    assert.deepEqual(result.all, [metadata.length, doc.length], metadata)
    assert.equal(result.caret, doc.indexOf('\n```', metadata.length), metadata)
  }
})
