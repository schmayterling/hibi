import assert from 'node:assert/strict'
import { once } from 'node:events'
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
import {
  crashAndReload,
  electron,
  stopElectronTree,
  waitForDocumentEditor,
} from './electron.mjs'
import { clickMenu, replaceRichText } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

async function runRecords(profile) {
  const directory = join(profile, 'logs', 'debug')
  const marker = JSON.parse(
    await readFile(join(directory, 'run-state.txt'), 'utf8'),
  )
  const records = (
    await Promise.all(
      (
        await readdir(directory)
      )
        .filter((name) => /^segment-\d\.log$/.test(name))
        .map((name) => readFile(join(directory, name), 'utf8')),
    )
  )
    .join('\n')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((record) => record.run === marker.run && record.code)
  return { marker, records }
}

async function waitForRecord(app, code) {
  await waitForAsync(
    app,
    async ({ app }, code) => {
      try {
        const fs = process.getBuiltinModule('node:fs/promises')
        const directory = `${app.getPath('userData')}/logs/debug`
        const marker = JSON.parse(
          await fs.readFile(`${directory}/run-state.txt`, 'utf8'),
        )
        const segments = await Promise.all(
          (await fs.readdir(directory))
            .filter((name) => /^segment-\d\.log$/.test(name))
            .map((name) => fs.readFile(`${directory}/${name}`, 'utf8')),
        )
        return segments
          .join('\n')
          .split('\n')
          .filter(Boolean)
          .some((line) => {
            const record = JSON.parse(line)
            return record.run === marker.run && record.code === code
          })
      } catch {
        return false
      }
    },
    code,
  )
}

async function launchProfile(t, profile) {
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  const child = app.process()
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    await app
      .evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1 })
      })
      .catch(() => {})
    await app.close().catch(() => stopElectronTree(child))
  })
  const page = await app.firstWindow()
  await waitForDocumentEditor(app, page)
  await waitForRecord(app, 'RUN_STARTED')
  return app
}

test('clean quits commit before exit; forced kills remain unconfirmed on the next launch', {
  timeout: 60000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-quit-marker-'))
  t.after(() => rm(profile, { recursive: true, force: true }))
  for (let run = 0; run < 3; run++) {
    const app = await launchProfile(t, profile)
    assert.ok(
      !(await runRecords(profile)).records.some(
        ({ code }) => code === 'PREVIOUS_RUN_UNCONFIRMED',
      ),
    )
    await app.close()
    const { marker, records } = await runRecords(profile)
    assert.equal(marker.state, 'clean')
    assert.equal(records.filter(({ code }) => code === 'RUN_ENDED').length, 1)
  }
  const killed = await launchProfile(t, profile)
  const closed = once(killed.process(), 'close')
  stopElectronTree(killed.process())
  await closed
  assert.equal((await runRecords(profile)).marker.state, 'active')
  const restarted = await launchProfile(t, profile)
  assert.equal(
    (await runRecords(profile)).records.filter(
      ({ code }) => code === 'PREVIOUS_RUN_UNCONFIRMED',
    ).length,
    1,
  )
  await restarted.close()
})

test('a stalled diagnostics finish is entered once and cannot hold repeated quits open', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-quit-deadline-'))
  t.after(() => rm(profile, { recursive: true, force: true }))
  const app = await launchProfile(t, profile)
  const child = app.process()
  await app.evaluate(({ app }) => {
    globalThis.diagnosticFinishCalls = 0
    globalThis.hibiTestPauses = Object.defineProperty(
      {},
      'local-diagnostics-finish',
      {
        get() {
          globalThis.diagnosticFinishCalls++
          return new Promise(() => {})
        },
      },
    )
    app.quit()
  })
  await waitForAsync(app, () => globalThis.diagnosticFinishCalls === 1)
  assert.equal(
    await app.evaluate(({ app }) => {
      app.quit()
      app.quit()
      return globalThis.diagnosticFinishCalls
    }),
    1,
  )
  await app.close()
  assert.equal(child.exitCode, 0)
  assert.equal((await runRecords(profile)).marker.state, 'active')
})

