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
// also when it stays in the table cell being edited, and when an addon asks
// for them. Each step starts with the note scrolled to its top, away from
// that selection.
test('codemirror: undo and redo scroll to the selection they restore', {
  timeout: 180000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-history-scroll-'))
  const profile = join(folder, 'profile')
  // An addon that runs the app's undo and redo commands, as Vim mode does.
  const addon = join(profile, 'installed-addons', 'history-commands')
  await mkdir(addon, { recursive: true })
  await writeFile(
    join(addon, 'hibi-addon.json'),
    JSON.stringify({
      id: 'history-commands',
      name: 'History commands',
      description: 'Runs undo and redo',
      kind: 'extension',
      apiVersion: 3,
      capabilities: [],
      version: '1.0.0',
      authors: [{ displayName: 'Test' }],
      entry: 'index.js',
    }),
  )
  await writeFile(
    join(addon, '.hibi-install.json'),
    JSON.stringify({
      hash: 'a'.repeat(64),
      files: ['index.js', 'hibi-addon.json'],
      source: 'local',
    }),
  )
  await writeFile(
    join(addon, 'index.js'),
    'export default () => ({ start(context) { window.historyApp = context.app } })',
  )
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'history-commands': true }),
  )
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
  // The toolbar stays shown, for its table actions.
  await waitForFormattedEditor(app, page)
  await page.evaluate(() =>
    localStorage.setItem('hibi:toolbar', JSON.stringify({ autoHide: false })),
  )
  await waitForFormattedEditor(app, page, { reload: true })
  await page.waitForFunction(() => !!window.historyApp)
  const command = (name) => () =>
    page.evaluate((name) => window.historyApp.runCommand(name), name)
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
  // Each step presses `key` or makes a call; its selection must show, in
  // `cell` when one is given.
  const step = async (name, key, text, scroller = '.rich-pane', cell) => {
    await page.evaluate((scroller) => {
      document.querySelector(scroller).scrollTop = 0
    }, scroller)
    await (typeof key === 'string' ? page.keyboard.press(key) : key())
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
    if (
      !last.shown ||
      (cell && JSON.stringify(last.cell) !== JSON.stringify(cell))
    )
      differences.push(`${name}: ${JSON.stringify(last)}`)
  }

  // Tab in the last cell adds a row and edits its first cell. Undo takes it
  // out with the cell editor's row, so the editor is made again in the cell
  // Tab left; redo brings the caret back to the new row, as native editors
  // do, and the undo after it to the cell Tab left.
  await open('table-rows', table, '.rich-pane td')
  await page.keyboard.press('Tab')
  const added = await changed(table)
  await step('undo of an added row', undoKey, table, '.rich-pane', [81, 1])
  await step('redo of an added row', redoKey, added, '.rich-pane', [82, 0])
  await step('undo after a redo', undoKey, table, '.rich-pane', [81, 1])

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
  await step('addon undo in a middle cell', command('undo'), table)
  await step('addon redo in a middle cell', command('redo'), middle)

  // A toolbar table action redoes with the caret where it left it, as Tab
  // does: a row before puts it in the new row's first cell.
  await open('table-toolbar', table, '.rich-pane td')
  for (let row = 0; row < 40; row++) await page.keyboard.press('ArrowUp')
  const bar = page.getByRole('navigation', { name: /editor toolbar/i })
  const rowBefore = bar.locator('[data-toolbar-id="format.row-before"]')
  const hidden = await rowBefore.evaluate(
    (element) =>
      !!element.closest('.toolbar-menu') &&
      !element.closest('.toolbar-menu').matches(':popover-open'),
  )
  if (hidden)
    await bar
      .getByRole('button', { name: /^more formatting actions$/i, exact: true })
      .click()
  await rowBefore.click()
  const rowed = await changed(table)
  await step('undo of a toolbar row', undoKey, table, '.rich-pane', [41, 1])
  await step('redo of a toolbar row', redoKey, rowed, '.rich-pane', [41, 0])

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
  const found = await page.waitForFunction(showsCell, 'needle').then(
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

  // A match at the start of a tall cell above the pane: the cell comes in
  // from above with its bottom in view, and the match is above that.
  const high = `${lines}${rows(80, (row) => (row === 40 ? `needle ${words}` : `v${row}`))}`
  await open('table-tall-find-above', high, '.rich-pane td')
  await page.evaluate(() => {
    const pane = document.querySelector('.rich-pane')
    pane.scrollTop = pane.scrollHeight
  })
  assert.equal(await page.evaluate(showsText, 'needle'), false)
  await pressShortcut(app, `${mod}+f`)
  await page
    .getByRole('textbox', { name: 'Find in document', exact: true })
    .fill('needle')
  const highFound = await page.waitForFunction(showsText, 'needle').then(
    () => true,
    () => false,
  )
  t.diagnostic(
    JSON.stringify({ name: 'find in a tall cell above', shown: highFound }),
  )
  if (!highFound) differences.push('find in a tall cell above: not shown')
  await page.keyboard.press('Escape')

  // Outside tables the view's own scrolling shows the caret.
  await open('paragraphs', paragraphs, '.rich-pane')
  await page.keyboard.type('x')
  const appended = await changed(paragraphs)
  await step('undo of typing in a paragraph', undoKey, paragraphs)
  await step('redo of typing in a paragraph', redoKey, appended)
  await step('addon undo in a paragraph', command('undo'), paragraphs)
  await step('addon redo in a paragraph', command('redo'), appended)

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
  // A view shown for the first time estimates its line heights until it
  // measures them in view, which can come after the switch: a scroll before
  // that lands where the estimates put it, and moves when they are measured.
  await page.evaluate(async (scroller) => {
    const { view } = document
      .querySelector(scroller)
      .querySelector('.cm-content').cmTile.root
    const measure = () =>
      new Promise((done) => view.requestMeasure({ read() {}, write: done }))
    for (let height = -1; ; ) {
      await measure()
      if (view.inView && view.contentHeight === height) break
      height = view.inView ? view.contentHeight : -1
    }
  }, source)
  // The pane's scroll position once it holds over two frames: a view
  // measures, and so scrolls, in the frame after a change.
  const settled = (scroller) =>
    page.evaluate(async (scroller) => {
      const pane = document.querySelector(scroller)
      const frame = () => new Promise(requestAnimationFrame)
      let last = null
      for (let read = 0; read < 50 && pane.scrollTop !== last; read++) {
        last = pane.scrollTop
        await frame()
        await frame()
      }
      return pane.scrollTop
    }, scroller)
  await page.evaluate((scroller) => {
    const pane = document.querySelector(scroller)
    pane.querySelector('.cm-content').cmTile.root.view.focus()
    pane.scrollTop = pane.scrollHeight / 2
  }, source)
  const kept = await settled(source)
  // The caret is off screen there, so a step that showed it would scroll.
  assert.equal((await page.evaluate(restored, source)).shown, false)
  await page.keyboard.press(undoKey)
  await waitForAsync(
    page,
    async (text) => (await window.hibi.getDocument()).markdown === text,
    paragraphs,
  )
  const place = await settled(source)
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
  await step(
    'addon undo in the source view',
    command('undo'),
    paragraphs,
    source,
  )
  await step('addon redo in the source view', command('redo'), sourced, source)

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
  await waitForFormattedEditor(app, page)
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
  // Focusing the other pane of a split makes its tab the active one: until
  // that is done the app is busy and its views read-only, and a key does nothing.
  const focus = (pane, top) =>
    page.evaluate(
      async ({ pane, top }) => {
        const root = document.querySelector(pane)
        const view = root.querySelector('.cm-content').cmTile.root.view
        view.focus()
        if (top) root.scrollTop = 0
        const ready = () =>
          root.closest('.editor-page')?.dataset.active === 'true' &&
          document.querySelector('.app')?.getAttribute('aria-busy') ===
            'false' &&
          !view.state.readOnly
        for (let frame = 0; frame < 2 || !ready(); frame++)
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

  // The view a pane shows once it is made again, not the one it had, and
  // takes input: a key pressed while it is still read-only does nothing.
  const view = (pane) =>
    page.evaluateHandle(
      (pane) => document.querySelector(`${pane} .cm-content`).cmTile.root.view,
      pane,
    )
  const remade = (pane, before) =>
    page.waitForFunction(
      ({ pane, before }) => {
        const view = document.querySelector(`${pane} .cm-content`)?.cmTile.root
          .view
        return !!view && view !== before && !view.state.readOnly
      },
      { pane, before },
    )
  const select = (pane, anchor) =>
    page.evaluate(
      ({ pane, anchor }) =>
        document
          .querySelector(`${pane} .cm-content`)
          .cmTile.root.view.dispatch({ selection: { anchor } }),
      { pane, anchor },
    )
  // The caret a pane's view was made with.
  const kept = async (name, pane, at) => {
    const { head } = await caret(pane)
    t.diagnostic(JSON.stringify({ name, at, head }))
    if (head !== at)
      differences.push(`${name}: ${JSON.stringify({ at, head })}`)
  }
  const idle = () => page.locator('.app[aria-busy="false"]').waitFor()
  const left = '.editor-page[data-side="left"] .rich-pane'
  const right = '.editor-page[data-side="right"] .rich-pane'
  const openSplit = async (name) => {
    const before = await view('.rich-pane')
    const { tabs } = await page.evaluate(() => window.hibi.getDocument())
    await splitTab(app, page, tabs.find((tab) => tab.name === name).id)
    await remade(left, before)
    await page.locator(`${right} .cm-content`).waitFor()
    await idle()
  }
  const closeSplit = async () => {
    const before = await view(left)
    await page.getByRole('button', { name: 'Close split', exact: true }).click()
    await remade('.rich-pane', before)
    await waitForDocumentEditor(app, page)
  }

  await open('warmup', 'warmup\n')
  await open('other', 'other\n')
  await open('paragraphs', paragraphs)
  const edit = await typeAtEnd('.rich-pane', 'x')
  await openSplit('other.md')
  await kept('caret when a split opens', left, edit.at + 1)
  await undo('undo in a split of an edit from before it', left, edit)

  const split = await typeAtEnd(left, 'y')
  await closeSplit()
  await undo('undo after a split closed of an edit in it', '.rich-pane', split)

  // The other pane shows another note before the split closes.
  await openSplit('other.md')
  await select(left, 100)
  await page.getByRole('tab', { name: 'warmup.md', exact: true }).click()
  await page.waitForFunction(() =>
    document
      .querySelector('.editor-page[data-side="right"] .split-tab-heading')
      ?.textContent.includes('warmup.md'),
  )
  await idle()
  await closeSplit()
  await kept(
    'caret after the other pane showed another note',
    '.rich-pane',
    100,
  )

  // One note in both panes: the left pane takes the note's caret, and its
  // own caret stays when the split closes.
  await openSplit('paragraphs.md')
  await kept('caret of the left pane of one note in both', left, 100)
  await select(left, 200)
  await select(right, 50)
  await closeSplit()
  await kept('caret when a split of one note closes', '.rich-pane', 200)

  // With the note in both panes, the pane that stays takes the other pane's
  // steps too: undo after the split closes shows what it takes back, where
  // the other pane typed, rather than changing text out of view.
  await openSplit('paragraphs.md')
  const other = await typeAtEnd(right, 'z')
  await focus(left, false)
  await page.keyboard.press('ControlOrMeta+Home')
  await closeSplit()
  await undo('undo after a split of one note closed', '.rich-pane', other)

  assert.deepEqual(differences, [])
})
