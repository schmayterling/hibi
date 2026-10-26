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
