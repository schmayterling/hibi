import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test, { after, before } from 'node:test'
import { build } from 'vite'
import { parseRow } from '../src/renderer/src/formatted/table-source.ts'
import { bundledColorschemes } from '../src/shared/color-palettes.ts'
import { COLOR_TOKENS } from '../src/shared/colorschemes.ts'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

const wide = Array.from({ length: 30 }, (_, i) => `col ${i}`)
const note = `# Formatted tables

A paragraph before the table.

| Name | **Bold** head | Right | Center |
| --- | :-- | --: | :-: |
| one | *em* and \`code\` | 1 | x |
| two \\| pipe | [link](https://example.com/) ~~gone~~ | 22 |
| three | a<br>b | 333 | z | extra |

| ${wide.join(' | ')} |
| ${wide.map(() => '---').join(' | ')} |
| ${wide.map((_, i) => `value ${i}`).join(' | ')} |

- item

  | a | b |
  | - | - |
  | c | d |

> quoted
>
> | q1 | q2 |
> | -- | -- |
> | q3 | q4 |
>
> after the quoted table

Closing paragraph.
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
    // Scrollbars show the document's height, which the formatted view estimates for text it has not rendered.
    style.textContent = `${css} .rich-pane { scrollbar-width: none !important; }`
    document.documentElement.dataset.colorscheme = id
    document.documentElement.dataset.appearance = appearance
  }, scheme)

before(
  async () => {
    folder = await mkdtemp(join(tmpdir(), 'hibi-formatted-tables-'))
    const bundle = join(folder, 'bundle')
    await build({
      configFile: false,
      logLevel: 'silent',
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        outDir: bundle,
        assetsInlineLimit: 0,
        lib: {
          entry: resolve('tests/fixtures/formatted-tables.ts'),
          name: 'TablesHarness',
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
    await mkdir(join(folder, 'notes'))
    const file = join(folder, 'notes', 'tables.md')
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
    await page.locator('.tiptap h1', { hasText: 'Formatted tables' }).waitFor()
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
    await harness.waitForFunction(() => Boolean(window.tables))
    // Hidden windows have no focus; keys and markers need a focused editor.
    const focus = await harness.context().newCDPSession(harness)
    await focus.send('Emulation.setFocusEmulationEnabled', { enabled: true })
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

/**
 * Every rendered table in a pane, by its header text: its cells' boxes, text
 * and styles, and where it is from the document's top, or above the closing
 * paragraph when the pane is scrolled down (the formatted view estimates the
 * height of text it has not rendered).
 */
const tables = (target, fromEnd) =>
  target.evaluate((fromEnd) => {
    const pane = document.querySelector('.rich-pane')
    const origin = pane.getBoundingClientRect()
    const closing = [...pane.querySelectorAll('p, .cm-line')]
      .find((element) => element.textContent.startsWith('Closing paragraph'))
      ?.getBoundingClientRect().top
    return [...pane.querySelectorAll('table')].map((table) => {
      const frame = table.getBoundingClientRect()
      return {
        header: table.rows[0].innerText,
        at: [
          frame.left - origin.left + pane.scrollLeft,
          fromEnd
            ? closing - frame.top
            : frame.top - origin.top + pane.scrollTop,
          frame.width,
          frame.height,
        ].map((value) => Math.round(value)),
        rows: [...table.rows].map((row) =>
          [...row.cells].map((cell) => {
            const box = cell.getBoundingClientRect()
            const style = getComputedStyle(cell)
            const inner = cell.querySelector(
              'strong, em, s, code, a, br, .hibi-lp-strong, .hibi-lp-em, .hibi-lp-strike, .hibi-lp-code, .hibi-lp-link',
            )
            const innerStyle = inner && getComputedStyle(inner)
            return {
              text: cell.innerText,
              box: [
                box.left - frame.left,
                box.top - frame.top,
                box.width,
                box.height,
              ].map((value) => Math.round(value)),
              tag: cell.tagName,
              style: [
                style.fontFamily,
                style.fontSize,
                style.fontWeight,
                style.color,
                style.backgroundColor,
                style.textAlign,
                style.borderTopColor,
                style.paddingLeft,
              ],
              inner: innerStyle && [
                inner.textContent,
                innerStyle.fontFamily,
                innerStyle.fontSize,
                innerStyle.fontWeight,
                innerStyle.fontStyle,
                innerStyle.color,
                innerStyle.backgroundColor,
                innerStyle.textDecorationLine,
              ],
            }
          }),
        ),
      }
    })
  }, fromEnd)

/** Scroll a pane to `top`, as a fraction of its scroll range. */
const scroll = (target, fraction) =>
  target.evaluate(async (fraction) => {
    const pane = document.querySelector('.rich-pane')
    pane.scrollTop = (pane.scrollHeight - pane.clientHeight) * fraction
    for (let frame = 0; frame < 3; frame++)
      await new Promise(requestAnimationFrame)
  }, fraction)

test('tables in the formatted view match the rich view in light and dark', {
  timeout: 60000,
}, async () => {
  const richPane = page.locator('.rich-pane')
  const pane = await richPane.evaluate((element) => {
    const box = element.getBoundingClientRect()
    return { width: box.width, height: box.height }
  })
  await harness.evaluate(({ doc, pane }) => window.tables.mount(doc, pane), {
    doc: note,
    pane,
  })
  for (const id of ['hibi-light', 'hibi-dark']) {
    const scheme = palette(id)
    await applyPalette(page, scheme)
    await applyPalette(harness, scheme)
    // The formatted view renders the tables near the visible part: compare
    // them at the top and the bottom of the note.
    const compared = new Set()
    for (const fraction of [0, 1]) {
      await scroll(page, fraction)
      await scroll(harness, fraction)
      const rich = await tables(page, fraction === 1)
      for (const table of await tables(harness, fraction === 1)) {
        const expected = rich.find((other) => other.header === table.header)
        // Same cells, at the same places, with the same text and styles.
        assert.deepEqual(table, expected, `${id} ${table.header}`)
        compared.add(table.header)
      }
    }
    assert.equal(compared.size, 4, [...compared].join(' / '))
    await scroll(page, 0)
    await scroll(harness, 0)
    const images = [
      await richPane.screenshot({
        path: `test-results/formatted-tables-rich-${id}.png`,
      }),
      await harness.locator('.rich-pane').screenshot({
        path: `test-results/formatted-tables-formatted-${id}.png`,
      }),
    ].map((image) => image.toString('base64'))
    const difference = await app.evaluate(({ nativeImage }, images) => {
      const [a, b] = images.map((image) =>
        nativeImage.createFromBuffer(Buffer.from(image, 'base64')),
      )
      const size = a.getSize(),
        other = b.getSize()
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
    console.log(JSON.stringify({ id, difference }))
    assert.ok(difference < 0.002, `${id}: ${difference}`)
  }
})

test('a 10,000-row table renders the rows in view and one row per edit', {
  timeout: 120000,
}, async () => {
  const result = await harness.evaluate(async () => {
    const preview = window.tables
    const rows = Array.from(
      { length: 10000 },
      (_, i) => `| row ${i} | **bold ${i}** | \`code ${i}\` |`,
    )
    const doc = `# Big table\n\nIntro.\n\n| a | b | c |\n| --- | :-: | --: |\n${rows.join('\n')}\n\nAfter.\n`
    await preview.mount(doc, { width: 1000, height: 800 })
    const view = preview.view()
    const rendered = () =>
      document.querySelectorAll('.hibi-lp-table tr[data-line]').length
    // The table appears once its block is scanned in idle slices.
    for (let i = 0; i < 500 && !document.querySelector('.hibi-lp-table'); i++)
      await new Promise((done) => setTimeout(done, 20))
    await preview.settle()
    const top = rendered()
    const pane = document.querySelector('.rich-pane')
    const table = document.querySelector('.hibi-lp-table')
    const box = table.getBoundingClientRect()
    pane.scrollTop +=
      box.top - pane.getBoundingClientRect().top + box.height / 2
    await preview.settle()
    await preview.settle()
    const shown = [
      ...document.querySelectorAll('.hibi-lp-table tr[data-line]'),
    ].filter((row) => {
      const rect = row.getBoundingClientRect()
      return rect.bottom > 0 && rect.top < innerHeight
    })
    const middle = rendered()
    // One keystroke in a visible row re-renders that row only.
    const line = Number(shown[3].dataset.line)
    const header = view.state.doc.lineAt(doc.indexOf('| a |')).number
    const target = view.state.doc.line(header + line)
    const added = []
    const observer = new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes)
          if (node.nodeName === 'TR') added.push(node.dataset.line)
    })
    observer.observe(table.querySelector('tbody'), { childList: true })
    preview.reset()
    view.dispatch({ changes: { from: target.from + 6, insert: 'X' } })
    await preview.settle()
    observer.disconnect()
    return {
      top,
      middle,
      shown: shown.map((row) => Number(row.dataset.line)),
      line,
      added,
      text: table.querySelector(`tr[data-line="${line}"]`)?.innerText,
      probe: { ...preview.probe },
      height: box.height,
    }
  })
  console.log(JSON.stringify(result))
  assert.ok(result.height > 10000 * 50, 'spacers keep the full height')
  assert.ok(result.top < 100, `${result.top} rows at the top`)
  assert.ok(result.middle < 100, `${result.middle} rows in the middle`)
  assert.ok(
    result.shown.length > 5 &&
      result.shown.every((line) => line > 4000 && line < 6000),
    JSON.stringify(result.shown),
  )
  assert.deepEqual(result.added, [String(result.line)])
  assert.match(result.text, /^row X/)
  // The table's rows are opaque to the parser: an edit parses its opening
  // lines and scans a bounded window, not the 380 KB table.
  assert.ok(result.probe.parsedUnits < 4096, JSON.stringify(result.probe))
  assert.ok(result.probe.scannedUnits <= 16384, JSON.stringify(result.probe))
})

