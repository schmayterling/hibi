import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { setTimeout } from 'node:timers/promises'
import { promisify } from 'node:util'
import electronPath from 'electron'
import { electron, stopElectronTree } from './electron.mjs'

function recordStartupDialogs(
  { app, BrowserWindow, dialog, ipcMain },
  { modals, failures, logged, occupy, block, closeDuringFlush },
) {
  const fs = process.getBuiltinModule('node:fs')
  const append = (path, value) =>
    fs.appendFileSync(path, `${JSON.stringify(value)}\n`)
  // Taking a channel first makes the app's own registration fail its startup.
  if (occupy) ipcMain.handle(occupy, () => {})
  if (closeDuringFlush) {
    // The diagnostics sink never creates its folder, so the flush before the
    // dialog waits its whole bound.
    const promises = process.getBuiltinModule('node:fs/promises')
    const mkdir = promises.mkdir
    promises.mkdir = function (path, ...rest) {
      if (/[\\/]logs$/.test(String(path))) return new Promise(() => {})
      return mkdir.call(this, path, ...rest)
    }
    process.getBuiltinModule('node:module').syncBuiltinESMExports()
  }
  const original = console.error
  console.error = (...args) => {
    if (args[0] === 'failed to load app:' || args[0] === 'startup failed:') {
      append(failures, {
        context: args[0],
        message: args[1]?.message,
        stack: args[1]?.stack,
      })
      // The person closes the window while the failure is being written.
      if (closeDuringFlush)
        setTimeout(() => BrowserWindow.getAllWindows()[0]?.close(), 100)
    }
    original(...args)
  }
  for (const method of [
    'showErrorBox',
    'showMessageBoxSync',
    'showOpenDialogSync',
    'showSaveDialogSync',
  ]) {
    dialog[method] = (...args) => {
      const options = args.at(-1)
      append(modals, {
        method,
        title: method === 'showErrorBox' ? args[0] : options?.title,
        content: method === 'showErrorBox' ? args[1] : options?.message,
      })
      if (logged) {
        // What a user who never dismisses the dialog leaves on disk.
        const directory = `${app.getPath('userData')}/logs/debug`
        for (const name of fs.existsSync(directory)
          ? fs.readdirSync(directory)
          : [])
          if (/^segment-\d\.log$/.test(name))
            fs.appendFileSync(
              logged,
              fs.readFileSync(`${directory}/${name}`, 'utf8'),
            )
      }
      // A native modal runs no main-process tasks or timers until it closes.
      if (block)
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000)
      return method === 'showMessageBoxSync' ? 1 : undefined
    }
  }
  dialog.showMessageBox = async () => ({ response: 1 })
  dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] })
  dialog.showSaveDialog = async () => ({ canceled: true })
  const quiet = (window) => {
    if (window.isDestroyed()) return
    window.setFocusable(false)
    for (const method of ['show', 'showInactive', 'focus', 'setFocusable'])
      window[method] = () => {}
  }
  for (const window of BrowserWindow.getAllWindows()) quiet(window)
  app.on('browser-window-created', (_event, window) => quiet(window))
  globalThis.startupDialogsInstalled = true
}

async function launch(t, env = {}, options = {}) {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-startup-quit-'))
  const modals = join(profile, 'modals.jsonl')
  const failures = join(profile, 'failures.jsonl')
  await writeFile(modals, '')
  await writeFile(failures, '')
  const hook = join(profile, 'startup-hook.cjs')
  await writeFile(
    hook,
    `(${recordStartupDialogs})(require('electron'), ${JSON.stringify({ modals, failures, ...options })})`,
  )
  const app = await electron.launch({
    args: ['--require', hook, resolve('.'), `--user-data-dir=${profile}`],
    // This fixture records native dialog calls before the app starts.
    diagnostics: false,
    env: {
      ...process.env,
      HIBI_TEST_ADDON_REVOCATIONS_URL: new URL(
        './fixtures/no-addon-revocations.json',
        import.meta.url,
      ).href,
      ...env,
    },
  })
  const child = app.process()
  const closed = once(child, 'close')
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null)
      stopElectronTree(child)
    await closed
    await rm(profile, { recursive: true, force: true })
  })
  assert.equal(
    await app.evaluate(() => globalThis.startupDialogsInstalled),
    true,
  )
  const records = async (path) =>
    (await readFile(path, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  return {
    app,
    child,
    closed,
    profile,
    modals: () => records(modals),
    failures: () => records(failures),
  }
}

async function diagnosticCodes(profile) {
  const directory = join(profile, 'logs/debug')
  const segments = (await readdir(directory)).filter((name) =>
    /^segment-\d\.log$/.test(name),
  )
  return (
    await Promise.all(
      segments.map((name) => readFile(join(directory, name), 'utf8')),
    )
  )
    .join('\n')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line).code)
}

