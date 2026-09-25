import assert from 'node:assert/strict'
import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { replaceExistingText } from '../src/main/workspace-atomic-update.ts'

test('failed precondition leaves existing bytes and removes staged file', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-workspace-update-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'note.md')
  await writeFile(file, 'saved')

  await assert.rejects(
    replaceExistingText(file, 'replacement', 0o640, async () => {
      assert.equal(await readFile(file, 'utf8'), 'saved')
      const staged = (await readdir(root)).filter((name) =>
        name.endsWith('.tmp'),
      )
      assert.equal(staged.length, 1)
      assert.equal(await readFile(join(root, staged[0]), 'utf8'), 'replacement')
      throw new Error('version conflict')
    }),
    /version conflict/,
  )
  assert.equal(await readFile(file, 'utf8'), 'saved')
  assert.deepEqual(await readdir(root), ['note.md'])
})

test('successful replacement keeps requested mode and reports directory sync', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-workspace-update-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'note.md')
  await writeFile(file, 'saved')
  await chmod(file, 0o640)
  const originalMode = (await stat(file)).mode

  const result = await replaceExistingText(
    file,
    'replacement',
    originalMode,
    async () => assert.equal(await readFile(file, 'utf8'), 'saved'),
  )
  assert.equal(result.atomicVisibility, true)
  assert.equal(typeof result.directorySynced, 'boolean')
  assert.equal(await readFile(file, 'utf8'), 'replacement')
  if (process.platform !== 'win32')
    assert.equal((await stat(file)).mode & 0o777, originalMode & 0o777)
  assert.deepEqual(await readdir(root), ['note.md'])
})
