import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test, { afterEach } from 'node:test'
import { build } from 'vite'
import { parseRow } from '../src/renderer/src/formatted/table-source.ts'
import { tableKey } from '../src/renderer/src/table-layout-store.ts'
import { bundledColorschemes } from '../src/shared/color-palettes.ts'
import { COLOR_TOKENS } from '../src/shared/colorschemes.ts'
import {
  after,
  before,
  electron,
  waitForDocumentEditor,
  waitForFormattedEditor,
} from './electron.mjs'
import { recordEvents, reportFailure } from './failure-state.mjs'
import { defaultPane, frozenSnapshot } from './frozen-oracle.mjs'
import {
  clickMenu,
  pressShortcut,
  redoKey,
  withHeldClock,
} from './keyboard.mjs'
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
// What the formatted view drew while it matched the removed rich view.
const check = frozenSnapshot('formatted-tables')
const tablesView = 'window.tables.view()'
const documentView = `document.querySelector('.rich-pane [aria-label="Document editor"]')?.cmTile?.root.view`

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
    // Colors are read once transitions to the new palette end.
    return Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation instanceof CSSTransition)
        .map((animation) => animation.finished.catch(() => {})),
    )
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
      args: [
        resolve('.'),
        '--force-device-scale-factor=1',
        `--user-data-dir=${join(folder, 'profile')}`,
      ],
    })
    page = await app.firstWindow()
    page.setDefaultTimeout(10000)
    await waitForFormattedEditor(app, page)
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
      .locator('.rich-pane .hibi-lp-h1', { hasText: 'Formatted tables' })
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
    await harness.waitForFunction(() => Boolean(window.tables))
    // Hidden windows have no focus; keys and markers need a focused editor.
    const focus = await harness.context().newCDPSession(harness)
    await focus.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await recordEvents(harness)
  },
  { timeout: 90000 },
)

afterEach(async (t) => {
  await reportFailure(t, harness, tablesView)
  await reportFailure(t, page, documentView)
})

after(
  async () => {
    await app?.close()
    if (folder) await rm(folder, { recursive: true, force: true })
  },
  { timeout: 30000 },
)

/**
 * Every table in view in a pane, by its header text: its cells' boxes, text
 * and styles, and where it is from the document's top, or above the closing
 * paragraph when the pane is scrolled down (the formatted view estimates the
 * height of text it has not rendered). Tables out of view are left out: how
 * far past the view the formatted view renders depends on when it last
 * measured.
 */
