import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForAsync } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'

test('vim block visual draws and edits every line without adding mouse cursors', {
  timeout: 60000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-vim-block-'))
  const profile = join(root, 'profile')
  await mkdir(profile)
  await writeFile(join(profile, 'addons.json'), JSON.stringify({ vim: true }))
  const file = join(root, 'note.md')
  const original = 'alpha\nbravo\ncharlie\n'
  await writeFile(file, original)
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, file)
  const page = await app.firstWindow()
  page.setDefaultTimeout(8000)
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  await clickMenu(app, 'Open…')
  await page.getByRole('button', { name: /^source view$/i }).click()
  const source = page.getByRole('textbox', { name: /markdown editor/i })
  await page.locator('.source-pane [data-vim-plugin]').waitFor()
  await source.click()
  for (const key of ['Escape', 'g', 'g', '0', 'Control+v', 'l', 'j', 'j'])
    await source.press(key)
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.source-pane .cm-selectionBackground')
        .length >= 3,
  )
  const lines = await source.locator('.hibi-vim-selected').allTextContents()
  assert.deepEqual(lines, ['al', 'br', 'ch'])
  await source.press('d')
  const read = () =>
    page.evaluate(async () => (await window.hibi.getDocument()).markdown)
  assert.equal(await read(), 'pha\navo\narlie\n')
  await source.press('u')
  await waitForAsync(
    page,
    async (original) => (await window.hibi.getDocument()).markdown === original,
    original,
  )
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^addon manager$/i, exact: true }).click()
  await page.locator('#addon-vim').click()
  await page.waitForFunction(
    () => !document.querySelector('#addon-vim')?.checked,
  )
  await page.getByRole('button', { name: /^back to app$/i }).click()
  await page
    .locator('.source-pane [data-vim-plugin]')
    .waitFor({ state: 'detached' })
  await source.locator('.cm-line').first().click()
  await source
    .locator('.cm-line')
    .nth(2)
    .click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] })
  await source.pressSequentially('X')
  assert.equal((await read()).match(/X/g)?.length, 1)
  assert.equal(
    await page.locator('.source-pane .cm-selectionBackground').count(),
    0,
  )
})
