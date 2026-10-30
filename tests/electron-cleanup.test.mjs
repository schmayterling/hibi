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

test('existing test windows are not raised again after a delayed first paint', () => {
  const calls = []
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    webContents: { getURL: () => 'app://hibi/' },
    setFocusable: () => calls.push('focusable'),
    show: () => calls.push('show'),
    focus: () => calls.push('focus'),
  })
  showElectronTestWindows({
    app: new EventEmitter(),
    BrowserWindow: { getAllWindows: () => [window] },
  })
  assert.deepEqual(calls, ['focusable', 'show', 'focus'])
  window.emit('ready-to-show')
  assert.deepEqual(calls, ['focusable', 'show', 'focus'])
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

test('hosted visibility policy lets a worker-only fixture launch and close', async (t) => {
  const child = { stdout: new PassThrough(), stderr: new PassThrough() }
  let windowWaits = 0
  let closed = 0
  const application = {
    process: () => child,
    evaluate: async () => {},
    windows: () => [],
    firstWindow: async () => {
      windowWaits++
      throw new Error('worker-only fixture has no window')
    },
    close: async () => {
      closed++
    },
  }
  t.after(async () => {
    if (!closed) await application.close()
    child.stdout.destroy()
    child.stderr.destroy()
  })
  // Exercise hosted policy without revealing a native window.
  const launch = new Function(
    '_electron',
    'showTestWindows',
    'forwardElectronDiagnostics',
    'showElectronTestWindows',
    'waitForElectronShutdown',
    'moduleUrl',
    `return ({${electron.launch.toString().replace('import.meta.url', 'moduleUrl')}}).launch`,
  )(
    { launch: async () => application },
    true,
    () => new EventEmitter(),
    showElectronTestWindows,
    (_child, pending) => pending,
    new URL('./electron.mjs', import.meta.url).href,
  )
  assert.equal(
    await launch({ args: ['worker-only'], diagnostics: false }),
    application,
  )
  assert.equal(windowWaits, 0)
  await application.close()
  assert.equal(closed, 1)
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
  // Extensionless fakes must stay CommonJS when TMPDIR sits inside a
  // "type": "module" package, such as a checkout's .scratch directory.
  await writeFile(join(root, 'package.json'), '{"type":"commonjs"}')
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
    `9 1 9 00:04 unrelated ${'x'.repeat(300000)}`,
    ...Array.from(
      { length: 30 },
      (_, i) => `${100 + i} 1 42 00:05 utility ${'x'.repeat(300)}`,
    ),
  ]
  const fixture = await snapshotFixture(
    t,
    `const rows = ${JSON.stringify(rows)}
const ids = process.argv[2] === '-p' ? new Set(process.argv[3].split(',')) : null
console.log(rows
  .filter(row => !ids || ids.has(row.split(' ')[0]))
  .map(row => process.argv.at(-1) === 'pid=,ppid=,pgid=' ? row.split(' ').slice(0, 3).join(' ') : row)
  .join('\\n'))`,
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

for (const exited of [false, true])
  test(`shutdown snapshot handles ${exited ? 'exited processes' : 'partial ps output'}`, {
    skip: process.platform === 'win32',
  }, async (t) => {
    const fixture = await snapshotFixture(
      t,
      `if (process.argv.at(-1) === 'pid=,ppid=,pgid=') console.log('42 1 42')
else {
  ${exited ? '' : "console.log('42 1 42 00:01 electron')"}
  process.exit(1)
}`,
      "console.log('held 42 x 1w PIPE inherited-output')",
    )
    await snapshotElectronProcesses(42)
    assert.doesNotMatch(fixture.messages.join('\n'), /snapshot unavailable/)
    if (exited)
      assert.match(fixture.messages[0], /process group already exited/)
    else {
      assert.match(fixture.messages[0], /42 1 42 00:01 electron/)
      assert.match(fixture.messages[1], /PIPE inherited-output/)
    }
  })

test('partial lsof output is retained when some processes have already exited', {
  skip: process.platform === 'win32',
}, async (t) => {
  const fixture = await snapshotFixture(
    t,
    "console.log(process.argv.at(-1) === 'pid=,ppid=,pgid=' ? '42 1 42' : '42 1 42 00:01 electron')",
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
      missing === 'ps'
        ? undefined
        : "console.log(process.argv.at(-1) === 'pid=,ppid=,pgid=' ? '42 1 42' : '42 1 42 00:01 electron')",
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

test('fake snapshot commands stay CommonJS inside a "type": "module" TMPDIR', {
  skip: process.platform === 'win32',
}, async (t) => {
  const scope = await mkdtemp(join(tmpdir(), 'hibi-module-scope-'))
  await writeFile(join(scope, 'package.json'), '{"type":"module"}')
  const previous = process.env.TMPDIR
  process.env.TMPDIR = scope
  t.after(async () => {
    if (previous === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previous
    await rm(scope, { recursive: true, force: true })
  })
  const fixture = await snapshotFixture(
    t,
    "console.log(process.argv.at(-1) === 'pid=,ppid=,pgid=' ? '42 1 42' : '42 1 42 00:01 electron')",
    `require('node:fs').writeFileSync(__filename + '.args', JSON.stringify(process.argv.slice(2)))
console.log('COMMAND PID USER FD TYPE NAME')
console.log('held 42 x 1w PIPE inherited-output')`,
  )
  assert.ok(fixture.root.startsWith(scope))
  await snapshotElectronProcesses(42)
  assert.match(fixture.messages[1], /PIPE inherited-output/)
  assert.deepEqual(
    JSON.parse(await readFile(join(fixture.root, 'lsof.args'), 'utf8')).slice(
      0,
      3,
    ),
    ['-nP', '-a', '-p'],
  )
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

test('cleanup stops Electron 15 s after quit, and still fails a quit that never comes at 20 s', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.mock.method(console, 'error', () => {})
  const start = async (killExits = true) => {
    const child = Object.assign(new EventEmitter(), {
      pid: 1,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    })
    let exit
    const result = { child, stopped: 0 }
    const application = {
      process: () => child,
      evaluate: async () => {},
      close: () => new Promise(() => {}),
    }
    const launch = new Function(
      '_electron',
      'showTestWindows',
      'forwardElectronDiagnostics',
      'waitForElectronShutdown',
      'stopElectronTree',
      'drainElectronStdio',
      'snapshotElectronProcesses',
      'moduleUrl',
      `return ({${electron.launch.toString().replace('import.meta.url', 'moduleUrl')}}).launch`,
    )(
      { launch: async () => application },
      false,
      forwardElectronDiagnostics,
      () =>
        new Promise((_, reject) => {
          exit = reject
        }),
      () => {
        result.stopped++
        if (killExits)
          exit(new Error('Electron exited with code null, signal SIGKILL'))
      },
      () => {},
      async () => {},
      new URL('./electron.mjs', import.meta.url).href,
    )
    await launch({ args: [], diagnostics: false })
    result.closing = application.close()
    result.exit = (error) => exit(error)
    return result
  }

  const quit = await start()
  quit.child.stderr.write('electron-main-quit\n')
  await new Promise(setImmediate)
  t.mock.timers.tick(14999)
  assert.equal(quit.stopped, 0)
  t.mock.timers.tick(1)
  assert.equal(quit.stopped, 1)
  await quit.closing

  const stuck = await start()
  t.mock.timers.tick(20000)
  await assert.rejects(stuck.closing, /exceeded 20 seconds/)
  assert.equal(stuck.stopped, 1)

  const crashed = await start()
  crashed.child.stderr.write('electron-main-quit\n')
  crashed.exit(new Error('Electron exited with code null, signal SIGSEGV'))
  await assert.rejects(crashed.closing, /SIGSEGV/)

  const transport = await start(false)
  transport.child.stderr.write('electron-main-quit\n')
  t.mock.timers.tick(15000)
  assert.equal(transport.stopped, 1)
  t.mock.timers.tick(5000)
  await assert.rejects(transport.closing, /post-quit cleanup did not finish/)
})

test('teardown waits for setup when a name filter skips every top-level test, and not past its timeout', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-filtered-hooks-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const run = async (name, setup, timeout, teardown = '') => {
    const file = join(root, `${name}.test.mjs`)
    await writeFile(
      file,
      `import test from 'node:test'
import { after, before } from ${JSON.stringify(new URL('./electron-hooks.mjs', import.meta.url).href)}
let open
before(async () => {
  open = setInterval(() => {}, 1000)
  ${setup}
  console.log('set up')
}, { timeout: ${timeout} })
after(async () => {
  console.log('closed')
  clearInterval(open)
  ${teardown}
}, { timeout: ${teardown ? 300 : name === 'slow' ? 100 : 5000} })
test('parent', async (t) => {
  await t.test('only a subtest matches', () => {})
})
`,
    )
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    const child = spawn(
      process.execPath,
      [
        '--test',
        '--test-reporter=tap',
        `--test-name-pattern=${name.endsWith('timeout') ? 'parent' : 'only a subtest'}`,
        file,
      ],
      { env, stdio: ['ignore', 'pipe', 'inherit'] },
    )
    t.after(() => child.kill('SIGKILL'))
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += chunk
    })
    const watchdog = setTimeout(() => child.kill('SIGKILL'), 10000)
    const [code, signal] = await once(child, 'close')
    clearTimeout(watchdog)
    assert.equal(signal, null, output)
    assert.equal(code, name.endsWith('timeout') ? 1 : 0, output)
    return output
  }
  assert.match(
    await run(
      'slow',
      'await new Promise((resolve) => setTimeout(resolve, 200))',
      5000,
    ),
    /set up[\s\S]*closed/,
  )
  assert.match(await run('stuck', 'await new Promise(() => {})', 300), /closed/)
  assert.match(
    await run(
      'infinite',
      'await new Promise((resolve) => setTimeout(resolve, 200))',
      'Infinity',
    ),
    /set up[\s\S]*closed/,
  )
  assert.match(
    await run('before-timeout', 'await new Promise(() => {})', 100),
    /failed running before hook[\s\S]*closed/,
  )
  assert.match(
    await run(
      'after-timeout',
      '',
      5000,
      'await new Promise((resolve) => setTimeout(resolve, 500))',
    ),
    /test timed out after 300ms/,
  )
})