const tables = (target, fromEnd) =>
  target.evaluate((fromEnd) => {
    const pane = document.querySelector('.rich-pane')
    const origin = pane.getBoundingClientRect()
    const closing = [...pane.querySelectorAll('p, .cm-line')]
      .find((element) => element.textContent.startsWith('Closing paragraph'))
      ?.getBoundingClientRect().top
    return [...pane.querySelectorAll('table')].flatMap((table) => {
      const frame = table.getBoundingClientRect()
      if (frame.bottom <= origin.top || frame.top >= origin.bottom) return []
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

/** Each top-level block the pane draws in view: its tag, classes and computed paint, and its box. */
const drawn = (target) =>
  target.evaluate(() => {
    const pane = document.querySelector('.rich-pane')
    const origin = pane.getBoundingClientRect()
    const keys = [
      'color',
      'backgroundColor',
      'fontSize',
      'fontWeight',
      'fontStyle',
      'textDecorationLine',
      'opacity',
    ]
    // As with tables, how far past the view blocks render depends on when
    // the formatted view last measured.
    const blocks = [...pane.querySelectorAll('.cm-content > *')].filter(
      (element) => {
        const box = element.getBoundingClientRect()
        return box.bottom > origin.top && box.top < origin.bottom
      },
    )
    return {
      blocks: blocks.map((element) => {
        const style = getComputedStyle(element)
        return {
          element: [
            element.tagName.toLowerCase(),
            ...[...element.classList]
              .filter((name) => !/^cm-(active|focused)/.test(name))
              .sort(),
          ].join('.'),
          ...Object.fromEntries(keys.map((key) => [key, style[key]])),
        }
      }),
      boxes: blocks.map((element) => {
        const box = element.getBoundingClientRect()
        return [
          box.left - origin.left,
          box.top - origin.top,
          box.width,
          box.height,
        ].map((value) => Math.round(value))
      }),
    }
  })

test('tables in the formatted view keep the rich view’s recorded cells, text and styles in light and dark', {
  timeout: 60000,
}, async () => {
  await harness.evaluate(({ doc, pane }) => window.tables.mount(doc, pane), {
    doc: note,
    pane: defaultPane,
  })
  for (const id of ['hibi-light', 'hibi-dark']) {
    await applyPalette(harness, palette(id))
    // The formatted view renders the tables near the visible part: check
    // them at the top and the bottom of the note.
    const compared = new Set()
    for (const fraction of [0, 1]) {
      await scroll(harness, fraction)
      for (const { at, rows, ...table } of await tables(
        harness,
        fraction === 1,
      )) {
        // The same cells, at the same places, with the same text and styles
        // as the rich view drew them.
        check(`${id} ${fraction} ${table.header} cells`, {
          ...table,
          rows: rows.map((row) => row.map(({ box, ...cell }) => cell)),
        })
        check(
          `${id} ${fraction} ${table.header} boxes`,
          { at, cells: rows.map((row) => row.map(({ box }) => box)) },
          { tolerance: 1 },
        )
        compared.add(table.header)
      }
    }
    assert.equal(compared.size, 4, [...compared].join(' / '))
    // In place of the pane's pixels, compared with the rich view's while it
    // existed: what the pane draws around the tables.
    await scroll(harness, 0)
    const { blocks, boxes } = await drawn(harness)
    check(`${id} blocks`, blocks)
    check(`${id} block boxes`, boxes, { tolerance: 1 })
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

test('a scroll that puts a row a long table has not drawn at the top shows it there', {
  timeout: 120000,
}, async () => {
  const result = await harness.evaluate(async () => {
    const preview = window.tables
    const rows = Array.from({ length: 10000 }, (_, i) => `| row ${i} | v${i} |`)
    // The note starts with the table. Lines above it would leave the drawn
    // part of the note as the pane scrolls this far, which moves what follows
    // by a few pixels in the formatted view, tables or not.
    const doc = `| a | b |\n| --- | --- |\n${rows.join('\n')}\n\nAfter.\n`
    await preview.mount(doc, { width: 1000, height: 800 }, { editable: true })
    const view = preview.view()
    for (let i = 0; i < 500 && !document.querySelector('.hibi-lp-table'); i++)
      await new Promise((done) => setTimeout(done, 20))
    await preview.settle()
    const table = document.querySelector('.hibi-lp-table')
    let added = 0
    const observer = new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes)
          if (node.nodeName === 'TR') added++
    })
    observer.observe(table.querySelector('tbody'), { childList: true })
    // Body row 6000 is the table's line 6002.
    const row = () => table.querySelector('tr[data-line="6002"]')
    const drawn = !!row()
    const at = doc.indexOf('row 6000 ')
    // Reading where the row is, as code does and CodeMirror does while it
    // measures, places it in the table without drawing it.
    const box = view.coordsAtPos(at)
    // Below the table's top: one-line rows measure the estimate's height, so
    // the row draws there.
    const estimate = box && box.top - table.getBoundingClientRect().top
    await new Promise((done) =>
      view.requestMeasure({ read: () => view.coordsAtPos(at), write: done }),
    )
    await preview.settle()
    const bounds = table.getBoundingClientRect()
    const reading = {
      added,
      inside:
        !!box && box.top > bounds.top + 1 && box.bottom < bounds.bottom - 1,
    }
    added = 0
    view.dispatch({
      effects: view.constructor.scrollIntoView(at, { y: 'start' }),
    })
    // Where the row's text is below the pane's top, once the table has
    // drawn and measured the rows the pane shows.
    const top = () => {
      const cell = row()?.querySelector('td')
      if (!cell) return null
      const text = document.createRange()
      text.selectNodeContents(cell.querySelector('p') ?? cell)
      const pane = document.querySelector('.rich-pane')
      return text.getBoundingClientRect().top - pane.getBoundingClientRect().top
    }
    await preview.settle()
    await preview.settle()
    const first = top()
    await preview.settle()
    observer.disconnect()
    const drawnAt =
      row() &&
      row().getBoundingClientRect().top - table.getBoundingClientRect().top
    return {
      drawn,
      reading,
      first,
      later: top(),
      scrolled: added,
      estimated: drawnAt === null ? null : Math.abs(estimate - drawnAt),
    }
  })
  assert.equal(result.drawn, false, 'the row starts undrawn')
  assert.deepEqual(
    result.reading,
    { added: 0, inside: true },
    JSON.stringify(result),
  )
  assert.ok(
    result.estimated !== null && result.estimated < 1,
    JSON.stringify(result),
  )
  // CodeMirror leaves a few pixels above the line it scrolls to the top.
  assert.ok(
    result.first !== null && result.first >= 0 && result.first < 20,
    JSON.stringify(result),
  )
  assert.equal(result.later, result.first, 'the row stays where it was put')
  // The scroll draws the rows of about two panes, not the table's.
  assert.ok(result.scrolled < 200, JSON.stringify(result))
})

test('a scroll to a row a long table has not drawn lands on it when rows are taller than the estimate', {
  timeout: 120000,
}, async () => {
  const result = await harness.evaluate(async () => {
    const preview = window.tables
    // Every fifth row breaks a cell over three lines: drawn, the rows around
    // the target measure taller than the estimate the scroll started from,
    // and ten of them on a side cover less than the pane.
    const rows = Array.from(
      { length: 10000 },
      (_, i) => `| row ${i} | ${i % 5 ? `v${i}` : 'a<br>b<br>c'} |`,
    )
    const doc = `| a | b |\n| --- | --- |\n${rows.join('\n')}\n\nAfter.\n`
    await preview.mount(doc, { width: 1000, height: 800 }, { editable: true })
    const view = preview.view()
    for (let i = 0; i < 500 && !document.querySelector('.hibi-lp-table'); i++)
      await new Promise((done) => setTimeout(done, 20))
    await preview.settle()
    const table = document.querySelector('.hibi-lp-table')
    const pane = document.querySelector('.rich-pane')
    // How far row `index`'s text is below the pane's top and above its bottom.
    const place = (index) => {
      const cell = table
        .querySelector(`tr[data-line="${index + 2}"]`)
        ?.querySelector('td')
      if (!cell) return null
      const text = document.createRange()
      text.selectNodeContents(cell.querySelector('p') ?? cell)
      const box = text.getBoundingClientRect()
      const bounds = pane.getBoundingClientRect()
      return { top: box.top - bounds.top, bottom: bounds.bottom - box.bottom }
    }
    // Scrolls to a row nothing has drawn or measured, as the start or the end
    // of the pane, and where it is then and one settle later.
    const scroll = async (index, y) => {
      const drawn = place(index) !== null
      view.dispatch({
        effects: view.constructor.scrollIntoView(doc.indexOf(`row ${index} `), {
          y,
        }),
      })
      await preview.settle()
      await preview.settle()
      const first = place(index)?.[y === 'start' ? 'top' : 'bottom'] ?? null
      await preview.settle()
      const later = place(index)?.[y === 'start' ? 'top' : 'bottom'] ?? null
      return { drawn, first, later }
    }
    return {
      start: await scroll(6001, 'start'),
      end: await scroll(3001, 'end'),
    }
  })
  for (const side of ['start', 'end']) {
    const { drawn, first, later } = result[side]
    assert.equal(drawn, false, `the row starts undrawn: ${side}`)
    // CodeMirror leaves a few pixels between the line and the pane's edge.
    assert.ok(
      first !== null && first >= 0 && first < 20,
      JSON.stringify(result),
    )
    assert.equal(later, first, `the row stays where it was put: ${side}`)
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

/** Runs pointer actions with Shift held (mouse actions take no modifiers), then reads the state. */
const shifted = async (run) => {
  await harness.keyboard.down('Shift')
  try {
    await run()
  } finally {
    await harness.keyboard.up('Shift')
  }
  return state()
}

/** The page point inside the character after the `offset`th of `word`, in lines or cells. */
const at = (word, offset) =>
  harness.evaluate(
    ({ word, offset }) => {
      const walker = document.createTreeWalker(
        window.tables.view().contentDOM,
        NodeFilter.SHOW_TEXT,
      )
      while (walker.nextNode()) {
        const i = walker.currentNode.data.indexOf(word)
        if (i < 0) continue
        const range = document.createRange()
        range.setStart(walker.currentNode, i + offset)
        range.setEnd(walker.currentNode, i + offset + 1)
        const { left, top, height } = range.getBoundingClientRect()
        return { x: left + 1, y: top + height / 2 }
      }
    },
    { word, offset },
  )

/** The text of the cells that hold the page selection's ends, after the view draws. */
const pick = () =>
  harness.evaluate(async () => {
    for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame)
    const selection = getSelection()
    const cell = (node) => node?.parentElement?.closest('td, th')?.textContent
    return [cell(selection.anchorNode), cell(selection.focusNode)]
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
  // From an edited cell, the selection keeps its anchor in the cell's text,
  // as in the rich editor.
  await harness.locator('.hibi-lp-table td', { hasText: 'x' }).click()
  await harness.keyboard.press('End')
  await harness.locator('.cm-line', { hasText: 'before' }).click({
    modifiers: ['Shift'],
  })
  const extended = await state()
  assert.equal(extended.anchor, doc.indexOf('x |') + 1)
  assert.ok(extended.head < doc.indexOf('| a'), String(extended.head))
  assert.equal(extended.editor, null)
})

test('shift-drag and shift-double-click from an edited cell keep the anchor in the cell, as the rich editor did', {
  timeout: 30000,
}, async () => {
  const doc =
    'one two three\n\n| a | b |\n| --- | --- |\n| x | y |\n\nfour five six'
  const cell = doc.indexOf('x |') + 1
  await mount(doc)
  /** The page point just inside the character at `pos`. */
  const point = (pos) =>
    harness.evaluate((pos) => {
      const { left, top, bottom } = window.tables.view().coordsAtPos(pos, 1)
      return { x: left + 1, y: (top + bottom) / 2 }
    }, pos)
  const edit = async () => {
    await harness.locator('.hibi-lp-table td', { hasText: 'x' }).click()
    await harness.keyboard.press('End')
    assert.equal((await state()).editor, 'x')
  }
  // The head follows a drag that starts outside the table.
  await edit()
  const from = await point(doc.indexOf('two') + 1)
  const to = await point(1)
  const dragged = await shifted(async () => {
    await harness.mouse.move(from.x, from.y)
    await harness.mouse.down()
    await harness.mouse.move(to.x, to.y, { steps: 5 })
    await harness.mouse.up()
  })
  assert.deepEqual([dragged.anchor, dragged.head], [cell, 1])
  // A double-click extends to the click, before or after the table.
  await edit()
  const before = await point(doc.indexOf('two') + 1)
  const up = await shifted(() => harness.mouse.dblclick(before.x, before.y))
  assert.deepEqual([up.anchor, up.head], [cell, doc.indexOf('two') + 1])
  await edit()
  const after = await point(doc.indexOf('five') + 1)
  const down = await shifted(() => harness.mouse.dblclick(after.x, after.y))
  assert.deepEqual([down.anchor, down.head], [cell, doc.indexOf('five') + 1])
  assert.equal(down.editor, null)
  // Without a cell, so does the view's own shift-double-click.
  await harness.evaluate(() => {
    const view = window.tables.view()
    view.focus()
    view.dispatch({ selection: { anchor: 1 } })
  })
  const plain = await shifted(() => harness.mouse.dblclick(after.x, after.y))
  assert.deepEqual([plain.anchor, plain.head], [1, doc.indexOf('five') + 1])
})

test('a shift-drag from an edited cell back over the table picks across cells, as the rich editor did', {
  timeout: 30000,
}, async () => {
  const doc =
    'one two three\n\n| a | bb |\n| --- | --- |\n| cell | tail |\n\nfour five six'
  const cell = doc.indexOf('cell') + 4
  await mount(doc)
  await harness.locator('.hibi-lp-table td', { hasText: 'cell' }).click()
  await harness.keyboard.press('End')
  assert.equal((await state()).editor, 'cell')
  const from = await at('two', 1)
  const header = await at('bb', 1)
  const back = await at('cell', 3)
  let over, inCell, picks
  const end = await shifted(async () => {
    await harness.mouse.move(from.x, from.y)
    await harness.mouse.down()
    await harness.mouse.move(header.x, header.y, { steps: 6 })
    over = await state()
    picks = [await pick()]
    // Back in the edited cell, no cell editor opens until the drag ends.
    await harness.mouse.move(back.x, back.y, { steps: 6 })
    inCell = await state()
    picks.push(await pick())
    await harness.mouse.up()
  })
  // Over another cell, the head is in that cell's text, drawn as a pick.
  assert.deepEqual(
    [over.anchor, over.head, over.editor],
    [cell, doc.indexOf('bb') + 1, null],
  )
  assert.deepEqual(picks[0], ['cell', 'bb'])
  assert.deepEqual(
    [inCell.anchor, inCell.head, inCell.editor],
    [cell, doc.indexOf('cell') + 3, null],
  )
  assert.deepEqual(picks[1], ['cell', 'cell'])
  // The drag ends with the cell's editor selecting the dragged text.
  assert.deepEqual(
    [end.anchor, end.head, end.editor],
    [cell, doc.indexOf('cell') + 3, 'cell'],
  )
  assert.equal(await harness.evaluate(() => getSelection().toString()), 'l')
})

test('shift-triple-click from an edited cell selects the clicked paragraph, as the rich editor did', {
  timeout: 30000,
}, async () => {
  const doc =
    'one two three\n\n| a | b |\n| --- | --- |\n| x | y |\n\nfour five six'
  await mount(doc)
  const point = (pos) =>
    harness.evaluate((pos) => {
      const { left, top, bottom } = window.tables.view().coordsAtPos(pos, 1)
      return { x: left + 1, y: (top + bottom) / 2 }
    }, pos)
  for (const [word, range] of [
    ['two', [0, doc.indexOf('\n')]],
    ['five', [doc.indexOf('four'), doc.length]],
  ]) {
    await harness.locator('.hibi-lp-table td', { hasText: 'x' }).click()
    await harness.keyboard.press('End')
    assert.equal((await state()).editor, 'x')
    const { x, y } = await point(doc.indexOf(word) + 1)
    const tripled = await shifted(() =>
      harness.mouse.click(x, y, { clickCount: 3 }),
    )
    assert.deepEqual(
      [tripled.anchor, tripled.head, tripled.editor],
      [...range, null],
      word,
    )
  }
})

test("triple-click selects the clicked block's text, with or without Shift, as the rich editor did", {
  timeout: 30000,
}, async () => {
  const doc =
    'alpha line\nbeta line\n\n- item words\n- [ ] task words\n  - nested words\n\n> qa line\n> qb line\n\n## heading words ##\n\n```\ncode one\ncode two\n```\n\n| aa | bb |\n| --- | --- |\n| cell words | tail |\n\nend words there'
  await mount(doc)
  // A paragraph's lines, a heading's or item's text without its markers, and
  // a code block's lines: never the line break after them.
  const blocks = [
    ['alpha', 'alpha line\nbeta line'],
    ['beta', 'alpha line\nbeta line'],
    ['item words', 'item words'],
    ['task words', 'task words'],
    ['nested words', 'nested words'],
    ['qb line', 'qa line\n> qb line'],
    ['heading words', 'heading words'],
    ['code two', 'code one\ncode two'],
    ['end words', 'end words there'],
  ]
  const tripled = async (word, shift) => {
    const start = await at(word === 'end words' ? 'alpha' : 'end words', 1)
    await harness.mouse.click(start.x, start.y)
    const { x, y } = await at(word, 2)
    const click = () => harness.mouse.click(x, y, { clickCount: 3 })
    if (!shift) await click()
    const { anchor, head, editor } = shift
      ? await shifted(click)
      : await state()
    return [doc.slice(anchor, head), editor]
  }
  for (const shift of [false, true])
    for (const [word, text] of blocks)
      assert.deepEqual(
        await tripled(word, shift),
        [text, null],
        `${shift ? 'shift ' : ''}${word}`,
      )
  // In a cell, at a person's pace, the cell's editor selects the cell's text.
  const start = await at('end words', 1)
  await harness.mouse.click(start.x, start.y)
  const { x, y } = await at('cell words', 2)
  await harness.mouse.move(x, y)
  for (let clickCount = 1; clickCount <= 3; clickCount++) {
    await harness.mouse.down({ clickCount })
    await harness.mouse.up({ clickCount })
    await harness.evaluate(() => new Promise((done) => setTimeout(done, 100)))
  }
  const cell = await state()
  assert.deepEqual(
    [doc.slice(cell.anchor, cell.head), cell.editor],
    ['cell words', 'cell words'],
  )
  // Presses in the open editor keep it focused and open, so clicks with no
  // gap between them select the cell's text too, from a rendered cell or
  // from the open editor.
  for (const edited of [false, true]) {
    const start = await at('end words', 1)
    await harness.mouse.click(start.x, start.y)
    const { x, y } = await at('cell words', 2)
    if (edited) await harness.mouse.click(x, y)
    const editor = await harness.evaluateHandle(() =>
      document.querySelector('.hibi-lp-cell-editor'),
    )
    await harness.mouse.click(x, y, { clickCount: 3 })
    const tripled = await state()
    assert.deepEqual(
      [doc.slice(tripled.anchor, tripled.head), tripled.editor],
      ['cell words', 'cell words'],
      edited ? 'edited' : 'rendered',
    )
    if (edited)
      assert.ok(
        await editor.evaluate((element) => element.isConnected),
        'the editor stays open',
      )
  }
})

test("a shift-drag from a cell into another table's cells keeps the anchor, as the rich editor did", {
  timeout: 30000,
}, async () => {
  const doc =
    'one two\n\n| a1 | b1 |\n| --- | --- |\n| first cell | first tail |\n\nbetween words here\n\n| a2 | b2 |\n| --- | --- |\n| second cell | second tail |\n\nend words'
  const anchor = doc.indexOf('first cell') + 3
  await mount(doc)
  await harness.locator('.hibi-lp-table td', { hasText: 'first cell' }).click()
  await harness.keyboard.press('Home')
  for (let i = 0; i < 3; i++) await harness.keyboard.press('ArrowRight')
  assert.equal((await state()).editor, 'first cell')
  const from = await at('between', 2)
  const into = await at('second cell', 8)
  const next = await at('second tail', 4)
  const steps = []
  const end = await shifted(async () => {
    await harness.mouse.move(from.x, from.y)
    await harness.mouse.down()
    await harness.mouse.move(into.x, into.y, { steps: 5 })
    steps.push([await state(), await pick()])
    await harness.mouse.move(next.x, next.y, { steps: 5 })
    steps.push([await state(), await pick()])
    await harness.mouse.move(into.x, into.y, { steps: 5 })
    await harness.mouse.up()
  })
  // The head follows the pointer through the other table's cell text.
  assert.deepEqual(
    steps.map(([{ anchor, head }, cells]) => [anchor, head, cells]),
    [
      [anchor, doc.indexOf('second cell') + 8, ['first cell', 'second cell']],
      [anchor, doc.indexOf('second tail') + 4, ['first cell', 'second tail']],
    ],
  )
  assert.deepEqual(
    [end.anchor, end.head, end.editor],
    [anchor, doc.indexOf('second cell') + 8, null],
  )
})

test("a shift-press in another table's cell extends the selection there", {
  timeout: 30000,
}, async () => {
  // The formatted view keeps the anchor in its cell, and the head follows
  // the pointer through the other table's cells, as from outside the tables.
  const doc =
    'one two\n\n| a1 | b1 |\n| --- | --- |\n| first cell | first tail |\n\nbetween words here\n\n| a2 | b2 |\n| --- | --- |\n| second cell | second tail |\n\nend words'
  await mount(doc)
  await harness.locator('.hibi-lp-table td', { hasText: 'first cell' }).click()
  await harness.keyboard.press('Home')
  for (let i = 0; i < 3; i++) await harness.keyboard.press('ArrowRight')
  const from = await at('second cell', 2)
  const next = await at('second tail', 4)
  const end = await shifted(async () => {
    await harness.mouse.move(from.x, from.y)
    await harness.mouse.down()
    await harness.mouse.move(next.x, next.y, { steps: 5 })
    await harness.mouse.up()
  })
  assert.deepEqual(
    [end.anchor, end.head, end.editor],
    [doc.indexOf('first cell') + 3, doc.indexOf('second tail') + 4, null],
  )
  assert.deepEqual(await pick(), ['first cell', 'second tail'])
})

/** `at`, asserting that the point hits the text there. */
const hitAt = async (word, offset) => {
  const point = await at(word, offset)
  assert.ok(
    await harness.evaluate(
      ({ x, y, word }) =>
        document.elementFromPoint(x, y)?.textContent.includes(word),
      { ...point, word },
    ),
    word,
  )
  return point
}

test('shift-double-click extends the selection to the click, and a drag from it follows the pointer, as the rich editor did', {
  timeout: 60000,
}, async () => {
  const doc =
    'one two three\n\n| a | b |\n| --- | --- |\n| x | yy pipe tail |\n\nfour five six'
  const cell = doc.indexOf('x |') + 1
  await mount(doc)
  const formatted = {}
  const place = (anchor) =>
    harness.evaluate((anchor) => {
      const view = window.tables.view()
      view.focus()
      view.dispatch({ selection: { anchor } })
    }, anchor)
  const edit = async () => {
    await harness.locator('.hibi-lp-table td', { hasText: /^x$/ }).click()
    await harness.keyboard.press('End')
    assert.equal((await state()).editor, 'x')
  }
  const dbl = (point) => () => harness.mouse.dblclick(point.x, point.y)
  await place(2)
  formatted.text = await shifted(dbl(await hitAt('five', 2)))
  await edit()
  formatted.cell = await shifted(dbl(await hitAt('five', 2)))
  await harness.locator('.hibi-lp-table td', { hasText: 'yy pipe' }).click()
  await harness.keyboard.press('Home')
  await harness.keyboard.press('ArrowRight')
  formatted.inCell = await shifted(dbl(await hitAt('pipe', 2)))
  await place(2)
  const start = await hitAt('five', 2)
  const end = await hitAt('six', 1)
  formatted.drag = await shifted(async () => {
    await harness.mouse.move(start.x, start.y)
    await harness.mouse.down({ clickCount: 1 })
    await harness.mouse.up({ clickCount: 1 })
    await harness.mouse.down({ clickCount: 2 })
    await harness.mouse.move(end.x, end.y, { steps: 6 })
    await harness.mouse.up({ clickCount: 2 })
  })
  const ends = ({ anchor, head }) => [anchor, head]
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(formatted).map(([name, value]) => [name, ends(value)]),
    ),
    {
      text: [2, doc.indexOf('five') + 2],
      cell: [cell, doc.indexOf('five') + 2],
      inCell: [doc.indexOf('yy') + 1, doc.indexOf('pipe') + 2],
      drag: [2, doc.indexOf('six') + 1],
    },
  )
})

test('shift-triple-click on a cell selects its text from outside the cells and extends from a cell, as the rich editor did', {
  timeout: 60000,
}, async () => {
  // The formatted view's cell editor selects the clicked cell's text, as on
  // a triple-click; from a cell, the selection extends as on a shift-click.
  const doc =
    'before words\n\n| a | b |\n| --- | --- |\n| x | cell words |\n\nafter'
  await mount(doc)
  const target = await hitAt('cell words', 2)
  const triple = () =>
    harness.mouse.click(target.x, target.y, { clickCount: 3 })
  const start = await hitAt('before', 2)
  await harness.mouse.click(start.x, start.y)
  const outside = await shifted(triple)
  assert.deepEqual(
    [outside.anchor, outside.head, outside.editor],
    [doc.indexOf('cell words'), doc.indexOf('cell words') + 10, 'cell words'],
  )
  const fromCell = async (run) => {
    await harness.locator('.hibi-lp-table td', { hasText: /^x$/ }).click()
    await harness.keyboard.press('End')
    assert.equal((await state()).editor, 'x')
    const end = await shifted(run)
    return [end.anchor, end.head, end.editor, await pick()]
  }
  const clicked = await fromCell(() => harness.mouse.click(target.x, target.y))
  assert.deepEqual(clicked, [
    doc.indexOf('x |') + 1,
    doc.indexOf('cell words') + 2,
    null,
    ['x', 'cell words'],
  ])
  assert.deepEqual(await fromCell(triple), clicked)
})

test('a drag from a cell selects its text and picks across cells, as the rich editor did', {
  timeout: 30000,
}, async () => {
  const doc =
    'one two\n\n| a | bb |\n| --- | --- |\n| cell words | tail end |\n\nfour five'
  const cell = doc.indexOf('cell words')
  await mount(doc)
  // From a cell as it shows and from the cell's open editor.
  for (const open of [false, true]) {
    const away = await at('five', 1)
    await harness.mouse.click(away.x, away.y)
    if (open)
      await harness.locator('.hibi-lp-table td', { hasText: 'cell' }).click()
    const from = await at('cell words', 1)
    const within = await at('cell words', 7)
    const across = await at('tail end', 3)
    const steps = []
    await harness.mouse.move(from.x, from.y)
    await harness.mouse.down()
    await harness.mouse.move(within.x, within.y, { steps: 5 })
    steps.push(await state())
    await harness.mouse.move(across.x, across.y, { steps: 5 })
    steps.push(await state())
    const cells = await pick()
    await harness.mouse.move(within.x, within.y, { steps: 5 })
    await harness.mouse.up()
    const end = await state()
    assert.deepEqual(
      steps.map(({ anchor, head }) => [anchor, head]),
      [
        [cell + 1, cell + 7],
        [cell + 1, doc.indexOf('tail end') + 3],
      ],
      `open ${open}`,
    )
    assert.deepEqual(cells, ['cell words', 'tail end'], `open ${open}`)
    // The drag ends with the cell's editor selecting the dragged text.
    assert.deepEqual(
      [end.anchor, end.head, end.editor],
      [cell + 1, cell + 7, 'cell words'],
      `open ${open}`,
    )
    assert.equal(
      await harness.evaluate(() => getSelection().toString()),
      'ell wo',
    )
  }
})

test('a drag from a cell scrolls a wide table sideways at the pane edges, as the rich editor did; a shift-drag does not', {
  timeout: 30000,
}, async () => {
  const columns = Array.from({ length: 30 }, (_, i) => i)
  const doc = `| ${columns.map((i) => `col ${i}`).join(' | ')} |\n| ${columns.map(() => '---').join(' | ')} |\n| ${columns.map((i) => `value ${i}`).join(' | ')} |\n\nafter`
  await harness.evaluate(
    (doc) =>
      window.tables.mount(doc, { width: 600, height: 400 }, { editable: true }),
    doc,
  )
  const pane = () =>
    harness.evaluate(() => {
      const pane = document.querySelector('.rich-pane')
      const { left, right } = pane.getBoundingClientRect()
      return {
        left,
        right,
        scrollLeft: pane.scrollLeft,
        wide: pane.scrollWidth > pane.clientWidth,
      }
    })
  const wait = () =>
    harness.evaluate(() => new Promise((done) => setTimeout(done, 400)))
  const box = await pane()
  assert.ok(box.wide, JSON.stringify(box))
  const from = await at('value 1', 2)
  const over = await at('value 2', 2)
  await harness.mouse.move(from.x, from.y)
  await harness.mouse.down()
  await harness.mouse.move(over.x, over.y, { steps: 4 })
  const before = await state()
  // Held right of the pane, the drag scrolls it and the head follows.
  await harness.mouse.move(box.right + 20, over.y, { steps: 4 })
  await wait()
  const held = [await pane(), await state()]
  await harness.mouse.up()
  const stopped = (await pane()).scrollLeft
  await wait()
  assert.ok(held[0].scrollLeft > 0, JSON.stringify(held[0]))
  assert.equal(held[1].anchor, doc.indexOf('value 1') + 2)
  assert.ok(held[1].head > before.head, JSON.stringify([held[1], before]))
  assert.equal((await pane()).scrollLeft, stopped)
  // A shift-drag from an edited cell follows the pointer without scrolling sideways.
  await harness.evaluate(() => {
    document.querySelector('.rich-pane').scrollLeft = 0
  })
  await harness.locator('.hibi-lp-table td', { hasText: 'value 0' }).click()
  const shift = await shifted(async () => {
    await harness.mouse.move(from.x, from.y)
    await harness.mouse.down()
    await harness.mouse.move(over.x, over.y, { steps: 4 })
    await harness.mouse.move(box.right + 20, over.y, { steps: 4 })
    await wait()
    await harness.mouse.up()
  })
  assert.equal((await pane()).scrollLeft, 0)
  assert.ok(shift.head > doc.indexOf('value 2'), JSON.stringify(shift))
})

test('a shift-drag from an edited cell scrolls at the pane edges', {
  timeout: 30000,
}, async () => {
  const lines = Array.from({ length: 80 }, (_, i) => `line ${i}`)
  const doc = `| a | b |\n| --- | --- |\n| x | y |\n\n${lines.join('\n\n')}`
  await harness.evaluate(
    (doc) =>
      window.tables.mount(
        doc,
        { width: 1000, height: 400 },
        { editable: true },
      ),
    doc,
  )
  const pane = () =>
    harness.evaluate(() => {
      const pane = document.querySelector('.rich-pane')
      const { top, bottom, left } = pane.getBoundingClientRect()
      return { top, bottom, left, scrollTop: pane.scrollTop }
    })
  const wait = () =>
    harness.evaluate(() => new Promise((done) => setTimeout(done, 400)))
  await harness.locator('.hibi-lp-table td', { hasText: 'x' }).click()
  await harness.keyboard.press('End')
  assert.equal((await state()).editor, 'x')
  const cell = doc.indexOf('x |') + 1
  const box = await pane()
  const start = await harness.evaluate((pos) => {
    const { left, top, bottom } = window.tables.view().coordsAtPos(pos, 1)
    return { x: left + 1, y: (top + bottom) / 2 }
  }, doc.indexOf('line 2'))
  let down, stopped, up
  await shifted(async () => {
    await harness.mouse.move(start.x, start.y)
    await harness.mouse.down()
    // Held below the pane, the drag scrolls it and the head follows.
    await harness.mouse.move(start.x, box.bottom + 20, { steps: 4 })
    const before = await state()
    await wait()
    down = [await pane(), await state(), before]
    // Back above the pane, it scrolls up again.
    await harness.mouse.move(start.x, box.top + 2, { steps: 4 })
    const scrolled = (await pane()).scrollTop
    await wait()
    up = [(await pane()).scrollTop, scrolled]
    await harness.mouse.up()
    stopped = (await pane()).scrollTop
    await wait()
  })
  assert.ok(down[0].scrollTop > 0, JSON.stringify(down[0]))
  assert.equal(down[1].anchor, cell)
  assert.ok(down[1].head > down[2].head, JSON.stringify([down[1], down[2]]))
  assert.ok(up[0] < up[1], JSON.stringify(up))
  // Releasing the button stops scrolling.
  assert.equal((await pane()).scrollTop, stopped)
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

test('physical typing replaces a selection over a table and undo restores it', async () => {
  const table = '| a | b |\n| - | - |\n| c | d |'
  for (const doc of [table, `before\n\n${table}\n\nafter`]) {
    await mount(doc)
    await harness.evaluate(() => window.tables.view().focus())
    await harness.keyboard.press('ControlOrMeta+a')
    assert.deepEqual(
      await harness.evaluate(() => {
        const { from, to } = window.tables.view().state.selection.main
        return [from, to]
      }),
      [0, doc.length],
    )
    await harness.keyboard.press('r')
    assert.equal((await state()).doc, 'r')
    await harness.keyboard.press('ControlOrMeta+z')
    assert.equal((await state()).doc, doc)
    assert.equal(await harness.locator('.hibi-lp-table').count(), 1)
  }
})

test('composed, option and altgr text replaces a selection over a table in one undo step', {
  timeout: 30000,
}, async () => {
  const table = '| a | b |\n| - | - |\n| c | d |'
  const cdp = await harness.context().newCDPSession(harness)
  const select = async (doc) => {
    await mount(doc)
    await harness.evaluate(() => window.tables.view().focus())
    await harness.keyboard.press('ControlOrMeta+a')
  }
  const undone = async (doc, label) => {
    await harness.keyboard.press('ControlOrMeta+z')
    assert.equal((await state()).doc, doc, label)
  }
  for (const doc of [table, `before\n\n${table}\n\nafter`]) {
    // An IME takes the key that starts a composition: keyCode 229, not yet composing.
    await select(doc)
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'k',
      code: 'KeyK',
      windowsVirtualKeyCode: 229,
      nativeVirtualKeyCode: 229,
    })
    await cdp.send('Input.imeSetComposition', {
      text: 'k',
      selectionStart: 1,
      selectionEnd: 1,
    })
    await cdp.send('Input.insertText', { text: 'か' })
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'k',
      code: 'KeyK',
      windowsVirtualKeyCode: 229,
    })
    await harness.evaluate(() => window.tables.settle())
    assert.equal((await state()).doc, 'か')
    await undone(doc, 'composition')
    // Option (Alt) characters on macOS; AltGr is Control and Alt on Windows.
    for (const [modifiers, text, code] of [
      [1, 'å', 'KeyA'],
      [3, '@', 'KeyQ'],
    ]) {
      await select(doc)
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: text,
        code,
        text,
        unmodifiedText: code.at(-1).toLowerCase(),
        modifiers,
        windowsVirtualKeyCode: code.charCodeAt(3),
      })
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: text,
        code,
        modifiers,
        windowsVirtualKeyCode: code.charCodeAt(3),
      })
      assert.equal((await state()).doc, text)
      await undone(doc, text)
    }
  }
  await cdp.detach()
})

