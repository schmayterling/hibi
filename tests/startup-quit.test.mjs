import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { setTimeout } from 'node:timers/promises'
import { electron, stopElectronTree } from './electron.mjs'

function recordStartupDialogs(
  { app, BrowserWindow, dialog },
  { modals, failures },
) {
  const fs = process.getBuiltinModule('node:fs')
  const append = (path, value) =>
    fs.appendFileSync(path, `${JSON.stringify(value)}\n`)
  const original = console.error
  console.error = (...args) => {
    if (args[0] === 'failed to load app:' || args[0] === 'startup failed:')
      append(failures, {
        context: args[0],
        message: args[1]?.message,
        stack: args[1]?.stack,
      })
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

async function launch(t, env = {}) {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-startup-quit-'))
  const modals = join(profile, 'modals.jsonl')
  const failures = join(profile, 'failures.jsonl')
  await writeFile(modals, '')
  await writeFile(failures, '')
  const hook = join(profile, 'startup-hook.cjs')
  await writeFile(
    hook,
    `(${recordStartupDialogs})(require('electron'), ${JSON.stringify({ modals, failures })})`,
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
    modals: () => records(modals),
    failures: () => records(failures),
  }
}

async function deadline(pending, label) {
  let timer
  try {
    return await Promise.race([
      pending,
      new Promise((_, reject) => {
        timer = globalThis.setTimeout(
          () => reject(new Error(`${label} exceeded five seconds`)),
          5000,
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
})
