import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { copyEntry, moveEntry } from '../src/main/workspace-entry-transfer.ts'

test('file copy cannot replace a destination created after validation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-entry-copy-race-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source.md')
  const destination = join(root, 'destination.md')
  await writeFile(source, 'original')
  await assert.rejects(
    copyEntry(source, destination, false, async () => {
      await writeFile(destination, 'competitor', { flag: 'wx' })
      return true
    }),
    { code: 'EEXIST' },
  )
  assert.equal(await readFile(source, 'utf8'), 'original')
  assert.equal(await readFile(destination, 'utf8'), 'competitor')
})

test('folder copy cannot claim a competing destination', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-folder-copy-race-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source')
  const destination = join(root, 'destination')
  await mkdir(source)
  await writeFile(join(source, 'note.md'), 'original')
  await assert.rejects(
    copyEntry(source, destination, true, async () => {
      await mkdir(destination)
      await writeFile(join(destination, 'competitor.md'), 'competitor')
      return true
    }),
    { code: 'EEXIST' },
  )
  assert.equal(await readFile(join(source, 'note.md'), 'utf8'), 'original')
  assert.equal(
    await readFile(join(destination, 'competitor.md'), 'utf8'),
    'competitor',
  )
})

test('folder copy still copies saved files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-folder-copy-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source')
  const destination = join(root, 'destination')
  await mkdir(source)
  await writeFile(join(source, 'note.md'), 'original')
  await mkdir(join(source, 'nested'))
  await writeFile(join(source, 'nested', 'child.md'), 'nested')
  await mkdir(join(source, 'empty'))
  await copyEntry(source, destination, true, () => true)
  assert.equal(await readFile(join(destination, 'note.md'), 'utf8'), 'original')
  assert.equal(
    await readFile(join(destination, 'nested', 'child.md'), 'utf8'),
    'nested',
  )
  await rmdir(join(destination, 'empty'))
})

test('folder copy rejects a source swapped for a symbolic link', async (t) => {
  if (process.platform === 'win32')
    return t.skip('Windows symbolic links require privileges')
  const root = await mkdtemp(join(tmpdir(), 'hibi-folder-copy-source-swap-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source')
  const saved = join(root, 'saved')
  const destination = join(root, 'destination')
  await mkdir(source)
  await writeFile(join(source, 'note.md'), 'original')
  await assert.rejects(
    copyEntry(source, destination, true, async () => {
      await rename(source, saved)
      await symlink(saved, source, 'dir')
      return true
    }),
    /Symbolic links cannot be copied/,
  )
  assert.equal(await readFile(join(saved, 'note.md'), 'utf8'), 'original')
  await assert.rejects(readFile(join(destination, 'note.md')), {
    code: 'ENOENT',
  })
})

test('folder copy rejects a destination swapped for a symbolic link', async (t) => {
  if (process.platform === 'win32')
    return t.skip('Windows symbolic links require privileges')
  const root = await mkdtemp(join(tmpdir(), 'hibi-folder-copy-dest-swap-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source')
  const destination = join(root, 'destination')
  const reserved = join(root, 'reserved')
  const outside = join(root, 'outside')
  await mkdir(source)
  await mkdir(outside)
  await writeFile(join(source, 'note.md'), 'original')
  await assert.rejects(
    copyEntry(
      source,
      destination,
      true,
      () => true,
      async (path) => {
        const names = await readdir(path)
        await rename(destination, reserved)
        await symlink(outside, destination, 'dir')
        return names
      },
    ),
    /destination folder changed/i,
  )
  assert.equal(await readFile(join(source, 'note.md'), 'utf8'), 'original')
  await assert.rejects(readFile(join(outside, 'note.md')), { code: 'ENOENT' })
})

test('folder copy rejects a source swapped after listing', async (t) => {
  if (process.platform === 'win32')
    return t.skip('Windows symbolic links require privileges')
  const root = await mkdtemp(join(tmpdir(), 'hibi-folder-copy-listed-swap-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source')
  const saved = join(root, 'saved')
  const destination = join(root, 'destination')
  await mkdir(source)
  await writeFile(join(source, 'note.md'), 'original')
  await assert.rejects(
    copyEntry(
      source,
      destination,
      true,
      () => true,
      async (path) => {
        const names = await readdir(path)
        await rename(source, saved)
        await symlink(saved, source, 'dir')
        return names
      },
    ),
    /Symbolic links cannot be copied/,
  )
  assert.equal(await readFile(join(saved, 'note.md'), 'utf8'), 'original')
  await assert.rejects(readFile(join(destination, 'note.md')), {
    code: 'ENOENT',
  })
})

test('file move creates its destination exclusively', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-entry-move-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source.md')
  const destination = join(root, 'destination.md')
  await writeFile(source, 'original')
  await writeFile(destination, 'competitor', { flag: 'wx' })
  await assert.rejects(
    moveEntry(source, destination, false, () => true),
    {
      code: 'EEXIST',
    },
  )
  assert.equal(await readFile(source, 'utf8'), 'original')
  assert.equal(await readFile(destination, 'utf8'), 'competitor')
  await unlink(destination)
  assert.deepEqual(await moveEntry(source, destination, false, () => true), {
    sourceRemoved: true,
  })
  await assert.rejects(readFile(source), { code: 'ENOENT' })
  assert.equal(await readFile(destination, 'utf8'), 'original')
})

test('destination swap after link retains source and competing file', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-entry-swap-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source.md')
  const destination = join(root, 'destination.md')
  await writeFile(source, 'original')
  const result = await moveEntry(source, destination, false, async () => {
    await unlink(destination)
    await writeFile(destination, 'competitor', { flag: 'wx' })
    return true
  })
  assert.equal(result.sourceRemoved, false)
  assert.equal(await readFile(source, 'utf8'), 'original')
  assert.equal(await readFile(destination, 'utf8'), 'competitor')
})

test('source replacement after link is never removed', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-entry-source-swap-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source.md')
  const destination = join(root, 'destination.md')
  await writeFile(source, 'original')
  const result = await moveEntry(source, destination, false, async () => {
    await rename(source, join(root, 'old.md'))
    await writeFile(source, 'replacement', { flag: 'wx' })
    return true
  })
  assert.equal(result.sourceRemoved, false)
  assert.equal(await readFile(source, 'utf8'), 'replacement')
  assert.equal(await readFile(destination, 'utf8'), 'original')
  assert.equal(await readFile(join(root, 'old.md'), 'utf8'), 'original')
})