/** Selects `range` (the whole note by default) in a focused harness editor. */
const selectRange = async (doc, range = [0, doc.length]) => {
  await mount(doc)
  await harness.evaluate((range) => {
    const view = window.tables.view()
    view.focus()
    view.dispatch({ selection: { anchor: range[0], head: range[1] } })
  }, range)
}
/** The range replaced by `text`, then one undo restores the note and redo the text. */
const replacedOnce = async (doc, [from, to], text, label) => {
  await harness.evaluate(() => window.tables.settle())
  const typed = doc.slice(0, from) + text + doc.slice(to)
  assert.equal((await state()).doc, typed, label)
  await harness.keyboard.press('ControlOrMeta+z')
  assert.equal((await state()).doc, doc, label)
  // The harness binds CodeMirror's history keymap: redo is Ctrl+Y on Windows.
  await harness.keyboard.press(redoKey)
  assert.equal((await state()).doc, typed, label)
}
const compose = async (cdp, ...candidates) => {
  for (const text of candidates)
    await cdp.send('Input.imeSetComposition', {
      text,
      selectionStart: text.length,
      selectionEnd: text.length,
    })
}
const overTableTable = '| a | b |\n| - | - |\n| c | d |'
const overTableNotes = [
  overTableTable,
  `before\n\n${overTableTable}\n\nafter`,
  `${overTableTable}\n\nafter`,
]

test('a dead key composes over a selection over a table in one undo step', {
  timeout: 30000,
}, async () => {
  const cdp = await harness.context().newCDPSession(harness)
  for (const doc of overTableNotes) {
    await selectRange(doc)
    // A dead key starts a composition with its own key code, not 229.
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'Dead',
      code: 'Quote',
      windowsVirtualKeyCode: 222,
      nativeVirtualKeyCode: 222,
    })
    await compose(cdp, '´', 'é')
    await cdp.send('Input.insertText', { text: 'é' })
    await replacedOnce(doc, [0, doc.length], 'é', doc)
  }
  await cdp.detach()
})

test('a composition that starts without a key replaces a selection over a table in one undo step', {
  timeout: 30000,
}, async () => {
  const cdp = await harness.context().newCDPSession(harness)
  for (const doc of overTableNotes) {
    await selectRange(doc)
    await harness.evaluate(() =>
      window.tables
        .view()
        .contentDOM.dispatchEvent(
          new CompositionEvent('compositionstart', { bubbles: true }),
        ),
    )
    await compose(cdp, '´', 'é')
    await cdp.send('Input.insertText', { text: 'é' })
    await replacedOnce(doc, [0, doc.length], 'é', `compositionstart ${doc}`)
  }
  // The table alone selected: the view's own observer clears only selections over several lines.
  const doc = `before\n\n${overTableTable}\n\nafter`
  const table = [doc.indexOf('|'), doc.lastIndexOf('|') + 1]
  await selectRange(doc, table)
  await compose(cdp, 'n', 'ni', '你')
  await cdp.send('Input.insertText', { text: '你' })
  await replacedOnce(doc, table, '你', 'table')
  await cdp.detach()
})

test('text without a key, as from dictation, replaces a selection over a table', {
  timeout: 30000,
}, async () => {
  const cdp = await harness.context().newCDPSession(harness)
  for (const doc of overTableNotes.slice(1)) {
    await selectRange(doc)
    await cdp.send('Input.insertText', { text: '👍' })
    await replacedOnce(doc, [0, doc.length], '👍', doc)
  }
  await cdp.detach()
})

test('a late first candidate keeps a composition over a table one undo step', {
  timeout: 30000,
}, async () => {
  const cdp = await harness.context().newCDPSession(harness)
  for (const doc of overTableNotes) {
    await selectRange(doc)
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'k',
      code: 'KeyK',
      windowsVirtualKeyCode: 229,
      nativeVirtualKeyCode: 229,
    })
    // History groups edits by their time; the IME answers a second later.
    await harness.evaluate(() => {
      const now = Date.now
      Date.now = () => now() + 1000
      window.restoreNow = () => {
        Date.now = now
      }
    })
    try {
      await compose(cdp, 'k', 'か')
      await cdp.send('Input.insertText', { text: 'か' })
      await replacedOnce(doc, [0, doc.length], 'か', doc)
    } finally {
      await harness.evaluate(() => window.restoreNow())
    }
  }
  await cdp.detach()
})

test('a composition from inside a table to past it composes in the table source at the caret, in one undo step', {
  timeout: 30000,
}, async () => {
  const cdp = await harness.context().newCDPSession(harness)
  const doc = `before\n\n${overTableTable}\n\nafter`
  const inner = doc.indexOf('| c') + 3
  // To the end of the note, and into the text after the table.
  for (const range of [
    [inner, doc.length],
    [inner, doc.length - 2],
  ]) {
    await selectRange(doc, range)
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'k',
      code: 'KeyK',
      windowsVirtualKeyCode: 229,
      nativeVirtualKeyCode: 229,
    })
    await compose(cdp, 'k', 'か')
    await cdp.send('Input.insertText', { text: 'か' })
    await replacedOnce(doc, range, 'か', `${range}`)
    // The table shows its source while the caret is in it, as a table again after.
    await harness.evaluate(() =>
      window.tables.view().dispatch({ selection: { anchor: 0 } }),
    )
    await harness.evaluate(() => window.tables.settle())
    assert.equal(await harness.locator('.hibi-lp-table').count(), 1)
  }
  await cdp.detach()
})

test('undoing a composition from inside a table to past it shows the tables it restores', {
  timeout: 30000,
}, async () => {
  const cdp = await harness.context().newCDPSession(harness)
  const doc = `before\n\n${overTableTable}\n\nafter\n\n${overTableTable}\n\nend`
  const range = [doc.indexOf('| c') + 3, doc.length]
  await selectRange(doc, range)
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'k',
    code: 'KeyK',
    windowsVirtualKeyCode: 229,
    nativeVirtualKeyCode: 229,
  })
  await compose(cdp, 'k', 'か')
  await cdp.send('Input.insertText', { text: 'か' })
  await harness.evaluate(() => window.tables.settle())
  assert.equal((await state()).doc, `${doc.slice(0, range[0])}か`)
  await harness.keyboard.press('ControlOrMeta+z')
  await harness.evaluate(() => window.tables.settle())
  assert.equal((await state()).doc, doc)
  assert.equal(await harness.locator('.hibi-lp-table').count(), 2)
  await cdp.detach()
})

test('an echo before the first composition candidate keeps one undo step', {
  timeout: 30000,
}, async () => {
  const cdp = await harness.context().newCDPSession(harness)
  const doc = `before\n\n${overTableTable}\n\nafter\n\n${overTableTable}\n\nend`
  const range = [doc.indexOf('| c') + 3, doc.indexOf('after') + 2]
  await selectRange(doc, range)
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'k',
    code: 'KeyK',
    windowsVirtualKeyCode: 229,
    nativeVirtualKeyCode: 229,
  })
  await harness.evaluate(() => window.tables.echo('!'))
  await harness.evaluate(() => window.tables.settle())
  const focused = await harness.evaluate(() => {
    const view = window.tables.view()
    return document.activeElement === view.contentDOM
  })
  await compose(cdp, 'k', 'か')
  await cdp.send('Input.insertText', { text: 'か' })
  await harness.evaluate(() => window.tables.settle())
  const expected = `${doc.slice(0, range[0])}か${doc.slice(range[1])}!`
  assert.equal((await state()).doc, expected)
  await harness.keyboard.press('ControlOrMeta+z')
  await harness.evaluate(() => window.tables.settle())
  assert.equal((await state()).doc, `${doc}!`)
  assert.equal(focused, true)
  assert.equal(await harness.locator('.hibi-lp-table').count(), 2)
  await harness.keyboard.press(
    process.platform === 'win32' ? 'Control+y' : 'ControlOrMeta+Shift+z',
  )
  await harness.evaluate(() => window.tables.settle())
  assert.equal((await state()).doc, expected)
  await cdp.detach()
})

