import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { electron } from './electron.mjs'
import {
  selectFormattedEngine,
  testFormattedEngines as test,
} from './formatted-engine.mjs'
import { waitForAsync } from './poll.mjs'

const markdown =
  '# Sizes\n\n| Name | Notes |\n| --- | --- |\n| one | first row |\n| two | second row |\n'

async function openNote(root, profile, apps, engine) {
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  apps.push(app)
  await app.evaluate(({ dialog }, root) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] })
  }, root)
  const page = await app.firstWindow()
  page.setDefaultTimeout(7000)
  await selectFormattedEngine(app, page, engine)
  await page.evaluate(() => window.hibi.openWorkspace())
  await page.getByRole('button', { name: 'Toggle workspace sidebar' }).click()
  await page.getByRole('treeitem', { name: 'note.md' }).click()
  const table = page.locator('.rich-pane table')
  await table.getByText('first row').waitFor()
  return { page, table }
}

/** Drag from just inside a cell border, so the resize handle is under the pointer. */
async function drag(page, cell, axis, distance) {
  await cell.evaluate((element) =>
    Promise.all(
      element.ownerDocument
        .getAnimations()
        .filter(
          (animation) =>
            animation.effect?.target?.contains(element) &&
            Number.isFinite(animation.effect.getComputedTiming().iterations),
        )
        .map((animation) => animation.finished.catch(() => {})),
    ),
  )
  const box = await cell.boundingBox()
  const x = axis === 'column' ? box.x + box.width - 2 : box.x + box.width / 2
  const y = axis === 'row' ? box.y + box.height - 2 : box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.locator(`.rich-pane [data-table-resize="${axis}"]`).waitFor()
  await page.mouse.down()
  for (let step = 1; step <= 4; step++)
    await page.mouse.move(
      x + (axis === 'column' ? (distance * step) / 4 : 0),
      y + (axis === 'row' ? (distance * step) / 4 : 0),
    )
  await page.mouse.up()
}

const sizes = (table) =>
  table.evaluate((element) => ({
    column: element.rows[0].cells[0].getBoundingClientRect().width,
    row: element.rows[1].getBoundingClientRect().height,
  }))

test('table columns and rows resize outside the Markdown file', {
  timeout: 60000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-table-resizing-'))
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
  let { page, table } = await openNote(
    root,
    join(folder, 'profile'),
    apps,
    t.formattedEngine,
  )

  const before = await sizes(table)
  await drag(page, table.locator('th').first(), 'column', 80)
  await drag(page, table.locator('tr').nth(1).locator('td').first(), 'row', 40)
  const after = await sizes(table)
  assert.ok(
    Math.abs(after.column - before.column - 80) <= 2,
    `column ${before.column} -> ${after.column}`,
  )
  assert.ok(
    Math.abs(after.row - before.row - 40) <= 2,
    `row ${before.row} -> ${after.row}`,
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
  const stored = JSON.parse(await readFile(layout, 'utf8'))
  const [entry] = stored.documents['note.md'].tables
  assert.match(entry.key, /^0:/)
  assert.equal(entry.columns.length, 1)
  assert.ok(Math.abs(entry.columns[0] - after.column) <= 1)
  assert.equal(entry.rows.length, 2)
  assert.equal(entry.rows[0], 0)
  assert.ok(Math.abs(entry.rows[1] - after.row) <= 1)
  assert.equal(await readFile(file, 'utf8'), markdown)
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).dirty,
    false,
  )

  await apps.pop().close()
  ;({ page, table } = await openNote(
    root,
    join(folder, 'profile'),
    apps,
    t.formattedEngine,
  ))
  await waitForAsync(
    page,
    (expected) => {
      const element = document.querySelector('.rich-pane table')
      return (
        Math.abs(
          element.rows[0].cells[0].getBoundingClientRect().width -
            expected.column,
        ) <= 1 &&
        Math.abs(
          element.rows[1].getBoundingClientRect().height - expected.row,
        ) <= 1
      )
    },
    after,
  )

  await table
    .locator('th')
    .first()
    .dblclick({
      position: {
        x: (await table.locator('th').first().boundingBox()).width - 2,
        y: 8,
      },
    })
  await waitForAsync(
    page,
    (width) =>
      document
        .querySelector('.rich-pane table')
        .rows[0].cells[0].getBoundingClientRect().width <
      width - 40,
    after.column,
  )
  assert.equal(await readFile(file, 'utf8'), markdown)
})