test('copy fallback does not remove source after same-size destination swap', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-entry-fallback-swap-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source.md')
  const destination = join(root, 'destination.md')
  await writeFile(source, 'original')
  const crossDeviceLink = async () => {
    throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' })
  }
  const result = await moveEntry(
    source,
    destination,
    false,
    async () => {
      await rename(destination, join(root, 'owned.md'))
      await writeFile(destination, 'compete!', { flag: 'wx' })
      return true
    },
    crossDeviceLink,
  )
  assert.equal(result.sourceRemoved, false)
  assert.equal(await readFile(source, 'utf8'), 'original')
  assert.equal(await readFile(destination, 'utf8'), 'compete!')
  assert.equal(await readFile(join(root, 'owned.md'), 'utf8'), 'original')
  assert.deepEqual(
    await moveEntry(
      source,
      join(root, 'moved.md'),
      false,
      () => true,
      crossDeviceLink,
    ),
    { sourceRemoved: true },
  )
  await assert.rejects(readFile(source), { code: 'ENOENT' })
  assert.equal(await readFile(join(root, 'moved.md'), 'utf8'), 'original')
})

test('folder move preserves the existing rename workflow', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-folder-move-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source')
  const destination = join(root, 'destination')
  await mkdir(source)
  await writeFile(join(source, 'note.md'), 'original')
  assert.deepEqual(await moveEntry(source, destination, true, () => true), {
    sourceRemoved: true,
  })
  assert.equal(await readFile(join(destination, 'note.md'), 'utf8'), 'original')
  await assert.rejects(readFile(join(source, 'note.md')), { code: 'ENOENT' })
})

test('folder reservation swap is detected before rename', async (t) => {
  if (process.platform === 'win32')
    return t.skip('Windows does not reserve folders')
  const root = await mkdtemp(join(tmpdir(), 'hibi-folder-swap-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source')
  const destination = join(root, 'destination')
  await mkdir(source)
  await writeFile(join(source, 'note.md'), 'original')
  await assert.rejects(
    moveEntry(source, destination, true, async () => {
      await rmdir(destination)
      await mkdir(destination)
      await writeFile(join(destination, 'competitor.md'), 'competitor')
      return true
    }),
    /destination folder changed/i,
  )
  assert.equal(await readFile(join(source, 'note.md'), 'utf8'), 'original')
  assert.equal(
    await readFile(join(destination, 'competitor.md'), 'utf8'),
    'competitor',
  )
})