for (const action of ['cancel', 'navigate', 'blur'])
  test(`an unfinished composition releases its revealed table on ${action}`, {
    timeout: 30000,
  }, async () => {
    const cdp = await harness.context().newCDPSession(harness)
    const doc = `before\n\n${overTableTable}\n\nafter\n\n${overTableTable}\n\nend`
    const range = [doc.indexOf('| c') + 3, doc.indexOf('after') + 2]
    await selectRange(doc, range)
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'k',
      code: 'KeyK',
      windowsVirtualKeyCode: 229,
      nativeVirtualKeyCode: 229,
    })
    await harness.evaluate(() => window.tables.echo('!'))
    await harness.evaluate(() => window.tables.settle())
    if (action === 'cancel')
      await harness.evaluate(() => {
        const content = window.tables.view().contentDOM
        content.dispatchEvent(
          new CompositionEvent('compositionstart', { bubbles: true }),
        )
        content.dispatchEvent(
          new CompositionEvent('compositionend', { bubbles: true }),
        )
      })
    else if (action === 'navigate') await harness.keyboard.press('Escape')
    else await harness.evaluate(() => window.tables.view().contentDOM.blur())
    await harness.waitForFunction(
      () => document.querySelectorAll('.hibi-lp-table').length === 2,
    )
    assert.equal(
      (await state()).doc,
      `${doc.slice(0, range[0])}${doc.slice(range[1])}!`,
    )
    await harness.evaluate(() => {
      const view = window.tables.view()
      view.focus()
      view.dispatch({ selection: { anchor: 0 } })
    })
    await harness.keyboard.press('ControlOrMeta+z')
    await harness.evaluate(() => window.tables.settle())
    assert.equal((await state()).doc, `${doc}!`)
    await cdp.detach()
  })

test('an edit from elsewhere while composing in a table source waits for the composition to end', {
  timeout: 30000,
}, async () => {
  const cdp = await harness.context().newCDPSession(harness)
  const doc = `before\n\n${overTableTable}\n\nafter\n\n${overTableTable}\n\nend`
  const range = [doc.indexOf('| c') + 3, doc.indexOf('after') + 2]
  await selectRange(doc, range)
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'k',
    code: 'KeyK',
    windowsVirtualKeyCode: 229,
    nativeVirtualKeyCode: 229,
  })
  await compose(cdp, 'k')
  // Another view's edit arrives without an input event.
  await harness.evaluate(() => {
    const view = window.tables.view()
    view.dispatch({ changes: { from: view.state.doc.length, insert: '!' } })
  })
  await compose(cdp, 'か')
  await cdp.send('Input.insertText', { text: 'か' })
  await harness.evaluate(() => window.tables.settle())
  assert.equal(
    (await state()).doc,
    `${doc.slice(0, range[0])}か${doc.slice(range[1])}!`,
  )
  // Once the composition ends, the source shows as tables again.
  await harness.waitForFunction(
    () => document.querySelectorAll('.hibi-lp-table').length === 2,
  )
  await cdp.detach()
})

test('a note that is only a table takes text and compositions without a key over its selection', {
  timeout: 30000,
}, async () => {
  const cdp = await harness.context().newCDPSession(harness)
  for (const [candidates, text] of [
    [[], '👍'],
    [['n', 'ni', '你'], '你'],
  ]) {
    await mount(overTableTable)
    await harness.evaluate(() => window.tables.view().focus())
    await harness.keyboard.press('ControlOrMeta+a')
    await compose(cdp, ...candidates)
    await cdp.send('Input.insertText', { text })
    await replacedOnce(overTableTable, [0, overTableTable.length], text, text)
  }
  await cdp.detach()
})

test('typing and composing below a table that ends the note starts a paragraph below it', {
  timeout: 30000,
}, async () => {
  const cdp = await harness.context().newCDPSession(harness)
  for (const doc of [overTableTable, `before\n\n${overTableTable}`]) {
    for (const composed of [false, true]) {
      await mount(doc)
      const below = await harness.evaluate(() => {
        const { left, bottom } = document
          .querySelector('.hibi-lp-table')
          .getBoundingClientRect()
        return { x: left + 20, y: bottom + 8 }
      })
      await harness.mouse.click(below.x, below.y)
      assert.equal((await state()).head, doc.length, doc)
      if (composed) {
        await cdp.send('Input.dispatchKeyEvent', {
          type: 'rawKeyDown',
          key: 'k',
          code: 'KeyK',
          windowsVirtualKeyCode: 229,
          nativeVirtualKeyCode: 229,
        })
        await compose(cdp, 'k', 'か')
        await cdp.send('Input.insertText', { text: 'か' })
      } else await harness.keyboard.type('xy')
      await replacedOnce(
        doc,
        [doc.length, doc.length],
        composed ? '\n\nか' : '\n\nxy',
        `${doc} ${composed}`,
      )
    }
  }
  await cdp.detach()
})

test('typing replaces a selection from inside a table to past it, and keys still move over a selected table', {
  timeout: 30000,
}, async () => {
  const doc = 'before\n\n| a | b |\n| - | - |\n| c | d |\n\nafter'
  // A selection a find match could leave, from a row to the end.
  const from = doc.indexOf('| c')
  await mount(doc)
  await harness.evaluate((from) => {
    const view = window.tables.view()
    view.focus()
    view.dispatch({ selection: { anchor: from, head: view.state.doc.length } })
  }, from)
  await harness.keyboard.press('r')
  assert.equal((await state()).doc, `${doc.slice(0, from)}r`)
  await harness.keyboard.press('ControlOrMeta+z')
  assert.equal((await state()).doc, doc)
  // Shortcuts and arrows over a selected table type nothing.
  for (const [key, at] of [
    ['ArrowLeft', 0],
    ['ArrowRight', doc.length],
  ]) {
    await harness.keyboard.press('ControlOrMeta+a')
    await harness.keyboard.press(key)
    const now = await state()
    assert.deepEqual([now.doc, now.anchor, now.head], [doc, at, at], key)
  }
})

test('mod-enter in a table that ends the note leaves it for a paragraph below, as the rich editor did', {
  timeout: 30000,
}, async () => {
  const doc = 'before\n\n| a | b |\n| - | - |\n| c | d |'
  for (const cell of ['a', 'c']) {
    await mount(doc)
    await harness
      .locator('.hibi-lp-table :is(td, th)', { hasText: cell })
      .click()
    await harness.keyboard.press('ControlOrMeta+Enter')
    const now = await state()
    assert.deepEqual(
      [now.doc, now.head, now.editor],
      [`${doc}\n\n`, doc.length + 2, null],
      cell,
    )
    await harness.keyboard.press('ControlOrMeta+z')
    assert.equal((await state()).doc, doc, cell)
  }
  await harness.locator('.hibi-lp-table td', { hasText: 'd' }).click()
  await harness.keyboard.press('ControlOrMeta+Enter')
  await harness.keyboard.type('AFTER')
  assert.equal((await state()).doc, `${doc}\n\nAFTER`)
})

test('a selection in a table edits the cell it is in once the table has redrawn', {
  timeout: 30000,
}, async () => {
  // An edit before the table, made before the cell editor opens, moves the
  // table and the selection with it: the editor opens where the selection is.
  const doc = 'intro\n\n| a | b |\n| - | - |\n| x | y |\n\nafter'
  await mount(doc)
  await harness.evaluate((at) => {
    const view = window.tables.view()
    view.focus()
    view.dispatch({ selection: { anchor: at } })
    view.dispatch({ changes: { from: 0, insert: 'more ' } })
  }, doc.indexOf('y |'))
  await harness.evaluate(() => window.tables.settle())
  const now = await state()
  assert.deepEqual(
    [now.cell, now.editor, now.head],
    ['2:1', 'y', doc.indexOf('y |') + 'more '.length],
  )
})

test('a change that removes a table under the selection opens no cell editor in it', {
  timeout: 30000,
}, async () => {
  const errors = []
  const listen = (error) => errors.push(error.message)
  harness.on('pageerror', listen)
  // CodeMirror places a removed table's detached DOM at the start or the end
  // of the new document; neither may open an editor or move the selection.
  for (const [text, at] of [
    ['/h2', 3],
    ['q  r', 1],
  ]) {
    await mount('| a | b |\n| - | - |\n| /h2 | end |\n\n/h2')
    await harness.evaluate(
      ({ text, at }) => {
        const view = window.tables.view()
        view.focus()
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
          selection: { anchor: at },
        })
      },
      { text, at },
    )
    await harness.evaluate(() => window.tables.settle())
    const now = await state()
    assert.deepEqual(
      [now.doc, now.anchor, now.head, now.editor],
      [text, at, at, null],
    )
  }
  harness.off('pageerror', listen)
  assert.deepEqual(errors, [])
})

test('a <br> in a cell is one line break, drawn alike in the cell and its editor', {
  timeout: 30000,
}, async () => {
  await mount('| a | b |\n| --- | --- |\n| one<br>two | c |\n')
  const breaks = () =>
    harness.evaluate(() => {
      const cell = [...document.querySelectorAll('.hibi-lp-table td')].find(
        (cell) => cell.textContent.includes('two'),
      )
      return {
        editing: !!cell.querySelector('.hibi-lp-cell-editor'),
        breaks: cell.querySelectorAll('br').length,
      }
    })
  assert.deepEqual(await breaks(), { editing: false, breaks: 1 })
  await harness.locator('.hibi-lp-table td', { hasText: 'two' }).click()
  await harness.keyboard.press('End')
  assert.deepEqual(await breaks(), { editing: true, breaks: 1 })
})

test('cell editors move with tab and arrows and leave with escape', {
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
    'ArrowDown',
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

/** The text of the cell that holds the page selection's head, and the selected text. */
const tabbed = (target) =>
  target.evaluate(async () => {
    for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame)
    const selection = getSelection()
    const node = selection.focusNode
    const element = node?.nodeType === 1 ? node : node?.parentElement
    return [
      element?.closest('td, th')?.textContent.trim(),
      selection.toString(),
    ]
  })

test('tab and shift-tab select the text of the cell they move to, as the rich editor did', {
  timeout: 30000,
}, async () => {
  const keys = [
    ...[
      'Tab',
      'Tab',
      'Tab',
      'Shift+Tab',
      'Shift+Tab',
      'Shift+Tab',
      'Shift+Tab',
    ],
    ...['Tab', 'ArrowLeft', 'Shift+Tab', 'ArrowRight', 'Shift+Tab', 'Tab'],
    'ArrowDown',
  ]
  const expected = [
    ['b', 'b'],
    ['c', 'c'],
    ['d', 'd'],
    ['c', 'c'],
    ['b', 'b'],
    ['a', 'a'],
    // Shift+Tab in the first cell goes nowhere.
    ['a', 'a'],
    // Sideways arrows move from the selection's head: Left collapses it to
    // the cell's start, Right at the cell's end goes to the next cell.
    ['b', 'b'],
    ['b', ''],
    ['a', 'a'],
    ['b', ''],
    ['a', 'a'],
    ['b', 'b'],
  ]
  // table-tab-001: down from a selection, the rich editor took the
  // browser's line move through the cells in document order; the formatted
  // view moves to the cell below, as from a caret.
  const down = ['d', '']
  const doc = '- item\n\n  | a | b |\n  | - | - |\n  | c | d |\n\nafter'
  await mount(doc)
  await harness.locator('.hibi-lp-table th', { hasText: 'a' }).click()
  const formatted = []
  for (const key of keys) {
    await harness.keyboard.press(key)
    formatted.push(await tabbed(harness))
  }
  assert.deepEqual(formatted, [...expected, down])
  // Typing replaces the selected text, which is the cell's source.
  await mount(doc)
  await harness.locator('.hibi-lp-table th', { hasText: 'a' }).click()
  await harness.keyboard.press('Tab')
  await harness.keyboard.type('Y')
  assert.equal((await state()).doc, doc.replace('| b |', '| Y |'))
  await harness.keyboard.press('Shift+Tab')
  await harness.keyboard.type('X')
  assert.equal((await state()).doc, doc.replace('| a | b |', '| X | Y |'))
  // A cell's formatting is part of its selected source.
  const marked = '| a | b |\n| - | - |\n| **c** d | e |'
  await mount(marked)
  await harness.locator('.hibi-lp-table td', { hasText: 'e' }).click()
  await harness.keyboard.press('Shift+Tab')
  const { anchor, head } = await state()
  assert.equal(marked.slice(anchor, head), '**c** d')
})

const undoKey = process.platform === 'darwin' ? 'Meta+z' : 'Control+z'

test('enter, shift-enter and mod-enter break the line in a cell, as the rich editor did', {
  timeout: 30000,
}, async () => {
  const doc = '| a | b |\n| --- | --- |\n|  | x |\n\nafter'
  await mount(doc)
  await harness.locator('.hibi-lp-table td').first().click()
  await harness.keyboard.press('Enter')
  await harness.keyboard.type('cell')
  let now = await state()
  assert.deepEqual([now.cell, now.editor], ['2:0', 'cell'])
  assert.match(now.doc, /^\| <br>cell \| x \|$/m)
  // The last cell of the last row keeps editing; each key adds a break there.
  await harness.locator('.hibi-lp-table td', { hasText: 'x' }).click()
  await harness.keyboard.press('End')
  for (const key of ['Enter', 'Shift+Enter', 'ControlOrMeta+Enter'])
    await harness.keyboard.press(key)
  now = await state()
  assert.equal(now.cell, '2:1')
  assert.match(now.doc, /^\| <br>cell \| x<br><br><br> \|\n\nafter$/m)
})

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

test('a cell editor whose row is deleted edits the row now there after later changes', {
  timeout: 30000,
}, async () => {
  await mount(
    '| h |\n| - |\n| alpha |\n| beta |\n| gamma |\n| delta |\n\nafter',
  )
  await harness.locator('.hibi-lp-table td', { hasText: 'beta' }).click()
  await harness.keyboard.press('End')
  // Before the editor follows, another change adds a row above.
  await harness.evaluate(() => {
    const view = window.tables.view()
    const text = view.state.doc.toString()
    view.dispatch({
      changes: { from: text.indexOf('| beta'), to: text.indexOf('| gamma') },
    })
    // A DOM selection echo carries no new navigation intent.
    view.dispatch({
      selection: { anchor: view.state.doc.length },
      userEvent: 'select',
    })
    view.dispatch({
      changes: { from: text.indexOf('| alpha'), insert: '| NEW |\n' },
    })
  })
  await harness.evaluate(() => window.tables.settle())
  await harness.keyboard.press('End')
  await harness.keyboard.type('X')
  const now = await state()
  assert.deepEqual([now.cell, now.editor], ['4:0', 'gammaX'])
  assert.match(now.doc, /\| alpha \|\n\| gammaX \|\n\| delta \|/)
})

test('a later pointer selection supersedes deleted-row recovery', {
  timeout: 30000,
}, async () => {
  await mount('| h |\n| - |\n| alpha |\n| beta |\n| gamma |\n\nafter')
  await harness.locator('.hibi-lp-table td', { hasText: 'beta' }).click()
  await harness.evaluate(() => {
    const view = window.tables.view()
    const text = view.state.doc.toString()
    view.dispatch({
      changes: { from: text.indexOf('| beta'), to: text.indexOf('| gamma') },
    })
    view.focus()
    view.dispatch({
      selection: { anchor: view.state.doc.length },
      userEvent: 'select.pointer',
    })
  })
  await harness.evaluate(() => window.tables.settle())
  const now = await state()
  assert.equal(now.head, now.doc.length)
  assert.equal(now.editor, null)
})

test('a later keyboard selection supersedes pending deleted-row recovery', {
  timeout: 30000,
}, async () => {
  await mount('| h |\n| - |\n| alpha |\n| beta |\n| gamma |\n\nafter')
  await harness.locator('.hibi-lp-table td', { hasText: 'beta' }).click()
  const end = await harness.evaluate(() => {
    const view = window.tables.view()
    const text = view.state.doc.toString()
    view.dispatch({
      changes: { from: text.indexOf('| beta'), to: text.indexOf('| gamma') },
    })
    view.focus()
    const mac = /Mac/.test(navigator.platform)
    view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'End',
        keyCode: 35,
        metaKey: mac,
        ctrlKey: !mac,
        bubbles: true,
        cancelable: true,
      }),
    )
    return [view.state.selection.main.head, view.state.doc.length]
  })
  assert.equal(end[0], end[1])
  await harness.evaluate(() => window.tables.settle())
  const now = await state()
  assert.equal(now.head, end[1])
  assert.equal(now.editor, null)
})

