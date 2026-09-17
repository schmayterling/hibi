import assert from 'node:assert/strict'
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'

test('native file operations preserve drafts and avoid silent overwrites', {
  timeout: 30000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-files-'))
  const alias = join(folder, 'linked')
  await symlink(folder, alias, 'junction')
  const destination = join(alias, 'saved.md')
  const fixture = join(folder, 'original.md')
  const original =
    '---\ntitle: source fidelity\n---\n\n<div data-note="keep">exact text</div>\n'
  await writeFile(fixture, original)
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({
        response: 1,
        checkboxChecked: false,
      })
    })
    await app.close()
    await rm(folder, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  const rich = page.getByRole('textbox', { name: /document editor/i })
  await rich.waitFor()
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
  }, destination)
  await rich.fill('hello file')
  await clickMenu(app, 'Save')
  await page
    .getByRole('status', { name: /unsaved changes/i })
    .waitFor({ state: 'hidden' })
  assert.equal(await readFile(destination, 'utf8'), 'hello file')
  assert.equal(
    (await readdir(folder)).some((name) => name.endsWith('.tmp')),
    false,
  )

  await rich.fill('unsaved draft')
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({
      response: 2,
      checkboxChecked: false,
    })
  })
  // Await cancellation before replacing the next dialog response.
  assert.equal(
    await page.evaluate(async () =>
      window.hibi.closeDocumentTab((await window.hibi.getDocument()).tabId),
    ),
    null,
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    'unsaved draft',
  )

  await writeFile(destination, 'external change')
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({
      response: 1,
      checkboxChecked: false,
    })
  })
  assert.equal(await page.evaluate(() => window.hibi.saveDocument(false)), null)
  assert.equal(await readFile(destination, 'utf8'), 'external change')
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).dirty,
    true,
  )
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({
      response: 0,
      checkboxChecked: false,
    })
  })
  await clickMenu(app, 'Save')
  await page
    .getByRole('status', { name: /unsaved changes/i })
    .waitFor({ state: 'hidden' })
  assert.equal(await readFile(destination, 'utf8'), 'unsaved draft')

  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, fixture)
  await clickMenu(app, 'Open…')
  await page
    .getByRole('tab', { name: /^original\.md$/i, exact: true })
    .waitFor()
  await page
    .getByRole('button', { name: /^markdown only$/i, exact: true })
    .click()
  await page.getByRole('textbox', { name: /markdown editor/i }).waitFor()
  await clickMenu(app, 'Save')
  assert.equal(await readFile(fixture, 'utf8'), original)
  assert.equal(
    await page.evaluate(() =>
      window.hibi.updateDocument(42).then(
        () => false,
        () => true,
      ),
    ),
    true,
  )

  await page.waitForFunction(
    () =>
      document.querySelector('.cm-content')?.getAttribute('contenteditable') ===
      'true',
  )
  await page
    .getByRole('textbox', { name: /markdown editor/i })
    .fill('recover this draft')
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({
      response: 2,
      checkboxChecked: false,
    })
  })
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].close()
  })
  assert.equal(
    await app.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    ),
    1,
  )
  // Finish pending locator-handle disposal before crashing the debug target.
  await page.evaluate(() => undefined)
  const crashed = page.waitForEvent('crash')
  const [recovered] = await Promise.all([
    app.evaluate(async ({ dialog, BrowserWindow }) => {
      dialog.showMessageBox = async () => ({
        response: 0,
        checkboxChecked: false,
      })
      const contents = BrowserWindow.getAllWindows()[0].webContents
      const loaded = new Promise((resolve) =>
        contents.once('did-finish-load', resolve),
      )
      contents.forcefullyCrashRenderer()
      await loaded
      return contents.executeJavaScript('window.hibi.getDocument()')
    }),
    crashed,
  ])
  assert.equal(recovered.markdown, 'recover this draft')
  assert.equal(recovered.dirty, true)
})
