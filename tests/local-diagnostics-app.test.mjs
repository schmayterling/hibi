import assert from 'node:assert/strict'
import {
  mkdir,
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
import { crashAndReload, electron } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'

test('an unavailable unsafe log directory leaves editing, saving and user files intact', {
  timeout: 20000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-unsafe-logs-'))
  const profile = join(root, 'profile')
  await mkdir(profile)
  const kept = join(root, 'kept.md'),
    saved = join(root, 'saved.md')
  await writeFile(kept, 'PRIVATE ORIGINAL DOCUMENT')
  await symlink(root, join(profile, 'logs'), 'dir')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(6000)
  await page
    .getByRole('textbox', { name: 'Document editor', exact: true })
    .fill('PRIVATE SAVED DOCUMENT')
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
    dialog.showMessageBox = async () => ({ response: 1 })
  }, saved)
  await page.evaluate(() => window.hibi.saveDocument(true))
  assert.equal(await readFile(saved, 'utf8'), 'PRIVATE SAVED DOCUMENT')
  assert.equal(await readFile(kept, 'utf8'), 'PRIVATE ORIGINAL DOCUMENT')
  assert.ok(!(await readdir(root)).some((name) => name.startsWith('segment-')))
})

test('default diagnostics preserve editing, use the raw bridge and export only safe records', {
  timeout: 30000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-local-log-app-'))
  const profile = join(root, 'profile')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app
      .evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1 })
      })
      .catch(() => {})
    await app.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(6000)
  const editor = page.getByRole('textbox', { name: /document editor/i })
  await editor.waitFor()
  const config = await page.evaluate(async () =>
    JSON.parse(await window.hibiDiagnostics.configuration()),
  )
  assert.equal(config.profile, 'debug')
  assert.ok(config.artifacts.length > 0)
  const sentinel = 'PRIVATE DIAGNOSTIC DOCUMENT 雪'
  await editor.fill(sentinel)
  const captured = await page.evaluate(
    ({ config, sentinel }) => {
      const frames = [[config.artifacts[0][1], 12, 3]]
      return {
        invalid: window.hibiDiagnostics.record(
          JSON.stringify({
            code: 'RENDERER_ERROR',
            stackStatus: 'unavailable',
            message: sentinel,
          }),
        ),
        forged: window.hibiDiagnostics.record(
          JSON.stringify({
            code: 'MAIN_EXCEPTION',
            stackStatus: 'unavailable',
          }),
        ),
        accepted: window.hibiDiagnostics.record(
          JSON.stringify({
            code: 'RENDERER_ERROR',
            stackStatus: 'captured',
            frames,
          }),
        ),
      }
    },
    { config, sentinel },
  )
  assert.deepEqual(captured, { invalid: false, forged: false, accepted: true })
  const directory = join(profile, 'logs', 'debug')
  let logs = ''
  const end = Date.now() + 6000
  while (Date.now() < end) {
    const names = await readdir(directory).catch(() => [])
    logs = (
      await Promise.all(
        names.map((name) =>
          readFile(join(directory, name), 'utf8').catch(() => ''),
        ),
      )
    ).join('\n')
    if (logs.includes('RENDERER_ERROR')) break
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.ok(logs.includes('RENDERER_ERROR'))
  assert.ok(logs.includes(await app.evaluate(() => process.versions.electron)))
  assert.ok(!logs.includes(sentinel))
  assert.ok(!logs.includes(profile))
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    sentinel,
  )
  const reportPath = join(root, 'safe-report.txt')
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
  }, reportPath)
  await clickMenu(app, 'Save diagnostic report…')
  let report = ''
  for (let i = 0; i < 100 && !report; i++) {
    report = await readFile(reportPath, 'utf8').catch(() => '')
    if (!report) await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.ok(report.includes('RENDERER_ERROR'))
  assert.ok(!report.includes(sentinel))
  assert.ok(Buffer.byteLength(report) <= 64 * 1024)
})

