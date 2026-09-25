import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  lstat,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SelectedTextService } from '../src/main/selected-text.ts'
import {
  SELECTED_TEXT_MAX_BYTES,
  SELECTED_TEXT_TTL_MS,
} from '../src/shared/selected-text.ts'

function window() {
  return {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false },
  }
}

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function failure(result, code) {
  assert.equal(result.ok, false, JSON.stringify(result))
  if (code) assert.equal(result.code, code)
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'hibi-selected-text-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const resolved = await realpath(directory)
  const file = join(resolved, 'note.txt')
  await writeFile(file, 'selected content\n')
  return { directory: resolved, file }
}

function serviceFor(file, options = {}) {
  const owners = new Map([
    ['demo', { addonId: 'demo', activationGeneration: 1 }],
    ['other', { addonId: 'other', activationGeneration: 1 }],
  ])
  let now = 0
  const service = new SelectedTextService(
    (id) => owners.get(id) ?? null,
    options.selectFile ?? (async () => file),
    () => now,
    options.files,
  )
  return { service, owners, advance: (ms) => (now += ms) }
}

async function selectHandle(service, target, addonId = 'demo') {
  const result = await service.select(target, addonId)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(typeof result.value?.handle, 'string')
  assert.ok(result.value.handle)
  return result.value.handle
}

test('canceled picker returns no grant; successful grant reads once with opaque handle', async (t) => {
  const { file } = await fixture(t)
  let selection = null
  const { service } = serviceFor(file, { selectFile: async () => selection })
  const target = window()
  assert.deepEqual(await service.select(target, 'demo'), {
    ok: true,
    value: null,
  })

  selection = file
  const handle = await selectHandle(service, target)
  assert.notEqual(handle, file)
  assert.equal(handle.includes(file), false)
  assert.deepEqual(await service.read(target, 'demo', handle), {
    ok: true,
    value: 'selected content\n',
  })
  failure(await service.read(target, 'demo', handle))
  service.clear()
})

test('grants bind addon, activation, webContents session, and expiry', async (t) => {
  const { file } = await fixture(t)
  const { service, owners, advance } = serviceFor(file)
  const target = window()
  const otherSession = window()

  let handle = await selectHandle(service, target)
  failure(await service.read(target, 'other', handle))
  failure(await service.read(target, 'demo', handle))

  handle = await selectHandle(service, target)
  failure(await service.read(otherSession, 'demo', handle))
  failure(await service.read(target, 'demo', handle))

  handle = await selectHandle(service, target)
  owners.set('demo', { addonId: 'demo', activationGeneration: 2 })
  failure(await service.read(target, 'demo', handle), 'stale')

  handle = await selectHandle(service, target)
  advance(SELECTED_TEXT_TTL_MS + 1)
  failure(await service.read(target, 'demo', handle), 'stale')
  service.clear()
})

test('revocation and clear invalidate outstanding grants', async (t) => {
  const { file } = await fixture(t)
  const { service, owners } = serviceFor(file)
  const target = window()
  const handle = await selectHandle(service, target)
  owners.delete('demo')
  service.revokeAddon('demo')
  failure(await service.read(target, 'demo', handle))

  owners.set('demo', { addonId: 'demo', activationGeneration: 2 })
  const next = await selectHandle(service, target)
  service.clear()
  failure(await service.read(target, 'demo', next))
})

test('disabling during picker or file open cannot publish a grant', async (t) => {
  const { file } = await fixture(t)
  const pickerStarted = deferred()
  const releasePicker = deferred()
  const picker = serviceFor(file, {
    selectFile: async () => {
      pickerStarted.resolve()
      await releasePicker.promise
      return file
    },
  })
  const target = window()
  const pendingPicker = picker.service.select(target, 'demo')
  await pickerStarted.promise
  picker.owners.delete('demo')
  picker.service.revokeAddon('demo')
  releasePicker.resolve()
  failure(await pendingPicker, 'stale')
  picker.service.clear()

  const openStarted = deferred()
  const releaseOpen = deferred()
  const opening = serviceFor(file, {
    files: {
      lstat,
      realpath,
      async open(...args) {
        openStarted.resolve()
        await releaseOpen.promise
        return open(...args)
      },
    },
  })
  const pendingOpen = opening.service.select(target, 'demo')
  await openStarted.promise
  opening.owners.delete('demo')
  opening.service.revokeAddon('demo')
  releaseOpen.resolve()
  failure(await pendingOpen, 'stale')
  opening.service.clear()
})

