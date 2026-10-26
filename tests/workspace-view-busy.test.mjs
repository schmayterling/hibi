import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'
import { uiName } from './ui.mjs'

test('opening a file and attaching media release editor busy state while explorer headers wait', {
  timeout: 30000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-view-busy-'))
  const folder = join(root, 'notes')
  await mkdir(folder)
  await writeFile(join(folder, 'one.md'), '# one')
  const image = join(root, 'image.gif')
  await writeFile(
    image,
    Buffer.from(
      'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
      'base64',
    ),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(root, 'profile')}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      globalThis.explorerBusy?.release()
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await waitForDocumentEditor(app, page)
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [folder],
    })
  }, folder)
  await page.evaluate(() => window.hibi.openWorkspace(false))
  await page.getByRole('button', { name: /toggle workspace sidebar/i }).click()
  const item = page.getByRole('treeitem', { name: 'one.md', exact: true })
  await item.waitFor()
  await app.evaluate(({ dialog, ipcMain }, image) => {
    const host = {}
    host.started = new Promise((resolve) => {
      host.start = resolve
    })
    host.held = new Promise((resolve) => {
      host.release = resolve
    })
    globalThis.explorerBusy = host
    const headers = ipcMain._invokeHandlers
    const read = headers.get('workspace:header')
    headers.set('workspace:header', async (...args) => {
      const result = await read(...args)
      host.start()
      await host.held
      return result
    })
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [image],
    })
  }, image)
  await item.click()
  await app.evaluate(async () => {
    await globalThis.explorerBusy.started
  })
  await waitForAsync(
    page,
    async () =>
      document.querySelector('.app')?.getAttribute('aria-busy') === 'false' &&
      document.querySelector('.tiptap')?.isContentEditable === true,
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).name,
    'one.md',
  )
  const rich = page.getByRole('textbox', { name: /document editor/i })
  await rich.click()
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await pressShortcut(app, `${mod}+k`)
  const palette = page.getByRole('dialog', { name: /command palette/i })
  await palette.getByRole('combobox').fill('image')
  await palette
    .getByRole('option')
    .filter({ has: page.getByText(uiName('image', true), { exact: true }) })
    .first()
    .click()
  await page
    .getByRole('textbox', { name: /document editor/i })
    .locator('img')
    .waitFor()
  await waitForAsync(
    page,
    async () =>
      document.querySelector('.app')?.getAttribute('aria-busy') === 'false',
  )
  assert.deepEqual(
    await readFile(join(folder, 'assets/image.gif')),
    await readFile(image),
  )
  await app.evaluate(() => globalThis.explorerBusy.release())
})
