import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  electron,
  startupDiagnostics,
  stopElectronTree,
  waitForDocumentEditor,
  waitForElectronShutdown,
} from './electron.mjs'
import { waitForAsync } from './poll.mjs'

async function records(profile) {
  const directory = join(profile, 'logs/debug')
  return (
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
}

async function profile() {
  await mkdir('.scratch', { recursive: true })
  return mkdtemp(resolve('.scratch/startup-'))
}

for (const [entry, kind] of [
  ['desktop-bridge', 'exception'],
  ['main', 'exception'],
  ['main', 'rejection'],
]) {
  test(`${entry} ${kind} before renderer entry retains navigation, resource and original error evidence locally`, {
    timeout: 30000,
  }, async (t) => {
    const root = await profile()
    const app = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${root}`],
    })
    const page = await app.firstWindow()
    t.after(async () => {
      // The injected immutable asset may remain in Chromium's code cache.
      // This fixture has no edits; retire its broken renderer explicitly.
      const closed = waitForElectronShutdown(
        app.process(),
        app.waitForEvent('close'),
      )
      await app.evaluate(({ app, BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) window.destroy()
        app.quit()
      })
      await closed
    })
    await waitForDocumentEditor(app, page)
    await app.evaluate(
      ({ app, protocol, net }, { entry, kind }) => {
        const fs = process.getBuiltinModule('node:fs/promises')
        const path = process.getBuiltinModule('node:path')
        const { pathToFileURL } = process.getBuiltinModule('node:url')
        let injected = false
        globalThis.preEntryFaults = 0
        protocol.unhandle('app')
        protocol.handle('app', async (request) => {
          const pathname = new URL(request.url).pathname
          const file = path.join(
            app.getAppPath(),
            'out/renderer',
            pathname === '/' ? 'index.html' : pathname,
          )
          const asset = entry === 'desktop-bridge' ? '/index-' : '/main-'
          if (
            !injected &&
            pathname.includes(asset) &&
            pathname.endsWith('.js')
          ) {
            injected = true
            globalThis.preEntryFaults++
            const source = await fs.readFile(file, 'utf8')
            return new Response(
              `${
                kind === 'rejection'
                  ? "void Promise.reject(new Error('PRIVATE_PRE_ENTRY')); await new Promise(() => {});"
                  : "throw new Error('PRIVATE_PRE_ENTRY');"
              }\n${source}`,
              { headers: { 'Content-Type': 'text/javascript' } },
            )
          }
          return net.fetch(pathToFileURL(file).href)
        })
      },
      { entry, kind },
    )
    const session = await page.context().newCDPSession(page)
    await session.send('Network.setCacheDisabled', { cacheDisabled: true })
    await page.reload({ waitUntil: 'commit' })
    await waitForAsync(
      { evaluate: async (fn) => fn() },
      async () => (await app.evaluate(() => globalThis.preEntryFaults)) === 1,
      undefined,
      { timeout: 4000 },
    )
    await waitForAsync(
      { evaluate: async (fn) => fn() },
      async () =>
        (await records(root)).some(
          (row) => row.code === 'RENDERER_STARTUP_FAILED',
        ),
      undefined,
      { timeout: 4000 },
    )
    const rows = await records(root)
    assert.ok(rows.some((row) => row.code === 'RENDERER_PRE_ENTRY'))
    const snapshot = await startupDiagnostics(app, page)
    assert.ok(snapshot.navigation, JSON.stringify(snapshot))
    assert.ok(
      snapshot.pageErrors.some((error) =>
        error.stack?.includes(entry === 'desktop-bridge' ? 'index-' : 'main-'),
      ),
    )
    assert.doesNotMatch(
      JSON.stringify(rows),
      /PRIVATE_PRE_ENTRY|startup-|\/Users\//,
    )
    assert.equal(
      await page.evaluate(
        () => performance.getEntriesByName('hibi:renderer-entry').length,
      ),
      0,
    )
  })
}

test('diagnostic metadata stays lazy and a stalled first-failure import keeps a bounded backlog', {
  timeout: 30000,
}, async (t) => {
  const root = await profile()
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${root}`],
  })
  const page = await app.firstWindow()
  t.after(async () => {
    await app
      .evaluate(() => globalThis.releaseDiagnosticMetadata?.())
      .catch(() => {})
    await app.close()
  })
  await waitForDocumentEditor(app, page)
  const chunks = JSON.parse(
    await readFile('out/renderer/startup-bundle.json', 'utf8'),
  )
  const metadata = chunks.find((chunk) =>
    chunk.modules.includes('src/renderer/src/local-diagnostics-report.ts'),
  )?.file
  assert.ok(metadata, 'failure metadata must have its own lazy chunk')
  assert.equal(
    await page.evaluate(
      (file) =>
        performance
          .getEntriesByType('resource')
          .some((entry) => entry.name.endsWith(file)),
      metadata,
    ),
    false,
  )
  await app.evaluate(({ net }, file) => {
    const fetch = net.fetch.bind(net)
    globalThis.diagnosticMetadataRequests = 0
    net.fetch = async (...args) => {
      if (String(args[0]).endsWith(file)) {
        globalThis.diagnosticMetadataRequests++
        await new Promise((resolve) => {
          globalThis.releaseDiagnosticMetadata = resolve
        })
      }
      return fetch(...args)
    }
  }, metadata)
  await page.evaluate(() => {
    for (let index = 0; index < 64; index++)
      window.dispatchEvent(
        new ErrorEvent('error', {
          message: 'PRIVATE_DIAGNOSTIC_BURST',
          error: new Error('PRIVATE_DIAGNOSTIC_BURST'),
        }),
      )
  })
  await waitForAsync(
    { evaluate: async (fn) => fn() },
    async () =>
      (await app.evaluate(() => globalThis.diagnosticMetadataRequests)) === 1,
    undefined,
    { timeout: 4000 },
  )
  assert.equal(
    (await records(root)).some((row) => row.code === 'RENDERER_ERROR'),
    false,
  )
  await app.evaluate(() => globalThis.releaseDiagnosticMetadata())
  await waitForAsync(
    { evaluate: async (fn) => fn() },
    async () =>
      (await records(root)).some(
        (row) => row.code === 'DIAGNOSTICS_DROPPED' && row.count >= 32,
      ),
    undefined,
    { timeout: 4000 },
  )
  const rows = await records(root)
  assert.ok(rows.some((row) => row.code === 'RENDERER_ERROR'))
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE_DIAGNOSTIC_BURST/)
})