test('escape and table-edge navigation wait for current table bounds', {
  timeout: 60000,
}, async (t) => {
  const doc =
    'intro\n\n| a | b |\n| - | - |\n' +
    Array.from(
      { length: 20000 },
      (_, index) => `| row ${index} | right${index} |`,
    ).join('\n') +
    '\n\nafter'
  for (const key of [
    'Escape',
    'ArrowUp',
    'ArrowLeft',
    'ArrowDown',
    'ArrowRight',
  ])
    for (const shrink of [false, true])
      await t.test(
        `${key} after table ${shrink ? 'shrink' : 'growth'}`,
        async () => {
          await harness.evaluate(
            (doc) =>
              window.tables.mount(
                doc,
                { width: 1000, height: 800 },
                { editable: true, slice: 0 },
              ),
            doc,
          )
          await harness.waitForFunction(() => !window.tables.settling())
          await harness.locator('.hibi-lp-table').waitFor()
          await harness.evaluate(() => window.tables.settle())
          const before = key === 'ArrowUp' || key === 'ArrowLeft'
          const target = before
            ? 'a'
            : key === 'Escape'
              ? 'right0'
              : 'right19999'
          if (target === 'right19999')
            await harness.locator('.rich-pane').evaluate((pane) => {
              pane.scrollTop = pane.scrollHeight
            })
          await harness
            .locator('.hibi-lp-table :is(th, td)', {
              hasText: new RegExp(`^${target}$`),
            })
            .click()
          const result = await harness.evaluate(
            ({ key, shrink, before }) => {
              const view = window.tables.view()
              const text = view.state.doc.toString()
              const editor = document.querySelector(
                '.hibi-lp-cell-editor .cm-content',
              )
              editor.focus()
              editor.dispatchEvent(
                new KeyboardEvent('keydown', {
                  key: before ? 'Home' : 'End',
                  bubbles: true,
                  cancelable: true,
                }),
              )
              view.dispatch({
                changes: [
                  { from: 0, insert: '~~~\n' },
                  shrink
                    ? {
                        from: text.indexOf('| row 10000'),
                        to: text.indexOf('\n\nafter'),
                      }
                    : { from: text.indexOf('row 0'), insert: 'Z'.repeat(200) },
                ],
              })
              const settling = window.tables.settling()
              const head = view.state.selection.main.head
              const doc = view.state.doc.toString()
              editor.dispatchEvent(
                new KeyboardEvent('keydown', {
                  key,
                  bubbles: true,
                  cancelable: true,
                }),
              )
              return {
                settling,
                head,
                after: view.state.selection.main.head,
                unchanged: doc === view.state.doc.toString(),
                connected: editor.isConnected,
              }
            },
            { key, shrink, before },
          )
          assert.equal(result.settling, true)
          assert.equal(result.after, result.head)
          assert.equal(result.unchanged, true)
          assert.equal(result.connected, true)
          // Once the snapshot is current, leaving works with the new bounds.
          await harness.evaluate(() =>
            window.tables.view().dispatch({ changes: { from: 0, to: 4 } }),
          )
          await harness.waitForFunction(() => !window.tables.settling())
          await harness.evaluate(() => window.tables.settle())
          const current =
            shrink && target === 'right19999' ? 'right9999' : target
          if ((await state()).editor?.trim() !== current) {
            // A parse that reached the table under the open fence drew it as
            // code, which dropped the cell's editor and the pane's place in
            // the table's rows: show the last row again to click it.
            if (target === 'right19999')
              await harness.locator('.rich-pane').evaluate((pane) => {
                pane.scrollTop = pane.scrollHeight
              })
            await harness
              .locator('.hibi-lp-table :is(th, td)', {
                hasText: new RegExp(`^${current}$`),
              })
              .click()
          }
          await harness.evaluate(
            ({ key, before }) => {
              const editor = document.querySelector(
                '.hibi-lp-cell-editor .cm-content',
              )
              for (const pressed of [before ? 'Home' : 'End', key])
                editor.dispatchEvent(
                  new KeyboardEvent('keydown', {
                    key: pressed,
                    bubbles: true,
                    cancelable: true,
                  }),
                )
            },
            { key, before },
          )
          const now = await state()
          assert.equal(now.editor, null)
          assert.equal(
            before
              ? now.head < now.doc.indexOf('| a')
              : now.head > now.doc.lastIndexOf('|'),
            true,
          )
        },
      )
})

test('unfinished syntax never resolves or writes cells with old spans', {
  timeout: 60000,
}, async () => {
  const doc =
    'intro\n\n| a | b |\n| - | - |\n' +
    Array.from(
      { length: 20000 },
      (_, index) => `| row ${index} | right${index} |`,
    ).join('\n') +
    '\n\nafter'
  for (const mode of ['input', 'follow', 'lookup', 'lookup-end']) {
    await harness.evaluate(
      (doc) =>
        window.tables.mount(
          doc,
          { width: 1000, height: 800 },
          { editable: true, slice: 0 },
        ),
      doc,
    )
    await harness.waitForFunction(() => !window.tables.settling())
    await recordEvents(harness, tablesView)
    const target = mode === 'lookup-end' ? 'right19999' : 'right0'
    if (mode === 'lookup-end') {
      await harness.evaluate((target) => {
        const view = window.tables.view()
        view.focus()
        view.dispatch({
          selection: { anchor: view.state.doc.toString().indexOf(target) },
        })
      }, target)
      await harness.evaluate(() => window.tables.settle())
    }
    await harness
      .locator('.hibi-lp-table td', { hasText: new RegExp(`^${target}$`) })
      .click()
    const result = await harness.evaluate(async (mode) => {
      const view = window.tables.view()
      const text = view.state.doc.toString()
      const target = mode === 'lookup-end' ? 'right19999' : 'right0'
      if (mode.startsWith('lookup')) view.focus()
      view.dispatch({
        changes: [
          { from: 0, insert: '~~~\n' },
          { from: text.indexOf('row 0'), insert: 'Z'.repeat(200) },
        ],
        ...(mode === 'input'
          ? {}
          : { selection: { anchor: text.indexOf(target) + 204 } }),
      })
      const settling = window.tables.settling()
      const before = view.state.doc.toString()
      const expected = view.state.selection.main.head
      await new Promise(queueMicrotask)
      const head = view.state.selection.main.head
      document.execCommand('insertText', false, 'Q')
      await new Promise(queueMicrotask)
      await new Promise(queueMicrotask)
      return {
        settling,
        before,
        expected,
        head,
        doc: view.state.doc.toString(),
      }
    }, mode)
    assert.equal(result.settling, true, mode)
    assert.equal(result.head, result.expected, mode)
    assert.equal(result.doc === result.before, true, mode)
    // Restore table syntax; queued recovery must retry after the new layout.
    await harness.evaluate(() =>
      window.tables.view().dispatch({ changes: { from: 0, to: 4 } }),
    )
    await harness.waitForFunction(() => window.tables.parsed())
    await harness.evaluate(() => window.tables.settle())
    const now = await state()
    assert.deepEqual(
      [now.cell, now.editor],
      [mode === 'lookup-end' ? '20001:1' : '2:1', target],
      mode,
    )
    await harness.keyboard.press('Home')
    await harness.keyboard.type('Q')
    assert.ok((await state()).doc.includes(`| Q${target} |`), mode)
  }
  // A settled parse may reuse its tree; its mapped widgets still need a new snapshot.
  await mount(doc)
  await harness.evaluate(() => {
    const view = window.tables.view()
    view.focus()
    view.dispatch({
      selection: { anchor: view.state.doc.toString().indexOf('right19998') },
    })
    view.dispatch({ changes: { from: 0, insert: 'prefix ' } })
  })
  await harness.evaluate(() => window.tables.settle())
  const now = await state()
  assert.deepEqual([now.cell, now.editor], ['20000:1', 'right19998'])
})

// Linked scrolling and the reading place line positions up with what
// coordsAtPos gives; until a changed table's layout comes, the table's edges
// would move the pane by up to half the table at each edit.
test('positions in a changed table measure at its rows until its layout comes', {
  timeout: 60000,
}, async () => {
  const rows = Array.from({ length: 30 }, (_, i) => `| r${i} | v${i} |`)
  const doc = `intro\n\n| a | b |\n| - | - |\n${rows.join('\n')}\n\n${'more text\n\n'.repeat(20000)}after`
  await harness.evaluate(
    (doc) =>
      window.tables.mount(
        doc,
        { width: 1000, height: 800 },
        { editable: true, slice: 0 },
      ),
    doc,
  )
  await harness.waitForFunction(() => !window.tables.settling())
  await harness.locator('.hibi-lp-table td', { hasText: /^v5$/ }).click()
  await harness.keyboard.press('End')
  const result = await harness.evaluate(() => {
    const view = window.tables.view()
    const editor = document.querySelector('.hibi-lp-cell-editor .cm-content')
      .cmTile.root.view
    // Typing in the cell, then an edit above the table, as from the other pane.
    editor.dispatch(editor.state.replaceSelection('Z'), {
      userEvent: 'input.type',
    })
    view.dispatch({ changes: { from: 0, insert: '~~~\n' } })
    const text = view.state.doc.toString()
    const caret = view.coordsAtPos(view.state.selection.main.head)
    const own = editor.coordsAtPos(editor.state.selection.main.head)
    const other = view.coordsAtPos(text.indexOf('r20 |') + 1)
    const row = document
      .querySelector('.hibi-lp-table tr[data-line="22"]')
      .getBoundingClientRect()
    return {
      settling: window.tables.settling(),
      caret: caret && [caret.left, caret.top, caret.bottom],
      own: [own.left, own.top, own.bottom],
      other: other && [other.top, other.bottom],
      row: [row.top, row.bottom],
    }
  })
  assert.equal(result.settling, true)
  // The edited cell's caret is its editor's.
  assert.deepEqual(result.caret, result.own)
  // Another row's position is in that row, not at the table's edges.
  assert.ok(
    result.other &&
      result.other[0] >= result.row[0] - 1 &&
      result.other[1] <= result.row[1] + 1,
    JSON.stringify(result),
  )
})

// Each text node of a cell maps its offsets through the cell's row: parsing
// the row for each of them made a position in a long cell cost the row's
// length for every text node before it (176 ms for 1,000 bold runs).
test('a position in a long cell reads its row once', {
  timeout: 30000,
}, async () => {
  const runs = Array.from({ length: 300 }, (_, i) => `x **b${i}** y`)
  await mount(`| long |\n| --- |\n| ${runs.join(' ')} |\n`)
  const slices = await harness.evaluate(() => {
    const view = window.tables.view()
    const at = view.state.doc.toString().indexOf('b299**') + 1
    view.coordsAtPos(at)
    const slice = String.prototype.slice
    let count = 0
    String.prototype.slice = function (...args) {
      count++
      return slice.apply(this, args)
    }
    try {
      view.coordsAtPos(at)
    } finally {
      String.prototype.slice = slice
    }
    return count
  })
  assert.ok(slices < 20, `${slices} string slices`)
})

// The edited cell's editor has the cell's text now and lays it out itself, so
// a position in that cell measures through the editor.
test('a position in the edited cell measures through its editor', {
  timeout: 30000,
}, async () => {
  await mount('| a | b |\n| - | - |\n| one | two |\n')
  await harness.locator('.hibi-lp-table td', { hasText: /^two$/ }).click()
  await harness.locator('.hibi-lp-cell-editor .cm-content').waitFor()
  const result = await harness.evaluate(() => {
    const view = window.tables.view()
    const editor = document.querySelector('.hibi-lp-cell-editor .cm-content')
      .cmTile.root.view
    const own = editor.coordsAtPos.bind(editor)
    let calls = 0
    editor.coordsAtPos = (...args) => {
      calls++
      return own(...args)
    }
    const box = view.coordsAtPos(view.state.doc.toString().indexOf('two') + 1)
    delete editor.coordsAtPos
    const caret = own(editor.state.doc.toString().indexOf('two') + 1)
    return {
      calls,
      box: box && [box.left, box.top, box.bottom],
      caret: caret && [caret.left, caret.top, caret.bottom],
    }
  })
  assert.equal(result.calls, 1, JSON.stringify(result))
  assert.deepEqual(result.box, result.caret)
})

test('a cell editor whose table a redraw removes gives focus back to the formatted view', {
  timeout: 30000,
}, async () => {
  await mount('before\n\n| a | b |\n| - | - |\n| c | d |')
  await harness.locator('.hibi-lp-table td', { hasText: 'c' }).click()
  // A fence opened above, from elsewhere, turns the table into code.
  await harness.evaluate(() =>
    window.tables.view().dispatch({ changes: { from: 0, insert: '~~~\n' } }),
  )
  await harness.waitForFunction(() => !window.tables.settling())
  await harness.evaluate(() => window.tables.settle())
  assert.equal(
    await harness.evaluate(() => window.tables.view().hasFocus),
    true,
  )
  await harness.evaluate(() =>
    window.tables.view().dispatch({ changes: { from: 0, to: 4 } }),
  )
  await harness.waitForFunction(() =>
    document.querySelector('.hibi-lp-cell-editor .cm-content:focus'),
  )
  await harness.keyboard.press('End')
  await harness.keyboard.type('W')
  assert.match((await state()).doc, /^\| cW \| d \|$/m)
})

