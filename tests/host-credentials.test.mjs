import assert from 'node:assert/strict'
import {
  lstat,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { HostCredentials } from '../src/main/host-credentials.ts'

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function mockStorage(overrides = {}) {
  const secrets = new Map()
  let sequence = 0
  const encrypt = (secret) => {
    const ciphertext = Buffer.from(`protected-${++sequence}`)
    secrets.set(ciphertext.toString('hex'), secret)
    return ciphertext
  }
  const decrypt = (ciphertext) => {
    const secret = secrets.get(ciphertext.toString('hex'))
    if (secret === undefined) throw new Error('invalid ciphertext')
    return secret
  }
  return {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (secret) => encrypt(secret),
    decryptStringAsync: async (ciphertext) => ({
      result: decrypt(ciphertext),
      shouldReEncrypt: false,
    }),
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: encrypt,
    decryptString: decrypt,
    ...overrides,
  }
}

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'hibi-host-credentials-'))
  const owners = new Map([
    ['demo', { addonId: 'demo', activationGeneration: 1 }],
    ['other', { addonId: 'other', activationGeneration: 1 }],
  ])
  const windowKey = {}
  const windows = new Set([windowKey])
  const storage = options.storage ?? mockStorage()
  const makeHost = () =>
    new HostCredentials({
      directory,
      storage,
      platform: options.platform ?? 'darwin',
      storageTimeoutMs: options.storageTimeoutMs,
      renameFile: options.renameFile,
      currentOwner: (id) => owners.get(id) ?? null,
      isWindowLive: (key) => windows.has(key),
    })
  const host = makeHost()
  t.after(async () => {
    host.dispose()
    await rm(directory, { recursive: true, force: true })
  })
  return { directory, host, makeHost, owners, storage, windowKey, windows }
}

function failure(result, code) {
  assert.equal(result.ok, false, JSON.stringify(result))
  assert.equal(result.code, code)
}

function success(result) {
  assert.equal(result.ok, true, JSON.stringify(result))
  return result.value
}

async function within(promise, ms = 2000) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('operation hung')), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function filesIn(directory) {
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
}

test('persistent secret stays encrypted on disk and status never returns it', async (t) => {
  const { directory, host, makeHost, windowKey } = await fixture(t)
  const secret = 'synthetic-private-token-123'
  const stored = await host.store('demo', windowKey, {
    key: 'api-token',
    secret,
    mode: 'persistent',
  })
  success(stored)
  assert.equal(JSON.stringify(stored).includes(secret), false)
  const status = success(
    await host.status('demo', windowKey, { key: 'api-token' }),
  )
  assert.equal(status.stored, 'persistent')
  assert.equal(status.persistence, 'protected')
  assert.equal(JSON.stringify(status).includes(secret), false)

  const files = await filesIn(directory)
  assert.equal(files.length, 1)
  const raw = await readFile(files[0], 'utf8')
  assert.equal(raw.includes(secret), false)
  if (process.platform !== 'win32')
    assert.equal((await lstat(files[0])).mode & 0o077, 0)
  const restarted = makeHost()
  t.after(() => restarted.dispose())
  assert.equal(
    success(await restarted.status('demo', windowKey, { key: 'api-token' }))
      .stored,
    'persistent',
  )
  const applied = []
  success(
    await restarted.applyForApprovedRequest(
      { addonId: 'demo', activationGeneration: 1 },
      windowKey,
      'api-token',
      (value) => applied.push(value),
    ),
  )
  assert.deepEqual(applied, [secret])
})

test('linux basic_text and unavailable protected backends refuse persistent writes', async (t) => {
  const storage = mockStorage({ getSelectedStorageBackend: () => 'basic_text' })
  const { host, directory, windowKey } = await fixture(t, {
    platform: 'linux',
    storage,
  })
  failure(
    await host.store('demo', windowKey, {
      key: 'token',
      secret: 'synthetic-secret',
      mode: 'persistent',
    }),
    'unprotected',
  )
  assert.deepEqual(await filesIn(directory), [])

  const locked = mockStorage({
    isAsyncEncryptionAvailable: async () => false,
    isEncryptionAvailable: () => false,
    getSelectedStorageBackend: () => 'unknown',
  })
  const second = await fixture(t, { platform: 'darwin', storage: locked })
  failure(
    await second.host.store('demo', second.windowKey, {
      key: 'token',
      secret: 'synthetic-secret',
      mode: 'persistent',
    }),
    'locked-or-unavailable',
  )
  assert.deepEqual(await filesIn(second.directory), [])
})

