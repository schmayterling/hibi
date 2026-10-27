import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { tableKey } from '../src/renderer/src/table-layout-store.ts'
import { electron } from './electron.mjs'
import { selectFormattedEngine } from './formatted-engine.mjs'
import { waitForAsync } from './poll.mjs'

const markdown =
  '# Sizes\n\n| Name | Notes |\n| --- | --- |\n| one | first row |\n| two | second row |\n'

/** Open the workspace's note in a fresh app on `profile`. */
async function openNote(root, profile, apps, engine) {
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  apps.push(app)
  await app.evaluate(({ dialog }, root) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] })
    // Quitting with the edited note answers the unsaved-changes prompt.
    dialog.showMessageBox = async () => ({ response: 1 })
  }, root)
  const page = await app.firstWindow()
  page.setDefaultTimeout(7000)
  await selectFormattedEngine(app, page, engine)
  await page.evaluate(() => window.hibi.openWorkspace())
  await page.getByRole('button', { name: 'Toggle workspace sidebar' }).click()
  await page.getByRole('treeitem', { name: 'note.md' }).click()
  return page
}

/** Drag from just inside a cell's edge, once the resize handle shows. */
async function drag(page, cell, axis, distance, handle) {
  const box = await cell.boundingBox()
  const x = axis === 'column' ? box.x + box.width - 2 : box.x + box.width / 2
  const y = axis === 'row' ? box.y + box.height - 2 : box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.locator(handle(axis)).waitFor()
  await page.mouse.down()
  for (let step = 1; step <= 4; step++)
    await page.mouse.move(
      x + (axis === 'column' ? (distance * step) / 4 : 0),
      y + (axis === 'row' ? (distance * step) / 4 : 0),
    )
  await page.mouse.up()
}

const stored = async (layout) =>
  JSON.parse(await readFile(layout, 'utf8')).documents['note.md']?.tables ?? []

test('formatted tables show and resize the column and row sizes the rich editor stores', {
  timeout: 120000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-formatted-table-sizes-'))
  const root = join(folder, 'notes')
  const file = join(root, 'note.md')
  const layout = join(root, '.hibi/layout.json')
  await mkdir(root)
  await writeFile(file, markdown)
  const apps = []
  t.after(async () => {
    for (const app of apps) await app.close()
    await rm(folder, { recursive: true, force: true })
  })
  const profile = join(folder, 'profile')

  // Sizes set in the rich editor.
  let page = await openNote(root, profile, apps, 'tiptap')
  const rich = page.locator('.tiptap table')
  await rich.getByText('first row').waitFor()
  await drag(
    page,
    rich.locator('th').first(),
    'column',
    80,
    (axis) => `.tiptap[data-table-resize="${axis}"]`,
  )
  await drag(
    page,
    rich.locator('tr').nth(1).locator('td').first(),
    'row',
    40,
    (axis) => `.tiptap[data-table-resize="${axis}"]`,
  )
  await waitForAsync(
    page,
    async () =>
      (
        await window.hibi.readTableLayout(
          (
            await window.hibi.getDocument()
          ).tabId,
        )
      )?.length === 1,
  )
  const [richEntry] = await stored(layout)
  await page.evaluate(() =>
    localStorage.setItem('hibi:formatted-engine', 'codemirror'),
  )
  await apps.pop().close()

  // The formatted view finds them by the table's key.
  page = await openNote(root, profile, apps, 'codemirror')
  const table = page.locator('.rich-pane .hibi-lp-table')
  await table.getByText('first row').waitFor()
  const measure = () =>
    table.evaluate((element) => {
      const rows = element.querySelector('table').rows
      return {
        column: rows[0].cells[0].getBoundingClientRect().width,
        row: rows[1].getBoundingClientRect().height,
      }
    })
  await waitForAsync(
    page,
    (expected) => {
      const rows = document.querySelector('.hibi-lp-table table').rows
      return (
        Math.abs(
          rows[0].cells[0].getBoundingClientRect().width - expected[0],
        ) <= 1 &&
        Math.abs(rows[1].getBoundingClientRect().height - expected[1]) <= 1
      )
    },
    [richEntry.columns[0], richEntry.rows[1]],
  )

  // Dragging an edge resizes and stores under the same key.
  const before = await measure()
  const handle = (axis) => `.hibi-lp-table[data-table-resize="${axis}"]`
  await drag(page, table.locator('th').first(), 'column', 40, handle)
  await waitForAsync(
    page,
    async (width) =>
      Math.abs(
        ((
          await window.hibi.readTableLayout(
            (
              await window.hibi.getDocument()
            ).tabId,
          )
        )?.[0]?.columns?.[0] ?? 0) - width,
      ) <= 2,
    before.column + 40,
  )
  const [entry] = await stored(layout)
  assert.equal(entry.key, richEntry.key)
  assert.ok(Math.abs(entry.columns[0] - (before.column + 40)) <= 2, entry)
  assert.deepEqual(entry.rows, richEntry.rows)

  // Renaming the header keeps the sizes under the table's new key.
  await table.locator('th').first().click()
  await page.keyboard.press('End')
  await page.keyboard.type('s')
  await waitForAsync(
    page,
    async (key) => {
      const tables = await window.hibi.readTableLayout(
        (await window.hibi.getDocument()).tabId,
      )
      return tables?.length === 1 && tables[0].key !== key
    },
    richEntry.key,
  )
  const [renamed] = await stored(layout)
  assert.deepEqual(renamed.columns, entry.columns)
  await page.keyboard.press('Escape')

  // Double-clicking the edge makes the column automatic again.
  const header = await table.locator('th').first().boundingBox()
  await page.mouse.move(header.x + header.width - 2, header.y + 8)
  await page.locator(handle('column')).waitFor()
  await page.mouse.dblclick(header.x + header.width - 2, header.y + 8)
  await waitForAsync(
    page,
    async () =>
      !(
        await window.hibi.readTableLayout(
          (
            await window.hibi.getDocument()
          ).tabId,
        )
      )?.[0]?.columns,
  )
  assert.ok((await measure()).column < before.column)
  // Sizes never enter the note, which holds only the unsaved header edit.
  assert.equal(await readFile(file, 'utf8'), markdown)
  assert.match(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    /^\| Names \| Notes \|$/m,
  )
})

