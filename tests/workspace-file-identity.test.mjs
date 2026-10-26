import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { dirname } from 'node:path'
import test from 'node:test'
import { sameFileIdentity } from '../src/shared/file-identity.ts'

test('workspace parent checks reject different file ids that round to the same number', async () => {
  const source = await readFile('src/main/workspace-files.ts', 'utf8')
  const start = source.indexOf('async function parentIdentity(')
  const end = source.indexOf('\nfunction sameFile(', start)
  let ino = 1152921504606846977n
  assert.equal(Number(ino), Number(ino + 1n))
  const { parentIdentity, verifyParent } = new Function(
    'dirname',
    'realpath',
    'lstat',
    'inside',
    'sameFileIdentity',
    `${stripTypeScriptTypes(source.slice(start, end))}\nreturn { parentIdentity, verifyParent }`,
  )(
    dirname,
    async (path) => path,
    async (_path, options) => ({
      dev: options?.bigint ? 1n : 1,
      ino: options?.bigint ? ino : Number(ino),
      isDirectory: () => true,
      isSymbolicLink: () => false,
    }),
    () => true,
    sameFileIdentity,
  )
  const parent = await parentIdentity('/workspace', '/workspace/note.md')
  await verifyParent('/workspace', '/workspace/note.md', parent)
  ino++
  await assert.rejects(
    verifyParent('/workspace', '/workspace/note.md', parent),
    { code: 'ESTALE' },
  )
})