async function deadline(pending, label, seconds = 5) {
  let timer
  try {
    return await Promise.race([
      pending,
      new Promise((_, reject) => {
        timer = globalThis.setTimeout(
          () => reject(new Error(`${label} exceeded ${seconds} seconds`)),
          seconds * 1000,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

for (const delay of [0, 200, 500]) {
  test(`quitting during startup after ${delay} ms does not show a failure dialog`, {
    timeout: 30000,
  }, async (t) => {
    const fixture = await launch(t)
    if (delay) await setTimeout(delay)
    const start = performance.now()
    // Use the shared shutdown bound; Windows can finish native teardown after quit.
    await fixture.app.close()
    assert.deepEqual(await fixture.modals(), [])
    assert.equal(fixture.child.exitCode, 0)
    t.diagnostic(
      `quit took ${Math.round(performance.now() - start)} ms; load failures ${JSON.stringify(await fixture.failures())}`,
    )
  })
}

test('quitting inside the first window constructor waits for its native wrapper', {
  skip: process.platform !== 'darwin',
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-constructor-quit-'))
  const hook = join(profile, 'constructor-hook.cjs')
  await writeFile(
    hook,
    `
const { app, BrowserWindow } = require('electron')
app.once('web-contents-created', () => {
  console.error('constructing windows:', BrowserWindow.getAllWindows().length)
  app.quit()
  console.error('quit returned')
})
app.once('browser-window-created', () => console.error('window constructed'))
app.once('quit', () => console.error('quit completed'))
`,
  )
  const env = {
    ...process.env,
    HIBI_TEST_ADDON_REVOCATIONS_URL: new URL(
      './fixtures/no-addon-revocations.json',
      import.meta.url,
    ).href,
  }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(
    electronPath,
    [
      '--require',
      hook,
      resolve('.'),
      `--user-data-dir=${profile}`,
      '--hibi-test',
    ],
    { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const closed = once(child, 'close')
  t.diagnostic(`constructor quit process: ${child.pid}`)
  // A native crash can leave helpers holding the output pipes open.
  child.once('exit', () => stopElectronTree(child))
  t.after(async () => {
    stopElectronTree(child)
    await closed
    await rm(profile, { recursive: true, force: true })
  })
  let output = ''
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => {
      output = (output + chunk).slice(-16384)
    })
  const [code, signal] = await closed
  assert.deepEqual([code, signal], [0, null], output)
  assert.match(
    output,
    /constructing windows: 0[\s\S]*quit returned[\s\S]*window constructed[\s\S]*quit completed/,
  )
})

test('a genuine startup navigation failure still shows the existing error', {
  timeout: 15000,
}, async (t) => {
  const requested = Promise.withResolvers()
  const server = createServer((request, response) => {
    // Commit the page so shown-window launch can return while loadURL is pending.
    response.writeHead(200, { 'Content-Type': 'text/html' })
    response.write('<!doctype html><title>Pending startup</title>')
    requested.resolve(request)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })
  const url = `http://127.0.0.1:${server.address().port}/`
  const fixture = await launch(t, { ELECTRON_RENDERER_URL: url })
  const request = await deadline(requested.promise, 'startup navigation')
  request.socket.destroy()
  await deadline(fixture.closed, 'failed startup exit')
  assert.equal(fixture.child.exitCode, 0)
  assert.deepEqual(await fixture.modals(), [
    {
      method: 'showErrorBox',
      title: 'Hibi could not start',
      content: 'Restart Hibi. If it still cannot start, reinstall it.',
    },
  ])
  assert.equal((await fixture.failures())[0].context, 'failed to load app:')
  // The local log must call this fatal exit critical whatever the load error code.
  const codes = await diagnosticCodes(fixture.profile)
  assert.ok(codes.includes('MAIN_STARTUP_FAILED'), codes.join(' '))
})

test('closing the window while a failed start is recorded still ends with the dialog and a quit', {
  timeout: 60000,
}, async (t) => {
  const requested = Promise.withResolvers()
  const server = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' })
    response.write('<!doctype html><title>Pending startup</title>')
    requested.resolve(request)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })
  const url = `http://127.0.0.1:${server.address().port}/`
  const fixture = await launch(
    t,
    { ELECTRON_RENDERER_URL: url },
    { closeDuringFlush: true },
  )
  const request = await deadline(requested.promise, 'startup navigation')
  request.socket.destroy()
  // On macOS closing the last window does not quit, so the dialog must still open.
  await deadline(fixture.closed, 'failed startup exit', 20)
  assert.equal(fixture.child.exitCode, 0)
  if (process.platform === 'darwin')
    assert.deepEqual(await fixture.modals(), [
      {
        method: 'showErrorBox',
        title: 'Hibi could not start',
        content: 'Restart Hibi. If it still cannot start, reinstall it.',
      },
    ])
})

// Spawned without Playwright: its inspector calls cannot reach a blocked main process.
async function spawnFailedStartup(t, { block = false } = {}) {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-startup-failure-'))
  const files = Object.fromEntries(
    ['modals', 'failures', 'logged'].map((name) => [
      name,
      join(profile, `${name}.jsonl`),
    ]),
  )
  for (const path of Object.values(files)) await writeFile(path, '')
  const hook = join(profile, 'startup-hook.cjs')
  await writeFile(
    hook,
    `(${recordStartupDialogs})(require('electron'), ${JSON.stringify({ ...files, occupy: 'clipboard:write-text', block })})`,
  )
  const env = {
    ...process.env,
    HIBI_TEST_ADDON_REVOCATIONS_URL: new URL(
      './fixtures/no-addon-revocations.json',
      import.meta.url,
    ).href,
  }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(
    electronPath,
    [
      // As Playwright launches it on Linux: the sandbox there needs a setuid
      // helper that an npm install of Electron does not set up.
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      '--require',
      hook,
      resolve('.'),
      `--user-data-dir=${profile}`,
      '--hibi-test',
    ],
    { env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] },
  )
  const closed = once(child, 'close')
  t.after(async () => {
    stopElectronTree(child)
    await closed
    await rm(profile, { recursive: true, force: true })
  })
  const read = async (path) => (await readFile(path, 'utf8')).trim()
  return {
    child,
    closed,
    profile,
    modals: () => read(files.modals),
    failures: () => read(files.failures),
    logged: async () =>
      (await read(files.logged))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
  }
}

// Every process of this run carries its profile in its command line.
async function survivors(profile) {
  const { stdout } = await promisify(execFile)('ps', ['-axo', 'command='])
  return stdout.split('\n').filter((line) => line.includes(profile))
}

test('a failed startup records its error before the dialog and quits when it closes', {
  skip: process.platform === 'win32',
  timeout: 30000,
}, async (t) => {
  const fixture = await spawnFailedStartup(t)
  // Spawning, failing and quitting a whole app can take seconds under load.
  assert.deepEqual(await deadline(fixture.closed, 'failed startup exit', 20), [
    0,
    null,
  ])
  assert.match(
    await fixture.failures(),
    /Attempted to register a second handler for 'clipboard:write-text'/,
  )
  assert.match(await fixture.modals(), /Hibi could not start/)
  const failure = (await fixture.logged()).find(
    (record) => record.code === 'MAIN_STARTUP_FAILED',
  )
  assert.ok(
    failure,
    'MAIN_STARTUP_FAILED was not on disk when the dialog opened',
  )
  // Frames of the main bundle (module 1) locate the failing registration.
  assert.equal(failure.stackStatus, 'captured')
  assert.equal(failure.frames[0][0], 1)
  assert.deepEqual(await survivors(fixture.profile), [])
})

test('the could-not-start dialog quits on SIGTERM without leaving Electron behind', {
  skip: process.platform === 'win32',
  timeout: 30000,
}, async (t) => {
  const fixture = await spawnFailedStartup(t, { block: true })
  const start = performance.now()
  while (!(await fixture.modals())) {
    assert.ok(performance.now() - start < 15000, 'no startup dialog')
    await setTimeout(50)
  }
  fixture.child.kill('SIGTERM')
  assert.deepEqual(await deadline(fixture.closed, 'SIGTERM exit'), [
    null,
    'SIGTERM',
  ])
  await setTimeout(1000)
  assert.deepEqual(await survivors(fixture.profile), [])
})
