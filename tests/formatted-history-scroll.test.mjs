import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForAsync, waitForDocumentEditor } from './electron.mjs'
import { selectFormattedEngine } from './formatted-engine.mjs'
import { clickMenu, redoKey } from './keyboard.mjs'

const undoKey = 'ControlOrMeta+z'
const lines = 'line\n\n'.repeat(60)
// Both notes open at their top with the caret at their end, far below: in
// the table's last cell, or after the last paragraph's text.
const table = `${lines}| aa | bb |\n| -- | -- |\n${Array.from(
  { length: 80 },
  (_, row) => `| r${row} | v${row} |`,
).join('\n')}\n`
const paragraphs = `${lines}${lines}last\n`

// The selection a history step restored, read where the user sees it: the
// cell whose editor has focus, or the view's caret, and whether it is inside
// the element that scrolls the view.
function restored(scroller) {
  const pane = document.querySelector(scroller)
  const view = pane.querySelector('.cm-content').cmTile.root.view
  const cell = document.activeElement?.closest('td, th')
  const box =
    cell?.getBoundingClientRect() ??
    view.coordsAtPos(view.state.selection.main.head)
  const bounds = pane.getBoundingClientRect()
  return {
    // The table's line and column.
    cell: cell ? [Number(cell.parentElement.dataset.line), cell.cellIndex] : null,
    shown:
      !!box && box.top >= bounds.top - 1 && box.bottom <= bounds.bottom + 1,
  }
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
  await selectFormattedEngine(app, page, 'codemirror')
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

  // Outside tables the view's own scrolling shows the caret.
  await open('paragraphs', paragraphs, '.rich-pane')
  await page.keyboard.type('x')
  const appended = await changed(paragraphs)
  await step('undo of typing in a paragraph', undoKey, paragraphs)
  await step('redo of typing in a paragraph', redoKey, appended)

  // The source view shows its history steps the same way.
  await page
    .locator('.view-switch')
    .getByRole('button', { name: 'Source view', exact: true })
    .click()
  await page.waitForFunction(
    () =>
      document.querySelector('.editor-panes.mode-markdown')?.dataset
        .sourceReady === 'true',
  )
  await page.locator('.source-pane .cm-line').first().click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type('y')
  const sourced = await changed(appended)
  const source = '.source-pane .cm-scroller'
  await step('undo in the source view', undoKey, appended, source)
  await step('redo in the source view', redoKey, sourced, source)

  assert.deepEqual(differences, [])
})
