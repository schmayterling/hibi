import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test, { after, before } from 'node:test'
import { build } from 'vite'
import { parseRow } from '../src/renderer/src/formatted/table-source.ts'
import { tableKey } from '../src/renderer/src/table-layout-store.ts'
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
    await preview.mount(doc, { width: 1000, height: 800 }, { editable: true })
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
    // Typing in a cell editor in the same row renders no rows or other cells.
    const changed = []
    const cells = new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes)
          if (/^(TR|TD|TH)$/.test(node.nodeName)) changed.push(node.nodeName)
    })
    cells.observe(table.querySelector('tbody'), {
      childList: true,
      subtree: true,
    })
    view.focus()
    table
      .querySelector(`tr[data-line="${line}"] td`)
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    const typing = []
    for (let key = 0; key < 5; key++) {
      preview.reset()
      document.execCommand('insertText', false, 'y')
      await preview.settle()
      typing.push({ ...preview.probe })
    }
    cells.disconnect()
    return {
      top,
      middle,
      shown: shown.map((row) => Number(row.dataset.line)),
      line,
      added,
      text: view.state.doc.line(header + line).text,
      probe: typing[0],
      typing,
      changed,
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
  assert.match(result.text, /^\| row X\d+yyyyy \|/)
  assert.deepEqual(result.changed, [], 'no rows or cells render again')
  // The table's rows are opaque to the parser: an edit parses its opening
  // lines and scans a bounded window, not the 380 KB table.
  for (const probe of result.typing) {
    assert.ok(probe.parsedUnits < 4096, JSON.stringify(probe))
    assert.ok(probe.scannedUnits <= 16384, JSON.stringify(probe))
  }
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

/** The harness editor's source, selection and cell editor. */
const state = () =>
  harness.evaluate(() => {
    const view = window.tables.view()
    const { anchor, head } = view.state.selection.main
    const editor = document.querySelector('.hibi-lp-cell-editor')
    const cell = editor?.closest('td, th')
    return {
      doc: view.state.doc.toString(),
      anchor,
      head,
      line: view.state.doc.lineAt(head).text,
      editor: editor?.querySelector('.cm-content').textContent ?? null,
      cell: cell
        ? [cell.parentElement.dataset.line, cell.cellIndex].join(':')
        : null,
    }
  })

test('arrow keys enter the nearest cells of an adjacent table and shift-click extends the selection', {
  timeout: 30000,
}, async () => {
  const doc = 'before\n\n| a | b |\n| --- | --- |\n| x | y |\n\nafter'
  await mount(doc)
  await harness.evaluate(() => {
    const view = window.tables.view()
    view.focus()
    view.dispatch({ selection: { anchor: 6 } })
  })
  // The caret stops on the gap line, then edits the header's first cell.
  await harness.keyboard.press('ArrowDown')
  assert.equal((await state()).line, '')
  await harness.keyboard.press('ArrowDown')
  assert.deepEqual([(await state()).cell, (await state()).editor], ['0:0', 'a'])
  await harness.keyboard.press('Escape')
  await harness.evaluate(
    (at) => window.tables.view().dispatch({ selection: { anchor: at } }),
    doc.length,
  )
  await harness.keyboard.press('ArrowUp')
  await harness.keyboard.press('ArrowUp')
  assert.equal((await state()).cell, '2:0')
  await harness.keyboard.press('Escape')
  await harness.evaluate(() =>
    window.tables.view().dispatch({ selection: { anchor: 1 } }),
  )
  await harness.locator('.hibi-lp-table td', { hasText: 'y' }).click({
    modifiers: ['Shift'],
  })
  const selection = await state()
  assert.equal(selection.anchor, 1)
  assert.equal(selection.line, '| x | y |')
  assert.equal(selection.editor, null)
})

test('arrow keys enter tables in quotes and lists', {
  timeout: 30000,
}, async () => {
  for (const doc of [
    'before\n\n> | a | b |\n> | - | - |\n> | x | y |\n\nafter',
    'before\n\n- | a | b |\n  | - | - |\n  | x | y |\n\nafter',
  ]) {
    await mount(doc)
    await harness.evaluate(() => {
      const view = window.tables.view()
      view.focus()
      view.dispatch({ selection: { anchor: 7 } })
    })
    await harness.keyboard.press('ArrowDown')
    assert.deepEqual(
      [(await state()).cell, (await state()).editor],
      ['0:0', 'a'],
      doc,
    )
    await harness.keyboard.press('Escape')
    await harness.evaluate(
      (at) => window.tables.view().dispatch({ selection: { anchor: at } }),
      doc.length - 6,
    )
    await harness.keyboard.press('ArrowUp')
    assert.equal((await state()).cell, '2:0', doc)
    await harness.keyboard.press('Escape')
  }
})

test('a selection from outside into a table opens no cell editor', {
  timeout: 30000,
}, async () => {
  // Text before the table's chunk, so an edit there moves the reused widget.
  const filler = Array.from({ length: 2000 }, (_, i) => `paragraph ${i}`).join(
    '\n\n',
  )
  const doc = `${filler}\n\n| a | b |\n| - | - |\n| x | y |\n\nafter`
  await mount(doc)
  await harness.evaluate(async () => {
    const pane = document.querySelector('.rich-pane')
    pane.scrollTop = pane.scrollHeight
    for (let i = 0; i < 100 && !document.querySelector('.hibi-lp-table'); i++)
      await window.tables.settle()
  })
  const errors = []
  const listen = (error) => errors.push(error.message)
  harness.on('pageerror', listen)
  await harness.evaluate((doc) => {
    const view = window.tables.view()
    view.dispatch({ changes: { from: 0, insert: 'moved ' } })
    view.focus()
    view.dispatch({
      selection: { anchor: 0, head: doc.indexOf('| x') + 'moved '.length + 2 },
    })
  }, doc)
  await harness.evaluate(() => window.tables.settle())
  harness.off('pageerror', listen)
  const selection = await state()
  assert.deepEqual(errors, [])
  assert.equal(selection.editor, null)
  assert.equal(selection.anchor, 0)
})

test('cell editors move with tab, enter and arrows and leave with escape', {
  timeout: 30000,
}, async () => {
  const doc = 'before\n\n| a | b |\n| --- | --- |\n| c | d |\n| e |\n\nafter'
  await mount(doc)
  await harness.locator('.hibi-lp-table th', { hasText: 'a' }).click()
  assert.equal((await state()).cell, '0:0')
  const moves = []
  for (const key of [
    'Tab',
    'Tab',
    'Shift+Tab',
    'Enter',
    'ArrowRight',
    'ArrowRight',
    'ArrowRight',
    'ArrowLeft',
    'ArrowUp',
    'ArrowDown',
    'ArrowDown',
  ]) {
    await harness.keyboard.press(key)
    moves.push((await state()).cell)
  }
  // The row `| e |` has no second cell: it is edited empty and created on input.
  assert.deepEqual(moves, [
    '0:1',
    '2:0',
    '0:1',
    '2:1',
    '3:0',
    '3:0',
    '3:1',
    '3:0',
    '2:0',
    '3:0',
    null,
  ])
  // Leaving below puts the caret on the line after the table, Escape too.
  assert.equal((await state()).head, doc.indexOf('\n\nafter') + 1)
  await harness.locator('.hibi-lp-table th', { hasText: 'a' }).click()
  await harness.keyboard.press('Escape')
  const left = await state()
  assert.equal(left.editor, null)
  assert.equal(left.head, doc.indexOf('\n\nafter') + 1)
  // Tab in the last cell adds a row, as in the rich editor.
  await harness.locator('.hibi-lp-table td', { hasText: 'e' }).click()
  await harness.keyboard.press('Tab')
  await harness.keyboard.press('Tab')
  assert.equal((await state()).cell, '4:0')
  assert.match((await state()).doc, /\| e \|\n\| {2}\| {2}\|\n\nafter/)
})

const undoKey = process.platform === 'darwin' ? 'Meta+z' : 'Control+z'

test('a cell editor follows its row when rows are added or deleted around it', {
  timeout: 30000,
}, async () => {
  const doc = '| h |\n| - |\n| alpha |\n| beta |\n| gamma |\n\nafter'
  await mount(doc)
  await harness.locator('.hibi-lp-table td', { hasText: 'gamma' }).click()
  await harness.keyboard.press('End')
  // Another edit adds a row above the edited one: typing stays in gamma.
  await harness.evaluate(
    (at) =>
      window.tables
        .view()
        .dispatch({ changes: { from: at, insert: '| NEW |\n' } }),
    doc.indexOf('| gamma'),
  )
  await harness.keyboard.type('X')
  let now = await state()
  assert.match(now.doc, /\| beta \|\n\| NEW \|\n\| gammaX \|\n/)
  assert.deepEqual([now.cell, now.editor], ['5:0', 'gammaX'])
  // Deleting the edited row moves the editor to the row now in its place.
  const from = now.doc.indexOf('\n| gammaX |')
  await harness.evaluate(
    ({ from, to }) => window.tables.view().dispatch({ changes: { from, to } }),
    { from, to: from + '\n| gammaX |'.length },
  )
  await harness.evaluate(() => window.tables.settle())
  await harness.keyboard.type('Y')
  now = await state()
  assert.match(now.doc, /\| beta \|\n\| NEWY \|\n\nafter$/)
  assert.deepEqual([now.cell, now.editor], ['4:0', 'NEWY'])
})

test('cell editors take no input while the formatted view takes none', {
  timeout: 30000,
}, async () => {
  const doc = 'before\n\n| a | b |\n| - | - |\n| c | d |\n\nafter'
  await mount(doc)
  await harness.locator('.hibi-lp-table td', { hasText: 'c' }).click()
  await harness.keyboard.press('End')
  await harness.evaluate(() => window.tables.setEditable(false))
  await harness.keyboard.type('Z')
  await harness.keyboard.press('Shift+Enter')
  assert.equal((await state()).doc, doc)
  await harness.evaluate(() => window.tables.setEditable(true))
  await harness.keyboard.type('W')
  assert.match((await state()).doc, /^\| cW \| d \|$/m)
  // Keys from above enter no cell of a read-only table.
  await harness.keyboard.press('Escape')
  await harness.evaluate(() => {
    const view = window.tables.view()
    window.tables.setEditable(false)
    view.dispatch({ selection: { anchor: 6 } })
    view.focus()
  })
  await harness.keyboard.press('ArrowDown')
  await harness.keyboard.press('ArrowDown')
  assert.equal((await state()).editor, null)
  await harness.evaluate(() => window.tables.setEditable(true))
})

test('navigation out of a read-only table writes nothing', {
  timeout: 30000,
}, async () => {
  const doc = '| a | b |\n| - | - |\n| x | y |'
  await mount(doc)
  // Tab in the last cell would add a row; escape at the end a paragraph.
  for (const [cell, key] of [
    ['y', 'Tab'],
    ['x', 'Escape'],
    ['x', process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter'],
  ]) {
    await harness.evaluate(() => window.tables.setEditable(true))
    await harness.locator('.hibi-lp-table td', { hasText: cell }).click()
    await harness.keyboard.press('End')
    await harness.evaluate(() => window.tables.setEditable(false))
    await harness.keyboard.press(key)
    const now = await state()
    assert.equal(now.doc, doc, key)
    assert.equal(now.editor, null, key)
  }
  // Nor do the toolbar's table actions.
  assert.equal(
    await harness.evaluate(() => {
      const view = window.tables.view()
      view.dispatch({ selection: { anchor: 3 } })
      return window.tables.runTableAction('row-after')
    }),
    false,
  )
  assert.equal((await state()).doc, doc)
  await harness.evaluate(() => window.tables.setEditable(true))
})

test('undo moves the cell editor to the cell whose edit it undoes', {
  timeout: 30000,
}, async () => {
  const doc = '| alpha | beta |\n| - | - |\n| x | y |\n\nafter'
  await mount(doc)
  await harness.locator('.hibi-lp-table th', { hasText: 'alpha' }).click()
  await harness.keyboard.press('End')
  await harness.keyboard.type('1')
  await harness.keyboard.press('Tab')
  await harness.keyboard.press('End')
  await harness.keyboard.type('2')
  await harness.keyboard.press(undoKey)
  assert.deepEqual(
    [(await state()).cell, (await state()).editor],
    ['0:1', 'beta'],
  )
  await harness.keyboard.press(undoKey)
  const now = await state()
  assert.equal(now.doc, doc)
  assert.deepEqual([now.cell, now.editor], ['0:0', 'alpha'])
  assert.equal(now.head, '| alpha'.length)
})

test('tab extends a table of only a header, and leaving a table at the end adds a paragraph', {
  timeout: 30000,
}, async () => {
  await mount('before\n\n| a | b |\n| - | - |')
  await harness.locator('.hibi-lp-table th', { hasText: 'b' }).click()
  await harness.keyboard.press('Tab')
  assert.equal((await state()).cell, '2:0')
  await harness.keyboard.type('c')
  assert.equal((await state()).doc, 'before\n\n| a | b |\n| - | - |\n| c |  |')
  await harness.keyboard.press(
    process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter',
  )
  await harness.keyboard.type('AFTER')
  const now = await state()
  assert.equal(now.doc, 'before\n\n| a | b |\n| - | - |\n| c |  |\n\nAFTER')
  assert.equal(now.editor, null)
})

/** Mount `doc` editable in a view of tab `tabId`, or in a second view of it beside the first. */
const mountTab = (doc, tabId, add = false) =>
  harness.evaluate(
    ({ doc, tabId, add }) =>
      window.tables.mount(
        doc,
        { width: 1000, height: 800 },
        { editable: true, tabId, add },
      ),
    { doc, tabId, add },
  )
/** Drag a cell's right edge by `distance` pixels, once the resize handle shows. */
const dragEdge = async (cell, distance) => {
  const box = await cell.boundingBox()
  const x = box.x + box.width - 2,
    y = box.y + box.height / 2
  await harness.mouse.move(x, y)
  await harness
    .locator('.hibi-lp-table[data-table-resize="column"]')
    .first()
    .waitFor()
  await harness.mouse.down()
  for (let step = 1; step <= 4; step++)
    await harness.mouse.move(x + (distance * step) / 4, y)
  await harness.mouse.up()
}
const layouts = (tabId) =>
  harness.evaluate((tabId) => window.tables.layouts(tabId), tabId)

test('tables with the same header keep their own stored sizes', {
  timeout: 30000,
}, async () => {
  const doc =
    '| h | g |\n| - | - |\n| a | b |\n\nbetween\n\n| h | g |\n| - | - |\n| c | d |\n'
  const first = tableKey(0, ['h', 'g']),
    second = tableKey(1, ['h', 'g'])
  await harness.evaluate(
    (key) =>
      window.tables.layouts('same', [{ key, columns: [200, 0], rows: null }]),
    first,
  )
  await mountTab(doc, 'same')
  const widths = () =>
    harness.evaluate(() =>
      [...document.querySelectorAll('.hibi-lp-table')].map(
        (table) => table.querySelector('th').style.width,
      ),
    )
  // Only the first table has sizes; the second shows its own, none.
  assert.deepEqual(await widths(), ['200px', ''])
  await dragEdge(
    harness.locator('.hibi-lp-table').nth(1).locator('th').first(),
    40,
  )
  await harness.waitForFunction(
    (key) => window.tables.layouts('same').some((table) => table.key === key),
    second,
  )
  const stored = await layouts('same')
  assert.deepEqual(
    stored.find((table) => table.key === first)?.columns,
    [200, 0],
  )
  assert.ok(stored.find((table) => table.key === second)?.columns?.[0] > 0)
})

test('two views of a tab keep the table sizes each other stores', {
  timeout: 30000,
}, async () => {
  const doc =
    '| a | b |\n| - | - |\n| 1 | 2 |\n\n| c | d |\n| - | - |\n| 3 | 4 |\n'
  await harness.evaluate(() => window.tables.layouts('two', []))
  await mountTab(doc, 'two')
  await mountTab(doc, 'two', true)
  const editors = harness.locator('.rich-editor-host > .cm-editor')
  await dragEdge(
    editors.nth(0).locator('.hibi-lp-table').nth(0).locator('th').first(),
    40,
  )
  await dragEdge(
    editors.nth(1).locator('.hibi-lp-table').nth(1).locator('th').first(),
    60,
  )
  const keys = [tableKey(0, ['a', 'b']), tableKey(1, ['c', 'd'])]
  await harness
    .waitForFunction(
      (keys) =>
        keys.every((key) =>
          window.tables.layouts('two').some((table) => table.key === key),
        ),
      keys,
      { timeout: 3000 },
    )
    .catch(() => {})
  assert.deepEqual(
    (await layouts('two')).map((table) => table.key).sort(),
    [...keys].sort(),
  )
  // The other view shows the size the first one stored.
  const width = await harness.evaluate(
    () =>
      document
        .querySelectorAll('.rich-editor-host > .cm-editor')[1]
        .querySelector('.hibi-lp-table th').style.width,
  )
  assert.notEqual(width, '')
})

test('table sizes follow their columns and rows through table actions and undo', {
  timeout: 30000,
}, async () => {
  const doc = '| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n\nafter'
  const key = tableKey(0, ['a', 'b'])
  await harness.evaluate(
    (key) =>
      window.tables.layouts('follow', [
        { key, columns: [200, 180], rows: [0, 0, 90] },
      ]),
    key,
  )
  await mountTab(doc, 'follow')
  const sizes = () =>
    harness.evaluate(() => {
      const table = document.querySelector('.hibi-lp-table table')
      return {
        columns: [...table.rows[0].cells].map((cell) => cell.style.width),
        rows: [...table.rows].map((row) => row.style.height),
      }
    })
  const action = (id, at) =>
    harness.evaluate(
      ({ id, at }) => {
        const view = window.tables.view()
        view.dispatch({ selection: { anchor: at } })
        return window.tables.runTableAction(id)
      },
      { id, at },
    )
  assert.deepEqual(await sizes(), {
    columns: ['200px', '180px'],
    rows: ['', '', '90px'],
  })
  // A row above the sized one and a column before the first shift them.
  assert.equal(await action('row-before', doc.indexOf('| 3') + 2), true)
  assert.equal(await action('column-before', 2), true)
  assert.deepEqual(await sizes(), {
    columns: ['', '200px', '180px'],
    rows: ['', '', '', '90px'],
  })
  // Undo puts the sizes back with the columns and rows.
  await harness.keyboard.press(undoKey)
  await harness.keyboard.press(undoKey)
  assert.equal((await state()).doc, doc)
  assert.deepEqual(await sizes(), {
    columns: ['200px', '180px'],
    rows: ['', '', '90px'],
  })
  await harness.waitForFunction(
    () =>
      JSON.stringify(window.tables.layouts('follow')[0]?.columns) ===
      '[200,180]',
  )
})

test('stored sizes apply to header cells that render again and rows that scroll in', {
  timeout: 30000,
}, async () => {
  const key = tableKey(0, ['a', 'b'])
  await harness.evaluate(
    (key) =>
      window.tables.layouts('mount', [{ key, columns: [200, 0], rows: null }]),
    key,
  )
  await mountTab('| a | b |\n| - | - |\n| 1 | 2 |\n\nafter', 'mount')
  // Leaving an edited header cell renders it again, at its stored width.
  await harness.locator('.hibi-lp-table th', { hasText: 'a' }).click()
  await harness.keyboard.press('Escape')
  assert.equal(
    await harness.evaluate(
      () => document.querySelector('.hibi-lp-table th').style.width,
    ),
    '200px',
  )
  // A sized row of a long table gets its height when its window renders it.
  const rows = Array.from({ length: 300 }, (_, i) => `| r${i} | x |`)
  const long = `| a | b |\n| - | - |\n${rows.join('\n')}\n\nafter`
  const stored = Array(252).fill(0)
  stored[251] = 120
  await harness.evaluate(
    ({ key, stored }) =>
      window.tables.layouts('long', [{ key, columns: null, rows: stored }]),
    { key, stored },
  )
  await mountTab(long, 'long')
  await harness.evaluate((at) => {
    const view = window.tables.view()
    view.focus()
    view.dispatch({ selection: { anchor: at } })
  }, long.indexOf('| r250 |') + 3)
  await harness.evaluate(() => window.tables.settle())
  const row = await harness.evaluate(() => {
    const tr = document.querySelector('.hibi-lp-table tr[data-line="252"]')
    return tr && [tr.style.height, tr.getBoundingClientRect().height >= 119]
  })
  assert.deepEqual(row, ['120px', true])
})

test('keyboard size handles resize and reset columns and rows', {
  timeout: 30000,
}, async () => {
  await harness.evaluate(() => window.tables.layouts('keys', []))
  await mountTab('| a | b |\n| - | - |\n| 1 | 2 |\n\nafter', 'keys')
  const key = tableKey(0, ['a', 'b'])
  const stored = () =>
    harness.evaluate(
      (key) => window.tables.layouts('keys').find((table) => table.key === key),
      key,
    )
  const column = harness
    .locator('.hibi-lp-table th')
    .first()
    .locator('.hibi-lp-table-resizer[data-axis="column"]')
  assert.equal(await column.getAttribute('aria-label'), 'Resize column')
  const width = await harness.evaluate(() =>
    Math.round(
      document.querySelector('.hibi-lp-table th').getBoundingClientRect().width,
    ),
  )
  await column.focus()
  await harness.keyboard.press('ArrowRight')
  await harness.keyboard.press('Shift+ArrowRight')
  await harness.waitForFunction(
    ({ key, width }) =>
      window.tables.layouts('keys').find((table) => table.key === key)
        ?.columns?.[0] ===
      width + 32,
    { key, width },
  )
  // A row's handle is in its first cell.
  const row = harness
    .locator('.hibi-lp-table tr[data-line="2"] td')
    .first()
    .locator('.hibi-lp-table-resizer[data-axis="row"]')
  assert.equal(await row.getAttribute('aria-label'), 'Resize row')
  await row.focus()
  await harness.keyboard.press('ArrowDown')
  await harness.waitForFunction(
    (key) =>
      (window.tables.layouts('keys').find((table) => table.key === key)
        ?.rows?.[1] ?? 0) > 0,
    key,
  )
  // Enter makes each automatic again.
  await harness.keyboard.press('Enter')
  await column.focus()
  await harness.keyboard.press('Enter')
  await harness.waitForFunction(() => !window.tables.layouts('keys').length)
  assert.equal(await stored(), undefined)
})

test('typing in a long table maps only its sized rows', {
  timeout: 60000,
}, async () => {
  const rows = Array.from({ length: 10000 }, (_, i) => `| r${i} | x |`)
  const doc = `| a | b |\n| - | - |\n${rows.join('\n')}\n\nafter`
  const stored = Array(5001).fill(0)
  stored[5000] = 120
  await harness.evaluate(
    ({ key, stored }) =>
      window.tables.layouts('sparse', [{ key, columns: null, rows: stored }]),
    { key: tableKey(0, ['a', 'b']), stored },
  )
  await mountTab(doc, 'sparse')
  await harness.evaluate(async () => {
    for (let i = 0; i < 500 && !document.querySelector('.hibi-lp-table'); i++)
      await new Promise((done) => setTimeout(done, 20))
    await window.tables.settle()
  })
  await harness.locator('.hibi-lp-table td', { hasText: 'r3' }).first().click()
  await harness.keyboard.press('End')
  const mapped = await harness.evaluate(async () => {
    const probe = window.tables.sizeProbe()
    const before = probe.mapped
    document.execCommand('insertText', false, 'y')
    await window.tables.settle()
    return probe.mapped - before
  })
  // One sized row of 10,000: one keystroke maps that row's position only.
  assert.equal(mapped, 1)
  assert.match((await state()).doc, /^\| r3y \| x \|$/m)
})

test('a sized table keeps its sizes when a table is inserted before it', {
  timeout: 30000,
}, async () => {
  const doc = 'intro\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nafter'
  await harness.evaluate(
    (key) =>
      window.tables.layouts('insert', [{ key, columns: [200, 0], rows: null }]),
    tableKey(0, ['a', 'b']),
  )
  await mountTab(doc, 'insert')
  await harness.evaluate(async (at) => {
    window.tables
      .view()
      .dispatch({ changes: { from: at, insert: '| x | y |\n| - | - |\n\n' } })
    await window.tables.settle()
  }, doc.indexOf('| a'))
  const widths = () =>
    harness.evaluate(() =>
      [...document.querySelectorAll('.hibi-lp-table')].map((table) => {
        const cell = table.querySelector('th')
        return [cell.innerText.trim(), cell.style.width]
      }),
    )
  assert.deepEqual(await widths(), [
    ['x', ''],
    ['a', '200px'],
  ])
  // Its ordinal changed: the sizes move to the new key, and stay after the view closes.
  const key = tableKey(1, ['a', 'b'])
  await harness.waitForFunction(
    (key) => window.tables.layouts('insert').some((table) => table.key === key),
    key,
  )
  await mountTab('closed', 'other')
  const stored = await layouts('insert')
  assert.deepEqual(
    stored.map((table) => [table.key, table.columns[0]]),
    [[key, 200]],
  )
})

test('a long table column made automatic again drops its fixed width', {
  timeout: 30000,
}, async () => {
  const rows = Array.from({ length: 300 }, (_, i) => `| r${i} | x |`)
  await harness.evaluate(
    (key) =>
      window.tables.layouts('fixed', [{ key, columns: [320, 0], rows: null }]),
    tableKey(0, ['a', 'b']),
  )
  await mountTab(`| a | b |\n| - | - |\n${rows.join('\n')}\n\nafter`, 'fixed')
  await harness.evaluate(() => window.tables.settle())
  const column = () =>
    harness.evaluate(
      () => document.querySelector('.hibi-lp-table col').style.width,
    )
  const handle = harness
    .locator('.hibi-lp-table th')
    .first()
    .locator('.hibi-lp-table-resizer[data-axis="column"]')
  await handle.focus()
  await harness.keyboard.press('ArrowRight')
  assert.equal(await column(), '328px')
  await harness.keyboard.press('Enter')
  assert.match(await column(), /%$/)
})

test('deleting the first of two sized columns keeps the other, and undo brings both back', {
  timeout: 30000,
}, async () => {
  const doc = '| a | b |\n| - | - |\n| 1 | 2 |\n\nafter'
  await harness.evaluate(
    (key) =>
      window.tables.layouts('delete', [
        { key, columns: [200, 180], rows: null },
      ]),
    tableKey(0, ['a', 'b']),
  )
  await mountTab(doc, 'delete')
  const widths = () =>
    harness.evaluate(() =>
      [...document.querySelector('.hibi-lp-table tr').cells].map(
        (cell) => cell.style.width,
      ),
    )
  assert.deepEqual(await widths(), ['200px', '180px'])
  // The one column left is written with outer pipes: its cell is rewritten.
  assert.equal(
    await harness.evaluate(() => {
      window.tables.view().dispatch({ selection: { anchor: 2 } })
      return window.tables.runTableAction('column-delete')
    }),
    true,
  )
  assert.deepEqual(await widths(), ['180px'])
  await harness.keyboard.press(undoKey)
  assert.equal((await state()).doc, doc)
  assert.deepEqual(await widths(), ['200px', '180px'])
})

test('a resize stores only the size it changed', {
  timeout: 30000,
}, async () => {
  const key = tableKey(0, ['a', 'b'])
  await harness.evaluate(
    (key) =>
      window.tables.layouts('axis', [
        { key, columns: [200, 0], rows: [0, 50] },
      ]),
    key,
  )
  await mountTab('| a | b |\n| - | - |\n| 1 | 2 |\n\nafter', 'axis')
  await harness
    .locator('.hibi-lp-table th')
    .first()
    .locator('.hibi-lp-table-resizer[data-axis="column"]')
    .focus()
  await harness.keyboard.press('ArrowRight')
  await harness.waitForFunction(() => window.tables.writes('axis').length > 0)
  assert.deepEqual(await harness.evaluate(() => window.tables.writes('axis')), [
    {
      remove: [],
      put: [],
      set: [{ key, axis: 'column', index: 0, size: 208 }],
    },
  ])
  assert.deepEqual((await layouts('axis'))[0].rows, [0, 50])
})

test('the first resize of a table stores only that size', {
  timeout: 30000,
}, async () => {
  await harness.evaluate(() => window.tables.layouts('first', []))
  await mountTab('| a | b |\n| - | - |\n| 1 | 2 |\n\nafter', 'first')
  await harness
    .locator('.hibi-lp-table th')
    .first()
    .locator('.hibi-lp-table-resizer[data-axis="column"]')
    .focus()
  await harness.keyboard.press('ArrowRight')
  await harness.waitForFunction(() => window.tables.writes('first').length > 0)
  const [write] = await harness.evaluate(() => window.tables.writes('first'))
  // Another window's first sizes for the table merge with this one.
  assert.deepEqual(
    [
      write.remove,
      write.put,
      write.set.map(({ axis, index }) => [axis, index]),
    ],
    [[], [], [['column', 0]]],
  )
})

test('moving 1,000 sized rows stores their heights in batches the workspace accepts', {
  timeout: 60000,
}, async () => {
  const rows = Array.from({ length: 1001 }, (_, i) => `| r${i} | x |`)
  const doc = `| a | b |\n| - | - |\n${rows.join('\n')}\n\nafter`
  // Every row a different height, so moving them all down changes each.
  const heights = [0, ...rows.map((_, i) => 24 + i)]
  await harness.evaluate(
    ({ key, heights }) =>
      window.tables.layouts('batches', [{ key, columns: null, rows: heights }]),
    { key: tableKey(0, ['a', 'b']), heights },
  )
  await mountTab(doc, 'batches')
  await harness.evaluate(async () => {
    for (let i = 0; i < 500 && !document.querySelector('.hibi-lp-table'); i++)
      await new Promise((done) => setTimeout(done, 20))
    await window.tables.settle()
  })
  assert.equal(
    await harness.evaluate((at) => {
      window.tables.view().dispatch({ selection: { anchor: at } })
      return window.tables.runTableAction('row-before')
    }, doc.indexOf('| r0') + 2),
    true,
  )
  await harness.waitForFunction(
    () =>
      window.tables.layouts('batches')[0]?.rows?.[2] === 24 &&
      window.tables.layouts('batches')[0]?.rows?.length === 1003,
  )
  const writes = await harness.evaluate(() => window.tables.writes('batches'))
  assert.ok(writes.length > 1, `${writes.length} writes`)
  assert.ok(
    writes.every((write) => (write.set?.length ?? 0) <= 1000),
    JSON.stringify(writes.map((write) => write.set?.length)),
  )
  assert.equal((await layouts('batches'))[0].rows[1], 0)
})

test('columns with the same header keep their own widths through a column delete and undo', {
  timeout: 30000,
}, async () => {
  const doc = '| Name | Name |\n| - | - |\n| 1 | 2 |\n\nafter'
  await harness.evaluate(
    (key) =>
      window.tables.layouts('twins', [
        { key, columns: [200, 180], rows: null },
      ]),
    tableKey(0, ['Name', 'Name']),
  )
  await mountTab(doc, 'twins')
  const widths = () =>
    harness.evaluate(() =>
      [...document.querySelector('.hibi-lp-table tr').cells].map(
        (cell) => cell.style.width,
      ),
    )
  assert.equal(
    await harness.evaluate(
      (at) => {
        window.tables.view().dispatch({ selection: { anchor: at } })
        return window.tables.runTableAction('column-delete')
      },
      doc.indexOf('Name |') + 'Name | '.length + 1,
    ),
    true,
  )
  assert.deepEqual(await widths(), ['200px'])
  await harness.keyboard.press(undoKey)
  assert.equal((await state()).doc, doc)
  assert.deepEqual(await widths(), ['200px', '180px'])
})

test('empty headers keep their own widths through a column delete and undo', {
  timeout: 30000,
}, async () => {
  const doc = '|  |  |\n| - | - |\n| 1 | 2 |\n\nafter'
  await harness.evaluate(
    (key) =>
      window.tables.layouts('empty', [
        { key, columns: [200, 180], rows: null },
      ]),
    tableKey(0, ['', '']),
  )
  await mountTab(doc, 'empty')
  const widths = () =>
    harness.evaluate(() =>
      [...document.querySelector('.hibi-lp-table tr').cells].map(
        (cell) => cell.style.width,
      ),
    )
  assert.deepEqual(await widths(), ['200px', '180px'])
  assert.equal(
    await harness.evaluate(() => {
      window.tables.view().dispatch({ selection: { anchor: 5 } })
      return window.tables.runTableAction('column-delete')
    }),
    true,
  )
  assert.deepEqual(await widths(), ['200px'])
  await harness.keyboard.press(undoKey)
  assert.equal((await state()).doc, doc)
  assert.deepEqual(await widths(), ['200px', '180px'])
})

test('moving rows stored by index stays within the workspace bound in every batch', {
  timeout: 60000,
}, async () => {
  const rows = Array.from({ length: 2001 }, (_, i) => `| r${i} | x |`)
  const doc = `| a | b |\n| - | - |\n${rows.join('\n')}\n\nafter`
  // Rows 1,001 to 2,000 sized, each differently: all stored by index.
  const heights = Array.from({ length: 2001 }, (_, i) =>
    i > 1000 ? 24 + (i % 900) : 0,
  )
  await harness.evaluate(
    ({ key, heights }) =>
      window.tables.layouts('bound', [{ key, columns: null, rows: heights }]),
    { key: tableKey(0, ['a', 'b']), heights },
  )
  await mountTab(doc, 'bound')
  await harness.evaluate(async () => {
    for (let i = 0; i < 500 && !document.querySelector('.hibi-lp-table'); i++)
      await new Promise((done) => setTimeout(done, 20))
    await window.tables.settle()
  })
  // Deleting a row above moves each sized row up by one.
  assert.equal(
    await harness.evaluate((at) => {
      window.tables.view().dispatch({ selection: { anchor: at } })
      return window.tables.runTableAction('row-delete')
    }, doc.indexOf('| r0') + 2),
    true,
  )
  await harness.waitForFunction(
    (expected) => window.tables.layouts('bound')[0]?.rows?.[1999] === expected,
    24 + (2000 % 900),
  )
  const stored = (await layouts('bound'))[0].rows
  assert.deepEqual(
    [stored[1000], stored[1999], stored[2000] ?? 0],
    [24 + (1001 % 900), 24 + (2000 % 900), 0],
  )
})

test('a save that waits for the workspace stays ahead of the next one', {
  timeout: 60000,
}, async () => {
  const rows = Array.from({ length: 1001 }, (_, i) => `| r${i} | x |`)
  const doc = `| a | b |\n| - | - |\n${rows.join('\n')}\n\nafter`
  const heights = [0, ...rows.map((_, i) => 24 + i)]
  await harness.evaluate(
    ({ key, heights }) =>
      window.tables.layouts('queue', [{ key, columns: null, rows: heights }]),
    { key: tableKey(0, ['a', 'b']), heights },
  )
  await mountTab(doc, 'queue')
  await harness.evaluate(async () => {
    for (let i = 0; i < 500 && !document.querySelector('.hibi-lp-table'); i++)
      await new Promise((done) => setTimeout(done, 20))
    await window.tables.settle()
    window.tables.holdWrites(true)
  })
  // A row inserted above every sized row: a save of two batches, the first waiting.
  assert.equal(
    await harness.evaluate((at) => {
      window.tables.view().dispatch({ selection: { anchor: at } })
      return window.tables.runTableAction('row-before')
    }, doc.indexOf('| r0') + 2),
    true,
  )
  await harness.waitForFunction(() => window.tables.writes('queue').length > 0)
  // Undo saves the heights back while the first save still waits.
  await harness.keyboard.press(undoKey)
  assert.equal((await state()).doc, doc)
  await harness.evaluate(async () => {
    for (let i = 0; i < 10; i++) await window.tables.settle()
    window.tables.holdWrites(false)
  })
  await harness.waitForFunction(
    (expected) =>
      JSON.stringify(window.tables.layouts('queue')[0]?.rows) === expected,
    JSON.stringify(heights),
    { timeout: 5000 },
  )
})

test('typing in a cell writes escaped source into that cell only', {
  timeout: 30000,
}, async () => {
  const doc = '| a | b |\n| - | - |\n| c |\n\nafter'
  await mount(doc)
  await harness.locator('.hibi-lp-table td', { hasText: 'c' }).click()
  await harness.keyboard.press('End')
  await harness.keyboard.type('|x\\')
  // A pipe is escaped; a last backslash keeps a space before the delimiter.
  assert.match((await state()).doc, /^\| c\\\|x\\ \|$/m)
  // The row's missing cell gets its delimiters on the first input.
  await harness.keyboard.press('Tab')
  await harness.keyboard.type('new')
  assert.match((await state()).doc, /^\| c\\\|x\\ \| new \|$/m)
  await harness.evaluate(async () => {
    const data = new DataTransfer()
    data.setData('text/plain', 'one\ntwo')
    document
      .querySelector('.hibi-lp-cell-editor .cm-content')
      .dispatchEvent(new ClipboardEvent('paste', { clipboardData: data }))
  })
  assert.match((await state()).doc, /\| newone<br>two \|$/m)
  await harness.keyboard.press(
    process.platform === 'darwin' ? 'Meta+z' : 'Control+z',
  )
  assert.match((await state()).doc, /\| new \|$/m)
  // Inline formatting shortcuts format the cell's source.
  await harness.keyboard.press('Home')
  await harness.keyboard.press('Shift+End')
  await harness.keyboard.press(
    process.platform === 'darwin' ? 'Meta+b' : 'Control+b',
  )
  assert.match((await state()).doc, /\| \*\*new\*\* \|$/m)
  await harness.keyboard.press(
    process.platform === 'darwin' ? 'Meta+z' : 'Control+z',
  )
  // The table renders the source after leaving it.
  await harness.keyboard.press('Escape')
  const cells = await harness.evaluate(() =>
    [...document.querySelectorAll('.hibi-lp-table tr')].map((row) =>
      [...row.cells].map((cell) => cell.innerText.trim()),
    ),
  )
  assert.deepEqual(cells, [
    ['a', 'b'],
    ['c|x\\', 'new'],
  ])
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

const markdown = async () =>
  (await page.evaluate(() => window.hibi.getDocument())).markdown
/** Wait until the app's document matches `check`, line by line. */
const saved = async (check) => {
  try {
    await waitForAsync(
      page,
      async (check) =>
        new RegExp(check, 'm').test((await window.hibi.getDocument()).markdown),
      check.source,
    )
  } catch {
    assert.match(await markdown(), check)
  }
}
let formatted = false
/** Open the note in the app's formatted view, once. */
const openFormatted = async () => {
  if (formatted) return
  formatted = true
  // Quitting with the edited note answers the unsaved-changes prompt.
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 })
  })
  await page.evaluate(() => {
    localStorage.setItem('hibi:formatted-engine', 'codemirror')
    localStorage.setItem('hibi:toolbar', JSON.stringify({ autoHide: false }))
  })
  await page.reload()
  await waitForDocumentEditor(app, page)
  await pressShortcut(
    app,
    process.platform === 'darwin' ? 'Meta+o' : 'Control+o',
  )
  await page.locator('.rich-pane .hibi-lp-table').first().waitFor()
  // Hidden windows have no focus; editors need a focused page.
  const session = await page.context().newCDPSession(page)
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: true })
}

