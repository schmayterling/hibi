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
import { crashAndReload, electron, waitForDocumentEditor } from './electron.mjs'
import { clickMenu, replaceRichText, replaceSourceText } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

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
  await waitForDocumentEditor(app, page)
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
  }, destination)
  await replaceRichText(page, rich, 'hello file')
  await clickMenu(app, 'Save')
  await page
    .getByRole('status', { name: /unsaved changes/i })
    .waitFor({ state: 'hidden' })
  assert.equal(await readFile(destination, 'utf8'), 'hello file')
  assert.equal(
    (await readdir(folder)).some((name) => name.endsWith('.tmp')),
    false,
  )

  await replaceRichText(page, rich, 'unsaved draft')
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
    .getByRole('button', { name: /^source view$/i, exact: true })
    .click()
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
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

  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  const draft = 'recover this draft'
  await replaceSourceText(
    page,
    page.getByRole('textbox', { name: /markdown editor/i }),
    draft,
  )
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    draft,
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    draft,
  )
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
  await crashAndReload(app)
  const recovered = await app.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents
    return contents.executeJavaScript('window.hibi.getDocument()')
  })
  assert.equal(recovered.markdown, draft)
  assert.equal(recovered.dirty, true)
})
