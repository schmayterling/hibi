import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

test('autosave preserves later edits, pauses on external changes, and never prompts for unnamed drafts', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-autosave-'))
  const file = join(profile, 'note.md')
  await writeFile(file, 'original')
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
  page.setDefaultTimeout(6500)
  const rich = page.getByRole('textbox', { name: /document editor/i })
  await rich.waitFor()
  await app.evaluate(({ dialog }, file) => {
    globalThis.dialogsShown = 0
    dialog.showSaveDialog = async () => {
      globalThis.dialogsShown++
      return { canceled: true }
    }
    dialog.showMessageBox = async () => {
      globalThis.dialogsShown++
      return { response: 0 }
    }
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, file)
  const pill = page.locator('[data-status-id="autosave"]')
  assert.equal(await pill.innerText(), 'Autosave off')
  await pill.click()
  await page.getByRole('checkbox', { name: /^autosave$/i, exact: true }).check()
  await page.getByLabel(/^save after$/i, { exact: true }).selectOption('1000')
  await page.getByRole('button', { name: /^back to app$/i }).click()
  await rich.fill('new draft')
  await page.waitForTimeout(1200)
  assert.equal(await app.evaluate(() => globalThis.dialogsShown), 0)
  assert.equal(await pill.innerText(), 'Autosave · save first')
  await rich.fill('')
  await clickMenu(app, 'Open…')
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).canAutosave,
  )
  await app.evaluate(({ ipcMain }) => {
    const save = ipcMain._invokeHandlers.get('document:autosave')
    ipcMain.removeHandler('document:autosave')
    ipcMain.handle('document:autosave', async (...args) => {
      const result = await save(...args)
      globalThis.firstSaved = result.document?.markdown
      await new Promise((resolve) => setTimeout(resolve, 500))
      return result
    })
  })
  await rich.fill('first automatic save')
  await waitForAsync(
    page,
    async () =>
      (await window.hibi.getDocument()).savedMarkdown ===
      'first automatic save',
  )
  await rich.fill('keep typing during save')
  await waitForAsync(page, async () => !(await window.hibi.getDocument()).dirty)
  await page.waitForFunction(
    () =>
      document.querySelector('[data-status-id="autosave"]').textContent ===
      'Autosave · saved',
  )
  assert.equal(await rich.innerText(), 'keep typing during save')
  assert.equal(await readFile(file, 'utf8'), 'keep typing during save')
  assert.ok((await page.evaluate(() => window.hibi.listVersions())).length >= 3)
  await writeFile(file, 'external edit')
  await rich.fill('local edit')
  await page.waitForFunction(
    () =>
      document.querySelector('[data-status-id="autosave"]').textContent ===
      'Autosave · paused',
  )
  assert.equal(await app.evaluate(() => globalThis.dialogsShown), 0)
  assert.equal(await readFile(file, 'utf8'), 'external edit')
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).dirty,
    true,
  )
  await rich.fill('another local edit')
  await page.waitForTimeout(1200)
  assert.equal(await readFile(file, 'utf8'), 'external edit')
  await clickMenu(app, 'Save')
  await waitForAsync(page, async () => !(await window.hibi.getDocument()).dirty)
  assert.equal(await readFile(file, 'utf8'), 'another local edit')
  await page.waitForFunction(
    () =>
      document.querySelector('.tiptap')?.getAttribute('contenteditable') ===
      'true',
  )
  await rich.fill('autosave resumes')
  await waitForAsync(page, async () => !(await window.hibi.getDocument()).dirty)
  assert.equal(await readFile(file, 'utf8'), 'autosave resumes')
  await page.reload()
  await rich.waitFor()
  await pill.click()
  assert.equal(
    await page
      .getByRole('checkbox', { name: /^autosave$/i, exact: true })
      .isChecked(),
    true,
  )
  assert.equal(
    await page.getByLabel(/^save after$/i, { exact: true }).inputValue(),
    '1000',
  )
})
