import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { electron } from './electron.mjs'
import {
  selectFormattedEngine,
  testFormattedEngines as test,
} from './formatted-engine.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'

test('normal view edits and removes an existing link from the toolbar and the palette', {
  timeout: 60000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-link-edit-'))
  const fixture = join(folder, 'note.md')
  await writeFile(fixture, 'See [docs](https://old.example) here.\n')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(folder, { recursive: true, force: true })
  })
  await app.evaluate(({ dialog }, fixture) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [fixture],
    })
  }, fixture)
  const page = await app.firstWindow()
  page.setDefaultTimeout(8000)
  const editor = await selectFormattedEngine(app, page, t.formattedEngine)
  await clickMenu(app, 'Open…')
  await page.waitForFunction(() =>
    document
      .querySelector('.rich-pane :is(.tiptap, .cm-content)')
      ?.textContent.includes('docs'),
  )
  await page.getByRole('button', { name: /^normal$/i, exact: true }).waitFor()
  const read = async () =>
    (await page.evaluate(() => window.hibi.getDocument())).markdown.trim()
  // The rich editor publishes its Markdown after the edit.
  const settled = async (expected) => {
    const deadline = Date.now() + 5000
    while ((await read()) !== expected && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(await read(), expected)
  }
  const button = page.locator('.editor-toolbar [data-toolbar-id="format.link"]')
  const dialog = page.getByRole('dialog', { name: 'Edit link', exact: true })
  const destination = page.getByLabel('Link destination', { exact: true })

  // A plain click puts the caret in the link; the link action then edits it.
  await editor.getByText('docs', { exact: true }).click()
  await page.waitForFunction(
    () =>
      document
        .querySelector('.editor-toolbar [data-toolbar-id="format.link"]')
        ?.getAttribute('aria-label') === 'Edit link',
  )
  await button.click()
  await dialog.waitFor()
  assert.equal(await destination.inputValue(), 'https://old.example')
  await destination.fill('https://new.example')
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  await settled('See [docs](https://new.example) here.')

  // From the keyboard: the command palette lists the action as "Edit link".
  await editor.getByText('docs', { exact: true }).click()
  await page.waitForFunction(
    () =>
      document
        .querySelector('.editor-toolbar [data-toolbar-id="format.link"]')
        ?.getAttribute('aria-label') === 'Edit link',
  )
  await pressShortcut(
    app,
    process.platform === 'darwin' ? 'Meta+K' : 'Control+K',
  )
  const palette = page.getByRole('dialog', { name: /^command palette$/i })
  await palette
    .getByRole('combobox', { name: /search commands/i })
    .fill('edit link')
  // The first match, which Enter runs.
  await palette
    .getByRole('option')
    .first()
    .filter({ hasText: /^edit link/i })
    .waitFor()
  await page.keyboard.press('Enter')
  await dialog.waitFor()
  assert.equal(await destination.inputValue(), 'https://new.example')
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })
  assert.equal(await read(), 'See [docs](https://new.example) here.')

  // Removing keeps the text.
  await editor.getByText('docs', { exact: true }).click()
  await page.waitForFunction(
    () =>
      document
        .querySelector('.editor-toolbar [data-toolbar-id="format.link"]')
        ?.getAttribute('aria-label') === 'Edit link',
  )
  await button.click()
  await dialog.getByRole('button', { name: 'Remove link', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  await page.waitForFunction(
    () =>
      document
        .querySelector('.editor-toolbar [data-toolbar-id="format.link"]')
        ?.getAttribute('aria-label') === 'Link',
  )
  await settled('See docs here.')
})