test('a cell editor keeps editing its cell when another edit changes the columns or alignments', {
  timeout: 60000,
}, async (t) => {
  const doc = 'before\n\n| a | b |\n| - | - |\n| c | d |\n\nafter'
  // Edits from elsewhere, each the smallest change from a text to another.
  for (const [name, edits, cell, editor, row] of [
    [
      'column after',
      [
        ['| a | b |', '| a | b | e |'],
        ['| - | - |', '| - | - | - |'],
        ['| cX | d |', '| cX | d | f |'],
      ],
      '2:0',
      'cX',
      '| cXY | d | f |',
    ],
    [
      'column before',
      [
        ['| a', '| n | a'],
        ['| - | - |', '| - | - | - |'],
        ['| cX', '| m | cX'],
      ],
      '2:1',
      'cX',
      '| m | cXY | d |',
    ],
    ['alignment', [['| - | - |', '| :- | -: |']], '2:0', 'cX', '| cXY | d |'],
    // The edited cell is gone: editing goes on where its caret maps to.
    [
      'column gone',
      [
        ['| a | b |', '| b |'],
        ['| - | - |', '| - |'],
        ['| cX | d |', '| d |'],
      ],
      '2:0',
      'd',
      '| Yd |',
    ],
  ])
    await t.test(name, async () => {
      await mount(doc)
      await harness.locator('.hibi-lp-table td', { hasText: 'c' }).click()
      await harness.keyboard.press('End')
      await harness.keyboard.type('X')
      const mapped = await harness.evaluate((edits) => {
        const view = window.tables.view()
        const text = view.state.doc.toString()
        const changes = edits.map(([a, b]) => {
          let start = 0,
            end = 0
          while (a[start] === b[start]) start++
          while (
            end < Math.min(a.length, b.length) - start &&
            a.at(-1 - end) === b.at(-1 - end)
          )
            end++
          const at = text.indexOf(a)
          return {
            from: at + start,
            to: at + a.length - end,
            insert: b.slice(start, b.length - end),
          }
        })
        window.editedCell = document.activeElement
        view.dispatch({ changes })
        return view.state.selection.main.head
      }, edits)
      await harness.evaluate(() => window.tables.settle())
      const focus = await harness.evaluate(() => {
        const view = window.tables.view()
        return {
          inView: view.dom.contains(document.activeElement),
          inCell: !!document.activeElement.closest('.hibi-lp-cell-editor'),
          head: view.state.selection.main.head,
          // The editor of a cell that is still there goes on, with any
          // composition in it.
          kept: document.activeElement === window.editedCell,
        }
      })
      assert.deepEqual(focus, {
        inView: true,
        inCell: true,
        head: mapped,
        kept: name !== 'column gone',
      })
      const now = await state()
      assert.deepEqual([now.cell, now.editor], [cell, editor])
      await harness.keyboard.type('Y')
      assert.equal((await state()).doc.split('\n')[4], row)
    })
})

test('a cell editor keeps focus while scrolling moves the rows a long table renders away from its row', {
  timeout: 30000,
}, async () => {
  await mount(
    'intro\n\n| a | b |\n| - | - |\n' +
      Array.from({ length: 1000 }, (_, i) => `| row ${i} | r${i} |`).join('\n'),
  )
  await harness.locator('.hibi-lp-table td', { hasText: /^r1$/ }).click()
  await harness.keyboard.press('End')
  for (const fraction of [0.5, 0.25, 0]) {
    await scroll(harness, fraction)
    assert.equal(
      await harness.evaluate(
        () => !!document.activeElement.closest('.hibi-lp-cell-editor'),
      ),
      true,
      String(fraction),
    )
  }
  await harness.keyboard.type('W')
  assert.match((await state()).doc, /^\| row 1 \| r1W \|$/m)
})

test('a cell editor whose row is deleted leaves focus that moved out of the editor', {
  timeout: 30000,
}, async () => {
  await mount('| h |\n| - |\n| alpha |\n| beta |\n| gamma |\n\nafter')
  await harness.locator('.hibi-lp-table td', { hasText: 'beta' }).click()
  await harness.keyboard.press('End')
  const focused = await harness.evaluate(async () => {
    const view = window.tables.view()
    const text = view.state.doc.toString()
    view.dispatch({
      changes: { from: text.indexOf('| beta'), to: text.indexOf('| gamma') },
    })
    const button = document.createElement('button')
    button.textContent = 'outside'
    document.body.append(button)
    button.focus()
    await window.tables.settle()
    const active = document.activeElement === button
    button.remove()
    return active
  })
  assert.equal(focused, true)
  assert.equal((await state()).editor, null)
})

test('a native table pick releases its editing host on blur, new intent, readonly and destruction', {
  timeout: 30000,
}, async (t) => {
  const doc = 'ab\n\n|   |\n| - |\n| cd |\n\nend'
  for (const action of [
    'outside focus',
    'outside pointer',
    'window blur',
    'readonly',
    'new document',
    'new pick',
    'destroy',
  ]) {
    await t.test(action, async () => {
      await mount(doc)
      await harness.evaluate((at) => {
        const view = window.tables.view()
        view.focus()
        view.dispatch({ selection: { anchor: at } })
      }, doc.indexOf('cd') + 1)
      await harness
        .getByRole('textbox', { name: 'Table cell', exact: true })
        .waitFor()
      await harness.evaluate(() => {
        const root = window.tables.view().contentDOM
        const find = (word) => {
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
          while (walker.nextNode())
            if (walker.currentNode.textContent.trim() === word)
              return walker.currentNode
        }
        const a = find('ab'),
          b = find('cd')
        getSelection().setBaseAndExtent(
          a,
          1,
          b,
          b.textContent.indexOf('cd') + 1,
        )
      })
      await harness.waitForFunction(
        () =>
          getSelection().toString().replace(/\s/g, '') === 'bc' &&
          document.querySelector('.hibi-lp-table').contentEditable ===
            'inherit',
      )
      const before = await state()
      await harness.evaluate(async (action) => {
        window.pickedTableDOM = document.querySelector('.hibi-lp-table')
        if (action === 'readonly') window.tables.setEditable(false)
        else if (action === 'new document') window.tables.echo('!')
        else if (action === 'new pick') {
          const view = window.tables.view()
          view.contentDOM.dispatchEvent(
            new PointerEvent('pointerdown', { bubbles: true }),
          )
          view.dispatch({ selection: { anchor: view.state.doc.length } })
          view.focus()
        } else if (action === 'destroy')
          await window.tables.mount(
            'replacement',
            { width: 1000, height: 800 },
            { editable: true },
          )
        else if (action === 'window blur')
          window.dispatchEvent(new FocusEvent('blur'))
        else {
          const button = document.createElement('button')
          button.className = 'table-pick-outside'
          button.textContent = 'Outside the editor'
          document.body.append(button)
          if (action === 'outside focus') button.focus()
          else
            button.dispatchEvent(
              new PointerEvent('pointerdown', { bubbles: true }),
            )
        }
        await window.tables.settle()
      }, action)
      assert.equal(
        await harness.evaluate(() => window.pickedTableDOM.contentEditable),
        'false',
      )
      if (action !== 'destroy') {
        const after = await state()
        assert.equal(after.doc, action === 'new document' ? doc + '!' : doc)
        assert.deepEqual(
          [after.anchor, after.head],
          action === 'new pick'
            ? [doc.length, doc.length]
            : [before.anchor, before.head],
        )
      }
      if (action === 'outside focus')
        assert.equal(
          await harness.evaluate(() =>
            document.activeElement.matches('.table-pick-outside'),
          ),
          true,
        )
      if (action === 'new pick') {
        await harness.keyboard.insertText('Q')
        assert.equal((await state()).doc, doc + 'Q')
      }
      await harness.evaluate(() =>
        document.querySelector('.table-pick-outside')?.remove(),
      )
    })
  }
})

test('a native selection in a read-only table becomes the editing selection', {
  timeout: 30000,
}, async () => {
  const doc = 'before\n\n| h | other |\n| - | - |\n| alpha | beta |\n\nafter'
  await mount(doc)
  await harness.evaluate(() => {
    window.tables.setEditable(false)
    // The pick as the double click made it.
    document.addEventListener(
      'dblclick',
      () => {
        window.pickedText = getSelection().toString()
      },
      { once: true },
    )
  })
  await harness
    .locator('.hibi-lp-table td', { hasText: 'alpha' })
    .dblclick({ position: { x: 8, y: 8 } })
  assert.equal(await harness.evaluate(() => window.pickedText), 'alpha')
  await harness.evaluate(() => window.tables.settle())
  const picked = await state()
  const from = doc.indexOf('alpha')
  assert.deepEqual(
    [
      Math.min(picked.anchor, picked.head),
      Math.max(picked.anchor, picked.head),
    ],
    [from, from + 5],
  )
  // The page keeps showing the pick, as the rich editor does, through
  // later updates too.
  assert.equal(await harness.evaluate(() => getSelection().toString()), 'alpha')
  await harness.evaluate(() => window.tables.view().dispatch({}))
  await harness.evaluate(() => window.tables.settle())
  assert.equal(await harness.evaluate(() => getSelection().toString()), 'alpha')
  await harness.keyboard.type('BLOCKED')
  assert.equal((await state()).doc, doc)
  await harness.evaluate(() => window.tables.setEditable(true))
  await harness.evaluate(() => window.tables.settle())
  await withHeldClock(harness, () => harness.keyboard.type('XY'))
  assert.equal((await state()).doc, doc.replace('alpha', 'XY'))
  await harness.keyboard.press(
    process.platform === 'darwin' ? 'Meta+z' : 'Control+z',
  )
  assert.equal((await state()).doc, doc)
})

test('a read-only double-click pick outlasts a measure that reads it first', {
  timeout: 30000,
}, async () => {
  const doc = 'before\n\n| h | other |\n| - | - |\n| alpha | beta |\n\nafter'
  await mount(doc)
  await harness.evaluate(() => {
    window.tables.setEditable(false)
    // A measure frame reads the double click's selection before the page
    // reports its change.
    const flush = () => {
      if (getSelection().toString() !== 'alpha') return
      document.removeEventListener('selectionchange', flush, true)
      window.tables.view().observer.forceFlush()
    }
    document.addEventListener('selectionchange', flush, true)
  })
  await harness
    .locator('.hibi-lp-table td', { hasText: 'alpha' })
    .dblclick({ position: { x: 8, y: 8 } })
  await harness.evaluate(() => window.tables.settle())
  const from = doc.indexOf('alpha')
  const picked = await state()
  assert.deepEqual(
    [
      Math.min(picked.anchor, picked.head),
      Math.max(picked.anchor, picked.head),
    ],
    [from, from + 5],
  )
  assert.equal(await harness.evaluate(() => getSelection().toString()), 'alpha')
  // A selection set after the pick replaces it.
  await harness.evaluate(() =>
    window.tables.view().dispatch({ selection: { anchor: 0 } }),
  )
  await harness.evaluate(() => window.tables.settle())
  const moved = await state()
  assert.deepEqual([moved.anchor, moved.head], [0, 0])
})

test('a script pick across cells outlasts a cell editor measure that reads it first', {
  timeout: 30000,
}, async () => {
  const doc = 'before\n\n| h | other |\n| - | - |\n| alpha | beta |\n\nafter'
  // The anchor at the cell editor's caret, which the measure finds unchanged,
  // and elsewhere in its text, which it reads as a new selection.
  for (const offset of [0, 2]) {
    await mount(doc)
    await harness.locator('.hibi-lp-table td', { hasText: 'alpha' }).click()
    await harness.waitForFunction(() =>
      document.activeElement?.closest('.hibi-lp-cell-editor'),
    )
    await harness.evaluate((offset) => {
      const editor = document.querySelector('.hibi-lp-cell-editor .cm-content')
        .cmTile.root.view
      editor.dispatch({ selection: { anchor: 0 } })
      const text = (root, value) => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
        while (walker.nextNode())
          if (walker.currentNode.data === value) return walker.currentNode
      }
      const cell = [...document.querySelectorAll('.hibi-lp-table td')].find(
        (cell) => cell.textContent === 'beta',
      )
      // An assistive tool or script selects from the edited cell into the
      // next while the cell editor keeps focus, and a measure frame comes
      // before the page reports the change.
      getSelection().setBaseAndExtent(
        text(editor.contentDOM, 'alpha'),
        offset,
        text(cell, 'beta'),
        4,
      )
      editor.observer.forceFlush()
    }, offset)
    await harness.evaluate(() => window.tables.settle())
    const picked = await state()
    assert.deepEqual(
      [picked.anchor, picked.head],
      [doc.indexOf('alpha') + offset, doc.indexOf('beta') + 4],
      `offset ${offset}`,
    )
    assert.equal(
      (await harness.evaluate(() => getSelection().toString())).replace(
        /\s/g,
        '',
      ),
      `${'alpha'.slice(offset)}beta`,
    )
  }
})

test('a read-only pick outlasts a view update before its selection change', {
  timeout: 30000,
}, async () => {
  const doc = 'before\n\n| h | other |\n| - | - |\n| alpha | beta |\n\nafter'
  await mount(doc)
  await harness.evaluate(() => window.tables.setEditable(false))
  await harness.locator('.hibi-lp-table td', { hasText: 'alpha' }).click()
  await harness.evaluate(() => {
    const cell = [...document.querySelectorAll('.hibi-lp-table td p')].find(
      (paragraph) => paragraph.textContent === 'alpha',
    )
    const text = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT)
    text.nextNode()
    getSelection().setBaseAndExtent(text.currentNode, 1, text.currentNode, 4)
    // As from a parse slice, before the page reports the selection change.
    window.tables.view().dispatch({})
  })
  await harness.evaluate(() => window.tables.settle())
  const from = doc.indexOf('alpha')
  const picked = await state()
  assert.deepEqual([picked.anchor, picked.head], [from + 1, from + 4])
})

test('a read-only cell pick maps hidden marks, escaped pipes and quote prefixes', {
  timeout: 30000,
}, async () => {
  const doc = String.raw`before

> | head | other |
> | --- | --- |
> | **al\|pha** | beta |

end`
  await mount(doc)
  await harness.evaluate(() => window.tables.setEditable(false))
  await harness.locator('.hibi-lp-table td', { hasText: 'al|pha' }).click()
  await harness.evaluate(() => {
    const cell = [...document.querySelectorAll('.hibi-lp-table td')].find(
      (cell) => cell.textContent === 'al|pha',
    )
    const paragraph = cell.firstElementChild
    getSelection().setBaseAndExtent(
      paragraph,
      0,
      paragraph,
      paragraph.childNodes.length,
    )
  })
  await harness.evaluate(() => window.tables.settle())
  const picked = await state()
  const from = doc.indexOf(String.raw`al\|pha`)
  assert.deepEqual([picked.anchor, picked.head], [from, from + 7])
  await harness.evaluate(() => window.tables.setEditable(true))
  await harness.evaluate(() => window.tables.settle())
  await harness.keyboard.type('XY')
  assert.equal((await state()).doc, doc.replace(String.raw`al\|pha`, 'XY'))
})