test('pending core asset records its catalog identity, status and elapsed time', {
  timeout: 30000,
}, async (t) => {
  const root = await profile()
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${root}`],
  })
  const page = await app.firstWindow()
  t.after(async () => {
    await app.evaluate(() => globalThis.releaseStartupAsset?.())
    await app.close()
  })
  await waitForDocumentEditor(app, page)
  await app.evaluate(({ net }) => {
    const fetch = net.fetch.bind(net)
    let held = false
    net.fetch = async (...args) => {
      if (!held && /\/main-[^/]+\.js$/.test(String(args[0]))) {
        held = true
        await new Promise((resolve) => {
          globalThis.releaseStartupAsset = resolve
        })
      }
      return fetch(...args)
    }
  })
  const session = await page.context().newCDPSession(page)
  await session.send('Network.setCacheDisabled', { cacheDisabled: true })
  const catalog = JSON.parse(
    await readFile('out/renderer/diagnostic-artifacts.json', 'utf8'),
  )
  const mainId = catalog.artifacts.find(([name]) => /\/main-/.test(name))?.[1]
  assert.ok(mainId)
  const loading = page.reload()
  try {
    await waitForAsync(
      { evaluate: async (fn) => fn() },
      async () =>
        (await records(root)).some(
          (row) => row.code === 'ASSET_PENDING' && row.moduleId === mainId,
        ),
      undefined,
      { timeout: 5000 },
    )
    const snapshot = await startupDiagnostics(app, page)
    assert.ok(snapshot.resources.pending.some((row) => /main-/.test(row.url)))
  } finally {
    await app.evaluate(() => globalThis.releaseStartupAsset?.())
    await loading
  }
  await waitForAsync(
    { evaluate: async (fn) => fn() },
    async () =>
      (await records(root)).some(
        (row) => row.code === 'ASSET_COMPLETED' && row.moduleId === mainId,
      ),
    undefined,
    { timeout: 4000 },
  )
  const record = (await records(root)).find(
    (row) => row.code === 'ASSET_COMPLETED' && row.moduleId === mainId,
  )
  assert.equal(record.statusCode, 200)
  assert.ok(record.elapsedMs >= 2000)
  assert.equal(record.moduleId, mainId)
})

test('ordinary quit waits for overdue sqlite close, preserves its active marker, then reopens cleanly', {
  timeout: 30000,
}, async (t) => {
  const root = await profile()
  await writeFile(
    join(root, 'addons.json'),
    JSON.stringify({ dictionary: true }),
  )
  let app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${root}`],
  })
  let child = app.process()
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    await app.evaluate(() => globalThis.releaseSqliteClose?.()).catch(() => {})
    await app.close()
  })
  const page = await app.firstWindow()
  await waitForDocumentEditor(app, page)
  await page.evaluate(() =>
    window.hibi.queryAddon('dictionary', 'customWordsMetadata'),
  )
  await app.evaluate(() => {
    const threads = process.getBuiltinModule('node:worker_threads')
    const send = threads.Worker.prototype.postMessage
    globalThis.sqliteCloseCalls = 0
    threads.Worker.prototype.postMessage = function (message, ...args) {
      if (message.method === 'close') {
        globalThis.sqliteCloseCalls++
        globalThis.releaseSqliteClose = () => send.call(this, message, ...args)
        return
      }
      return send.call(this, message, ...args)
    }
  })
  t.diagnostic(
    'body complete; entering graceful cleanup with held sqlite close',
  )
  await app.evaluate(({ app }) => {
    app.quit()
  })
  await waitForAsync(
    { evaluate: async (fn) => fn() },
    async () =>
      (await records(root)).some((row) => row.code === 'SQLITE_CLOSE_WAITING'),
    undefined,
    { timeout: 5000 },
  )
  assert.equal(child.exitCode, null)
  assert.equal(
    JSON.parse(await readFile(join(root, 'logs/debug/run-state.txt'), 'utf8'))
      .state,
    'active',
  )
  assert.equal(
    (await records(root)).some((row) => row.code === 'RUN_ENDED'),
    false,
  )
  await app.evaluate(({ app }) => {
    app.quit()
    app.quit()
  })
  assert.equal(await app.evaluate(() => globalThis.sqliteCloseCalls), 1)
  const closed = waitForElectronShutdown(child, app.waitForEvent('close'))
  await app.evaluate(() => globalThis.releaseSqliteClose())
  await closed
  assert.equal(child.exitCode, 0)
  assert.ok((await records(root)).some((row) => row.code === 'SQLITE_CLOSED'))
  assert.equal(
    JSON.parse(await readFile(join(root, 'logs/debug/run-state.txt'), 'utf8'))
      .state,
    'clean',
  )
  t.diagnostic('graceful cleanup complete; reopening same profile')
  app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${root}`],
  })
  child = app.process()
  const reopened = await app.firstWindow()
  await waitForDocumentEditor(app, reopened)
  assert.equal(
    (
      await reopened.evaluate(() =>
        window.hibi.queryAddon('dictionary', 'customWordsMetadata'),
      )
    ).count,
    0,
  )
})

// The real worker keeps its database open; each close request reports failure.
function failSqliteClose() {
  const threads = process.getBuiltinModule('node:worker_threads')
  const send = threads.Worker.prototype.postMessage
  globalThis.sqliteCloseCalls = 0
  threads.Worker.prototype.postMessage = function (message, ...args) {
    if (message?.method !== 'close') return send.call(this, message, ...args)
    globalThis.sqliteCloseCalls++
    setImmediate(() =>
      this.emit('message', { seq: message.seq, error: 'PRIVATE_CLOSE_ERROR' }),
    )
  }
}

test('a sqlite close that keeps failing is recorded and cannot keep Hibi from quitting', {
  timeout: 45000,
}, async (t) => {
  const root = await profile()
  await writeFile(
    join(root, 'addons.json'),
    JSON.stringify({ dictionary: true }),
  )
  let app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${root}`],
  })
  let child = app.process()
  let quitting = false
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    // A blocked quit has already closed every window; nothing can retry it.
    if (quitting) stopElectronTree(child)
    else await app.close()
  })
  const page = await app.firstWindow()
  await waitForDocumentEditor(app, page)
  await page.evaluate(async () => {
    const call = (input) =>
      window.hibi.invokeAddonProfile('dictionary', 'changeCustomWords', input)
    const { revision } = await window.hibi.invokeAddonProfile(
      'dictionary',
      'customWordsMetadata',
    )
    const { token } = await call({ type: 'begin', revision })
    await call({
      type: 'stage',
      token,
      upsert: [{ id: 'kept', word: 'durable' }],
      remove: [],
    })
    await call({ type: 'commit', token })
  })
  await app.evaluate(failSqliteClose)
  quitting = true
  const closed = waitForElectronShutdown(child, app.waitForEvent('close'))
  await app.evaluate(({ app }) => {
    app.quit()
  })
  let timer
  await Promise.race([
    closed,
    new Promise((_, reject) => {
      timer = setTimeout(
        () =>
          reject(new Error('Hibi kept running after its sqlite close failed')),
        10000,
      )
    }),
  ]).finally(() => clearTimeout(timer))
  assert.equal(child.exitCode, 0)
  const rows = await records(root)
  assert.ok(rows.some((row) => row.code === 'SQLITE_CLOSE_FAILED'))
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE_CLOSE_ERROR/)
  t.diagnostic('quit after failed close; reopening same profile')
  quitting = false
  app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${root}`],
  })
  child = app.process()
  const reopened = await app.firstWindow()
  await waitForDocumentEditor(app, reopened)
  const { words } = await reopened.evaluate(() =>
    window.hibi.invokeAddonProfile('dictionary', 'customWords', {}),
  )
  assert.deepEqual(
    words.map((word) => word.word),
    ['durable'],
  )
})

test('disabling the dictionary neither waits on nor fails with its sqlite close', {
  timeout: 30000,
}, async (t) => {
  const root = await profile()
  await writeFile(
    join(root, 'addons.json'),
    JSON.stringify({ dictionary: true }),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${root}`],
  })
  t.after(async () => {
    await app.evaluate(() => globalThis.releaseSqliteClose?.()).catch(() => {})
    await app.close()
  })
  const page = await app.firstWindow()
  await waitForDocumentEditor(app, page)
  const enabled = () =>
    page.evaluate(() =>
      window.hibi.invokeAddonProfile('dictionary', 'customWordsMetadata'),
    )
  await enabled()
  await app.evaluate(() => {
    const threads = process.getBuiltinModule('node:worker_threads')
    const send = threads.Worker.prototype.postMessage
    globalThis.sqliteCloseCalls = 0
    threads.Worker.prototype.postMessage = function (message, ...args) {
      if (message?.method !== 'close') return send.call(this, message, ...args)
      globalThis.sqliteCloseCalls++
      globalThis.releaseSqliteClose = () => send.call(this, message, ...args)
    }
  })
  const toggle = (enabled) =>
    page.evaluate(
      (enabled) => window.hibi.setAddonEnabled('dictionary', enabled),
      enabled,
    )
  let timer
  const states = await Promise.race([
    toggle(false),
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('disabling waited for the held sqlite close')),
        8000,
      )
    }),
  ]).finally(() => clearTimeout(timer))
  assert.equal(
    states.find((state) => state.id === 'dictionary')?.enabled,
    false,
  )
  assert.equal(await app.evaluate(() => globalThis.sqliteCloseCalls), 1)
  // The close keeps running; re-enabling waits for it instead of opening twice.
  await toggle(true)
  const reopened = enabled()
  await app.evaluate(() => globalThis.releaseSqliteClose())
  assert.equal((await reopened).count, 0)
  await waitForAsync(
    { evaluate: async (fn) => fn() },
    async () =>
      (await records(root)).some((row) => row.code === 'SQLITE_CLOSED'),
    undefined,
    { timeout: 4000 },
  )
  await app.evaluate(failSqliteClose)
  const failed = await toggle(false)
  assert.equal(
    failed.find((state) => state.id === 'dictionary')?.enabled,
    false,
  )
})

