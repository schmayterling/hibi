import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'

test('quick note captures to a chosen folder without replacing files', {
  timeout: 45000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-quick-note-'))
  const workspace = join(root, 'workspace')
  const folder = join(workspace, 'Notes')
  const profile = join(root, 'profile')
  await mkdir(folder, { recursive: true })
  await mkdir(profile)
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'quick-note': true }),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  await app.evaluate(({ dialog }, destination) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [destination],
    })
  }, workspace)
  const page = await app.firstWindow()
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  await page.evaluate(() => window.hibi.openWorkspace())
  await clickMenu(app, 'Command palette')
  await page
    .getByRole('combobox', { name: /search commands/i })
    .fill('Quick note: capture')
  await page.getByRole('option', { name: /Quick note: capture/i }).click()
  const defaultDialog = page.getByRole('dialog', { name: 'Quick note' })
  assert.equal(
    await defaultDialog.getByRole('textbox', { name: 'Title' }).count(),
    0,
  )
  await defaultDialog
    .getByRole('textbox', { name: 'Note' })
    .fill('Default thought')
  await defaultDialog.getByRole('button', { name: 'Save note' }).click()
  await defaultDialog.waitFor({ state: 'hidden' })
  assert.equal(
    await readFile(join(workspace, 'Quick note.md'), 'utf8'),
    'Default thought',
  )
  await clickMenu(app, 'Command palette')
  await page
    .getByRole('combobox', { name: /search commands/i })
    .fill('Quick note settings')
  await page.getByRole('option', { name: /Quick note settings/i }).click()
  await page.getByLabel('Folder', { exact: true }).selectOption('Notes')
  await page.getByLabel('Ask for a title').check()
  await page.getByLabel('Default title').fill('Draft')
  await page.getByLabel('Global shortcut').fill('')
  await page.getByRole('button', { name: 'Save settings' }).click()
  await page
    .getByRole('status')
    .getByText('Quick note settings saved.')
    .waitFor()
  await clickMenu(app, 'Command palette')
  await page
    .getByRole('combobox', { name: /search commands/i })
    .fill('Quick note: capture')
  await page.getByRole('option', { name: /Quick note: capture/i }).click()
  const dialog = page.getByRole('dialog', { name: 'Quick note' })
  await dialog.getByRole('textbox', { name: 'Title' }).fill('Daily')
  await dialog.getByRole('textbox', { name: 'Note' }).fill('First thought')
  await dialog.getByRole('button', { name: 'Save note' }).click()
  await dialog.waitFor({ state: 'hidden' })
  assert.equal(
    await readFile(join(folder, 'Daily.md'), 'utf8'),
    'First thought',
  )

  const request = {
    workspaceId: '',
    folder: 'Notes',
    title: 'Daily',
    markdown: 'Second thought',
  }
  const second = await page.evaluate(
    (input) => window.hibi.invokeAddon('quick-note', 'save', input),
    request,
  )
  assert.equal(second.name, 'Daily 2.md')
  assert.equal(
    await readFile(join(folder, 'Daily.md'), 'utf8'),
    'First thought',
  )
  assert.equal(
    await readFile(join(folder, 'Daily 2.md'), 'utf8'),
    'Second thought',
  )
  await assert.rejects(
    page.evaluate(
      (input) =>
        window.hibi.invokeAddon('quick-note', 'save', {
          ...input,
          folder: '../outside',
        }),
      request,
    ),
    /file or folder name|folder inside/,
  )

  const other = join(root, 'other')
  await mkdir(join(other, 'Inbox'), { recursive: true })
  await app.evaluate(({ dialog }, destination) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [destination],
    })
  }, other)
  await clickMenu(app, 'Command palette')
  await page
    .getByRole('combobox', { name: /search commands/i })
    .fill('Quick note settings')
  await page.getByRole('option', { name: /Quick note settings/i }).click()
  const settings = page.getByRole('tabpanel', { name: 'Quick note' })
  await settings.getByRole('button', { name: 'Choose workspace…' }).click()
  const recent = await page.evaluate(() => window.hibi.getRecentWorkspaces())
  const otherPath = await realpath(other)
  const otherId = recent.find((entry) => entry.path === otherPath)?.id
  assert.ok(otherId)
  await page.waitForFunction(
    (id) => document.querySelector('#quick-note-workspace')?.value === id,
    otherId,
  )
  assert.equal(
    await settings.getByLabel('Workspace', { exact: true }).inputValue(),
    otherId,
  )
  await settings.getByLabel('Folder', { exact: true }).selectOption('Inbox')
  await page.getByRole('button', { name: 'Save settings' }).click()
  await clickMenu(app, 'Command palette')
  await page
    .getByRole('combobox', { name: /search commands/i })
    .fill('Quick note: capture')
  await page.getByRole('option', { name: /Quick note: capture/i }).click()
  const secondDialog = page.getByRole('dialog', { name: 'Quick note' })
  await secondDialog.getByRole('textbox', { name: 'Title' }).fill('Elsewhere')
  await secondDialog
    .getByRole('textbox', { name: 'Note' })
    .fill('Another workspace')
  await secondDialog.getByRole('button', { name: 'Save note' }).click()
  await secondDialog.waitFor({ state: 'hidden' })
  assert.equal(
    await readFile(join(other, 'Inbox', 'Elsewhere.md'), 'utf8'),
    'Another workspace',
  )
})
