import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { pressShortcut } from './keyboard.mjs'

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'hibi-import-cancel-'))
  const profile = join(root, 'profile'),
    workspace = join(root, 'notes'),
    source = join(root, 'source')
  for (const path of [profile, workspace, source]) await mkdir(path)
  await writeFile(join(workspace, 'Start.md'), '# Original')
  await writeFile(join(source, 'asset.bin'), Buffer.alloc(128 * 1024, 7))
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'import-notion': true }),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app
      .evaluate(() => {
        const held = globalThis.__heldImport
        if (held) {
          const fs = process.getBuiltinModule('node:fs')
          fs.createWriteStream = held.original
          process.getBuiltinModule('node:module').syncBuiltinESMExports()
          held.writer?.destroy(new Error('test cleanup'))
        }
      })
      .catch(() => {})
    await app.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(10000)
  await waitForDocumentEditor(app, page)
  const choose = (path) =>
    app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      })
    }, path)
  await choose(workspace)
  await page.evaluate(() => window.hibi.openWorkspace())
  await page.evaluate(() =>
    window.hibi.updateWorkspaceSettings({ action: 'create-manifest' }),
  )
  await page.evaluate(() => window.hibi.setBackgroundMode(false))
  const request = {
    id: 'folder',
    source: 'folder',
    workspaceId: (await page.evaluate(() => window.hibi.getWorkspace())).id,
  }
  await choose(source)
  const holdCopy = () =>
    app.evaluate(() => {
      const fs = process.getBuiltinModule('node:fs')
      const { Writable } = process.getBuiltinModule('node:stream')
      const entered = Promise.withResolvers()
      const state = {
        original: fs.createWriteStream,
        entered: entered.promise,
        writer: null,
      }
      globalThis.__heldImport = state
      fs.createWriteStream = (path, options) => {
        if (!String(path).includes('.hibi-import-'))
          return state.original(path, options)
        state.writer = new Writable({
          write() {
            entered.resolve()
          },
        })
        return state.writer
      }
      process.getBuiltinModule('node:module').syncBuiltinESMExports()
    })
  const waitForCopy = () => app.evaluate(() => globalThis.__heldImport.entered)
  const clean = async () => {
    assert.equal(
      (await readdir(workspace)).some((name) =>
        name.startsWith('.hibi-import-'),
      ),
      false,
    )
    assert.equal(
      await readFile(join(workspace, 'Start.md'), 'utf8'),
      '# Original',
    )
    assert.equal((await readFile(join(source, 'asset.bin'))).length, 128 * 1024)
  }
  return { app, page, source, workspace, request, holdCopy, waitForCopy, clean }
}

test('busy import cancel bypasses the file lock and removes staging before dismissing', {
  timeout: 30000,
}, async (t) => {
  const { app, page, workspace, holdCopy, waitForCopy, clean } = await setup(t)
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await pressShortcut(app, `${mod}+,`)
  await page
    .getByRole('tab', { name: 'Workspace settings', exact: true })
    .click()
  await page.getByRole('button', { name: /^Import…$/i, exact: true }).click()
  const dialog = page.getByRole('dialog', { name: /^Import into workspace$/i })
  await dialog.waitFor()
  await holdCopy()
  await dialog
    .getByRole('button', { name: 'Choose folder…', exact: true })
    .click()
  await waitForCopy()
  assert.ok(
    (await readdir(workspace)).some((name) => name.startsWith('.hibi-import-')),
  )
  const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true })
  assert.equal(await cancel.isEnabled(), true)
  await page.evaluate(() => {
    window.__queuedImportRead = window.hibi
      .getWorkspaceSettings()
      .then(() => true)
  })
  await cancel.click()
  await dialog.waitFor({ state: 'hidden' })
  assert.equal(await page.evaluate(() => window.__queuedImportRead), true)
  await clean()
})

test('closing a window aborts its copy before waiting for file operations', {
  timeout: 30000,
}, async (t) => {
  const { app, page, request, holdCopy, waitForCopy, clean } = await setup(t)
  await holdCopy()
  await page.evaluate((request) => {
    window.__pendingImport = window.hibi.importIntoWorkspace(request)
  }, request)
  await waitForCopy()
  const closed = page.waitForEvent('close')
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].close()
  })
  await closed
  await clean()
})

test('converted output collisions return the duplicate-name notice and remove staging', {
  timeout: 30000,
}, async (t) => {
  const { page, source, request, clean } = await setup(t)
  await writeFile(join(source, 'Tasks.csv'), 'Name\nTask\n')
  await writeFile(join(source, 'Tasks.csv.md'), '# Existing export')
  await assert.rejects(
    page.evaluate(
      (request) =>
        window.hibi.importIntoWorkspace({ ...request, id: 'import-notion' }),
      request,
    ),
    /duplicate file names: Tasks\.csv\.md/,
  )
  await clean()
  assert.equal(
    await readFile(join(source, 'Tasks.csv.md'), 'utf8'),
    '# Existing export',
  )
})