/** Mount `doc` in the editable harness. */
const mount = (doc) =>
  harness.evaluate(
    (doc) =>
      window.tables.mount(
        doc,
        { width: 1000, height: 800 },
        { editable: true },
      ),
    doc,
  )

test('container markers stay out of the cells of tables in lists and quotes', {
  timeout: 30000,
}, async () => {
  for (const doc of [
    '- | a | b |\n  | - | - |\n  | c | d |',
    '> - | a | b |\n>   | - | - |\n>   | c | d |',
    '- outer\n  - item\n\n    > | a | b |\n    > | - | - |\n    > | c | d |',
  ]) {
    await mount(doc)
    const rows = await harness.evaluate(() =>
      [...document.querySelectorAll('.hibi-lp-table tr')].map((row) =>
        [...row.cells].map((cell) => cell.innerText.trim()),
      ),
    )
    assert.deepEqual(
      rows,
      [
        ['a', 'b'],
        ['c', 'd'],
      ],
      doc,
    )
  }
})

test('arrow keys move into the nearest row of an adjacent table and shift-click extends the selection', {
  timeout: 30000,
}, async () => {
  const doc = 'before\n\n| a | b |\n| --- | --- |\n| x | y |\n\nafter'
  const caret = () =>
    harness.evaluate(() => {
      const view = window.tables.view()
      const { anchor, head } = view.state.selection.main
      return { anchor, head, line: view.state.doc.lineAt(head).text }
    })
  await mount(doc)
  await harness.evaluate(() => {
    const view = window.tables.view()
    view.focus()
    view.dispatch({ selection: { anchor: 6 } })
  })
  // The caret stops on the gap line, then moves into the header row.
  await harness.keyboard.press('ArrowDown')
  assert.equal((await caret()).line, '')
  await harness.keyboard.press('ArrowDown')
  assert.equal((await caret()).line, '| a | b |')
  // The source shows while the caret is in it.
  await harness.locator('.cm-line', { hasText: '| a | b |' }).waitFor()
  await harness.evaluate(
    (at) => window.tables.view().dispatch({ selection: { anchor: at } }),
    doc.length,
  )
  await harness.locator('.hibi-lp-table').waitFor()
  await harness.keyboard.press('ArrowUp')
  assert.equal((await caret()).line, '')
  await harness.keyboard.press('ArrowUp')
  assert.equal((await caret()).line, '| x | y |')
  await harness.evaluate(() =>
    window.tables.view().dispatch({ selection: { anchor: 1 } }),
  )
  await harness.locator('.hibi-lp-table td', { hasText: 'y' }).click({
    modifiers: ['Shift'],
  })
  const selection = await caret()
  assert.equal(selection.anchor, 1)
  assert.equal(selection.line, '| x | y |')
  assert.ok(selection.head > doc.indexOf('| x'))
})

