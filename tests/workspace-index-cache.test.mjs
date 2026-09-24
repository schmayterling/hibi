import assert from 'node:assert/strict'
import {
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  diskIndexVersion,
  needsIndexVerification,
  readIndexPage,
} from '../src/main/workspace-index-cache.ts'

test('workspace index reuses unchanged text and reads only changed files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-index-cache-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'note.md')
  await writeFile(path, 'first')
  let reads = 0
  const read = () => {
    reads++
    return readFile(path, 'utf8')
  }
  const firstVersion = diskIndexVersion(await stat(path, { bigint: true }))
  const first = await readIndexPage(
    undefined,
    firstVersion,
    'id',
    'note.md',
    read,
  )
  const unchanged = await readIndexPage(
    first,
    firstVersion,
    'id',
    'note.md',
    read,
  )
  assert.strictEqual(unchanged, first)
  assert.equal(reads, 1)

  await writeFile(join(root, 'replacement.md'), 'other')
  await rename(join(root, 'replacement.md'), path)
  const secondVersion = diskIndexVersion(await stat(path, { bigint: true }))
  assert.notEqual(secondVersion, firstVersion)
  const changed = await readIndexPage(
    unchanged,
    secondVersion,
    'id',
    'note.md',
    read,
  )
  assert.equal(changed.page.markdown, 'other')
  assert.equal(reads, 2)
})

test('known file changes verify only affected paths and folder descendants', () => {
  const changed = new Set(['folder', 'other.md'])
  assert.equal(needsIndexVerification(changed, 'folder/a.md'), true)
  assert.equal(needsIndexVerification(changed, 'other.md'), true)
  assert.equal(needsIndexVerification(changed, 'stable.md'), false)
  assert.equal(needsIndexVerification(null, 'stable.md'), true)
})