test('linux protected storage uses sync backend while mac uses async backend', async (t) => {
  const linuxBase = mockStorage()
  const linux = await fixture(t, {
    platform: 'linux',
    storage: {
      ...linuxBase,
      encryptStringAsync: async () =>
        assert.fail('linux must use sync backend'),
      decryptStringAsync: async () =>
        assert.fail('linux must use sync backend'),
    },
  })
  success(
    await linux.host.store('demo', linux.windowKey, {
      key: 'token',
      secret: 'synthetic-secret',
      mode: 'persistent',
    }),
  )
  const linuxApplied = []
  success(
    await linux.host.applyForApprovedRequest(
      linux.owners.get('demo'),
      linux.windowKey,
      'token',
      (secret) => linuxApplied.push(secret),
    ),
  )
  assert.deepEqual(linuxApplied, ['synthetic-secret'])

  const macBase = mockStorage()
  const mac = await fixture(t, {
    platform: 'darwin',
    storage: {
      ...macBase,
      encryptString: () => assert.fail('mac must use async backend'),
      decryptString: () => assert.fail('mac must use async backend'),
    },
  })
  success(
    await mac.host.store('demo', mac.windowKey, {
      key: 'token',
      secret: 'synthetic-secret',
      mode: 'persistent',
    }),
  )
  const macApplied = []
  success(
    await mac.host.applyForApprovedRequest(
      mac.owners.get('demo'),
      mac.windowKey,
      'token',
      (secret) => macApplied.push(secret),
    ),
  )
  assert.deepEqual(macApplied, ['synthetic-secret'])
})

test('explicit session secret stays in memory and expires with window and owner', async (t) => {
  const { directory, host, owners, windowKey, windows } = await fixture(t, {
    platform: 'linux',
    storage: mockStorage({ getSelectedStorageBackend: () => 'basic_text' }),
  })
  success(
    await host.store('demo', windowKey, {
      key: 'token',
      secret: 'synthetic-secret',
      mode: 'session',
    }),
  )
  assert.equal(
    success(await host.status('demo', windowKey, { key: 'token' })).stored,
    'session',
  )
  assert.deepEqual(await filesIn(directory), [])
  host.stopWindow(windowKey)
  const nextWindow = {}
  windows.add(nextWindow)
  assert.equal(
    success(await host.status('demo', nextWindow, { key: 'token' })).stored,
    'missing',
  )

  success(
    await host.store('demo', nextWindow, {
      key: 'token',
      secret: 'synthetic-secret',
      mode: 'session',
    }),
  )
  host.stopOwner(owners.get('demo'))
  owners.set('demo', { addonId: 'demo', activationGeneration: 2 })
  assert.equal(
    success(await host.status('demo', nextWindow, { key: 'token' })).stored,
    'missing',
  )
})

test('another live window cannot read or erase a session secret', async (t) => {
  const { host, owners, windowKey, windows } = await fixture(t)
  success(
    await host.store('demo', windowKey, {
      key: 'token',
      secret: 'synthetic-secret',
      mode: 'session',
    }),
  )
  const otherWindow = {}
  windows.add(otherWindow)
  assert.equal(
    success(await host.status('demo', otherWindow, { key: 'token' })).stored,
    'missing',
  )
  failure(
    await host.applyForApprovedRequest(
      owners.get('demo'),
      otherWindow,
      'token',
      () => assert.fail('another window cannot use this secret'),
    ),
    'not-found',
  )
  assert.equal(
    success(await host.status('demo', windowKey, { key: 'token' })).stored,
    'session',
  )
  assert.deepEqual(await host.remove('demo', otherWindow, { key: 'token' }), {
    ok: true,
    value: { removed: false },
  })
  assert.equal(
    success(await host.status('demo', windowKey, { key: 'token' })).stored,
    'session',
  )
  success(
    await host.store('demo', otherWindow, {
      key: 'token',
      secret: 'other-synthetic-secret',
      mode: 'session',
    }),
  )
  const seen = []
  success(
    await host.applyForApprovedRequest(
      owners.get('demo'),
      windowKey,
      'token',
      (secret) => {
        seen.push(secret)
      },
    ),
  )
  success(
    await host.applyForApprovedRequest(
      owners.get('demo'),
      otherWindow,
      'token',
      (secret) => {
        seen.push(secret)
      },
    ),
  )
  assert.deepEqual(seen, ['synthetic-secret', 'other-synthetic-secret'])
  assert.deepEqual(await host.remove('demo', otherWindow, { key: 'token' }), {
    ok: true,
    value: { removed: true },
  })
  assert.equal(
    success(await host.status('demo', windowKey, { key: 'token' })).stored,
    'session',
  )
})

