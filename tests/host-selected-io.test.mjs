import assert from 'node:assert/strict'
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { HostSelectedIoService } from '../src/main/host-selected-io.ts'
import {
  HOST_SELECTED_IO_MAX_BYTES,
  HOST_SELECTED_IO_TTL_MS,
} from '../src/shared/host-selected-io.ts'

const files = { lstat, realpath, open, link, unlink }
const owner = (addonId, activationGeneration = 1) => ({
  addonId,
  activationGeneration,
})
const window = () => ({
  isDestroyed: () => false,
  webContents: { isDestroyed: () => false },
})
const deferred = () => {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const expectFailure = (result, code) => {
  assert.equal(result.ok, false, JSON.stringify(result))
  assert.equal(result.code, code)
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'hibi-host-selected-io-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = await realpath(root)
  const input = join(directory, 'input.bin')
  const output = join(directory, 'output.bin')
  await writeFile(input, Buffer.from([0, 1, 2, 255]))
  return { directory, input, output }
}

function serviceFor(input, output, overrides = {}) {
  const owners = new Map([
    ['demo', owner('demo')],
    ['other', owner('other')],
  ])
  let now = 0
  const service = new HostSelectedIoService((id) => owners.get(id) ?? null, {
    selectImport: async () => input,
    selectExport: async () => output,
    isOpenDocument: () => false,
    now: () => now,
    files,
    ...overrides,
  })
  return { service, owners, advance: (ms) => (now += ms) }
}

async function importHandle(service, target, addonId = 'demo') {
  const result = await service.selectImport(target, addonId)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.ok(result.value?.handle)
  return result.value.handle
}

async function exportHandle(service, target, addonId = 'demo') {
  const result = await service.selectExport(target, addonId, {
    suggestedName: 'output.bin',
    extension: 'bin',
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.ok(result.value?.handle)
  return result.value.handle
}

test('dialog cancellation creates no grant; import bytes are one-use and owner scoped', async (t) => {
  const { input, output } = await fixture(t)
  let selection = null
  const { service } = serviceFor(input, output, {
    selectImport: async () => selection,
    selectExport: async () => null,
  })
  const target = window()
  assert.deepEqual(await service.selectImport(target, 'demo'), {
    ok: true,
    value: null,
  })
  assert.deepEqual(
    await service.selectExport(target, 'demo', { suggestedName: 'new.bin' }),
    { ok: true, value: null },
  )
  selection = input
  const handle = await importHandle(service, target)
  assert.equal(handle.includes(input), false)
  expectFailure(await service.readImport(target, 'other', handle), 'not-found')
  expectFailure(await service.readImport(window(), 'demo', handle), 'not-found')
  expectFailure(
    await service.writeExport(target, 'demo', handle, new Uint8Array([3])),
    'not-found',
  )
  assert.deepEqual(await service.readImport(target, 'demo', handle), {
    ok: true,
    value: Buffer.from([0, 1, 2, 255]),
  })
  expectFailure(await service.readImport(target, 'demo', handle), 'not-found')
  service.clear()
})

test('owner restart, expiry, replacement, and file limits invalidate imports', async (t) => {
  const { directory, input, output } = await fixture(t)
  const { service, owners, advance } = serviceFor(input, output)
  const target = window()
  let handle = await importHandle(service, target)
  owners.set('demo', owner('demo', 2))
  expectFailure(await service.readImport(target, 'demo', handle), 'stale')
  handle = await importHandle(service, target)
  advance(HOST_SELECTED_IO_TTL_MS + 1)
  expectFailure(await service.readImport(target, 'demo', handle), 'stale')

  handle = await importHandle(service, target)
  const replacement = join(directory, 'replacement.bin')
  await writeFile(replacement, Buffer.from([9]))
  await rename(replacement, input)
  expectFailure(await service.readImport(target, 'demo', handle), 'stale')
  service.clear()

  const oversized = await open(input, 'w')
  await oversized.truncate(HOST_SELECTED_IO_MAX_BYTES + 1)
  await oversized.close()
  const limited = serviceFor(input, output)
  expectFailure(
    await limited.service.selectImport(target, 'demo'),
    'limit-exceeded',
  )
  limited.service.clear()

  if (process.platform !== 'win32') {
    const linked = join(directory, 'linked.bin')
    await symlink(input, linked)
    const symbolic = serviceFor(linked, output)
    expectFailure(
      await symbolic.service.selectImport(target, 'demo'),
      'unsupported',
    )
    symbolic.service.clear()
  }
})

test('cancellation during an import read delivers no bytes', async (t) => {
  const { input, output } = await fixture(t)
  const entered = deferred(),
    release = deferred()
  const { service } = serviceFor(input, output, {
    files: {
      ...files,
      async open(path, ...args) {
        const file = await open(path, ...args)
        if (path !== input) return file
        return {
          stat: (...values) => file.stat(...values),
          close: () => file.close(),
          async read(...values) {
            entered.resolve()
            await release.promise
            return file.read(...values)
          },
        }
      },
    },
  })
  const target = window()
  const handle = await importHandle(service, target)
  const pending = service.readImport(target, 'demo', handle)
  await entered.promise
  assert.deepEqual(await service.cancel(target, 'demo', handle), {
    ok: true,
    value: null,
  })
  release.resolve()
  expectFailure(await pending, 'cancelled')
  expectFailure(await service.readImport(target, 'demo', handle), 'not-found')
  service.clear()
})

test('pending dialog is bounded and owner revocation discards its late selection', async (t) => {
  const { input, output } = await fixture(t)
  const entered = deferred(),
    release = deferred()
  const { service, owners } = serviceFor(input, output, {
    selectImport: async () => {
      entered.resolve()
      await release.promise
      return input
    },
  })
  const target = window()
  const pending = service.selectImport(target, 'demo')
  await entered.promise
  expectFailure(
    await service.selectExport(target, 'demo', { suggestedName: 'output.bin' }),
    'busy',
  )
  owners.delete('demo')
  service.revokeAddon('demo')
  release.resolve()
  expectFailure(await pending, 'stale')
  service.clear()
})

test('export creates one atomic file and never replaces existing bytes', async (t) => {
  const { input, output } = await fixture(t)
  const { service } = serviceFor(input, output)
  const target = window()
  const handle = await exportHandle(service, target)
  expectFailure(
    await service.writeExport(
      target,
      'demo',
      handle,
      new Uint8Array(HOST_SELECTED_IO_MAX_BYTES + 1),
    ),
    'limit-exceeded',
  )
  const bytes = new Uint8Array([4, 5, 6])
  const written = await service.writeExport(target, 'demo', handle, bytes)
  assert.equal(written.ok, true, JSON.stringify(written))
  assert.deepEqual(written.value.bytes, 3)
  assert.equal(written.value.atomicVisibility, true)
  assert.deepEqual(await readFile(output), Buffer.from([4, 5, 6]))
  assert.deepEqual(bytes, new Uint8Array([4, 5, 6]))
  expectFailure(
    await service.writeExport(target, 'demo', handle, bytes),
    'not-found',
  )
  expectFailure(
    await service.selectExport(target, 'demo', { suggestedName: 'output.bin' }),
    'conflict',
  )
  assert.deepEqual(await readFile(output), Buffer.from([4, 5, 6]))
  service.clear()
})

test('external create, open-document conflict, and stale parent preserve export target', async (t) => {
  const { directory, input, output } = await fixture(t)
  const target = window()
  const external = serviceFor(input, output)
  const handle = await exportHandle(external.service, target)
  await writeFile(output, 'external')
  expectFailure(
    await external.service.writeExport(
      target,
      'demo',
      handle,
      new Uint8Array([1]),
    ),
    'conflict',
  )
  assert.equal(await readFile(output, 'utf8'), 'external')
  external.service.clear()

  const opened = serviceFor(input, join(directory, 'open.bin'), {
    isOpenDocument: () => true,
  })
  expectFailure(
    await opened.service.selectExport(target, 'demo', {
      suggestedName: 'open.bin',
    }),
    'conflict',
  )
  opened.service.clear()

  const folder = join(directory, 'subfolder')
  await mkdir(folder)
  const chosen = join(folder, 'new.bin')
  const stale = serviceFor(input, chosen)
  const staleHandle = await exportHandle(stale.service, target)
  await rename(folder, join(directory, 'old-subfolder'))
  await mkdir(folder)
  expectFailure(
    await stale.service.writeExport(
      target,
      'demo',
      staleHandle,
      new Uint8Array([2]),
    ),
    'stale',
  )
  await assert.rejects(readFile(chosen), { code: 'ENOENT' })
  stale.service.clear()
})

test('cancellation during staged export leaves no output or temporary file', async (t) => {
  const { directory, input, output } = await fixture(t)
  const entered = deferred(),
    release = deferred()
  const { service } = serviceFor(input, output, {
    files: {
      ...files,
      async open(path, ...args) {
        const file = await open(path, ...args)
        if (!path.endsWith('.tmp')) return file
        return {
          async write(...values) {
            entered.resolve()
            await release.promise
            return file.write(...values)
          },
          sync: () => file.sync(),
          stat: (...values) => file.stat(...values),
          close: () => file.close(),
        }
      },
    },
  })
  const target = window()
  const handle = await exportHandle(service, target)
  const pending = service.writeExport(
    target,
    'demo',
    handle,
    new Uint8Array([7]),
  )
  await entered.promise
  assert.equal((await service.cancel(target, 'demo', handle)).ok, true)
  release.resolve()
  expectFailure(await pending, 'cancelled')
  await assert.rejects(readFile(output), { code: 'ENOENT' })
  const entries = await (await import('node:fs/promises')).readdir(directory)
  assert.equal(
    entries.some((entry) => entry.endsWith('.tmp')),
    false,
  )
  service.clear()
})

test('a swapped staging path cannot become the exported file', async (t) => {
  const { input, output } = await fixture(t)
  const { service } = serviceFor(input, output, {
    files: {
      ...files,
      async lstat(path, ...args) {
        if (path.endsWith('.tmp')) {
          await unlink(path)
          await symlink(input, path)
        }
        return lstat(path, ...args)
      },
    },
  })
  const target = window()
  const handle = await exportHandle(service, target)
  expectFailure(
    await service.writeExport(target, 'demo', handle, new Uint8Array([8])),
    'stale',
  )
  await assert.rejects(readFile(output), { code: 'ENOENT' })
  service.clear()
})
