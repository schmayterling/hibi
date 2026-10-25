import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'
import { waitForAsync } from './poll.mjs'

const bundles = new Map()
async function runtime({
  platform = 'win32',
  code = 'EPERM',
  failures = 1,
} = {}) {
  if (!bundles.has(platform))
    bundles.set(
      platform,
      build({
        stdin: {
          contents:
            "export { loadAppearance, saveAppearance } from './src/main/appearance.ts'; export { rememberWorkspace, setKnownWorkspace, observeKnownWorkspaces } from './src/main/recent-workspaces.ts'; export { saveUiCase, getUiCase } from './src/main/ui-case.ts'; export { writeText } from './src/main/files.ts'; export { createAddonStorage } from './src/main/addon-storage.ts'; export { replaceExistingText } from './src/main/workspace-atomic-update.ts'; export { writeWorkspaceText, WORKSPACE_MANIFEST } from './src/main/workspace-metadata.ts'; export { HostCredentials } from './src/main/host-credentials.ts'; export { LocalDiagnosticSink } from './src/main/local-diagnostics/sink.ts'",
          resolveDir: resolve('.'),
        },
        bundle: true,
        write: false,
        platform: 'node',
        external: ['electron'],
        format: 'cjs',
        define: { 'process.platform': JSON.stringify(platform) },
      }),
    )
  const { outputFiles } = await bundles.get(platform)
  const state = { attempts: 0, syncs: 0, delays: [], live: true }
  const original = Object.assign(new Error('first rename failure'), { code })
  const mocks = {
    electron: {
      app: { getPath: () => state.preferenceRoot },
      nativeTheme: { themeSource: 'system', shouldUseDarkColors: false },
    },
    'node:fs/promises': {
      ...fs,
      open: async (...args) => {
        const file = await fs.open(...args)
        const sync = file.sync.bind(file)
        file.sync = async () => {
          state.syncs++
          return sync()
        }
        return file
      },
      rename: async (source, destination) => {
        state.attempts++
        await state.beforeRename?.()
        if (state.attempts <= failures)
          throw state.attempts === 1
            ? original
            : Object.assign(new Error('later rename failure'), { code })
        return fs.rename(source, destination)
      },
    },
    'node:timers/promises': {
      setTimeout: async (milliseconds, _value, options) => {
        state.delays.push(milliseconds)
        await state.onDelay?.(options?.signal)
        options?.signal?.throwIfAborted()
      },
    },
  }
  const module = { exports: {} }
  const require = createRequire(import.meta.url)
  new Function('require', 'module', 'exports', outputFiles[0].text)(
    (id) => mocks[id] ?? require(id),
    module,
    module.exports,
  )
  return { module, state, original }
}

test('migrated casing preference keeps old file and cleans staging on failed commit', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'hibi-preference-write-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const file = join(root, 'ui-case.json')
  await fs.writeFile(file, JSON.stringify('sentence'))
  const { module, state, original } = await runtime({
    platform: 'linux',
    code: 'EACCES',
    failures: 1,
  })
  state.preferenceRoot = root
  await assert.rejects(
    module.exports.saveUiCase('lowercase'),
    (error) => error === original,
  )
  assert.equal(await fs.readFile(file, 'utf8'), JSON.stringify('sentence'))
  assert.deepEqual(await fs.readdir(root), ['ui-case.json'])
  // Casing intentionally publishes before persistence, including on failure.
  assert.equal(module.exports.getUiCase(), 'lowercase')
  await module.exports.saveUiCase('sentence')
  assert.equal(await fs.readFile(file, 'utf8'), JSON.stringify('sentence'))
  assert.deepEqual(await fs.readdir(root), ['ui-case.json'])
})

test('unchanged workspace lists notify listeners without repeating file sync', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'hibi-workspace-writes-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const { module, state } = await runtime({ platform: 'linux', failures: 0 })
  state.preferenceRoot = root
  const api = module.exports
  const events = []
  const stop = api.observeKnownWorkspaces((known) => events.push(known))
  t.after(stop)
  await api.rememberWorkspace(root)
  assert.equal(state.syncs, 1)
  for (let repeat = 0; repeat < 10; repeat++) await api.rememberWorkspace(root)
  assert.equal(state.syncs, 1)
  assert.equal(events.length, 11)
  const id = events.at(-1)[0].id
  await api.setKnownWorkspace(id, 'pin')
  assert.equal(state.syncs, 2)
  await api.setKnownWorkspace(id, 'pin')
  await api.rememberWorkspace(root)
  assert.equal(state.syncs, 2)
  assert.equal(events.length, 14)
  assert.equal(events.at(-1)[0].pinned, true)
  assert.equal(
    JSON.parse(
      await fs.readFile(join(root, 'recent-workspaces.json'), 'utf8'),
    )[0].pinned,
    true,
  )
})