test('corrupt or newer vault files are preserved and never overwritten', async (t) => {
  const { host, directory, windowKey } = await fixture(t)
  const file = join(directory, 'demo.json')
  for (const raw of [
    '{not-json',
    JSON.stringify({ version: 999, entries: [] }),
  ]) {
    await writeFile(file, raw, { mode: 0o600 })
    failure(await host.status('demo', windowKey, { key: 'token' }), 'corrupt')
    failure(
      await host.store('demo', windowKey, {
        key: 'token',
        secret: 'synthetic-secret',
        mode: 'persistent',
      }),
      'corrupt',
    )
    assert.equal(await readFile(file, 'utf8'), raw)
  }
})

test('remove clears session and persistent credentials without returning plaintext', async (t) => {
  const { host, windowKey } = await fixture(t)
  for (const mode of ['session', 'persistent']) {
    success(
      await host.store('demo', windowKey, {
        key: 'token',
        secret: `synthetic-${mode}-secret`,
        mode,
      }),
    )
    assert.deepEqual(await host.remove('demo', windowKey, { key: 'token' }), {
      ok: true,
      value: { removed: true },
    })
    assert.equal(
      success(await host.status('demo', windowKey, { key: 'token' })).stored,
      'missing',
    )
  }
  assert.deepEqual(await host.remove('demo', windowKey, { key: 'token' }), {
    ok: true,
    value: { removed: false },
  })
})

test('owner or window invalidation during encryption cannot publish secret', async (t) => {
  for (const action of ['owner', 'window']) {
    const started = deferred()
    const release = deferred()
    const base = mockStorage()
    const storage = {
      ...base,
      encryptStringAsync: async (secret) => {
        started.resolve()
        await release.promise
        return base.encryptStringAsync(secret)
      },
    }
    const { host, owners, windows, windowKey, directory } = await fixture(t, {
      storage,
    })
    const pending = host.store('demo', windowKey, {
      key: 'token',
      secret: 'synthetic-secret',
      mode: 'persistent',
    })
    await started.promise
    if (action === 'owner') {
      const oldOwner = owners.get('demo')
      owners.set('demo', { addonId: 'demo', activationGeneration: 2 })
      host.stopOwner(oldOwner)
    } else {
      windows.delete(windowKey)
      host.stopWindow(windowKey)
    }
    release.resolve()
    failure(await pending, 'stale')
    assert.deepEqual(await filesIn(directory), [])
  }
})

test('approved use checks owner lifetime after async decrypt and never calls sink stale', async (t) => {
  const started = deferred()
  const release = deferred()
  const base = mockStorage()
  const storage = {
    ...base,
    decryptStringAsync: async (ciphertext) => {
      started.resolve()
      await release.promise
      return base.decryptStringAsync(ciphertext)
    },
  }
  const { host, owners, windowKey } = await fixture(t, { storage })
  success(
    await host.store('demo', windowKey, {
      key: 'token',
      secret: 'synthetic-secret',
      mode: 'persistent',
    }),
  )
  const owner = owners.get('demo')
  const applied = []
  const pending = host.applyForApprovedRequest(
    owner,
    windowKey,
    'token',
    (secret) => applied.push(secret),
  )
  await started.promise
  owners.set('demo', { addonId: 'demo', activationGeneration: 2 })
  host.stopOwner(owner)
  release.resolve()
  failure(await pending, 'stale')
  assert.deepEqual(applied, [])
})