test('arrow keys move into tables in quotes and lists at their row text', {
  timeout: 30000,
}, async () => {
  for (const [doc, header, last] of [
    [
      'before\n\n> | a | b |\n> | - | - |\n> | x | y |\n\nafter',
      '> | a | b |',
      '> | x | y |',
    ],
    [
      'before\n\n- | a | b |\n  | - | - |\n  | x | y |\n\nafter',
      '- | a | b |',
      '  | x | y |',
    ],
  ]) {
    await mount(doc)
    const caret = () =>
      harness.evaluate(() => {
        const view = window.tables.view()
        const { head } = view.state.selection.main
        const line = view.state.doc.lineAt(head)
        return { head, line: line.text, column: head - line.from }
      })
    await harness.evaluate(() => {
      const view = window.tables.view()
      view.focus()
      view.dispatch({ selection: { anchor: 7 } })
    })
    // From the gap line into the header's text, after the container marker.
    await harness.keyboard.press('ArrowDown')
    const entered = await caret()
    assert.deepEqual([entered.line, entered.column], [header, 2], doc)
    await harness.locator('.cm-line', { hasText: header.slice(2) }).waitFor()
    // The next press moves on through the source instead of staying put.
    await harness.keyboard.press('ArrowDown')
    assert.notEqual((await caret()).head, entered.head, doc)
    await harness.evaluate(
      (at) => window.tables.view().dispatch({ selection: { anchor: at } }),
      doc.length - 6,
    )
    await harness.locator('.hibi-lp-table').waitFor()
    await harness.keyboard.press('ArrowUp')
    const below = await caret()
    assert.deepEqual([below.line, below.column], [last, 2], doc)
  }
})