for (const [label, content, pickedText, source] of [
  ['named entity', 'left &amp; right', '&', '&amp;'],
  ['scalar entity', 'left &#169; right', '©', '&#169;'],
  ['astral entity', 'left &#x1F600; right', '😀', '&#x1F600;'],
  ['combined entity', 'left &NotEqualTilde; right', '≂̸', '&NotEqualTilde;'],
  ['escaped pipe', String.raw`al\|pha`, '|', String.raw`\|`],
  ['escaped punctuation', String.raw`al\*pha`, '*', String.raw`\*`],
  ['plain astral text', 'a😀z', '😀', '😀'],
  ['entity and escape', String.raw`**a&amp;\|z**`, '&|', String.raw`&amp;\|`],
  ['text before escape', String.raw`al\|pha`, 'al', 'al'],
  ['text after escape', String.raw`al\|pha`, 'pha', 'pha'],
]) {
  for (const backward of [false, true]) {
    test(`a ${backward ? 'backward' : 'forward'} read-only pick maps ${label} to complete source units`, {
      timeout: 30000,
    }, async () => {
      const doc = `before\n\n> | h | other |\n> | - | - |\n> | ${content} | beta |\n\nafter`
      await mount(doc)
      await harness.evaluate(() => window.tables.setEditable(false))
      await harness.locator('.hibi-lp-table td').first().click()
      const native = await harness.evaluate(
        ({ pickedText, backward }) => {
          const cell = document.querySelector('.hibi-lp-table td p')
          const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT)
          const nodes = []
          for (let node = walker.nextNode(); node; node = walker.nextNode())
            nodes.push(node)
          const point = (at, end) => {
            for (const node of nodes) {
              const length = node.textContent.length
              if (at < length || (end && at === length)) return [node, at]
              at -= length
            }
            throw new Error('The selected text has no DOM position.')
          }
          const from = cell.textContent.indexOf(pickedText)
          if (from < 0) throw new Error('The selected text is not rendered.')
          const start = point(from, false)
          const end = point(from + pickedText.length, true)
          const [anchor, head] = backward ? [end, start] : [start, end]
          getSelection().setBaseAndExtent(...anchor, ...head)
          return getSelection().toString()
        },
        { pickedText, backward },
      )
      assert.equal(native, pickedText)
      await harness.evaluate(() => window.tables.settle())
      const from = doc.indexOf(source)
      const to = from + source.length
      const picked = await state()
      assert.deepEqual(
        [picked.anchor, picked.head],
        backward ? [to, from] : [from, to],
      )
      await harness.keyboard.type('BLOCKED')
      assert.equal((await state()).doc, doc)
      await harness.evaluate(() => window.tables.setEditable(true))
      await harness.evaluate(() => window.tables.settle())
      await withHeldClock(harness, () => harness.keyboard.type('XY'))
      assert.equal(
        (await state()).doc,
        `${doc.slice(0, from)}XY${doc.slice(to)}`,
      )
      await harness.keyboard.press(undoKey)
      assert.equal((await state()).doc, doc)
    })
  }
}

test('a backward native table selection keeps both cell positions while read-only', {
  timeout: 30000,
}, async () => {
  const doc = 'before\n\n| h | other |\n| - | - |\n| alpha | beta |\n\nafter'
  await mount(doc)
  await harness.evaluate(() => window.tables.setEditable(false))
  await harness.locator('.hibi-lp-table td', { hasText: 'alpha' }).click()
  await harness.evaluate(() => {
    const cells = [...document.querySelectorAll('.hibi-lp-table td')]
    const text = (value) =>
      document
        .createTreeWalker(
          cells.find((cell) => cell.textContent === value),
          NodeFilter.SHOW_TEXT,
        )
        .firstChild()
    getSelection().setBaseAndExtent(text('beta'), 4, text('alpha'), 0)
  })
  await harness.evaluate(() => window.tables.settle())
  const picked = await state()
  assert.deepEqual(
    [picked.anchor, picked.head],
    [doc.indexOf('beta') + 4, doc.indexOf('alpha')],
  )
  assert.equal(picked.doc, doc)
})

test('unlocking a picked table leaves focus that moved outside the view', {
  timeout: 30000,
}, async (t) => {
  const doc = '| h |\n| - |\n| alpha |'
  await mount(doc)
  await harness.evaluate(() => window.tables.setEditable(false))
  await harness.locator('.hibi-lp-table td', { hasText: 'alpha' }).dblclick({
    position: { x: 8, y: 8 },
  })
  await harness.evaluate(() => {
    const input = document.createElement('input')
    input.id = 'readonly-table-outside'
    input.style.cssText = 'position:fixed;top:20px;left:600px;z-index:1000'
    document.body.append(input)
  })
  t.after(() =>
    harness.evaluate(() =>
      document.getElementById('readonly-table-outside')?.remove(),
    ),
  )
  const outside = harness.locator('#readonly-table-outside')
  await outside.click()
  await harness.evaluate(() => window.tables.setEditable(true))
  await harness.evaluate(() => window.tables.settle())
  assert.equal(
    await harness.evaluate(() => document.activeElement.id),
    'readonly-table-outside',
  )
  await harness.keyboard.type('outside')
  assert.equal(await outside.inputValue(), 'outside')
  assert.equal((await state()).doc, doc)
})