test('in the app, cells edit their source in place, undo and run the toolbar table actions', {
  timeout: 90000,
}, async () => {
  await openFormatted()
  await page
    .locator('.rich-pane .hibi-lp-table td', { hasText: 'two | pipe' })
    .click()
  await page.keyboard.press('End')
  await page.keyboard.type('!')
  await saved(/^\| two \\\| pipe! \| \[link\]/)
  const row = (await markdown())
    .split('\n')
    .find((text) => text.startsWith('| two'))
  assert.deepEqual(
    parseRow(row).cells.map(({ from, to }) => row.slice(from, to)),
    ['two \\| pipe!', '[link](https://example.com/) ~~gone~~', '22'],
  )
  // The page's key reaches the focused cell editor, which undoes through the document.
  await page.keyboard.press(
    process.platform === 'darwin' ? 'Meta+z' : 'Control+z',
  )
  await saved(/^\| two \\\| pipe \| \[link\]/)
  // The toolbar's table actions edit the table around the cell; block
  // actions, which would break the row, are off there.
  const bar = page.getByRole('navigation', { name: /editor toolbar/i })
  await page.waitForFunction(
    () =>
      document.querySelector('[data-toolbar-id="format.heading-1"]')
        ?.disabled === true &&
      !!document.querySelector('[data-toolbar-id="format.row-after"]'),
  )
  const run = async (id) => {
    const action = bar.locator(`[data-toolbar-id="format.${id}"]`)
    if (
      !(await action.evaluate(
        (element) =>
          !element.closest('.toolbar-menu') ||
          element.closest('.toolbar-menu').matches(':popover-open'),
      ))
    )
      await bar
        .getByRole('button', { name: /^more formatting actions$/i })
        .click()
    await action.click()
  }
  await run('row-after')
  await saved(/^\| two \\\| pipe \|.*\n\| {2}\| {2}\| {2}\| {2}\|$/)
  await run('column-after')
  await saved(/^\| Name \| {2}\| \*\*Bold\*\* head \|/)
  await run('column-delete')
  await saved(/^\| Name \| \*\*Bold\*\* head \|/)
  await run('row-delete')
  assert.doesNotMatch(await markdown(), /^\| {2}\| {2}\| {2}\| {2}\|$/m)
  await run('table-delete')
  await waitForAsync(
    page,
    async () =>
      !(await window.hibi.getDocument()).markdown.includes('| Name |'),
  )
  assert.match(
    await markdown(),
    /A paragraph before the table\.\n\n\| col 0 \|/,
  )
})

