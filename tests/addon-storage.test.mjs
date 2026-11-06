import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createAddonStorage } from '../src/main/addon-storage.ts'
import { createAddonStorageScope } from '../src/renderer/src/addon-storage.ts'

const target = { workspaceId: 'a'.repeat(64), workspaceGeneration: 1 }

function testStorage(directory, isCurrent = () => true) {
  const service = createAddonStorage(directory, isCurrent, () => true)
  return {
    ...service,
    read: (request) => service.read(request, 0),
    write: (request) => service.write(request, 0),
  }
}

async function temporaryStorage(t, isCurrent = () => true) {
  const directory = await mkdtemp(join(tmpdir(), 'hibi-addon-storage-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return { directory, storage: testStorage(directory, isCurrent) }
}

test('addon storage isolates owners and scopes, persists acknowledged writes, and clears sessions', async (t) => {
  const { directory, storage } = await temporaryStorage(t)
  const global = {
    owner: 'documentation',
    scope: { kind: 'global' },
    key: 'options',
    version: 1,
  }
  const workspace = { ...global, scope: { kind: 'workspace', target } }
  const session = { ...global, scope: { kind: 'session' } }
  assert.deepEqual(await storage.read(global), {
    status: 'missing',
    revision: 0,
  })
  assert.deepEqual(
    await storage.write({
      ...global,
      baseRevision: 0,
      value: { title: 'one' },
    }),
    {
      status: 'saved',
      revision: 1,
      value: { title: 'one' },
    },
  )
  assert.equal((await storage.read(workspace)).status, 'missing')
  assert.equal(
    (await storage.read({ ...global, owner: 'other' })).status,
    'missing',
  )
  assert.deepEqual(await storage.read({ ...global, key: 'constructor' }), {
    status: 'missing',
    revision: 0,
  })
  assert.equal(
    (
      await storage.write({
        ...global,
        key: 'constructor',
        baseRevision: 0,
        value: true,
      })
    ).status,
    'saved',
  )
  assert.equal(
    (await storage.write({ ...workspace, baseRevision: 0, value: 'workspace' }))
      .status,
    'saved',
  )
  assert.equal(
    (await storage.write({ ...session, baseRevision: 0, value: 'temporary' }))
      .status,
    'saved',
  )
  await storage.clearSession('documentation')
  assert.equal((await storage.read(session)).status, 'missing')

  const restarted = testStorage(directory)
  assert.deepEqual(await restarted.read(global), {
    status: 'ready',
    revision: 1,
    value: { title: 'one' },
  })
  assert.deepEqual(await restarted.read(workspace), {
    status: 'ready',
    revision: 1,
    value: 'workspace',
  })
  assert.equal((await restarted.read(session)).status, 'missing')
  assert.equal(
    (
      await readFile(join(directory, 'global', 'documentation.json'), 'utf8')
    ).includes('one'),
    true,
  )
})

test('addon storage serializes competing writes and requires explicit older-schema migration', async (t) => {
  const { storage } = await temporaryStorage(t)
  const request = {
    owner: 'documentation',
    scope: { kind: 'global' },
    key: 'options',
    version: 1,
  }
  const results = await Promise.all([
    storage.write({ ...request, baseRevision: 0, value: 'first' }),
    storage.write({ ...request, baseRevision: 0, value: 'second' }),
  ])
  assert.deepEqual(
    results.map((result) => result.status),
    ['saved', 'conflict'],
  )
  assert.deepEqual(await storage.read({ ...request, version: 2 }), {
    status: 'version-mismatch',
    revision: 1,
    storedVersion: 1,
    value: 'first',
  })
  assert.equal(
    (
      await storage.write({
        ...request,
        version: 2,
        baseRevision: 1,
        value: 'migrated',
      })
    ).status,
    'version-mismatch',
  )
  assert.deepEqual(
    await storage.write({
      ...request,
      version: 2,
      baseRevision: 1,
      migrateFromVersion: 1,
      value: 'migrated',
    }),
    {
      status: 'saved',
      revision: 2,
      value: 'migrated',
    },
  )
  assert.deepEqual(await storage.read({ ...request, version: 2 }), {
    status: 'ready',
    revision: 2,
    value: 'migrated',
  })
  assert.equal((await storage.read(request)).status, 'version-mismatch')
})

test('corrupt and newer files stay recoverable; stale workspace targets cannot write', async (t) => {
  let generation = 1
  const { directory, storage } = await temporaryStorage(
    t,
    (value) => value.workspaceGeneration === generation,
  )
  const request = {
    owner: 'documentation',
    scope: { kind: 'global' },
    key: 'options',
    version: 1,
  }
  await mkdir(join(directory, 'global'), { recursive: true })
  const file = join(directory, 'global', 'documentation.json')
  await writeFile(file, JSON.stringify({ format: 2, entries: {} }))
  assert.deepEqual(await storage.read(request), {
    status: 'unavailable',
    reason: 'newer-format',
  })
  assert.deepEqual(
    await storage.write({ ...request, baseRevision: 0, value: 1 }),
    { status: 'unavailable', reason: 'newer-format' },
  )
  assert.equal(JSON.parse(await readFile(file, 'utf8')).format, 2)

  const corrupt = testStorage(directory)
  await writeFile(file, '{broken')
  assert.deepEqual(await corrupt.read(request), {
    status: 'unavailable',
    reason: 'corrupt',
  })
  const workspace = { ...request, scope: { kind: 'workspace', target } }
  generation = 2
  assert.deepEqual(
    await storage.write({ ...workspace, baseRevision: 0, value: 1 }),
    { status: 'unavailable', reason: 'stale-workspace' },
  )
  assert.equal((await storage.read(workspace)).status, 'unavailable')
})

test('addon storage rejects non-JSON and oversized values', async (t) => {
  const { storage } = await temporaryStorage(t)
  const request = {
    owner: 'documentation',
    scope: { kind: 'session' },
    key: 'options',
    version: 1,
    baseRevision: 0,
  }
  const cycle = {}
  cycle.self = cycle
  await assert.rejects(
    storage.write({ ...request, value: cycle }),
    /JSON value/,
  )
  await assert.rejects(
    storage.write({ ...request, value: 'x'.repeat(10 * 1024 * 1024) }),
    /too large/,
  )
  const sparse = [1, 2, 3]
  Reflect.deleteProperty(sparse, '1')
  await assert.rejects(
    storage.write({ ...request, value: sparse }),
    /JSON value/,
  )
  sparse.extra = 'offset key count'
  await assert.rejects(
    storage.write({ ...request, value: sparse }),
    /JSON value/,
  )
  await assert.rejects(
    storage.write({ ...request, owner: 'a'.repeat(81), value: true }),
    /owner/,
  )
  assert.equal((await storage.read(request)).status, 'missing')
})

test('malformed IPC requests fail before touching storage files', async (t) => {
  const { directory, storage } = await temporaryStorage(t)
  const base = {
    owner: 'documentation',
    scope: { kind: 'global' },
    key: 'options',
    version: 1,
  }
  for (const malformed of [
    null,
    [],
    {},
    { ...base, scope: null },
    { ...base, scope: [] },
    { ...base, scope: { kind: 'wrong' } },
    { ...base, scope: { kind: 'workspace', target: null } },
    { ...base, scope: { kind: 'workspace', target: [] } },
    { ...base, key: null },
    { ...base, version: '1' },
  ]) {
    await assert.rejects(storage.read(malformed), /Invalid/)
    await assert.rejects(storage.write(malformed), /Invalid/)
  }
  for (const malformed of [
    { ...base, baseRevision: null, value: true },
    { ...base, baseRevision: -1, value: true },
    { ...base, baseRevision: 0 },
  ])
    await assert.rejects(storage.write(malformed), /Invalid/)
  await assert.rejects(
    storage.write({ ...base, baseRevision: 0, value: undefined }),
    /JSON value/,
  )
  await assert.rejects(
    readFile(join(directory, 'global', 'documentation.json')),
    { code: 'ENOENT' },
  )
})

test('workspace switch during an asynchronous write leaves its old target untouched', async (t) => {
  let checks = 0
  const { directory, storage } = await temporaryStorage(t, () => ++checks < 4)
  const result = await storage.write({
    owner: 'documentation',
    scope: { kind: 'workspace', target },
    key: 'options',
    version: 1,
    baseRevision: 0,
    value: 'old workspace',
  })
  assert.deepEqual(result, { status: 'unavailable', reason: 'stale-workspace' })
  await assert.rejects(
    readFile(
      join(directory, 'workspace', target.workspaceId, 'documentation.json'),
    ),
    { code: 'ENOENT' },
  )
})

test('persistent writes preserve exact serialized bytes for changed and retained entries', async (t) => {
  const { directory } = await temporaryStorage(t)
  await mkdir(join(directory, 'global'), { recursive: true })
  const file = join(directory, 'global', 'documentation.json')
  const entries = {
    retained: {
      value: { text: 'quotes " and\nlines 🌱' },
      revision: 3,
      version: 1,
      extra: ['kept'],
    },
  }
  await writeFile(file, JSON.stringify({ format: 1, entries }))
  const storage = testStorage(directory)
  const request = {
    owner: 'documentation',
    scope: { kind: 'global' },
    key: 'tick',
    version: 1,
  }
  let revision = 0
  for (const value of [
    null,
    'escaped\ttext',
    { nested: [true, false, 1.5, 'é'] },
  ]) {
    const result = await storage.write({
      ...request,
      baseRevision: revision,
      value,
    })
    assert.equal(result.status, 'saved')
    revision++
    entries.tick = { version: 1, revision, value }
    assert.equal(
      await readFile(file, 'utf8'),
      JSON.stringify({ format: 1, entries }),
    )
  }
})

test('external and failed writes cannot suppress the next persistent serialization', async (t) => {
  const { directory, storage } = await temporaryStorage(t)
  const file = join(directory, 'global', 'documentation.json')
  const request = {
    owner: 'documentation',
    scope: { kind: 'global' },
    key: 'tick',
    version: 1,
  }
  await storage.write({ ...request, baseRevision: 0, value: 'initial' })
  await writeFile(file, 'external bytes')
  assert.equal(
    (
      await storage.write({
        ...request,
        baseRevision: 1,
        value: 'after external',
      })
    ).status,
    'saved',
  )
  const stable = await readFile(file, 'utf8')
  await rename(file, `${file}.saved`)
  await mkdir(file)
  await assert.rejects(
    storage.write({ ...request, baseRevision: 2, value: 'failed' }),
  )
  await rm(file, { recursive: true })
  await rename(`${file}.saved`, file)
  assert.equal(await readFile(file, 'utf8'), stable)
  assert.equal(
    (
      await storage.write({
        ...request,
        baseRevision: 2,
        value: 'after failure',
      })
    ).status,
    'saved',
  )
  assert.equal(
    await readFile(file, 'utf8'),
    JSON.stringify({
      format: 1,
      entries: { tick: { version: 1, revision: 3, value: 'after failure' } },
    }),
  )
})

for (const reason of ['revoke', 'uninstall'])
  test(`persistent publication rejects ${reason} after staging and preserves its prior bytes`, async (t) => {
    const { directory } = await temporaryStorage(t)
    let current = 0,
      checks = 0,
      interrupt = false
    const storage = createAddonStorage(
      directory,
      () => true,
      (_owner, generation) => {
        if (interrupt && ++checks === 4)
          current = reason === 'revoke' ? 1 : null
        return generation === current
      },
    )
    const request = {
      owner: 'documentation',
      scope: { kind: 'global' },
      key: 'tick',
      version: 1,
    }
    await storage.write({ ...request, baseRevision: 0, value: 'initial' }, 0)
    const file = join(directory, 'global', 'documentation.json')
    const initial = await readFile(file, 'utf8')
    interrupt = true
    const result = await storage.write(
      { ...request, baseRevision: 1, value: 'revoked' },
      0,
    )
    assert.deepEqual(result, {
      status: 'unavailable',
      reason: 'stale-activation',
    })
    assert.equal(checks, 4)
    assert.equal(await readFile(file, 'utf8'), initial)
    interrupt = false
    current = 1
    assert.equal(
      (
        await storage.write(
          { ...request, baseRevision: 1, value: 'next activation' },
          1,
        )
      ).status,
      'saved',
    )
    assert.equal(
      await readFile(file, 'utf8'),
      JSON.stringify({
        format: 1,
        entries: {
          tick: { version: 1, revision: 2, value: 'next activation' },
        },
      }),
    )
  })

test('full namespace rejection leaves serialized entries usable by the next write', async (t) => {
  const { directory, storage } = await temporaryStorage(t)
  const request = {
    owner: 'documentation',
    scope: { kind: 'global' },
    version: 1,
    baseRevision: 0,
  }
  for (const [key, size] of [
    ['first', 8],
    ['second', 7],
  ])
    assert.equal(
      (
        await storage.write({
          ...request,
          key,
          value: 'x'.repeat(size * 1024 * 1024),
        })
      ).status,
      'saved',
    )
  const file = join(directory, 'global', 'documentation.json')
  const initial = await readFile(file, 'utf8')
  await assert.rejects(
    storage.write({
      ...request,
      key: 'third',
      value: 'x'.repeat(2 * 1024 * 1024),
    }),
    /scope is full/,
  )
  assert.equal(await readFile(file, 'utf8'), initial)
  assert.equal(
    (await storage.write({ ...request, key: 'third', value: 'small' })).status,
    'saved',
  )
  const parsed = JSON.parse(initial)
  parsed.entries.third = { version: 1, revision: 1, value: 'small' }
  assert.equal(await readFile(file, 'utf8'), JSON.stringify(parsed))
})

test('a maximum stored revision refuses another write without damaging its file', async (t) => {
  const { directory } = await temporaryStorage(t)
  await mkdir(join(directory, 'global'), { recursive: true })
  const file = join(directory, 'global', 'documentation.json')
  const stored = JSON.stringify({
    format: 1,
    entries: {
      options: { version: 1, revision: Number.MAX_SAFE_INTEGER, value: 'old' },
    },
  })
  await writeFile(file, stored)
  const storage = testStorage(directory)
  await assert.rejects(
    storage.write({
      owner: 'documentation',
      scope: { kind: 'global' },
      key: 'options',
      version: 1,
      baseRevision: Number.MAX_SAFE_INTEGER,
      value: 'new',
    }),
    /revision limit/,
  )
  assert.equal(await readFile(file, 'utf8'), stored)
})

test('a queued old activation cannot restore a cleared session after re-enable', async (t) => {
  const { directory } = await temporaryStorage(t)
  let generation = 0
  const storage = createAddonStorage(
    directory,
    () => true,
    (_owner, captured) => captured === generation,
  )
  const request = {
    owner: 'documentation',
    scope: { kind: 'session' },
    key: 'draft',
    version: 1,
  }
  assert.equal(
    (await storage.write({ ...request, baseRevision: 0, value: 'before' }, 0))
      .status,
    'saved',
  )
  generation = -1
  const clearing = storage.clearSession('documentation')
  const stale = storage.write({ ...request, baseRevision: 0, value: 'old' }, 0)
  generation = 1
  const fresh = storage.write(
    { ...request, baseRevision: 0, value: 'fresh' },
    1,
  )
  await clearing
  assert.deepEqual(await stale, {
    status: 'unavailable',
    reason: 'stale-activation',
  })
  assert.equal((await fresh).status, 'saved')
  assert.deepEqual(await storage.read(request, 1), {
    status: 'ready',
    revision: 1,
    value: 'fresh',
  })
  assert.deepEqual(await storage.read(request, 0), {
    status: 'unavailable',
    reason: 'stale-activation',
  })
})

test('deactivation waits for pending session writes and renderer subscriptions stop', async (t) => {
  const { storage } = await temporaryStorage(t)
  const errors = t.mock.method(console, 'error', () => {})
  const callbacks = new Set()
  const scope = createAddonStorageScope('documentation', () => true, {
    readAddonStorage: (request) => storage.read(request),
    writeAddonStorage: (request) => storage.write(request),
    onAddonStorageChanged(callback) {
      callbacks.add(callback)
      return () => callbacks.delete(callback)
    },
  })
  const release = storage.subscribe((change) => {
    for (const callback of callbacks) callback(change)
  })
  t.after(release)
  assert.equal(callbacks.size, 0)
  const handle = await scope.api.session('draft', 1)
  assert.equal(callbacks.size, 1)
  let notifications = 0
  handle.subscribe(() => {
    throw new Error('bad subscriber')
  })
  handle.subscribe(() => notifications++)
  const pending = handle.set('pending')
  await storage.clearSession('documentation')
  assert.equal((await pending).status, 'saved')
  assert.deepEqual(
    await storage.read({
      owner: 'documentation',
      scope: { kind: 'session' },
      key: 'draft',
      version: 1,
    }),
    { status: 'missing', revision: 0 },
  )
  assert.equal(handle.snapshot().status, 'missing')
  scope.dispose()
  assert.deepEqual(handle.snapshot(), {
    status: 'unavailable',
    reason: 'stale-activation',
  })
  assert.equal(callbacks.size, 0)
  await assert.rejects(handle.set('late'), /Enable this addon/)
  assert.equal(notifications, 2)
  // The subscriber that throws is reported at each change, and the next still runs.
  assert.deepEqual(
    errors.mock.calls.map(({ arguments: [text, error] }) => [
      text,
      error.message,
    ]),
    Array(2).fill([
      'Could not notify addon storage subscriber:',
      'bad subscriber',
    ]),
  )
})

test('a renderer handle applies its own write once, however late its notice, and still takes newer and other-version changes', async (t) => {
  const { storage } = await temporaryStorage(t)
  const held = []
  let reply = null
  const scope = createAddonStorageScope('documentation', () => true, {
    readAddonStorage: (request) => storage.read(request),
    writeAddonStorage: async (request) => {
      await reply?.promise
      return storage.write(request)
    },
    onAddonStorageChanged(callback) {
      // Notices arrive after the write's reply, as they can between processes.
      return storage.subscribe((change) => held.push(() => callback(change)))
    },
  })
  t.after(() => scope.dispose())
  const handle = await scope.api.global('options', 1)
  let notifications = 0
  handle.subscribe(() => notifications++)
  const deliver = () => {
    for (const notice of held.splice(0)) notice()
  }
  const key = {
    owner: 'documentation',
    scope: { kind: 'global' },
    key: 'options',
  }
  assert.equal((await handle.set({ size: 1 })).status, 'saved')
  assert.equal(notifications, 1)
  // The first write's late notice lands while the next write waits for its
  // reply; that reply still applies before its own notice.
  reply = Promise.withResolvers()
  const second = handle.set({ size: 2 })
  deliver()
  assert.equal(notifications, 1)
  reply.resolve()
  reply = null
  assert.equal((await second).status, 'saved')
  assert.deepEqual(handle.snapshot(), {
    status: 'ready',
    revision: 2,
    value: { size: 2 },
  })
  deliver()
  assert.equal(notifications, 2)
  // Another writer's equal value is still a newer revision.
  await storage.write({
    ...key,
    version: 1,
    baseRevision: 2,
    value: { size: 2 },
  })
  deliver()
  assert.equal(notifications, 3)
  assert.equal(handle.snapshot().revision, 3)
  // A newer schema's write is a mismatch, not this handle's write.
  assert.equal(
    (
      await storage.write({
        ...key,
        version: 2,
        migrateFromVersion: 1,
        baseRevision: 3,
        value: { size: 2 },
      })
    ).status,
    'saved',
  )
  deliver()
  assert.equal(notifications, 4)
  assert.equal(handle.snapshot().status, 'version-mismatch')
})
