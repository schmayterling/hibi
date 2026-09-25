import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createAddonStorage } from '../src/main/addon-storage.ts'
import { createAddonStorageScope } from '../src/renderer/src/addon-storage.ts'

const target = { workspaceId: 'a'.repeat(64), workspaceGeneration: 1 }

async function temporaryStorage(t, isCurrent = () => true) {
  const directory = await mkdtemp(join(tmpdir(), 'hibi-addon-storage-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return { directory, storage: createAddonStorage(directory, isCurrent) }
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

  const restarted = createAddonStorage(directory, () => true)
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

  const corrupt = createAddonStorage(directory, () => true)
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
  assert.equal((await storage.read(request)).status, 'missing')
})

test('deactivation waits for pending session writes and renderer subscriptions stop', async (t) => {
  const { storage } = await temporaryStorage(t)
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
  const handle = await scope.api.session('draft', 1)
  let notifications = 0
  handle.subscribe(() => notifications++)
  const pending = handle.set('pending')
  await storage.clearSession('documentation')
  await pending
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
  assert.equal(callbacks.size, 0)
  await assert.rejects(handle.set('late'), /Enable this addon/)
  assert.equal(notifications, 2)
})