test('background addon failure is recorded without addon identity or error content', {
  timeout: 30000,
}, async (t) => {
  const root = await profile()
  const folder = join(root, 'installed-addons', 'private-startup')
  await mkdir(folder, { recursive: true })
  await writeFile(
    join(folder, 'hibi-addon.json'),
    JSON.stringify({
      id: 'private-startup',
      name: 'PRIVATE_ADDON',
      description: 'Fixture.',
      kind: 'extension',
      apiVersion: 2,
      version: '1.0.0',
      defaultEnabled: true,
      startup: 'background',
      capabilities: [],
      authors: [{ displayName: 'Test' }],
      entry: 'index.js',
    }),
  )
  await writeFile(
    join(folder, 'index.js'),
    "export default () => ({ start() { window.backgroundFaultStarted = true; throw new Error('PRIVATE_BACKGROUND') } })",
  )
  await writeFile(
    join(folder, '.hibi-install.json'),
    JSON.stringify({
      hash: 'a'.repeat(64),
      files: ['hibi-addon.json', 'index.js'],
      source: 'local',
    }),
  )
  await writeFile(
    join(root, 'addons.json'),
    JSON.stringify({ 'private-startup': true }),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${root}`],
  })
  t.after(() => app.close())
  const page = await app.firstWindow()
  await waitForDocumentEditor(app, page)
  await page.waitForFunction(() => window.backgroundFaultStarted === true)
  await waitForAsync(
    { evaluate: async (fn) => fn() },
    async () =>
      (await records(root)).some(
        (row) => row.code === 'BACKGROUND_STARTUP_FAILED',
      ),
    undefined,
    { timeout: 4000 },
  )
  assert.doesNotMatch(
    JSON.stringify(await records(root)),
    /PRIVATE_|private-startup/,
  )
})
