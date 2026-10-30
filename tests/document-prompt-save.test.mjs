import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { electron, waitForDocumentEditor } from './electron.mjs'
import {
  selectFormattedEngine,
  testFormattedEngines as test,
} from './formatted-engine.mjs'
import { clickMenu, replaceRichText } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

async function fixture(t) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'hibi-prompt-save-')),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(root, 'profile')}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      globalThis.promptGate?.release?.()
      globalThis.promptGate?.restore()
      dialog.showMessageBox = async () => ({ response: 1 })
      globalThis.otherWindow?.destroy()
    })
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await selectFormattedEngine(app, page, t.formattedEngine)
  page.setDefaultTimeout(6500)
  await waitForDocumentEditor(app, page)
  const editor = page.getByRole('textbox', {
    name: 'Document editor',
    exact: true,
  })
  return { root, app, page, editor }
}

test('prompt Save As names a draft edited during disk I/O and isolates another window', {
  timeout: 40000,
}, async (t) => {
  const { root, app, page, editor } = await fixture(t)
  const file = join(root, 'saved.md')
  await replaceRichText(page, editor, 'saved draft')
  const before = await page.evaluate(() => window.hibi.getDocument())
  await app.evaluate(async ({ BrowserWindow, dialog }, file) => {
    const fs = process.getBuiltinModule('node:fs/promises')
    const { syncBuiltinESMExports } = process.getBuiltinModule('node:module')
    const original = fs.rename
    const held = Promise.withResolvers()
    const main = BrowserWindow.getAllWindows()[0]
    const other = new BrowserWindow({ show: false })
    await other.loadURL('about:blank')
    globalThis.otherWindow = other
    globalThis.reportWindows = []
    for (const window of [main, other]) {
      const send = window.webContents.send.bind(window.webContents)
      window.webContents.send = (channel, ...args) => {
        if (channel === 'document:saved')
          globalThis.reportWindows.push(window.id)
        return send(channel, ...args)
      }
    }
    globalThis.promptWindowId = main.id
    globalThis.saveDialogs = 0
    dialog.showSaveDialog = async () => {
      globalThis.saveDialogs++
      return { canceled: false, filePath: file }
    }
    dialog.showMessageBox = async () => ({ response: 0 })
    globalThis.promptGate = {
      entered: false,
      release: held.resolve,
      restore: () => {
        fs.rename = original
        syncBuiltinESMExports()
      },
    }
    fs.rename = async (from, to) => {
      if (String(to) === file) {
        globalThis.promptGate.entered = true
        await held.promise
      }
      return original(from, to)
    }
    syncBuiltinESMExports()
    main.close()
  }, file)
  await waitForAsync(app, () => globalThis.promptGate.entered)
  await replaceRichText(page, editor, 'saved draft plus later edit')
  await waitForAsync(
    page,
    async () =>
      (await window.hibi.getDocument()).markdown ===
      'saved draft plus later edit',
  )
  await app.evaluate(() => globalThis.promptGate.release())
  await waitForAsync(app, () => globalThis.reportWindows.length === 1)
  await page.getByRole('tab', { name: 'saved.md', exact: true }).waitFor()
  assert.equal(await readFile(file, 'utf8'), 'saved draft')
  const after = await page.evaluate(() => window.hibi.getDocument())
  assert.equal(after.tabId, before.tabId)
  assert.equal(after.revision, before.revision)
  assert.equal(after.ephemeral, false)
  assert.equal(after.canAutosave, true)
  assert.equal(after.dirty, true)
  assert.equal(after.markdown, 'saved draft plus later edit')
  assert.deepEqual(await app.evaluate(() => globalThis.reportWindows), [
    await app.evaluate(() => globalThis.promptWindowId),
  ])
  await page
    .getByRole('tab', { name: 'saved.md', exact: true })
    .getAttribute('aria-description')
    .then((value) => assert.equal(value, 'Unsaved changes'))
  // A subsequent regular save uses the chosen destination without a second dialog.
  await clickMenu(app, 'Save')
  await waitForAsync(page, async () => !(await window.hibi.getDocument()).dirty)
  assert.equal(await readFile(file, 'utf8'), after.markdown)
  assert.equal(await app.evaluate(() => globalThis.saveDialogs), 1)
})

test('version restore keeps a prompt save acknowledged when reading the version fails', {
  timeout: 40000,
}, async (t) => {
  const { root, app, page, editor } = await fixture(t)
  const file = join(root, 'note.md')
  await writeFile(file, 'original')
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, file)
  await clickMenu(app, 'Open…')
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).markdown === 'original',
  )
  await waitForDocumentEditor(app, page)
  await replaceRichText(page, editor, 'saved change')
  await clickMenu(app, 'Save')
  await waitForAsync(
    page,
    async () => (await window.hibi.listVersions()).length === 2,
  )
  const version = await page.evaluate(
    async () => (await window.hibi.listVersions()).at(-1).id,
  )
  await replaceRichText(page, editor, 'prompt save')
  const tab = (await page.evaluate(() => window.hibi.getDocument())).tabId
  await page.waitForFunction(
    (id) =>
      document
        .querySelector(`[data-tab-id="${id}"]`)
        ?.getAttribute('aria-description') === 'Unsaved changes',
    tab,
  )
  await app.evaluate(({ dialog }, version) => {
    dialog.showMessageBox = async () => ({ response: 0 })
    const fs = process.getBuiltinModule('node:fs/promises')
    const { syncBuiltinESMExports } = process.getBuiltinModule('node:module')
    const { basename } = process.getBuiltinModule('node:path')
    const original = fs.open
    fs.open = async (path, ...args) => {
      if (basename(String(path)) === `${version}.md`)
        throw new Error('version read failed')
      return original(path, ...args)
    }
    syncBuiltinESMExports()
    globalThis.promptGate = {
      restore: () => {
        fs.open = original
        syncBuiltinESMExports()
      },
    }
  }, version)
  await assert.rejects(
    page.evaluate((id) => window.hibi.restoreVersion(id), version),
    /version read failed/,
  )
  assert.equal(await readFile(file, 'utf8'), 'prompt save')
  await page.waitForFunction(
    (id) =>
      document
        .querySelector(`[data-tab-id="${id}"]`)
        ?.getAttribute('aria-description') === null,
    tab,
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    'prompt save',
  )
  await app.evaluate(() => globalThis.promptGate.restore())
  // The same restore succeeds next; the restored editor is dirty against the saved prompt text.
  await page.evaluate((id) => window.hibi.restoreVersion(id), version)
  await page.getByRole('tab', { name: 'note.md', exact: true }).click()
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).markdown === 'original',
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).dirty,
    true,
  )
  assert.equal(await readFile(file, 'utf8'), 'prompt save')
})