test('cells show disabled syntax as written and follow syntax setting changes', {
  timeout: 30000,
}, async () => {
  const cell = () =>
    harness.evaluate(() => ({
      text: document.querySelector('.hibi-lp-table td').innerText,
      bold: document.querySelectorAll('.hibi-lp-table .hibi-lp-strong').length,
      struck: document.querySelectorAll('.hibi-lp-table .hibi-lp-strike')
        .length,
    }))
  await harness.evaluate(() => window.tables.setEnabled('core.bold', false))
  await mount('**bold**\n\n| h |\n| - |\n| **bold** ~~gone~~ |\n\nafter')
  assert.deepEqual(await cell(), {
    text: '**bold** gone',
    bold: 0,
    struck: 1,
  })
  /** Change a syntax setting while the table is mounted. */
  const toggle = (id, enabled) =>
    harness.evaluate(
      async ({ id, enabled }) => {
        window.tables.setEnabled(id, enabled)
        await new Promise((done) => setTimeout(done, 50))
        await window.tables.settle()
      },
      { id, enabled },
    )
  // A core setting alone, which changes no syntax, renders the cells again.
  await toggle('core.bold', true)
  assert.deepEqual(await cell(), { text: 'bold gone', bold: 1, struck: 1 })
  await toggle('core.bold', false)
  assert.deepEqual(await cell(), { text: '**bold** gone', bold: 0, struck: 1 })
  // So does a contributed syntax setting.
  await toggle('core.bold', true)
  await toggle('markdown.strike', false)
  assert.deepEqual(await cell(), { text: 'bold ~~gone~~', bold: 1, struck: 0 })
  await toggle('markdown.strike', true)
})

test('clicking a cell reveals the table source with the caret in that cell', {
  timeout: 90000,
}, async () => {
  // Quitting with the edited note answers the unsaved-changes prompt.
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 })
  })
  await page.evaluate(() =>
    localStorage.setItem('hibi:formatted-engine', 'codemirror'),
  )
  await page.reload()
  await waitForDocumentEditor(app, page)
  await pressShortcut(
    app,
    process.platform === 'darwin' ? 'Meta+o' : 'Control+o',
  )
  await page.locator('.rich-pane .hibi-lp-table').first().waitFor()
  // Hidden windows have no focus; revealing source needs a focused editor.
  const session = await page.context().newCDPSession(page)
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await page
    .locator('.rich-pane .hibi-lp-table td', { hasText: 'two | pipe' })
    .click()
  const line = page.locator('.rich-pane .cm-line', {
    hasText: '| two \\| pipe |',
  })
  await line.waitFor()
  // Other tables stay rendered.
  await page
    .locator('.rich-pane .hibi-lp-table th', { hasText: 'col 0' })
    .waitFor()
  await page.keyboard.type('!')
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.includes('!'),
  )
  // The typed text lands in the clicked cell's source.
  const { markdown } = await page.evaluate(() => window.hibi.getDocument())
  const row = markdown.split('\n').find((text) => text.startsWith('| two'))
  const [first, ...rest] = parseRow(row).cells.map(({ from, to }) =>
    row.slice(from, to),
  )
  assert.equal(first.replace('!', ''), 'two \\| pipe', row)
  assert.deepEqual(rest, ['[link](https://example.com/) ~~gone~~', '22'])
  // Leaving the table renders it again with the edit.
  await page
    .locator('.rich-pane .cm-line', {
      hasText: 'A paragraph before the table.',
    })
    .click()
  await page.locator('.rich-pane .hibi-lp-table td', { hasText: '!' }).waitFor()
})
