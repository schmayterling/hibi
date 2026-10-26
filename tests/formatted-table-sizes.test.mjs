import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { waitForAsync } from './poll.mjs'

const markdown =
  '# Sizes\n\n| Name | Notes |\n| --- | --- |\n| one | first row |\n| two | second row |\n'

/** Open the workspace's note in a fresh app on `profile`. */
async function openNote(root, profile, apps) {
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  apps.push(app)
  await app.evaluate(({ dialog }, root) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] })
  }, root)
  const page = await app.firstWindow()
  page.setDefaultTimeout(7000)
  await waitForDocumentEditor(app, page)
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
  let page = await openNote(root, profile, apps)
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
  page = await openNote(root, profile, apps)
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
  // Sizes never enter the note.
  assert.equal(await readFile(file, 'utf8'), markdown)
})
