import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForFormattedEditor } from './electron.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

test('Enter and Escape that end an input method composition leave the palette, find and a rename open', {
  timeout: 60000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-ime-keys-'))
  const notes = join(profile, 'notes')
  await mkdir(notes)
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(8000)
  await waitForFormattedEditor(app, page)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const compose = (text) =>
    cdp.send('Input.imeSetComposition', {
      text,
      selectionStart: text.length,
      selectionEnd: text.length,
    })
  const commit = (text) => cdp.send('Input.insertText', { text })
  const press = async (key, keyCode) => {
    for (const type of ['rawKeyDown', 'keyUp'])
      await cdp.send('Input.dispatchKeyEvent', {
        type,
        key,
        code: key,
        windowsVirtualKeyCode: keyCode,
      })
  }

  // The palette, and the dialog it is.
  await clickMenu(app, 'Command palette')
  const palette = page.getByRole('dialog', { name: /^command palette$/i })
  await page.getByRole('combobox', { name: /^search commands$/i }).focus()
  // Enter commits the reading; it runs none of the commands it matches.
  await compose('settings')
  await press('Enter', 13)
  await page.waitForTimeout(200)
  assert.equal(await palette.isVisible(), true)
  await compose('か')
  await press('Escape', 27)
  await page.waitForTimeout(200)
  assert.equal(await palette.isVisible(), true)
  await commit('か')
  await press('Escape', 27)
  await palette.waitFor({ state: 'hidden' })

  // Find in document.
  await pressShortcut(app, `${mod}+f`)
  const find = page.getByRole('textbox', {
    name: /^find in document$/i,
    exact: true,
  })
  await find.focus()
  await compose('か')
  await press('Escape', 27)
  await page.waitForTimeout(200)
  assert.equal(await find.isVisible(), true)
  await commit('か')
  await press('Escape', 27)
  await find.waitFor({ state: 'hidden' })

  // Renaming a new note in the explorer.
  await app.evaluate(({ dialog }, notes) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [notes],
    })
  }, notes)
  await pressShortcut(app, `${mod}+Shift+o`)
  await page
    .getByRole('button', { name: 'New workspace file', exact: true })
    .click()
  const name = page.getByRole('textbox', { name: 'Rename item', exact: true })
  await name.waitFor()
  await compose('か')
  await press('Enter', 13)
  await page.waitForTimeout(200)
  assert.equal(await name.isVisible(), true)
  await commit('か')
  await press('Enter', 13)
  await name.waitFor({ state: 'hidden' })
  await cdp.detach()
})