test('in the app, a composition in a cell undoes as one step', {
  timeout: 60000,
}, async () => {
  await openFormatted()
  await page
    .locator('.rich-pane .hibi-lp-table td')
    .filter({ hasText: /^value 1$/ })
    .click()
  await page.keyboard.press('End')
  const cdp = await page.context().newCDPSession(page)
  // Converting moves the selection inside the composition between changes.
  for (const [text, from, to] of [
    ['に', 1, 1],
    ['にほ', 2, 2],
    ['日本', 0, 2],
    ['日本', 2, 2],
    ['日本語', 3, 3],
  ])
    await cdp.send('Input.imeSetComposition', {
      text,
      selectionStart: from,
      selectionEnd: to,
    })
  await cdp.send('Input.insertText', { text: '日本語' })
  await saved(/^\| value 0 \| value 1日本語 \| value 2 \|/)
  await page.keyboard.press(undoKey)
  await saved(/^\| value 0 \| value 1 \| value 2 \|/)
})

test('in the app, undo and redo in a cell do nothing while the view takes no input', {
  timeout: 60000,
}, async () => {
  await openFormatted()
  await page
    .locator('.rich-pane .hibi-lp-table td')
    .filter({ hasText: /^value 2$/ })
    .click()
  await page.keyboard.press('End')
  await page.keyboard.type('X')
  await saved(/\| value 2X \| value 3 \|/)
  const before = await markdown()
  // Flip the editor's own read-only and editable switch, as while its
  // input is not ready.
  const readOnly = await page.evaluate(() => {
    const view = document.querySelector('.rich-pane .cm-content').cmTile.root
      .view
    const [compartment, access] = [...view.state.config.compartments].find(
      ([, value]) =>
        Array.isArray(value) &&
        value.length === 2 &&
        value.every((part) => part.facet && typeof part.value === 'boolean'),
    )
    window.restoreInput = () =>
      view.dispatch({ effects: compartment.reconfigure(access) })
    view.dispatch({
      effects: compartment.reconfigure(
        access.map((part) => part.facet.of(!part.value)),
      ),
    })
    return view.state.readOnly
  })
  assert.equal(readOnly, true)
  const settled = () =>
    page.evaluate(async () => {
      for (let frame = 0; frame < 3; frame++)
        await new Promise(requestAnimationFrame)
      return (await window.hibi.getDocument()).markdown
    })
  const results = []
  for (const key of [
    undoKey,
    process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y',
  ]) {
    await page.keyboard.press(key)
    results.push(await settled())
  }
  await page.evaluate(() => window.restoreInput())
  assert.deepEqual(results, [before, before])
  // Input again: undo reaches the document's history.
  await page.keyboard.press(undoKey)
  await saved(/\| value 2 \| value 3 \|/)
})