test('invalid keys and oversized secrets fail before storage; owners are isolated', async (t) => {
  const { host, windowKey, directory } = await fixture(t)
  for (const request of [
    null,
    {},
    { key: '', secret: 'x', mode: 'persistent' },
    { key: '../escape', secret: 'x', mode: 'persistent' },
    { key: 'x'.repeat(1000), secret: 'x', mode: 'persistent' },
    { key: 'token', secret: 'x'.repeat(1024 * 1024), mode: 'persistent' },
    { key: 'token', secret: 'x', mode: 'other' },
  ])
    failure(await host.store('demo', windowKey, request), 'invalid-request')
  assert.deepEqual(await filesIn(directory), [])

  success(
    await host.store('demo', windowKey, {
      key: 'token',
      secret: 'synthetic-secret',
      mode: 'session',
    }),
  )
  assert.equal(
    success(await host.status('other', windowKey, { key: 'token' })).stored,
    'missing',
  )
  failure(
    await host.applyForApprovedRequest(
      { addonId: 'other', activationGeneration: 1 },
      windowKey,
      'token',
      () => assert.fail('another owner cannot use this secret'),
    ),
    'not-found',
  )
})

test('parallel persistent writes leave one readable, private credential file', async (t) => {
  const { host, windowKey, directory } = await fixture(t)
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      host.store('demo', windowKey, {
        key: 'token',
        secret: `synthetic-secret-${index}`,
        mode: 'persistent',
      }),
    ),
  )
  assert.equal(
    results.some((result) => result.ok),
    true,
  )
  assert.equal(
    success(await host.status('demo', windowKey, { key: 'token' })).stored,
    'persistent',
  )
  const files = await filesIn(directory)
  assert.equal(files.length, 1)
  if (process.platform !== 'win32')
    assert.equal((await lstat(files[0])).mode & 0o077, 0)
  const raw = await readFile(files[0], 'utf8')
  assert.equal(raw.includes('synthetic-secret'), false)
  const applied = []
  success(
    await host.applyForApprovedRequest(
      { addonId: 'demo', activationGeneration: 1 },
      windowKey,
      'token',
      (secret) => applied.push(secret),
    ),
  )
  assert.equal(/^synthetic-secret-[0-7]$/.test(applied[0]), true)
})

test('never-settling safeStorage availability times out with active requests bounded', async (t) => {
  let availabilityCalls = 0
  const storage = mockStorage({
    isAsyncEncryptionAvailable: () => {
      availabilityCalls++
      return new Promise(() => {})
    },
  })
  const { host, windowKey, directory } = await fixture(t, {
    storage,
    storageTimeoutMs: 25,
  })
  const pending = ['demo', 'demo', 'other', 'other'].map((owner, index) =>
    host.store(owner, windowKey, {
      key: `token-${index}`,
      secret: 'synthetic-secret',
      mode: 'persistent',
    }),
  )
  failure(
    await host.store('other', windowKey, {
      key: 'extra',
      secret: 'synthetic-secret',
      mode: 'persistent',
    }),
    'busy',
  )
  for (const result of await within(Promise.all(pending)))
    failure(result, 'locked-or-unavailable')
  assert.equal(availabilityCalls, 4)
  failure(
    await host.store('demo', windowKey, {
      key: 'later',
      secret: 'synthetic-secret',
      mode: 'persistent',
    }),
    'busy',
  )
  assert.equal(availabilityCalls, 4)
  assert.deepEqual(await filesIn(directory), [])
})