for (const duration of [2200, 5500])
  test(`main-loop stall of ${duration} ms persists a bounded warning before quitting`, {
    timeout: 20000,
  }, async (t) => {
    const profile = await mkdtemp(join(tmpdir(), 'hibi-loop-stall-'))
    t.after(() => rm(profile, { recursive: true, force: true }))
    const app = await launchProfile(t, profile)
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.isVisible = () => true
      window.emit('show')
    })
    const since = Date.now()
    await app.evaluate((_, duration) => {
      const end = performance.now() + duration
      while (performance.now() < end) {
        // Deliberately block only this test's main process.
      }
    }, duration)
    await waitForRecord(app, 'MAIN_LOOP_STALLED')
    const records = (await runRecords(profile)).records.filter(
      ({ code }) => code === 'MAIN_LOOP_STALLED',
    )
    assert.equal(records.length, 1)
    const record = records[0]
    assert.equal(record.severity, 'warning')
    assert.equal(record.role, 'main')
    assert.equal(record.stackStatus, 'unavailable')
    assert.ok(
      ['1-5s', '5-15s', '15-60s', '60s+'].includes(record.durationBucket),
    )
    if (duration >= 5000) assert.notEqual(record.durationBucket, '1-5s')
    assert.ok(record.time >= since && record.time <= Date.now())
    assert.deepEqual(Object.keys(record).sort(), [
      'code',
      'durationBucket',
      'label',
      'profile',
      'role',
      'run',
      'schema',
      'severity',
      'stackStatus',
      'time',
    ])
    await app.close()
  })

for (const hidden of [false, true])
  test(`${hidden ? 'all windows hidden' : 'sleep and lid close'} do not become main-loop stalls after resume`, {
    timeout: 20000,
  }, async (t) => {
    const profile = await mkdtemp(join(tmpdir(), 'hibi-loop-suspend-'))
    t.after(() => rm(profile, { recursive: true, force: true }))
    const app = await launchProfile(t, profile)
    await app.evaluate(async ({ BrowserWindow, powerMonitor }, hidden) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.isVisible = () => true
      window.emit('show')
      if (hidden) {
        window.isVisible = () => false
        window.emit('hide')
      } else powerMonitor.emit('suspend')
      const end = performance.now() + 2200
      while (performance.now() < end) {
        // Model an unobserved interval without suspending the shared machine.
      }
      if (hidden) {
        window.isVisible = () => true
        window.emit('show')
      } else powerMonitor.emit('resume')
      await new Promise((resolve) => setTimeout(resolve, 0))
    }, hidden)
    await app.close()
    const { marker, records } = await runRecords(profile)
    assert.equal(marker.state, 'clean')
    assert.ok(!records.some(({ code }) => code === 'MAIN_LOOP_STALLED'))
  })

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
  await waitForDocumentEditor(app, page)
  await replaceRichText(
    page,
    page.getByRole('textbox', { name: 'Document editor', exact: true }),
    'PRIVATE SAVED DOCUMENT',
  )
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
    dialog.showMessageBox = async () => ({ response: 1 })
  }, saved)
  await page.evaluate(() => window.hibi.saveDocument(true))
  assert.equal(await readFile(saved, 'utf8'), 'PRIVATE SAVED DOCUMENT')
  assert.equal(await readFile(kept, 'utf8'), 'PRIVATE ORIGINAL DOCUMENT')
  assert.ok(!(await readdir(root)).some((name) => name.startsWith('segment-')))
  const child = app.process()
  await app.close()
  assert.equal(child.exitCode, 0)
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
  await waitForDocumentEditor(app, page)
  const config = await page.evaluate(async () =>
    JSON.parse(await window.hibiDiagnostics.configuration()),
  )
  assert.equal(config.profile, 'debug')
  assert.ok(config.artifacts.length > 0)
  const sentinel = 'PRIVATE DIAGNOSTIC DOCUMENT 雪'
  await replaceRichText(page, editor, sentinel)
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
  await waitForDocumentEditor(app, page)
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
  await replaceRichText(page, editor, sentinel)
  const saved = await page.evaluate(() => window.hibi.saveDocument(true))
  assert.equal(saved.saveReceipt, true)
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    sentinel,
  )
  assert.equal(await readFile(file, 'utf8'), sentinel)
  await replaceRichText(page, editor, 'PRIVATE RECOVERED TEXT 雪')
  await page.evaluate(() => window.hibi.flushDocumentChanges())
  const canceled = await app.evaluate(
    async ({ app, BrowserWindow, dialog }) => {
      const window = BrowserWindow.getAllWindows()[0]
      let prompted
      const prompt = new Promise((resolve) => {
        prompted = resolve
      })
      dialog.showMessageBox = async () => {
        prompted()
        return { response: 2 }
      }
      app.quit()
      await prompt
      await new Promise((resolve) => setTimeout(resolve, 30))
      return !window.isDestroyed()
    },
  )
  assert.equal(canceled, true)
  assert.ok(
    !(await runRecords(profile)).records.some(
      ({ code }) => code === 'RUN_ENDED',
    ),
  )
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