test('unchanged appearance shares the pending save and skips repeat file sync', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'hibi-appearance-writes-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const { module, state } = await runtime({ platform: 'linux', failures: 0 })
  state.preferenceRoot = root
  const saved = {
    preferences: { mode: 'system', light: 'hibi-light', dark: 'hibi-dark' },
    light: { background: '#ffffff', foreground: '#1b2021' },
    dark: { background: '#181818', foreground: '#e4e9e9' },
  }
  const path = join(root, 'appearance.json')
  await fs.writeFile(path, JSON.stringify(saved))
  await module.exports.loadAppearance()
  await module.exports.saveAppearance(saved)
  assert.equal(state.syncs, 0)
  const changed = {
    ...saved,
    preferences: { ...saved.preferences, mode: 'dark' },
  }
  const pending = module.exports.saveAppearance(changed)
  assert.equal(module.exports.saveAppearance(changed), pending)
  await pending
  await module.exports.saveAppearance(changed)
  assert.equal(state.syncs, 1)
  assert.deepEqual(JSON.parse(await fs.readFile(path, 'utf8')), changed)
  await module.exports.saveAppearance(saved)
  assert.equal(state.syncs, 2)
})

async function writer(t, kind, options) {
  const { module, state, original } = await runtime(options)
  const root = await fs.mkdtemp(join(tmpdir(), 'hibi-atomic-rename-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const file =
    kind === 'metadata'
      ? join(root, module.exports.WORKSPACE_MANIFEST)
      : kind !== 'storage'
        ? join(root, 'note.md')
        : join(root, 'global', 'example.json')
  await fs.mkdir(dirname(file), { recursive: true })
  const initial =
    kind !== 'storage' ? 'original' : JSON.stringify({ format: 1, entries: {} })
  await fs.writeFile(file, initial)
  const storage = module.exports.createAddonStorage(
    root,
    () => true,
    () => state.live,
  )
  return {
    state,
    file,
    initial,
    original,
    write: () =>
      kind === 'document'
        ? module.exports.writeText(file, 'replacement', false, () => state.live)
        : kind === 'workspace'
          ? module.exports.replaceExistingText(
              file,
              'replacement',
              0o600,
              async () => {
                if (!state.live) throw new Error('workspace request expired')
              },
            )
          : kind === 'metadata'
            ? module.exports.writeWorkspaceText(
                root,
                module.exports.WORKSPACE_MANIFEST,
                'replacement',
              )
            : storage.write(
                {
                  owner: 'example',
                  scope: { kind: 'global' },
                  key: 'value',
                  version: 1,
                  baseRevision: 0,
                  value: 'replacement',
                },
                0,
              ),
    content: async () => {
      const bytes = await fs.readFile(file, 'utf8')
      return kind !== 'storage' ? bytes : JSON.parse(bytes).entries.value.value
    },
    assertClean: async () =>
      assert.deepEqual(await fs.readdir(dirname(file)), [basename(file)]),
  }
}

for (const kind of ['document', 'storage', 'workspace']) {
  for (const [code, failures] of [
    ['EPERM', 1],
    ['EACCES', 2],
    ['EBUSY', 5],
  ])
    test(`${kind} atomic write retries transient windows ${code}`, async (t) => {
      const writing = await writer(t, kind, { code, failures })
      await writing.write()
      assert.equal(writing.state.attempts, failures + 1)
      assert.deepEqual(
        writing.state.delays,
        [50, 100, 200, 400, 800].slice(0, failures),
      )
      assert.equal(await writing.content(), 'replacement')
      await writing.assertClean()
    })

  test(`${kind} atomic write preserves the original error after bounded retries`, async (t) => {
    const writing = await writer(t, kind, { failures: Infinity })
    await assert.rejects(writing.write(), (error) => error === writing.original)
    assert.equal(writing.state.attempts, 6)
    assert.deepEqual(writing.state.delays, [50, 100, 200, 400, 800])
    assert.equal(await fs.readFile(writing.file, 'utf8'), writing.initial)
    await writing.assertClean()
  })

  for (const [platform, code] of [
    ['darwin', 'EPERM'],
    ['linux', 'EPERM'],
    ['win32', 'ENOENT'],
    ['win32', 'EIO'],
  ])
    test(`${kind} atomic write does not retry ${platform} ${code}`, async (t) => {
      const writing = await writer(t, kind, {
        platform,
        code,
        failures: Infinity,
      })
      await assert.rejects(
        writing.write(),
        (error) => error === writing.original,
      )
      assert.equal(writing.state.attempts, 1)
      assert.deepEqual(writing.state.delays, [])
      assert.equal(await fs.readFile(writing.file, 'utf8'), writing.initial)
      await writing.assertClean()
    })

  test(`${kind} atomic write rechecks liveness after retry backoff`, async (t) => {
    const writing = await writer(t, kind)
    writing.state.onDelay = () => {
      writing.state.live = false
    }
    if (kind !== 'storage')
      await assert.rejects(
        writing.write(),
        /The save request is no longer current\.|workspace request expired/,
      )
    else
      assert.deepEqual(await writing.write(), {
        status: 'unavailable',
        reason: 'stale-activation',
      })
    assert.equal(writing.state.attempts, 1)
    assert.deepEqual(writing.state.delays, [50])
    assert.equal(await fs.readFile(writing.file, 'utf8'), writing.initial)
    await writing.assertClean()
  })
}

for (const failures of [1, 5, Infinity])
  test(`metadata atomic write keeps the six-attempt retry budget: ${failures}`, async (t) => {
    const writing = await writer(t, 'metadata', { failures })
    if (Number.isFinite(failures)) {
      await writing.write()
      assert.equal(writing.state.attempts, failures + 1)
      assert.equal(await writing.content(), 'replacement')
    } else {
      await assert.rejects(
        writing.write(),
        (error) => error === writing.original,
      )
      assert.equal(writing.state.attempts, 6)
      assert.equal(await fs.readFile(writing.file, 'utf8'), writing.initial)
    }
    assert.deepEqual(
      writing.state.delays,
      [50, 100, 200, 400, 800].slice(0, failures),
    )
    await writing.assertClean()
  })

test('workspace atomic write rejects a staged pathname swapped during backoff', async (t) => {
  const writing = await writer(t, 'workspace')
  const directory = dirname(writing.file)
  const saved = join(directory, 'saved-stage')
  writing.state.onDelay = async () => {
    const temporary = join(
      directory,
      (await fs.readdir(directory)).find((name) => name.endsWith('.tmp')),
    )
    await fs.rename(temporary, saved)
    await fs.writeFile(temporary, 'swapped bytes', { flag: 'wx' })
  }
  await assert.rejects(writing.write(), /The staged file changed\./)
  assert.equal(writing.state.attempts, 1)
  assert.equal(await fs.readFile(writing.file, 'utf8'), writing.initial)
  assert.equal(await fs.readFile(saved, 'utf8'), 'replacement')
})

async function credentialWriter(t, options) {
  const { module, state } = await runtime(options)
  const directory = await fs.mkdtemp(join(tmpdir(), 'hibi-credential-rename-'))
  let owner = { addonId: 'example', activationGeneration: 1 }
  const windowKey = {}
  const host = new module.exports.HostCredentials({
    directory,
    platform: 'darwin',
    currentOwner: () => owner,
    isWindowLive: () => true,
    storage: {
      isAsyncEncryptionAvailable: async () => state.available !== false,
      encryptStringAsync: async () => Buffer.from('ciphertext'),
      isEncryptionAvailable: () => true,
    },
  })
  t.after(async () => {
    host.dispose()
    await fs.rm(directory, { recursive: true, force: true })
  })
  return {
    host,
    state,
    directory,
    revoke: () => host.stopOwner(owner),
    restart: () => {
      owner = { ...owner, activationGeneration: owner.activationGeneration + 1 }
    },
    stopWindow: () => host.stopWindow(windowKey),
    write: () =>
      host.store('example', windowKey, {
        key: 'token',
        secret: 'synthetic-secret',
        mode: 'persistent',
      }),
  }
}

for (const failures of [1, 5, Infinity])
  test(`credential rename keeps the six-attempt retry budget: ${failures}`, async (t) => {
    const writing = await credentialWriter(t, { failures })
    const result = await writing.write()
    assert.equal(result.ok, Number.isFinite(failures))
    if (!result.ok) assert.equal(result.code, 'io-error')
    assert.equal(writing.state.attempts, Math.min(failures + 1, 6))
    assert.deepEqual(
      writing.state.delays,
      [50, 100, 200, 400, 800].slice(0, failures),
    )
    const entries = await fs.readdir(writing.directory)
    assert.equal(entries.length, Number.isFinite(failures) ? 1 : 0)
    if (entries.length)
      assert.doesNotMatch(
        await fs.readFile(join(writing.directory, entries[0]), 'utf8'),
        /synthetic-secret/,
      )
  })

for (const action of ['revoke', 'stopWindow', 'dispose'])
  test(`credential ${action} cancels retry backoff without another native rename`, async (t) => {
    const writing = await credentialWriter(t)
    let cancelled = false
    writing.state.onDelay = (signal) =>
      new Promise((_resolve, reject) => {
        assert.ok(signal)
        signal.addEventListener(
          'abort',
          () => {
            cancelled = true
            reject(signal.reason)
          },
          { once: true },
        )
        if (action === 'dispose') writing.host.dispose()
        else writing[action]()
      })
    const result = await writing.write()
    assert.equal(result.ok, false)
    assert.equal(result.code, 'stale')
    assert.equal(result.committed, undefined)
    assert.equal(cancelled, true)
    assert.equal(writing.state.attempts, 1)
    assert.deepEqual(writing.state.delays, [50])
    await waitForAsync(
      { evaluate: (predicate) => predicate() },
      async () => (await fs.readdir(writing.directory)).length === 0,
      undefined,
      { timeout: 2000 },
    )
    assert.deepEqual(await fs.readdir(writing.directory), [])
  })

for (const action of ['restart', 'unavailable'])
  test(`credential retry rechecks ${action} without an abort`, async (t) => {
    const writing = await credentialWriter(t)
    writing.state.onDelay = () => {
      if (action === 'restart') writing.restart()
      else writing.state.available = false
    }
    const result = await writing.write()
    assert.equal(result.ok, false)
    assert.equal(
      result.code,
      action === 'restart' ? 'stale' : 'locked-or-unavailable',
    )
    assert.equal(result.committed, undefined)
    assert.equal(writing.state.attempts, 1)
    assert.deepEqual(writing.state.delays, [50])
  })

for (const succeeds of [true, false])
  test(`credential abort awaits a windows native rename that succeeds: ${succeeds}`, async (t) => {
    const writing = await credentialWriter(t, { failures: succeeds ? 0 : 1 })
    let enter, release
    const entered = new Promise((resolve) => {
      enter = resolve
    })
    const gate = new Promise((resolve) => {
      release = resolve
    })
    writing.state.beforeRename = async () => {
      enter()
      await gate
    }
    const pending = writing.write()
    await entered
    writing.revoke()
    let settled = false
    void pending.then(() => {
      settled = true
    })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(settled, false)
    release()
    const result = await pending
    assert.equal(result.ok, false)
    assert.equal(result.code, 'stale')
    assert.equal(result.committed, succeeds ? true : undefined)
    assert.equal(writing.state.attempts, 1)
  })

async function diagnosticWriter(t, options) {
  const { module, state } = await runtime(options)
  const directory = await fs.mkdtemp(join(tmpdir(), 'hibi-diagnostic-rename-'))
  const sink = new module.exports.LocalDiagnosticSink({
    userData: directory,
    profile: 'release',
    identity: {
      app: '0.1.0',
      build: 'unknown',
      electron: '44.3.0',
      chrome: '152.0.0',
      node: '24.11.0',
      v8: '15.0',
      platform: 'win32',
      arch: 'x64',
      packaged: false,
    },
  })
  await sink.ready
  t.after(async () => {
    await sink.finish()
    await fs.rm(directory, { recursive: true, force: true })
  })
  return { sink, state, directory: sink.location }
}

test('diagnostic first rename refuses an unowned incident destination', async (t) => {
  const { sink, state, directory } = await diagnosticWriter(t)
  const file = join(directory, 'last-incident.txt')
  const initial = 'PRIVATE_UNOWNED'
  await fs.writeFile(file, initial)
  sink.enqueue(
    JSON.stringify({ code: 'RENDERER_ERROR', stackStatus: 'unavailable' }),
  )
  await sink.flush()
  assert.equal(sink.status.state, 'failed')
  assert.equal(state.attempts, 0)
  assert.equal(await fs.readFile(file, 'utf8'), initial)
})

test('diagnostic first rename enforces the smaller run marker limit', async (t) => {
  const { sink, state, directory } = await diagnosticWriter(t)
  const file = join(directory, 'run-state.txt')
  const initial = JSON.stringify({
    kind: 'hibi-local-diagnostics',
    padding: 'x'.repeat(5000),
  })
  assert.ok(Buffer.byteLength(initial) > 4096)
  assert.ok(Buffer.byteLength(initial) < 65536)
  await fs.writeFile(file, initial)
  await sink.finish()
  assert.equal(sink.status.state, 'failed')
  assert.equal(state.attempts, 0)
  assert.equal(await fs.readFile(file, 'utf8'), initial)
})

for (const changed of [
  'incident-next.txt',
  'last-incident.txt',
  'run-state.txt',
])
  test(`diagnostic retry refuses an unowned ${changed} swapped during backoff`, async (t) => {
    const { sink, state, directory } = await diagnosticWriter(t)
    state.onDelay = () =>
      fs.writeFile(join(directory, changed), 'PRIVATE_UNOWNED')
    if (changed === 'run-state.txt') await sink.finish()
    else {
      sink.enqueue(
        JSON.stringify({ code: 'RENDERER_ERROR', stackStatus: 'unavailable' }),
      )
      await sink.flush()
    }
    assert.equal(sink.status.state, 'failed')
    assert.equal(state.attempts, 1)
    assert.equal(
      await fs.readFile(join(directory, changed), 'utf8'),
      'PRIVATE_UNOWNED',
    )
    assert.doesNotMatch(sink.report(), /PRIVATE_UNOWNED/)
  })

for (const target of ['last-incident.txt', 'run-state.txt'])
  test(`diagnostic ${target} preserves its destination when staging disappears during backoff`, async (t) => {
    const { sink, state, directory } = await diagnosticWriter(t)
    const file = join(directory, target)
    if (target === 'last-incident.txt')
      await fs.writeFile(
        file,
        JSON.stringify({
          kind: 'hibi-local-diagnostics',
          previous: 'retained',
        }),
      )
    const initial = await fs.readFile(file, 'utf8')
    state.onDelay = () => fs.unlink(join(directory, 'incident-next.txt'))
    if (target === 'run-state.txt') await sink.finish()
    else {
      sink.enqueue(
        JSON.stringify({ code: 'RENDERER_ERROR', stackStatus: 'unavailable' }),
      )
      await sink.flush()
    }
    assert.equal(sink.status.state, 'failed')
    assert.equal(state.attempts, 1)
    assert.equal(await fs.readFile(file, 'utf8'), initial)
  })

for (const target of ['last-incident.txt', 'run-state.txt'])
  for (const failures of [1, Infinity])
    test(`diagnostic ${target} handles bounded rename retries: ${failures}`, async (t) => {
      const { sink, state, directory } = await diagnosticWriter(t, { failures })
      if (target === 'last-incident.txt') {
        sink.enqueue(
          JSON.stringify({
            code: 'RENDERER_ERROR',
            stackStatus: 'unavailable',
          }),
        )
        await sink.flush()
      } else await sink.finish()
      assert.equal(state.attempts, Math.min(failures + 1, 6))
      assert.deepEqual(
        state.delays,
        [50, 100, 200, 400, 800].slice(0, failures),
      )
      const bytes = await fs.readFile(join(directory, target), 'utf8')
      if (Number.isFinite(failures)) {
        assert.equal(
          sink.status.state,
          target === 'run-state.txt' ? 'closed' : 'ready',
        )
        if (target === 'run-state.txt')
          assert.equal(JSON.parse(bytes).state, 'clean')
        else assert.match(bytes, /RENDERER_ERROR/)
      } else {
        assert.equal(sink.status.state, 'failed')
        assert.equal(sink.status.failures, 1)
        assert.doesNotMatch(
          sink.report(),
          /first rename failure|later rename failure/,
        )
        if (target === 'run-state.txt')
          assert.equal(JSON.parse(bytes).state, 'active')
        else assert.equal(bytes, '')
      }
    })

test('streamed text writes publish complete utf8 and roll back interrupted input', async (t) => {
  const { module } = await runtime({ platform: 'darwin', failures: 0 })
  const root = await fs.mkdtemp(join(tmpdir(), 'hibi-streamed-write-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const path = join(root, 'export.html')
  await fs.writeFile(path, 'original')
  const bytes = Buffer.from('streamed 日本語')
  async function* chunks() {
    for (const byte of bytes) yield Buffer.from([byte])
  }
  await module.exports.writeText(path, chunks())
  assert.equal(await fs.readFile(path, 'utf8'), 'streamed 日本語')
  async function* interrupted() {
    yield Buffer.from('partial')
    throw new Error('source closed')
  }
  await assert.rejects(
    module.exports.writeText(path, interrupted()),
    /source closed/,
  )
  assert.equal(await fs.readFile(path, 'utf8'), 'streamed 日本語')
  assert.deepEqual(await fs.readdir(root), ['export.html'])
})
