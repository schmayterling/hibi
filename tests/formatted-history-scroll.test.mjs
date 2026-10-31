import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForAsync, waitForDocumentEditor } from './electron.mjs'
import { selectFormattedEngine } from './formatted-engine.mjs'
import { clickMenu, pressShortcut, redoKey, splitTab } from './keyboard.mjs'

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

// Whether the formatted view shows this text of a table cell.
function showsText(text) {
  const pane = document.querySelector('.rich-pane')
  const bounds = pane.getBoundingClientRect()
  for (const cell of pane.querySelectorAll('td')) {
    const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode
      const at = node.textContent.indexOf(text)
      if (at < 0) continue
      const range = document.createRange()
      range.setStart(node, at)
      range.setEnd(node, at + text.length)
      const box = range.getBoundingClientRect()
      return box.top >= bounds.top - 1 && box.bottom <= bounds.bottom + 1
    }
  }
  return false
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

  // Find in a cell taller than the pane shows the match, not only the cell's
  // top, also with no cell editor there: the find field keeps the focus.
  const deep = `${lines}${rows(80, (row) => (row === 40 ? `${words} needle` : `v${row}`))}`
  await open('table-tall-find', deep, '.rich-pane td')
  await page.evaluate(() => {
    document.querySelector('.rich-pane').scrollTop = 0
  })
  await pressShortcut(app, `${mod}+f`)
  await page
    .getByRole('textbox', { name: 'Find in document', exact: true })
    .fill('needle')
  const deepFound = await page.waitForFunction(showsText, 'needle').then(
    () => true,
    () => false,
  )
  t.diagnostic(
    JSON.stringify({ name: 'find in a tall cell', shown: deepFound }),
  )
  if (!deepFound) differences.push('find in a tall cell: not shown')
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

// Opening or closing a split gives the note's pane another view id. Its
// history stays its own: undo restores the caret of the pane's edit and
// shows it, as before the split.
test('codemirror: a pane undoes its own edits after a split opens or closes', {
  timeout: 120000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-history-split-'))
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
  const open = async (name, text) => {
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
  }
  // The caret of the note's pane and whether it shows there.
  const caret = (pane) =>
    page.evaluate((pane) => {
      const root = document.querySelector(pane)
      const view = root.querySelector('.cm-content').cmTile.root.view
      const bounds = root.getBoundingClientRect()
      const box = view.coordsAtPos(view.state.selection.main.head)
      return {
        head: view.state.selection.main.head,
        shown:
          !!box && box.top >= bounds.top - 1 && box.bottom <= bounds.bottom + 1,
      }
    }, pane)
  // Type at the end of the note in the pane, and the caret before that.
  // Focus the pane's view, scroll it to its top when asked, and let it measure.
  const focus = (pane, top) =>
    page.evaluate(
      async ({ pane, top }) => {
        const root = document.querySelector(pane)
        root.querySelector('.cm-content').cmTile.root.view.focus()
        if (top) root.scrollTop = 0
        for (let frame = 0; frame < 2; frame++)
          await new Promise(requestAnimationFrame)
      },
      { pane, top },
    )
  const typeAtEnd = async (pane, text) => {
    await focus(pane, false)
    await page.keyboard.press('ControlOrMeta+End')
    const before = await caret(pane)
    const from = await markdown()
    await page.keyboard.type(text)
    await waitForAsync(
      page,
      async (from) => (await window.hibi.getDocument()).markdown !== from,
      from,
    )
    return { at: before.head, from }
  }
  const differences = []
  // Undo in the pane, scrolled to its top, away from the caret it restores.
  const undo = async (name, pane, { at, from }) => {
    await focus(pane, true)
    await page.keyboard.press(undoKey)
    await waitForAsync(
      page,
      async (from) => (await window.hibi.getDocument()).markdown === from,
      from,
    )
    let last = null
    for (let read = 0; read < 30; read++) {
      await page.waitForTimeout(100)
      const now = await caret(pane)
      if (now.shown && JSON.stringify(now) === JSON.stringify(last)) break
      last = now
    }
    t.diagnostic(JSON.stringify({ name, at, ...last }))
    if (!last.shown || last.head !== at)
      differences.push(`${name}: ${JSON.stringify({ at, ...last })}`)
  }

  await open('warmup', 'warmup\n')
  await open('other', 'other\n')
  await open('paragraphs', paragraphs)
  const edit = await typeAtEnd('.rich-pane', 'x')
  const tabs = (await page.evaluate(() => window.hibi.getDocument())).tabs
  await splitTab(app, page, tabs.find((tab) => tab.name === 'other.md').id)
  const left = '.editor-page[data-side="left"] .rich-pane'
  await page.locator(`${left} .cm-content`).waitFor()
  await page.locator('.editor-page[data-side="right"] .cm-content').waitFor()
  await undo('undo in a split of an edit from before it', left, edit)

  const split = await typeAtEnd(left, 'y')
  await page.getByRole('button', { name: 'Close split' }).click()
  await page.locator('.editor-page[data-side]').first().waitFor({
    state: 'detached',
  })
  await waitForDocumentEditor(app, page)
  await undo('undo after a split closed of an edit in it', '.rich-pane', split)

  assert.deepEqual(differences, [])
})
