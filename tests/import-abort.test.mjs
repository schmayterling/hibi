import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import test from 'node:test'
import {
  cancelImport,
  runCancellableImport,
} from '../src/main/import-cancellation.ts'
import { copyImportFile, readImportFolder } from '../src/main/import-files.ts'
import { readZipEntry } from '../src/main/zip-reader.ts'

test('cancellation owns all imports for one window and leaves other windows alone', async () => {
  const held = Promise.withResolvers()
  const signals = []
  const start = (id) =>
    runCancellableImport(id, async (signal) => {
      signals.push(signal)
      await held.promise
      signal.throwIfAborted()
      return id
    })
  const pending = [start(1), start(1), start(2)]
  cancelImport(1)
  assert.deepEqual(
    signals.map((signal) => signal.aborted),
    [true, true, false],
  )
  held.resolve()
  assert.deepEqual(await Promise.all(pending), [null, null, 2])
  assert.equal(
    await runCancellableImport(1, async (signal) => {
      assert.equal(signal.aborted, false)
      return 'next'
    }),
    'next',
  )
})

test('aborting a held file copy destroys its stream and closes the source', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-copy-abort-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'source.bin'), Buffer.alloc(128 * 1024))
  const source = (await readImportFolder(root)).files[0]
  const fs = process.getBuiltinModule('node:fs')
  const original = fs.createWriteStream
  const started = Promise.withResolvers()
  let destination
  fs.createWriteStream = () => {
    destination = new Writable({
      write() {
        started.resolve()
      },
    })
    return destination
  }
  syncBuiltinESMExports()
  try {
    const controller = new AbortController()
    const copying = copyImportFile(
      source,
      join(root, 'copy.bin'),
      controller.signal,
    )
    await started.promise
    controller.abort()
    await assert.rejects(copying, { name: 'AbortError' })
    assert.equal(destination.destroyed, true)
  } finally {
    destination?.destroy()
    fs.createWriteStream = original
    syncBuiltinESMExports()
  }
})

test('aborting folder discovery stops before visiting later files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-discover-abort-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (let index = 0; index < 20; index++)
    await writeFile(join(root, `${index}.md`), '')
  const fs = process.getBuiltinModule('node:fs/promises')
  const original = fs.lstat
  const controller = new AbortController()
  let visited = 0
  fs.lstat = async (...args) => {
    const result = await original(...args)
    if (++visited === 5) controller.abort()
    return result
  }
  syncBuiltinESMExports()
  try {
    await assert.rejects(readImportFolder(root, controller.signal), {
      name: 'AbortError',
    })
    assert.equal(visited, 5)
  } finally {
    fs.lstat = original
    syncBuiltinESMExports()
  }
})

test('aborting archive extraction destroys a waiting entry stream', async () => {
  const source = new PassThrough()
  const controller = new AbortController()
  const reading = readZipEntry(
    { uncompressedSize: 10, stream: () => source },
    32,
    controller.signal,
  )
  controller.abort()
  await assert.rejects(reading, { name: 'AbortError' })
  assert.equal(source.destroyed, true)
})
