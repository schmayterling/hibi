import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  electron,
  waitForAsync,
  waitForDocumentEditor,
  waitForFormattedEditor,
} from './electron.mjs'
import { clickMenu, pressShortcut, redoKey } from './keyboard.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const undoKey = 'ControlOrMeta+z'
const lines = 'line\n\n'.repeat(60)
const rows = (count, cell = (row) => `v${row}`) =>
  `| aa | bb |\n| -- | -- |\n${Array.from(
    { length: count },
    (_, row) => `| r${row} | ${cell(row)} |`,
  ).join('\n')}\n`
// The notes open at their top with the caret at their end, far below: in
// the table's last cell, or after the last paragraph's text.
const table = `${lines}${rows(80)}`
const paragraphs = `${lines}${lines}last\n`

// The selection a history step restored, read where the user sees it: the
// caret of the focused cell editor or of the view, with all of its cell when
// the cell fits, and whether that is inside the element that scrolls the view.
function restored(scroller) {
  const pane = document.querySelector(scroller)
  const bounds = pane.getBoundingClientRect()
  const inside = (box) =>
    !!box && box.top >= bounds.top - 1 && box.bottom <= bounds.bottom + 1
  const cell = document.activeElement?.closest('td, th')
  const { view } = (cell ?? pane).querySelector('.cm-content').cmTile.root
  const box = cell?.getBoundingClientRect()
  return {
    // The table's line and column.
    cell: cell
      ? [Number(cell.parentElement.dataset.line), cell.cellIndex]
      : null,
    shown:
      inside(view.coordsAtPos(view.state.selection.main.head)) &&
      (!box || inside(box) || box.height > bounds.height),
  }
}

// Whether the formatted view shows all of the table cell with this text.
function showsCell(text) {
  const pane = document.querySelector('.rich-pane')
  const bounds = pane.getBoundingClientRect()
  const box = [...pane.querySelectorAll('td')]
    .find((cell) => cell.textContent.trim() === text)
    ?.getBoundingClientRect()
  return !!box && box.top >= bounds.top - 1 && box.bottom <= bounds.bottom + 1
}