test('disabling or clearing during file read prevents content delivery', async (t) => {
  const { file } = await fixture(t)
  for (const action of ['revoke', 'clear']) {
    const readStarted = deferred()
    const releaseRead = deferred()
    const { service, owners } = serviceFor(file, {
      files: {
        lstat,
        realpath,
        async open(...args) {
          const handle = await open(...args)
          return {
            stat: (...statArgs) => handle.stat(...statArgs),
            close: () => handle.close(),
            async read(...readArgs) {
              readStarted.resolve()
              await releaseRead.promise
              return handle.read(...readArgs)
            },
            async readFile(...readArgs) {
              readStarted.resolve()
              await releaseRead.promise
              return handle.readFile(...readArgs)
            },
          }
        },
      },
    })
    const target = window()
    const token = await selectHandle(service, target)
    const pending = service.read(target, 'demo', token)
    await readStarted.promise
    if (action === 'revoke') {
      owners.delete('demo')
      service.revokeAddon('demo')
    } else {
      service.clear()
    }
    releaseRead.resolve()
    failure(await pending, 'stale')
    service.clear()
  }
})

test('grant expires while a file read is pending', async (t) => {
  const { file } = await fixture(t)
  const readStarted = deferred()
  const releaseRead = deferred()
  const { service, advance } = serviceFor(file, {
    files: {
      lstat,
      realpath,
      async open(...args) {
        const handle = await open(...args)
        return {
          stat: (...statArgs) => handle.stat(...statArgs),
          close: () => handle.close(),
          async read(...readArgs) {
            readStarted.resolve()
            await releaseRead.promise
            return handle.read(...readArgs)
          },
        }
      },
    },
  })
  const target = window()
  const token = await selectHandle(service, target)
  const pending = service.read(target, 'demo', token)
  await readStarted.promise
  advance(SELECTED_TEXT_TTL_MS + 1)
  releaseRead.resolve()
  failure(await pending, 'stale')
  service.clear()
})

test('concurrent reads are bounded without burning a queued grant', async (t) => {
  const { file } = await fixture(t)
  const started = deferred()
  const release = deferred()
  let active = 0
  const { service } = serviceFor(file, {
    files: {
      lstat,
      realpath,
      async open(...args) {
        const handle = await open(...args)
        return {
          stat: (...statArgs) => handle.stat(...statArgs),
          close: () => handle.close(),
          async read(...readArgs) {
            if (++active === 4) started.resolve()
            await release.promise
            return handle.read(...readArgs)
          },
        }
      },
    },
  })
  const target = window()
  const handles = []
  for (let i = 0; i < 5; i += 1)
    handles.push(await selectHandle(service, target))
  const reads = handles
    .slice(0, 4)
    .map((handle) => service.read(target, 'demo', handle))
  await started.promise
  failure(await service.read(target, 'demo', handles[4]), 'busy')
  release.resolve()
  for (const result of await Promise.all(reads)) assert.equal(result.ok, true)
  assert.equal((await service.read(target, 'demo', handles[4])).ok, true)
  service.clear()
})

test('size and utf8 checks reject content before delivery', async (t) => {
  const { directory, file } = await fixture(t)
  const target = window()
  await writeFile(file, Buffer.alloc(SELECTED_TEXT_MAX_BYTES + 1, 0x61))
  const oversized = serviceFor(file)
  const sizeResult = await oversized.service.select(target, 'demo')
  if (sizeResult.ok) {
    failure(
      await oversized.service.read(target, 'demo', sizeResult.value.handle),
      'limit-exceeded',
    )
  } else {
    failure(sizeResult, 'limit-exceeded')
  }
  oversized.service.clear()

  const invalid = join(directory, 'invalid.txt')
  await writeFile(invalid, Buffer.from([0xc3, 0x28]))
  const utf8 = serviceFor(invalid)
  const token = await selectHandle(utf8.service, target)
  failure(await utf8.service.read(target, 'demo', token), 'unsupported')
  utf8.service.clear()
})

test('symlink, fifo, and replaced pathname never expose unintended bytes', async (t) => {
  const { directory, file } = await fixture(t)
  const target = window()

  if (process.platform !== 'win32') {
    const link = join(directory, 'link.txt')
    await symlink(file, link)
    const linked = serviceFor(link)
    failure(await linked.service.select(target, 'demo'), 'unsupported')
    linked.service.clear()

    const fifo = join(directory, 'pipe.txt')
    execFileSync('mkfifo', [fifo])
    const piped = serviceFor(fifo)
    failure(await piped.service.select(target, 'demo'), 'unsupported')
    piped.service.clear()
  }

  const replaced = serviceFor(file)
  const token = await selectHandle(replaced.service, target)
  await rename(file, join(directory, 'old.txt'))
  await writeFile(file, 'replacement secret')
  failure(await replaced.service.read(target, 'demo', token), 'stale')
  replaced.service.clear()
})
