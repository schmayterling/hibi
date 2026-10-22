import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import {
  electron,
  forwardElectronDiagnostics,
  installElectronDiagnostics,
  showElectronTestWindows,
  snapshotElectronProcesses,
  stopElectronTree,
  waitForDocumentEditor,
} from './electron.mjs'

test('electron cleanup stops descendants after the process group leader exits', {
  skip: process.platform === 'win32',
  timeout: 5000,
}, async (t) => {
  const parent = spawn(
    process.execPath,
    [
      '-e',
      `const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 1, 2] });
child.unref();`,
    ],
    { detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const cleanup = () => {
    try {
      process.kill(-parent.pid, 'SIGKILL')
    } catch {}
  }
  t.after(cleanup)
  const closed = once(parent, 'close')
  await once(parent, 'exit')
  assert.equal(parent.exitCode, 0)
  let rescued = false
  const watchdog = setTimeout(() => {
    rescued = true
    cleanup()
  }, 2000)
  try {
    stopElectronTree(parent)
    await closed
    assert.equal(
      rescued,
      false,
      'cleanup must stop descendants without the watchdog',
    )
  } finally {
    clearTimeout(watchdog)
  }
})

test('shutdown snapshot finds pipe holders after their process group leader exits', {
  skip: process.platform === 'win32',
  timeout: 10000,
}, async (t) => {
  const parent = spawn(
    process.execPath,
    [
      '-e',
      `
const { spawn } = require('node:child_process')
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 1, 2] })
console.log(String(child.pid))
child.unref()
`,
    ],
    { detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const closed = once(parent, 'close')
  const exited = once(parent, 'exit')
  t.after(async () => {
    stopElectronTree(parent)
    await closed
  })
  const [data] = await once(parent.stdout, 'data')
  const childPid = Number(String(data).trim())
  await exited
  const messages = []
  t.mock.method(console, 'error', (...args) => messages.push(args.join(' ')))
  await snapshotElectronProcesses(parent.pid)
  assert.match(
    messages[0],
    new RegExp(`^\\s*${childPid}\\s+\\d+\\s+${parent.pid}\\s`, 'm'),
  )
  assert.doesNotMatch(messages[0], new RegExp(`^\\s*${process.pid}\\s`, 'm'))
})

test('late ready-to-show skips windows that are closing, destroyed or quitting', async () => {
  const app = new EventEmitter()
  const windows = []
  showElectronTestWindows({
    app,
    BrowserWindow: { getAllWindows: () => windows },
  })
  for (const state of ['live', 'closing', 'destroyed', 'quitting']) {
    const calls = []
    const window = Object.assign(new EventEmitter(), {
      isDestroyed: () => state === 'destroyed',
      webContents: { getURL: () => 'app://hibi/' },
      setFocusable: () => calls.push('focusable'),
      show: () => calls.push('show'),
      focus: () => calls.push('focus'),
    })
    windows.push(window)
    app.emit('browser-window-created', {}, window)
    if (state === 'closing') window.emit('close')
    if (state === 'destroyed') window.webContents = undefined
    if (state === 'quitting') app.emit('before-quit')
    await new Promise((resolve, reject) =>
      queueMicrotask(() => {
        try {
          window.emit('ready-to-show')
          resolve()
        } catch (error) {
          reject(error)
        }
      }),
    )
    assert.deepEqual(
      calls,
      state === 'live' ? ['focusable', 'show', 'focus'] : [],
    )
  }
})

test('delayed ready-to-show does not reveal a real window during its close', {
  timeout: 10000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-late-window-'))
  const env = { ...process.env }
  delete env.HIBI_TEST_ADDON_REVOCATIONS_URL
  const app = await electron.launch({
    args: [process.cwd(), `--user-data-dir=${profile}`],
    env,
  })
  t.after(async () => {
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  await waitForDocumentEditor(app, await app.firstWindow())
  assert.equal(
    await app.evaluate(() => process.env.HIBI_TEST_ADDON_REVOCATIONS_URL),
    new URL('./fixtures/no-addon-revocations.json', import.meta.url).href,
  )
  await assert.rejects(
    app.evaluate(async ({ net }) =>
      net.fetch(process.env.HIBI_TEST_ADDON_REVOCATIONS_URL),
    ),
    /ERR_FILE_NOT_FOUND/,
  )
  const calls = await app.evaluate(({ app, BrowserWindow }, source) => {
    const install = new Function(`return (${source})`)()
    install({ app, BrowserWindow: { getAllWindows: () => [] } })
    const window = new BrowserWindow({
      show: false,
      focusable: false,
      webPreferences: { javascript: false },
    })
    const calls = []
    for (const method of ['setFocusable', 'show', 'focus'])
      window[method] = () => calls.push(method)
    window.on('close', (event) => event.preventDefault())
    window.close()
    return new Promise((resolve, reject) =>
      setImmediate(() => {
        try {
          window.emit('ready-to-show')
          resolve(calls)
        } catch (error) {
          reject(error)
        } finally {
          window.destroy()
        }
      }),
    )
  }, showElectronTestWindows.toString())
  assert.deepEqual(calls, [])
})

async function snapshotFixture(t, ps, lsof) {
  const root = await mkdtemp(join(tmpdir(), 'hibi-shutdown-snapshot-'))
  const path = process.env.PATH
  t.after(async () => {
    process.env.PATH = path
    await rm(root, { recursive: true, force: true })
  })
  for (const [name, body] of [
    ['ps', ps],
    ['lsof', lsof],
  ])
    if (body !== undefined)
      await writeFile(join(root, name), `#!${process.execPath}\n${body}\n`, {
        mode: 0o700,
      })
  process.env.PATH = root
  const messages = []
  t.mock.method(console, 'error', (...args) => messages.push(args.join(' ')))
  return { root, messages }
}

test('shutdown snapshots limit the tree and pipes, including descendants outside its group', {
  skip: process.platform === 'win32',
}, async (t) => {
  const rows = [
    '44 43 77 00:01 renderer',
    '43 42 77 00:02 gpu',
    '42 1 42 00:03 electron',
    '9 1 9 00:04 unrelated',
    ...Array.from(
      { length: 30 },
      (_, i) => `${100 + i} 1 42 00:05 utility ${'x'.repeat(300)}`,
    ),
  ]
  const fixture = await snapshotFixture(
    t,
    `console.log(${JSON.stringify(rows.join('\n'))})`,
    `require('node:fs').writeFileSync(__filename + '.args', JSON.stringify(process.argv.slice(2)))
console.log('COMMAND PID USER FD TYPE NAME')
console.log('held 44 x 1w PIPE inherited-output')
console.log('held 44 x 3r REG unrelated-file')
console.log('held 44 x 4u unix held-socket')
for (let i = 0; i < 100; i++) console.log('held 44 x 5r PIPE ' + 'x'.repeat(200))
`,
  )
  await snapshotElectronProcesses(42)
  const [tree, files] = fixture.messages
  assert.equal(tree.split('\n').length, 21)
  assert.ok(
    tree
      .split('\n')
      .slice(1)
      .every((line) => line.length <= 200),
  )
  assert.match(tree, /renderer/)
  assert.match(tree, /gpu/)
  assert.doesNotMatch(tree, /unrelated/)
  assert.match(files, /inherited-output/)
  assert.match(files, /held-socket/)
  assert.doesNotMatch(files, /unrelated-file/)
  assert.ok(files.length <= 2040)
  assert.ok(files.split('\n').length <= 26)
  const args = JSON.parse(
    await readFile(join(fixture.root, 'lsof.args'), 'utf8'),
  )
  assert.deepEqual(args.slice(0, 3), ['-nP', '-a', '-p'])
  assert.equal(args[3].split(',').length, 20)
  assert.ok(args[3].split(',').includes('44'))
})

test('partial lsof output is retained when some processes have already exited', {
  skip: process.platform === 'win32',
}, async (t) => {
  const fixture = await snapshotFixture(
    t,
    "console.log('42 1 42 00:01 electron')",
    "console.log('COMMAND PID FD TYPE NAME'); console.log('held 42 1w PIPE inherited-output'); process.exit(1)",
  )
  await snapshotElectronProcesses(42)
  assert.match(fixture.messages[1], /lsof incomplete: 1/)
  assert.match(fixture.messages[2], /PIPE inherited-output/)
})

for (const missing of ['ps', 'lsof']) {
  test(`missing ${missing} remains best effort`, {
    skip: process.platform === 'win32',
  }, async (t) => {
    const fixture = await snapshotFixture(
      t,
      missing === 'ps' ? undefined : "console.log('42 1 42 00:01 electron')",
    )
    await snapshotElectronProcesses(42)
    assert.match(fixture.messages.at(-1), /snapshot unavailable:.*ENOENT/)
  })
}

test('a stuck snapshot command is killed after two seconds', {
  skip: process.platform === 'win32',
  timeout: 6000,
}, async (t) => {
  const fixture = await snapshotFixture(
    t,
    "require('node:fs').writeFileSync(__filename + '.pid', String(process.pid)); setInterval(() => {}, 1000)",
  )
  const start = performance.now()
  await snapshotElectronProcesses(42)
  assert.ok(performance.now() - start < 5000)
  assert.match(fixture.messages.at(-1), /snapshot unavailable/)
  const pid = Number(await readFile(join(fixture.root, 'ps.pid'), 'utf8'))
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
})

test('only diagnostic lines are relayed from Electron stderr, including split chunks', async (t) => {
  const messages = []
  t.mock.method(console, 'error', (line) => messages.push(line))
  const stderr = new PassThrough()
  const reader = forwardElectronDiagnostics(stderr)
  const closed = once(reader, 'close')
  stderr.write('unrelated chromium output\nelectron-native-')
  stderr.write(
    'modal {"title":"test"}\nelectron-main-uncaught {"stack":"error"}\n',
  )
  stderr.end()
  await closed
  assert.deepEqual(messages, [
    'electron-native-modal {"title":"test"}',
    'electron-main-uncaught {"stack":"error"}',
  ])
})

test('dialog and uncaught tracing preserve native results, errors and default handling', (t) => {
  const messages = []
  const monitors = new Set(process.listeners('uncaughtExceptionMonitor'))
  const handlers = process.listeners('uncaughtException')
  t.after(() => {
    for (const listener of process.listeners('uncaughtExceptionMonitor'))
      if (!monitors.has(listener))
        process.off('uncaughtExceptionMonitor', listener)
  })
  t.mock.method(console, 'error', (...args) => messages.push(args))
  const failure = new Error('native dialog failed')
  const calls = []
  const dialog = Object.fromEntries(
    [
      'showErrorBox',
      'showMessageBoxSync',
      'showOpenDialogSync',
      'showSaveDialogSync',
    ].map((method) => [
      method,
      function (...args) {
        assert.equal(this, dialog)
        assert.equal(JSON.parse(messages.at(-1)[1]).method, method)
        calls.push([method, ...args])
        if (method === 'showMessageBoxSync') throw failure
        return args
      },
    ]),
  )
  installElectronDiagnostics({ dialog })
  const window = {}
  const options = { title: 'save', message: 'changes', detail: 'keep editing' }
  assert.deepEqual(dialog.showErrorBox('editor', 'x'.repeat(2000)), [
    'editor',
    'x'.repeat(2000),
  ])
  assert.throws(
    () => dialog.showMessageBoxSync(window, options),
    (error) => error === failure,
  )
  assert.deepEqual(dialog.showOpenDialogSync(options), [options])
  assert.deepEqual(dialog.showSaveDialogSync(window, options), [
    window,
    options,
  ])
  assert.equal(calls.length, 4)
  const errorBox = JSON.parse(messages[0][1])
  assert.equal(errorBox.title, 'editor')
  assert.equal(errorBox.content.length, 800)
  assert.deepEqual(JSON.parse(messages[1][1]), {
    method: 'showMessageBoxSync',
    title: 'save',
    content: 'changes',
    detail: 'keep editing',
  })
  process.emit('uncaughtExceptionMonitor', failure, 'uncaughtException')
  assert.deepEqual(messages.at(-1), [
    'electron-main-uncaught',
    JSON.stringify({ stack: failure.stack }),
  ])
  assert.deepEqual(process.listeners('uncaughtException'), handlers)
  t.mock.method(console, 'error', () => {
    throw new Error('logging failed')
  })
  // A logging failure must still reach the original native function.
  const quiet = { ...dialog, showErrorBox: () => 'shown' }
  installElectronDiagnostics({ dialog: quiet })
  assert.equal(quiet.showErrorBox('title', 'message'), 'shown')
})