test('disabling addon releases active and queued secret work before backend settles', async (t) => {
  const started = deferred()
  const release = deferred()
  let encryptCalls = 0
  const storage = mockStorage({
    encryptStringAsync: () => {
      encryptCalls++
      started.resolve()
      return release.promise
    },
  })
  const { host, owners, windowKey, directory } = await fixture(t, {
    storage,
    storageTimeoutMs: 5000,
  })
  const active = host.store('demo', windowKey, {
    key: 'first',
    secret: 'synthetic-secret',
    mode: 'persistent',
  })
  await started.promise
  const queued = host.store('demo', windowKey, {
    key: 'second',
    secret: 'synthetic-other-secret',
    mode: 'persistent',
  })
  const owner = owners.get('demo')
  host.stopOwner(owner)
  owners.set('demo', { addonId: 'demo', activationGeneration: 2 })
  failure(await within(active), 'stale')
  failure(await within(queued), 'stale')
  const late = Buffer.from('synthetic-late-ciphertext')
  release.resolve(late)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(encryptCalls, 1)
  assert.equal(
    late.every((byte) => byte === 0),
    true,
  )
  assert.deepEqual(await filesIn(directory), [])
})

test('late encrypted buffer is zeroed after backend timeout', async (t) => {
  const started = deferred()
  const release = deferred()
  const storage = mockStorage({
    encryptStringAsync: () => {
      started.resolve()
      return release.promise
    },
  })
  const { host, windowKey, directory } = await fixture(t, {
    storage,
    storageTimeoutMs: 25,
  })
  const pending = host.store('demo', windowKey, {
    key: 'token',
    secret: 'synthetic-secret',
    mode: 'persistent',
  })
  await started.promise
  failure(await within(pending), 'locked-or-unavailable')
  const late = Buffer.from('synthetic-ciphertext')
  release.resolve(late)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(
    late.every((byte) => byte === 0),
    true,
  )
  assert.deepEqual(await filesIn(directory), [])
})

test('one hung addon does not block another addon vault', async (t) => {
  const started = deferred()
  const base = mockStorage()
  const storage = {
    ...base,
    encryptStringAsync: (secret) => {
      if (secret === 'demo-secret') {
        started.resolve()
        return new Promise(() => {})
      }
      return base.encryptStringAsync(secret)
    },
  }
  const { host, owners, windowKey } = await fixture(t, {
    storage,
    storageTimeoutMs: 5000,
  })
  const hung = host.store('demo', windowKey, {
    key: 'token',
    secret: 'demo-secret',
    mode: 'persistent',
  })
  await started.promise
  success(
    await within(
      host.store('other', windowKey, {
        key: 'token',
        secret: 'other-secret',
        mode: 'persistent',
      }),
    ),
  )
  assert.equal(
    success(await host.status('other', windowKey, { key: 'token' })).stored,
    'persistent',
  )
  host.stopOwner(owners.get('demo'))
  failure(await within(hung), 'stale')
})

test('never-settling decrypt cannot invoke approved sink', async (t) => {
  const storage = mockStorage({
    decryptStringAsync: () => new Promise(() => {}),
  })
  const { host, owners, windowKey } = await fixture(t, {
    storage,
    storageTimeoutMs: 25,
  })
  success(
    await host.store('demo', windowKey, {
      key: 'token',
      secret: 'synthetic-secret',
      mode: 'persistent',
    }),
  )
  failure(
    await within(
      host.applyForApprovedRequest(owners.get('demo'), windowKey, 'token', () =>
        assert.fail('timed-out decrypt cannot use secret'),
      ),
    ),
    'locked-or-unavailable',
  )
})

test('revocation during atomic rename waits to report committed outcome', async (t) => {
  const entered = deferred()
  const release = deferred()
  const { host, owners, windowKey, directory } = await fixture(t, {
    renameFile: async (source, destination) => {
      entered.resolve()
      await release.promise
      await rename(source, destination)
    },
  })
  const pending = host.store('demo', windowKey, {
    key: 'token',
    secret: 'synthetic-secret',
    mode: 'persistent',
  })
  await within(entered.promise)
  let settled = false
  void pending.then(() => {
    settled = true
  })
  const owner = owners.get('demo')
  host.stopOwner(owner)
  owners.set('demo', { addonId: 'demo', activationGeneration: 2 })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(settled, false)
  release.resolve()
  const result = await within(pending)
  failure(result, 'stale')
  assert.equal(result.committed, true)
  const files = await filesIn(directory)
  assert.equal(files.length, 1)
  assert.equal(
    (await readFile(files[0], 'utf8')).includes('synthetic-secret'),
    false,
  )
})