test('the rich editor stores only the tables it changes', {
  timeout: 120000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-rich-table-updates-'))
  const root = join(folder, 'notes')
  const layout = join(root, '.hibi/layout.json')
  await mkdir(join(root, '.hibi'), { recursive: true })
  await writeFile(
    join(root, 'note.md'),
    '# Two\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n| C | D |\n| --- | --- |\n| 3 | 4 |\n',
  )
  const first = tableKey(0, ['A', 'B'])
  await writeFile(
    layout,
    JSON.stringify({
      version: 1,
      documents: {
        'note.md': { tables: [{ key: first, columns: [100, 0], rows: null }] },
      },
    }),
  )
  const apps = []
  t.after(async () => {
    for (const app of apps) await app.close()
    await rm(folder, { recursive: true, force: true })
  })
  const page = await openNote(root, join(folder, 'profile'), apps, 'tiptap')
  const rich = page.locator('.tiptap table')
  await rich.nth(1).getByText('3').waitFor()
  // Another view or window stores a new width for the first table.
  await page.evaluate(async (key) => {
    const { tabId } = await window.hibi.getDocument()
    await window.hibi.writeTableLayout(tabId, {
      remove: [key],
      put: [{ key, columns: [180, 0], rows: null }],
    })
  }, first)
  // Another window gives the second, unsized table its first size, a row height.
  const second = tableKey(1, ['C', 'D'])
  await page.evaluate(async (key) => {
    const { tabId } = await window.hibi.getDocument()
    await window.hibi.writeTableLayout(tabId, {
      remove: [],
      put: [],
      set: [{ key, axis: 'row', index: 1, size: 90 }],
    })
  }, second)
  // The rich editor resizes the second table: its save keeps the first's
  // width and the second's row height.
  await drag(
    page,
    rich.nth(1).locator('th').first(),
    'column',
    40,
    (axis) => `.tiptap[data-table-resize="${axis}"]`,
  )
  await waitForAsync(
    page,
    async (key) =>
      (
        await window.hibi.readTableLayout(
          (
            await window.hibi.getDocument()
          ).tabId,
        )
      )?.find((table) => table.key === key)?.columns?.[0] > 0,
    second,
  )
  const tables = await stored(layout)
  assert.deepEqual(
    tables.find((table) => table.key === first)?.columns,
    [180, 0],
  )
  assert.ok(tables.find((table) => table.key === second)?.columns?.[0] > 0)
  assert.equal(tables.find((table) => table.key === second)?.rows?.[1], 90)
})