test('lost diagnostic credit cannot delay save, canceled close or acknowledged renderer recovery', {
  timeout: 30000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-log-barriers-'))
  const profile = join(root, 'profile')
  const file = join(root, 'saved.md')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app
      .evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1 })
      })
      .catch(() => {})
    await app.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(7000)
  const editor = page.getByRole('textbox', {
    name: 'Document editor',
    exact: true,
  })
  await editor.waitFor()
  await page.evaluate(() => window.hibiDiagnostics.configuration())
  const invalid = await app.evaluate(
    async ({ BrowserWindow, ipcMain, dialog }, file) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents
      const handler = ipcMain._invokeHandlers.get('hibi:local-diagnostics')
      const foreign = new BrowserWindow({ show: false, focusable: false })
      const results = [
        await handler(
          {
            sender: foreign.webContents,
            senderFrame: foreign.webContents.mainFrame,
          },
          'hello',
        ),
        await handler(
          { sender: contents, senderFrame: { url: contents.mainFrame.url } },
          'hello',
        ),
      ]
      foreign.destroy()
      globalThis.diagnosticBatches = 0
      ipcMain.removeHandler('hibi:local-diagnostics')
      ipcMain.handle('hibi:local-diagnostics', (event, operation, ...args) => {
        if (operation === 'batch') {
          globalThis.diagnosticBatches++
          return new Promise(() => {})
        }
        return handler(event, operation, ...args)
      })
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file })
      return results
    },
    file,
  )
  assert.deepEqual(invalid, [false, false])
  await page.evaluate(() => {
    window.hibiDiagnostics.record(
      JSON.stringify({ code: 'RENDERER_ERROR', stackStatus: 'unavailable' }),
    )
  })
  await new Promise((resolve) => setTimeout(resolve, 300))
  const sentinel = 'PRIVATE SAVED TEXT 雪'
  await editor.fill(sentinel)
  const saved = await page.evaluate(() => window.hibi.saveDocument(true))
  assert.equal(saved.markdown, sentinel)
  assert.equal(await readFile(file, 'utf8'), sentinel)
  await editor.fill('PRIVATE RECOVERED TEXT 雪')
  await page.evaluate(() => window.hibi.flushDocumentChanges())
  const canceled = await app.evaluate(async ({ BrowserWindow, dialog }) => {
    const window = BrowserWindow.getAllWindows()[0]
    let prompted
    const prompt = new Promise((resolve) => {
      prompted = resolve
    })
    dialog.showMessageBox = async () => {
      prompted()
      return { response: 2 }
    }
    window.close()
    await prompt
    await new Promise((resolve) => setTimeout(resolve, 30))
    return !window.isDestroyed()
  })
  assert.equal(canceled, true)
  const directory = join(profile, 'logs', 'debug')
  assert.equal(
    JSON.parse(await readFile(join(directory, 'run-state.txt'), 'utf8')).state,
    'active',
  )
  await crashAndReload(app)
  const recovered = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
      `new Promise(resolve => { const poll = () => { if (!document.querySelector('.tiptap[contenteditable="true"]')) { setTimeout(poll, 20); return; } Promise.resolve(window.hibi.getDocument()).then(resolve) }; poll() })`,
    ),
  )
  assert.equal(recovered.markdown, 'PRIVATE RECOVERED TEXT 雪')
  assert.equal(await app.evaluate(() => globalThis.diagnosticBatches), 1)
  await new Promise((resolve) => setTimeout(resolve, 350))
  const logs = (
    await Promise.all(
      (
        await readdir(directory)
      ).map((name) => readFile(join(directory, name), 'utf8')),
    )
  ).join('\n')
  assert.match(logs, /RENDERER_GONE/)
  assert.doesNotMatch(logs, /PRIVATE|saved\.md/)
  assert.ok(!logs.includes(profile))
})
