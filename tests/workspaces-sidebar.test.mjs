import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'

test('workspaces sidebar pins, hides, reopens, and confirms trash', {
  timeout: 60000,
}, async (t) => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'hibi-workspaces-')))
  const paths = ['one', 'two', 'three'].map((name) => join(temp, name))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(temp, 'profile')}`],
  })
  t.after(async () => {
    await app.close()
    await rm(temp, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(6500)
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  for (const path of paths) {
    await mkdir(path)
    await app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [selected],
      })
    }, path)
    await page.evaluate(() => window.hibi.openWorkspace())
  }
  await page.getByRole('button', { name: 'Toggle workspace sidebar' }).click()
  await page.getByRole('button', { name: 'Sidebar views' }).click()
  await page.getByRole('menuitem', { name: 'Workspaces' }).click()
  const sidebar = page.getByRole('complementary', { name: 'Workspaces' })
  const rows = sidebar.getByRole('treeitem')
  await rows.first().waitFor()
  assert.deepEqual(await rows.allTextContents(), ['three', 'two', 'one'])
  assert.match(await rows.first().getAttribute('data-tooltip'), /three/)
  assert.match(
    await rows.first().getAttribute('data-tooltip'),
    /hibi-workspaces-/,
  )

  await sidebar.getByRole('button', { name: 'Actions for one' }).click()
  await page.getByRole('menuitem', { name: 'Pin to top' }).click()
  await page.waitForFunction(
    (first) =>
      document.querySelector('.workspaces-sidebar [role="treeitem"]')
        ?.textContent === first,
    'one',
  )
  assert.deepEqual(await rows.allTextContents(), ['one', 'three', 'two'])

  await sidebar.getByRole('button', { name: 'Actions for two' }).click()
  await page.getByRole('menuitem', { name: 'Hide workspace' }).click()
  await rows.filter({ hasText: 'two' }).waitFor({ state: 'hidden' })
  assert.deepEqual(await rows.allTextContents(), ['one', 'three'])
  assert.equal(
    (await page.evaluate(() => window.hibi.getKnownWorkspaces())).find(
      (item) => item.path === paths[1],
    ).hidden,
    true,
  )

  await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [selected],
    })
  }, paths[1])
  await sidebar.getByRole('button', { name: 'Open a folder' }).click()
  await page.getByRole('button', { name: 'Sidebar views' }).click()
  await page.getByRole('menuitem', { name: 'Workspaces' }).click()
  await rows.filter({ hasText: 'two' }).waitFor()
  assert.equal(
    (await page.evaluate(() => window.hibi.getKnownWorkspaces())).find(
      (item) => item.path === paths[1],
    ).hidden,
    false,
  )

  await app.evaluate(({ shell }) => {
    globalThis.trashCalls = []
    shell.trashItem = async (path) => {
      globalThis.trashCalls.push(path)
    }
  })
  await sidebar.getByRole('button', { name: 'Actions for one' }).click()
  await page.getByRole('menuitem', { name: 'Delete workspace…' }).click()
  const confirmation = page.getByRole('dialog', { name: /move .* to trash/i })
  await page.mouse.click(4, 4)
  assert.equal(await confirmation.isVisible(), true)
  await confirmation.getByRole('button', { name: 'Cancel' }).click()
  assert.equal(await rows.count(), 3)
  assert.deepEqual(await app.evaluate(() => globalThis.trashCalls), [])

  await sidebar.getByRole('button', { name: 'Actions for one' }).click()
  await page.getByRole('menuitem', { name: 'Delete workspace…' }).click()
  await confirmation.getByRole('button', { name: 'Move to Trash' }).click()
  await rows.filter({ hasText: 'one' }).waitFor({ state: 'hidden' })
  assert.deepEqual(await app.evaluate(() => globalThis.trashCalls), [paths[0]])
  assert.equal(
    (await page.evaluate(() => window.hibi.getKnownWorkspaces())).some(
      (item) => item.path === paths[0],
    ),
    false,
  )

  await sidebar.getByRole('button', { name: 'Actions for two' }).click()
  await page.getByRole('menuitem', { name: 'Delete workspace…' }).click()
  await confirmation.getByRole('button', { name: 'Move to Trash' }).click()
  await rows.filter({ hasText: 'two' }).waitFor({ state: 'hidden' })
  assert.equal(await page.evaluate(() => window.hibi.getWorkspace()), null)
})
