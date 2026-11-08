import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  isCaseOnlyRename,
  renameCaseOnly,
} from '../src/main/workspace-case-rename.ts'
import { diffVault, fixtureVault, snapshotVault } from './vault-fidelity.mjs'

test('case-only rename preserves Unicode/BOM/CRLF bytes and leaves no staging entries', async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'hibi-case-fidelity-')),
  )
  t.after(() => rm(root, { recursive: true, force: true }))
  await fixtureVault(root)
  const bytes = Buffer.from('\ufeff# café\r\n[[nested/Target|alias]]  \r\n')
  await writeFile(join(root, 'case/Case.md'), bytes)
  const before = await snapshotVault(root)
  const from = join(root, 'case/Case.md'),
    to = join(root, 'case/CASE.md')
  const insensitive = await isCaseOnlyRename(from, to)
  await renameCaseOnly(from, to)
  assert.deepEqual(await readFile(to), bytes)
  assert.ok((await readdir(join(root, 'case'))).includes('CASE.md'))
  assert.deepEqual(
    diffVault(before, await snapshotVault(root), {
      'case/Case.md': null,
      'case/CASE.md': before.get('case/Case.md'),
    }),
    [],
  )
  t.diagnostic(JSON.stringify({ insensitive }))
})
test('case rename never overwrites distinct existing destination', async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'hibi-case-conflict-')),
  )
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'old.md'), 'old\r\n')
  await writeFile(join(root, 'new.md'), 'keep\r\n')
  await assert.rejects(
    renameCaseOnly(join(root, 'old.md'), join(root, 'new.md')),
    { code: 'EEXIST' },
  )
  assert.equal(await readFile(join(root, 'old.md'), 'utf8'), 'old\r\n')
  assert.equal(await readFile(join(root, 'new.md'), 'utf8'), 'keep\r\n')
  assert.deepEqual((await readdir(root)).sort(), ['new.md', 'old.md'])
})