test('cell editors take no input while the formatted view takes none', {
  timeout: 30000,
}, async () => {
  const doc = 'before\n\n| a | b |\n| - | - |\n| c | d |\n\nafter'
  await mount(doc)
  await recordEvents(harness, tablesView)
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

test('a cell editor that a change drops while the view takes no input is back once it does', {
  timeout: 60000,
}, async (t) => {
  const doc = 'before\n\n| a | b |\n| - | - |\n| c | d |\n\nafter'
  // Changes from elsewhere, as a sync while the view is read-only applies.
  for (const [name, changes, typed] of [
    // The edited column is gone: the cell its caret maps to is edited.
    [
      'column gone',
      [
        [10, 14, ''],
        [22, 26, ''],
        [30, 35, ''],
      ],
      /^\| Yd \|$/m,
    ],
    // A fence opened above turns the table into code: the view is focused.
    ['fence', [[0, 0, '~~~\n']], /^\| cXY \| d \|$/m],
  ])
    await t.test(name, async () => {
      await mount(doc)
      await harness.locator('.hibi-lp-table td', { hasText: 'c' }).click()
      await harness.keyboard.press('End')
      await harness.keyboard.type('X')
      await harness.evaluate((changes) => {
        window.tables.setEditable(false)
        window.tables.view().dispatch({
          changes: changes.map(([from, to, insert]) => ({ from, to, insert })),
        })
      }, changes)
      await harness.waitForFunction(() => !window.tables.settling())
      await harness.evaluate(() => window.tables.settle())
      assert.equal(
        await harness.evaluate(() => document.activeElement === document.body),
        true,
      )
      await harness.evaluate(() => window.tables.setEditable(true))
      await harness.evaluate(() => window.tables.settle())
      await harness.keyboard.type('Y')
      assert.match((await state()).doc, typed)
    })
})

test('a pointer selection of the formatted view keeps a focused cell editor’s page selection', {
  timeout: 60000,
}, async (t) => {
  const doc = 'before\n\n| a | b |\n| - | - |\n| c | d |\n\nafter'
  // As addons and the view's own selection reads can dispatch, apart from
  // the read-only pick reader.
  for (const [name, readOnly, at, typed] of [
    ['caret, read-only', true, null, /^\| cW \| d \|$/m],
    ['caret', false, null, /^\| cW \| d \|$/m],
    ['cell start, read-only', true, 30, /^\| Wc \| d \|$/m],
    // Away from the table, the view takes input there once it can.
    ['elsewhere, read-only', true, doc.length, /afterW$/],
  ])
    await t.test(name, async () => {
      await mount(doc)
      await harness.locator('.hibi-lp-table td', { hasText: 'c' }).click()
      await harness.keyboard.press('End')
      const page = await harness.evaluate(
        async ({ readOnly, at }) => {
          const view = window.tables.view()
          if (readOnly) window.tables.setEditable(false)
          view.dispatch({
            selection: { anchor: at ?? view.state.selection.main.head },
            userEvent: 'select.pointer',
          })
          await window.tables.settle()
          const cell = document.querySelector(
            '.hibi-lp-cell-editor .cm-content',
          )
          return !!cell?.contains(getSelection().focusNode)
        },
        { readOnly, at },
      )
      if (at !== doc.length) assert.equal(page, true)
      await harness.evaluate(() => window.tables.setEditable(true))
      await harness.evaluate(() => window.tables.settle())
      await harness.keyboard.type('W')
      assert.match((await state()).doc, typed)
    })
})

test('navigation out of a read-only table writes nothing', {
  timeout: 30000,
}, async () => {
  const doc = '| a | b |\n| - | - |\n| x | y |'
  await mount(doc)
  // Tab in the last cell would add a row; escape or a move down past the
  // end a paragraph.
  for (const [cell, key] of [
    ['y', 'Tab'],
    ['x', 'Escape'],
    ['x', 'ArrowDown'],
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
  // Nor do the keys that break a line in a cell.
  await harness.evaluate(() => window.tables.setEditable(true))
  await harness.locator('.hibi-lp-table td', { hasText: 'x' }).click()
  await harness.evaluate(() => window.tables.setEditable(false))
  for (const key of ['Enter', 'Shift+Enter', 'ControlOrMeta+Enter']) {
    await harness.keyboard.press(key)
    assert.equal((await state()).doc, doc, key)
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

test('a long table shows the edited row in its place once the pane scrolled away from it', {
  timeout: 120000,
}, async () => {
  const rows = Array.from({ length: 3000 }, (_, i) => `| row ${i} | v${i} |`)
  // The note starts with the table, as in the scroll tests above. The pane
  // fits the harness window, which is as tall as the app's, 720 px.
  const doc = `| a | b |\n| --- | --- |\n${rows.join('\n')}\n\nAfter.\n`
  await harness.evaluate(
    (doc) =>
      window.tables.mount(
        doc,
        { width: 1000, height: 606 },
        { editable: true },
      ),
    doc,
  )
  await harness.evaluate(async (at) => {
    const preview = window.tables
    for (let i = 0; i < 500 && !document.querySelector('.hibi-lp-table'); i++)
      await new Promise((done) => setTimeout(done, 20))
    await preview.settle()
    const view = preview.view()
    view.dispatch({
      effects: view.constructor.scrollIntoView(at, { y: 'center' }),
    })
    await preview.settle()
    await preview.settle()
  }, doc.indexOf('v1801 '))
  await harness.locator('.hibi-lp-table tr[data-line="1803"] td').nth(1).click()
  await harness.keyboard.press('End')
  await harness.keyboard.type('Z')
  // Scrolled back to the top, the window draws the rows there and keeps the
  // edited row mounted after them, out of its place.
  const away = () =>
    harness.evaluate(async () => {
      document.querySelector('.rich-pane').scrollTop = 0
      for (let i = 0; i < 3; i++) await window.tables.settle()
    })
  // The focused cell, and whether it is inside the pane once the window is
  // drawn for where the pane scrolled.
  const shown = () =>
    harness.evaluate(async () => {
      for (let i = 0; i < 3; i++) await window.tables.settle()
      const cell = document.activeElement?.closest('td')
      const box = cell?.getBoundingClientRect()
      const pane = document.querySelector('.rich-pane').getBoundingClientRect()
      return {
        cell: cell
          ? `${cell.parentElement.dataset.line}:${cell.cellIndex}`
          : null,
        inside: !!box && box.top >= pane.top && box.bottom <= pane.bottom,
      }
    })
  await away()
  await harness.keyboard.press(undoKey)
  assert.equal((await state()).doc, doc)
  assert.deepEqual(await shown(), { cell: '1803:1', inside: true }, 'undo')
  // Moving to the row's other cell edits it in its place too.
  await away()
  await harness.keyboard.press('Shift+Tab')
  assert.deepEqual(await shown(), { cell: '1803:0', inside: true }, 'Shift+Tab')
  // Typing goes on in the cell, which CodeMirror's own scroll to its caret
  // shows in its place, before the row above it.
  await away()
  await harness.keyboard.type('Y')
  const typed = await harness.evaluate(async () => {
    for (let i = 0; i < 3; i++) await window.tables.settle()
    const cell = document.activeElement?.closest('td')
    const editor = window.tables
      .view()
      .constructor.findFromDOM(document.activeElement.closest('.cm-editor'))
    const caret = editor.coordsAtPos(editor.state.selection.main.head)
    const pane = document.querySelector('.rich-pane').getBoundingClientRect()
    return {
      cell: `${cell.parentElement.dataset.line}:${cell.cellIndex}`,
      before: cell.parentElement.previousElementSibling?.dataset.line,
      inside: caret.top >= pane.top && caret.bottom <= pane.bottom,
    }
  })
  assert.deepEqual(
    typed,
    { cell: '1803:0', before: '1802', inside: true },
    'typing',
  )
})

test("a scroll to the start of a long table's edited row lands on it in its place once the pane scrolled away from it", {
  timeout: 120000,
}, async () => {
  // Every fifth row breaks a cell over three lines: the rows drawn around the
  // edited row measure taller than the estimate a scroll would start from.
  const rows = Array.from(
    { length: 3000 },
    (_, i) => `| row ${i} | ${i % 5 ? `v${i}` : 'a<br>b<br>c'} |`,
  )
  // As in the test above: the note starts with the table, in a pane that
  // fits the harness window.
  const doc = `| a | b |\n| --- | --- |\n${rows.join('\n')}\n\nAfter.\n`
  await harness.evaluate(
    (doc) =>
      window.tables.mount(
        doc,
        { width: 1000, height: 606 },
        { editable: true },
      ),
    doc,
  )
  await harness.evaluate(async (at) => {
    const preview = window.tables
    for (let i = 0; i < 500 && !document.querySelector('.hibi-lp-table'); i++)
      await new Promise((done) => setTimeout(done, 20))
    await preview.settle()
    const view = preview.view()
    view.dispatch({
      effects: view.constructor.scrollIntoView(at, { y: 'center' }),
    })
    await preview.settle()
    await preview.settle()
  }, doc.indexOf('v1801 '))
  await harness.locator('.hibi-lp-table tr[data-line="1803"] td').nth(1).click()
  await harness.keyboard.press('End')
  await harness.keyboard.type('Z')
  const result = await harness.evaluate(async () => {
    const preview = window.tables
    const pane = document.querySelector('.rich-pane')
    // The cell editor scrolls to its caret after the typing first.
    await preview.settle()
    pane.scrollTop = 0
    const row = () =>
      document.querySelector('.hibi-lp-table tr[data-line="1803"]')
    // The window moves to the rows at the top once the table measures there.
    for (
      let i = 0;
      i < 20 && row().previousElementSibling?.dataset.line === '1802';
      i++
    )
      await preview.settle()
    const away = row().previousElementSibling?.dataset.line
    // A scroll that puts the caret at the pane's top, as no in-app caller
    // asks of a cell yet.
    const view = preview.view()
    view.dispatch({
      effects: view.constructor.scrollIntoView(view.state.selection.main.head, {
        y: 'start',
      }),
    })
    for (let i = 0; i < 4; i++) await preview.settle()
    const editor = view.constructor.findFromDOM(
      document.activeElement.closest('.cm-editor'),
    )
    const caret = editor.coordsAtPos(editor.state.selection.main.head)
    const cell = document.activeElement.closest('td')
    return {
      away,
      cell: `${cell.parentElement.dataset.line}:${cell.cellIndex}`,
      before: row().previousElementSibling?.dataset.line,
      top: Math.round(caret.top - pane.getBoundingClientRect().top),
    }
  })
  assert.notEqual(result.away, '1802', 'the edited row starts out of its place')
  assert.deepEqual(
    [result.cell, result.before],
    ['1803:1', '1802'],
    JSON.stringify(result),
  )
  // CodeMirror leaves a few pixels between the line and the pane's top.
  assert.ok(result.top >= 0 && result.top < 20, JSON.stringify(result))
})

test('a cell editor shows its cell formatted as it opens', {
  timeout: 30000,
}, async () => {
  const doc = '| a | b |\n| - | - |\n| x<br>**y** | z |'
  await mount(doc)
  const shown = await harness.evaluate(async (at) => {
    const view = window.tables.view()
    view.focus()
    view.dispatch({ selection: { anchor: at } })
    const text = () =>
      document.querySelector('.hibi-lp-cell-editor .cm-content')?.textContent
    // The editor opens in a microtask, before CodeMirror's focus change,
    // which waits for a timer.
    await Promise.resolve()
    const opened = text()
    await new Promise((done) => setTimeout(done, 50))
    await window.tables.settle()
    return [opened, text()]
  }, doc.indexOf('x'))
  // The line break shows as one, with no source text.
  assert.deepEqual(shown, ['x**y**', 'x**y**'])
})

test('the toolbar inserts a header and two rows, with the caret in the first header cell', {
  timeout: 30000,
}, async () => {
  await mount('hello')
  await harness.evaluate(() => {
    const view = window.tables.view()
    view.focus()
    view.dispatch({ selection: { anchor: 0, head: 5 } })
  })
  assert.equal(
    await harness.evaluate(() => window.tables.runFormatting('table')),
    true,
  )
  const rows = harness.locator('.hibi-lp-table tr')
  await harness.locator('.hibi-lp-table').waitFor()
  assert.equal(await rows.count(), 3)
  await harness.evaluate(() => window.tables.settle())
  // The rich editor's table spelling `\n|     |`: an empty cell's caret sits
  // mid-padding, after the line break, the pipe and three of its five spaces.
  assert.deepEqual([(await state()).cell, (await state()).head], ['0:0', 5])
  // Table actions edit the table around that cell, as in the rich editor.
  assert.equal(
    await harness.evaluate(() => window.tables.runTableAction('row-after')),
    true,
  )
  assert.equal(await rows.count(), 4)
  assert.equal(
    await harness.evaluate(() => window.tables.runTableAction('column-after')),
    true,
  )
  assert.equal(await rows.first().locator('th, td').count(), 3)
})

// The first input into a cell its row lacks adds the cell. Undo comes back
// to that row and redo to the typed text, not to where the caret was before
// the cell was clicked.
test('undo and redo of typing into a cell its row lacks come back to that cell', {
  timeout: 30000,
}, async () => {
  const doc = '| a | b |\n| - | - |\n| x | y |\n| short |\n| u | v |\n\nafter'
  await mount(doc)
  // The caret starts in another row.
  await harness.locator('.hibi-lp-table td', { hasText: /^v$/ }).click()
  await harness.locator('.hibi-lp-table tr[data-line="3"] td').nth(1).click()
  await harness.keyboard.type('q')
  const typed = await state()
  assert.match(typed.line, /^\| short \|\s*q\s*\|$/)
  assert.equal(typed.cell, '3:1')
  await harness.keyboard.press(undoKey)
  const undone = await state()
  assert.equal(undone.doc, doc)
  assert.equal(undone.line, '| short |')
  await harness.keyboard.press(redoKey)
  const redone = await state()
  assert.equal(redone.doc, typed.doc)
  assert.deepEqual([redone.cell, redone.head], [typed.cell, typed.head])
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
  await harness.keyboard.press('ArrowDown')
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
  await recordEvents(page)
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

test('typed cell padding follows selection, blur, readonly and a source change', {
  timeout: 30000,
}, async (t) => {
  const doc = 'before\n\n| h |\n| - |\n| south     |\n\nafter'
  const end = doc.indexOf('south') + 5
  for (const action of ['selection', 'blur', 'readonly', 'source']) {
    await t.test(action, async () => {
      await mount(doc)
      const cell = harness.locator('.hibi-lp-table td', { hasText: 'south' })
      await cell.click()
      await harness.keyboard.press('End')
      await harness.keyboard.press('Space')
      await harness.evaluate(() => window.tables.settle())
      assert.equal(await cell.innerText(), 'south ')
      assert.equal((await state()).doc, doc.replace('south', 'south '))
      await harness.evaluate(
        ({ action, end }) => {
          const view = window.tables.view()
          if (action === 'selection') {
            const content = document.querySelector(
              '.hibi-lp-cell-editor .cm-content',
            )
            const cellView = content.cmTile.root.view
            cellView.dispatch({
              selection: {
                anchor: cellView.state.doc.toString().indexOf('south') + 5,
              },
            })
          } else if (action === 'blur') {
            const button = document.createElement('button')
            button.dataset.cellSpaceFocus = ''
            document.body.append(button)
            button.focus()
          } else if (action === 'readonly') window.tables.setEditable(false)
          else view.dispatch({ changes: { from: end, to: end + 1 } })
        },
        { action, end },
      )
      await harness.evaluate(() => window.tables.settle())
      const after = await state()
      assert.equal(
        await cell.innerText(),
        action === 'readonly' ? 'south ' : 'south',
        action,
      )
      assert.equal(
        after.doc,
        action === 'source' ? doc : doc.replace('south', 'south '),
      )
      if (action === 'blur' || action === 'readonly')
        assert.deepEqual([after.anchor, after.head], [end + 1, end + 1])
      if (action !== 'blur')
        assert.equal(
          await harness.evaluate(
            () =>
              document.querySelector('.hibi-lp-cell-editor .cm-content').cmTile
                .root.view.state.selection.main.head,
          ),
          after.head - (doc.indexOf('south') - 1),
        )
      if (action === 'readonly') {
        await harness.keyboard.type('BLOCKED')
        assert.equal((await state()).doc, after.doc)
        await harness.evaluate(() => window.tables.settle())
        const blocked = await state()
        assert.deepEqual([blocked.anchor, blocked.head], [end + 1, end + 1])
        await harness.evaluate(() => window.tables.setEditable(true))
      }
      if (action === 'source' || action === 'readonly') {
        await harness.keyboard.type('Q')
        const expected =
          action === 'source'
            ? doc.replace('south', 'southQ')
            : doc.replace('south', 'south Q')
        assert.equal((await state()).doc, expected)
        const next = await harness.evaluate(() => {
          const content = document.querySelector(
            '.hibi-lp-cell-editor .cm-content',
          )
          const view = content.cmTile.root.view
          const selection = getSelection()
          return [
            view.state.selection.main.head,
            view.posAtDOM(selection.focusNode, selection.focusOffset),
          ]
        })
        assert.equal(next[0], next[1])
      }
      await harness.evaluate(() =>
        document.querySelector('[data-cell-space-focus]')?.remove(),
      )
    })
  }
})

test('toolbar formatting preserves genuine DOM picks across table redraws', {
  timeout: 30000,
}, async (t) => {
  await openFormatted()
  const doc = 'plain\n\n\n| aa   | bb   |\n| ---- | ---- |\n| cell | tail |\n'
  const cases = [
    {
      id: 'bold',
      start: 'plain',
      a: 1,
      end: 'cell',
      b: 2,
      selected: 'lainaabbce',
      source:
        'p**lain**\n\n\n| **aa**   | **bb** |\n| -------- | ------ |\n| **ce**ll | tail   |\n',
      styles: [
        ['p', false, false],
        ['lainaabbce', true, false],
        ['lltail', false, false],
      ],
      caret: [
        ['p', 'lain'],
        ['ce', 'll'],
      ],
    },
    {
      id: 'italic',
      start: 'cell',
      a: 1,
      end: 'tail',
      b: 2,
      selected: 'ellta',
      source:
        'plain\n\n\n| aa     | bb     |\n| ------ | ------ |\n| c*ell* | *ta*il |\n',
      styles: [
        ['plain', false, false],
        ['aabb', true, false],
        ['c', false, false],
        ['ellta', false, true],
        ['il', false, false],
      ],
      caret: [
        ['c', 'ell'],
        ['ta', 'il'],
      ],
    },
  ]
  const snapshot = () =>
    page.evaluate(async () => {
      await window.hibi.flushDocumentChanges()
      const accepted = await window.hibi.getDocument()
      const root = document.querySelector(
        '.rich-pane [aria-label="Document editor"]',
      )
      const selection = getSelection()
      const clean = (fragment) => {
        for (const node of fragment.querySelectorAll(
          '.hibi-lp-marker, [aria-hidden="true"], label',
        ))
          node.remove()
        return fragment.textContent
      }
      const at = (node, offset) => {
        const block = (
          node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement
        ).closest('.cm-line, p')
        const left = document.createRange(),
          right = document.createRange()
        left.selectNodeContents(block)
        left.setEnd(node, offset)
        right.selectNodeContents(block)
        right.setStart(node, offset)
        return [clean(left.cloneContents()), clean(right.cloneContents())]
      }
      const styles = []
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      while (walker.nextNode()) {
        const node = walker.currentNode,
          parent = node.parentElement
        if (
          !node.data ||
          parent.closest('.hibi-lp-marker, [aria-hidden="true"], label') ||
          !parent.getClientRects().length
        )
          continue
        const css = getComputedStyle(parent),
          bold = Number(css.fontWeight) >= 600,
          italic = css.fontStyle === 'italic'
        const last = styles.at(-1)
        if (last && last[1] === bold && last[2] === italic) last[0] += node.data
        else styles.push([node.data, bold, italic])
      }
      const range = root.cmTile.root.view.state.selection.main
      return {
        source: accepted.markdown,
        version: accepted.contentVersion,
        range: [range.anchor, range.head],
        text: clean(root.cloneNode(true)),
        styles,
        selected: clean(selection.getRangeAt(0).cloneContents()).replace(
          /\s/g,
          '',
        ),
        caret: [
          at(selection.anchorNode, selection.anchorOffset),
          at(selection.focusNode, selection.focusOffset),
        ],
        collapsed: selection.isCollapsed,
        inputs: window.tableActionInputs,
      }
    })
  for (const item of cases)
    for (const reverse of [false, true])
      await t.test(item.id + (reverse ? ' reverse' : ' forward'), async () => {
        const name = 'table-action-' + item.id + '-' + reverse + '.md'
        const file = join(folder, name)
        await writeFile(file, doc)
        await app.evaluate(({ dialog }, file) => {
          dialog.showOpenDialog = async () => ({
            canceled: false,
            filePaths: [file],
          })
        }, file)
        await clickMenu(app, 'Open…')
        await waitForAsync(
          page,
          async (name) => (await window.hibi.getDocument()).name === name,
          name,
        )
        await waitForDocumentEditor(app, page)
        const rich = page.getByRole('textbox', {
          name: 'Document editor',
          exact: true,
        })
        await page.waitForFunction(
          (doc) =>
            document
              .querySelector('.rich-pane [aria-label="Document editor"]')
              .cmTile.root.view.state.doc.toString() === doc,
          doc,
        )
        await recordEvents(page, documentView)
        await rich.evaluate((root, at) => {
          const view = root.cmTile.root.view
          view.focus()
          view.dispatch({ selection: { anchor: at }, scrollIntoView: true })
        }, doc.indexOf(item.end) + item.b)
        await page
          .getByRole('textbox', { name: 'Table cell', exact: true })
          .waitFor()
        await page.waitForFunction(
          () =>
            document.activeElement?.getAttribute('aria-label') === 'Table cell',
        )
        await rich.evaluate(
          (root, { item, reverse }) => {
            const find = (word) => {
              const walker = document.createTreeWalker(
                root,
                NodeFilter.SHOW_TEXT,
              )
              while (walker.nextNode())
                if (walker.currentNode.data.trim() === word)
                  return walker.currentNode
            }
            const a = find(item.start),
              h = find(item.end)
            getSelection().setBaseAndExtent(
              reverse ? h : a,
              reverse ? item.b : item.a,
              reverse ? a : h,
              reverse ? item.a : item.b,
            )
            // A pointer pick moves focus out of the cell editor, and the
            // view reads it in that turn. This pick leaves the editor
            // focused, so a measure before the page reports it would let
            // the editor draw its caret over it.
            document.dispatchEvent(new Event('selectionchange'))
            window.tableActionInputs = []
            if (!window.tableActionInputInstalled) {
              window.tableActionInputInstalled = true
              document.addEventListener('input', (event) => {
                if (
                  document
                    .querySelector('.rich-pane [aria-label="Document editor"]')
                    ?.contains(event.target)
                )
                  window.tableActionInputs.push({
                    type: event.inputType,
                    data: event.data,
                  })
              })
            }
          },
          { item, reverse },
        )
        const initial = [
          doc.indexOf(item.start) + item.a,
          doc.indexOf(item.end) + item.b,
        ]
        if (reverse) initial.reverse()
        await page.waitForFunction((range) => {
          const current = document.querySelector(
            '.rich-pane [aria-label="Document editor"]',
          ).cmTile.root.view.state.selection.main
          return current.anchor === range[0] && current.head === range[1]
        }, initial)
        const before = await snapshot()
        assert.equal(before.source, doc)
        assert.equal(before.version, 0)
        assert.equal(before.selected, item.selected)
        await page
          .locator('.editor-toolbar [data-toolbar-id="format.' + item.id + '"]')
          .click()
        await page.evaluate(async () => {
          await new Promise(requestAnimationFrame)
          await new Promise(requestAnimationFrame)
        })
        await rich.focus()
        const from = item.source.indexOf(item.id === 'bold' ? 'lain' : 'ell')
        const to = item.source.indexOf(item.id === 'bold' ? 'ce' : 'ta') + 2
        const expectedRange = reverse ? [to, from] : [from, to]
        const expectedCaret = reverse ? [...item.caret].reverse() : item.caret
        const action = await snapshot()
        assert.equal(action.source, item.source)
        assert.equal(action.version, 1)
        assert.equal(action.text, 'plainaabbcelltail')
        assert.deepEqual(action.styles, item.styles)
        assert.deepEqual(action.range, expectedRange)
        assert.deepEqual(action.caret, expectedCaret)
        assert.equal(action.selected, item.selected)
        assert.equal(action.collapsed, false)
        assert.deepEqual(action.inputs, [])
        // Round-trip the real range through the registered widget mapping.
        await page.evaluate(() =>
          document.dispatchEvent(new Event('selectionchange')),
        )
        await page.evaluate(async () => {
          await new Promise(requestAnimationFrame)
          await new Promise(requestAnimationFrame)
        })
        assert.deepEqual(await snapshot(), action)
      })
})

test('a caret moved in a cell while its table is stale reaches the formatted view', {
  timeout: 60000,
}, async () => {
  const doc =
    'intro\n\n| a | b |\n| - | - |\n' +
    Array.from(
      { length: 20000 },
      (_, index) => `| row ${index} | right${index} |`,
    ).join('\n') +
    '\n\nafter'
  await harness.evaluate(
    (doc) =>
      window.tables.mount(
        doc,
        { width: 1000, height: 800 },
        { editable: true, slice: 0 },
      ),
    doc,
  )
  await harness.waitForFunction(() => !window.tables.settling())
  await harness.locator('.hibi-lp-table td', { hasText: /^right0$/ }).click()
  await harness.keyboard.press('End')
  // Typing below the table leaves its spans old while the parse settles.
  const settling = await harness.evaluate(() => {
    const view = window.tables.view()
    const text = view.state.doc.toString()
    const cell = document.activeElement.cmTile.root.view
    view.dispatch({ changes: { from: text.indexOf('row 5 '), insert: '`' } })
    const settling = window.tables.settling()
    cell.dispatch({ selection: { anchor: 2 }, userEvent: 'select' })
    return settling
  })
  assert.equal(settling, true)
  await harness.waitForFunction(() => !window.tables.settling())
  await harness.evaluate(() => window.tables.settle())
  const heads = await harness.evaluate(() => {
    const view = window.tables.view()
    return {
      main: view.state.selection.main.head,
      cell: view.state.doc.toString().indexOf(' right0 ') + 2,
      editor:
        document.activeElement.cmTile?.root?.view.state.selection.main.head,
    }
  })
  assert.deepEqual([heads.editor, heads.main], [2, heads.cell])
})