// Undo and redo show the selection they bring back, as native editors do,
// also when it stays in the table cell being edited. Each step starts with
// the note scrolled to its top, away from that selection.
test('codemirror: undo and redo scroll to the selection they restore', {
  timeout: 180000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-history-scroll-'))
  const profile = join(folder, 'profile')
  await mkdir(profile)
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.close()
    await rm(folder, { recursive: true, force: true })
  })
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10000)
  await waitForFormattedEditor(app, page)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const markdown = () =>
    page.evaluate(async () => (await window.hibi.getDocument()).markdown)
  const changed = async (from) => {
    await waitForAsync(
      page,
      async (from) => (await window.hibi.getDocument()).markdown !== from,
      from,
    )
    return markdown()
  }
  const open = async (name, text, focus) => {
    const file = join(folder, `${name}.md`)
    await writeFile(file, text)
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
      `${name}.md`,
    )
    await waitForDocumentEditor(app, page)
    // The table opens its cell editor after the view's focus update.
    if (focus)
      await page.waitForFunction(
        (focus) => document.activeElement?.closest(focus),
        focus,
      )
  }
  // The first note a new window opens may not take focus.
  await open('warmup', 'warmup\n', null)
  const differences = []
  const step = async (name, key, text, scroller = '.rich-pane') => {
    await page.evaluate((scroller) => {
      document.querySelector(scroller).scrollTop = 0
    }, scroller)
    await page.keyboard.press(key)
    await waitForAsync(
      page,
      async (text) => (await window.hibi.getDocument()).markdown === text,
      text,
    )
    // The view scrolls at its next measure; the table's rows render after it.
    let last = null
    for (let read = 0; read < 30; read++) {
      await page.waitForTimeout(100)
      const now = await page.evaluate(restored, scroller)
      if (now.shown && JSON.stringify(now) === JSON.stringify(last)) break
      last = now
    }
    t.diagnostic(JSON.stringify({ name, ...last }))
    if (!last.shown) differences.push(`${name}: ${JSON.stringify(last)}`)
  }

  // Tab in the last cell adds a row. Undo takes it out with the cell editor's
  // row, so the editor is made again; redo and the undo after it leave the
  // editor in its cell.
  await open('table-rows', table, '.rich-pane td')
  await page.keyboard.press('Tab')
  const added = await changed(table)
  await step('undo of an added row', undoKey, table)
  await step('redo of an added row', redoKey, added)
  await step('undo after a redo', undoKey, table)

  await open('table-typing', table, '.rich-pane td')
  await page.keyboard.type('x')
  const typed = await changed(table)
  await step('undo of typing in a cell', undoKey, table)
  await step('redo of typing in a cell', redoKey, typed)

  // In the middle of the table, the table's edges, where the view scrolls to
  // for a place in it, do not show the cell.
  await open('table-middle', table, '.rich-pane td')
  for (let row = 0; row < 40; row++) await page.keyboard.press('ArrowUp')
  await page.keyboard.type('x')
  const middle = await changed(table)
  assert.deepEqual((await page.evaluate(restored, '.rich-pane')).cell, [41, 1])
  await step('undo of typing in a middle cell', undoKey, table)
  await step('redo of typing in a middle cell', redoKey, middle)

  // A cell taller than the pane shows the caret, not only the cell's top.
  const words = Array.from({ length: 600 }, (_, word) => `w${word}`).join(' ')
  const tall = `${lines}${rows(80, (row) => (row === 40 ? words : `v${row}`))}`
  await open('table-tall-cell', tall, '.rich-pane td')
  // Up into a cell puts the caret at the end of its text.
  for (let row = 0; row < 39; row++) await page.keyboard.press('ArrowUp')
  await page.keyboard.type('x')
  const taller = await changed(tall)
  assert.deepEqual((await page.evaluate(restored, '.rich-pane')).cell, [42, 1])
  await step('undo of typing in a cell taller than the pane', undoKey, tall)
  await step('redo of typing in a cell taller than the pane', redoKey, taller)

  // Find in a table too long to draw all its rows shows the match's cell,
  // in a row the table draws for it.
  const long = `${lines}${rows(1000, (row) => (row === 600 ? 'needle' : `v${row}`))}`
  await open('table-find', long, '.rich-pane td')
  await page.evaluate(() => {
    document.querySelector('.rich-pane').scrollTop = 0
  })
  await pressShortcut(app, `${mod}+f`)
  await page
    .getByRole('textbox', { name: 'Find in document', exact: true })
    .fill('needle')
  const found = await page
    .waitForFunction(showsCell, 'needle', { timeout: 3000 })
    .then(
      () => true,
      () => false,
    )
  t.diagnostic(JSON.stringify({ name: 'find in a long table', shown: found }))
  if (!found) differences.push('find in a long table: not shown')
  await page.keyboard.press('Escape')

  // Outside tables the view's own scrolling shows the caret.
  await open('paragraphs', paragraphs, '.rich-pane')
  await page.keyboard.type('x')
  const appended = await changed(paragraphs)
  await step('undo of typing in a paragraph', undoKey, paragraphs)
  await step('redo of typing in a paragraph', redoKey, appended)

  // Each view keeps its own caret. Undoing the formatted view's edit from the
  // source view restores no selection there: the source view keeps its place,
  // away from its caret on the first line.
  await page
    .locator('.view-switch')
    .getByRole('button', { name: 'Source view', exact: true })
    .click()
  await page.waitForFunction(
    () =>
      document.querySelector('.editor-panes.mode-markdown')?.dataset
        .sourceReady === 'true',
  )
  const source = '.source-pane .cm-scroller'
  const top = (scroller) => document.querySelector(scroller).scrollTop
  await page.evaluate((scroller) => {
    const pane = document.querySelector(scroller)
    pane.querySelector('.cm-content').cmTile.root.view.focus()
    pane.scrollTop = pane.scrollHeight / 2
  }, source)
  await page.waitForTimeout(500)
  const kept = await page.evaluate(top, source)
  await page.keyboard.press(undoKey)
  await waitForAsync(
    page,
    async (text) => (await window.hibi.getDocument()).markdown === text,
    paragraphs,
  )
  await page.waitForTimeout(500)
  const place = await page.evaluate(top, source)
  t.diagnostic(JSON.stringify({ name: 'undo of another view', kept, place }))
  if (Math.abs(place - kept) > 1)
    differences.push(`undo of another view: ${kept} became ${place}`)

  // The source view shows its own history steps as the formatted view does.
  await page.locator('.source-pane .cm-line').first().click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type('y')
  const sourced = await changed(paragraphs)
  await step('undo in the source view', undoKey, paragraphs, source)
  await step('redo in the source view', redoKey, sourced, source)

  assert.deepEqual(differences, [])
})
