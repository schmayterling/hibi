import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  diffVault,
  fixtureVault,
  paragraph,
  replaceBytes,
  replacement,
  snapshotManifest,
  snapshotVault,
} from './vault-fidelity.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'hibi-fidelity-check-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('fixture generation is deterministic for this filesystem', async (t) => {
  const root = await fixture(t)
  const first = join(root, 'first')
  const second = join(root, 'second')
  const capabilities = await fixtureVault(first)
  assert.deepEqual(await fixtureVault(second), capabilities)
  assert.deepEqual(
    snapshotManifest(await snapshotVault(first)),
    snapshotManifest(await snapshotVault(second)),
  )
  const snapshot = await snapshotVault(first)
  assert.equal(
    snapshot.get('bom.md').bytes.subarray(0, 3).toString('hex'),
    'efbbbf',
  )
  assert.ok(snapshot.get('crlf.md').bytes.includes(Buffer.from('\r\n')))
  assert.ok(snapshot.get('syntax.md').bytes.toString().includes('cafe\u0301'))
  assert.ok(
    !snapshot.get('editable-syntax.md').bytes.toString().includes('[^note]'),
  )
  assert.equal(
    snapshot.get('no-final-newline.md').bytes.at(-1),
    'stay'.charCodeAt(3),
  )
  t.diagnostic(JSON.stringify(capabilities))
})

test('byte-span edits preserve bom, line endings, unicode, and final newline', async (t) => {
  const root = await fixture(t)
  await fixtureVault(root)
  const before = await snapshotVault(root)
  const changes = {}
  for (const path of [
    'syntax.md',
    'crlf.md',
    'bom.md',
    'mixed-eol.md',
    'no-final-newline.md',
  ]) {
    changes[path] = replaceBytes(before, path, paragraph, replacement)
    await writeFile(join(root, path), changes[path].bytes)
  }
  assert.deepEqual(diffVault(before, await snapshotVault(root), changes), [])
  const corrupt = changes['crlf.md'].bytes.toString().replaceAll('\r\n', '\n')
  await writeFile(join(root, 'crlf.md'), corrupt)
  assert.deepEqual(
    diffVault(before, await snapshotVault(root), changes).map(
      ({ path }) => path,
    ),
    ['crlf.md'],
  )
})

test('protected state cannot be allowlisted and new empty folders count as writes', async (t) => {
  const root = await fixture(t)
  await fixtureVault(root)
  const before = await snapshotVault(root)
  const path = '.obsidian/plugins/fixture-plugin/data.json'
  const changed = { kind: 'file', bytes: Buffer.from('{}') }
  await writeFile(join(root, path), changed.bytes)
  await mkdir(join(root, '.hibi'))
  const violations = diffVault(before, await snapshotVault(root), {
    [path]: changed,
  })
  assert.deepEqual(
    violations.map(({ path }) => path),
    ['.hibi', path],
  )
  assert.equal(violations[1].reason, 'protected obsidian state changed')
})

test('expected creates, moves, deletes and missing operations are checked exactly', async (t) => {
  const root = await fixture(t)
  await writeFile(join(root, 'old.md'), 'old\r\n')
  const before = await snapshotVault(root)
  await mkdir(join(root, 'new'))
  await writeFile(join(root, 'new', 'moved.md'), 'old\r\n')
  await rm(join(root, 'old.md'))
  const changes = {
    'old.md': null,
    new: { kind: 'directory' },
    'new/moved.md': before.get('old.md'),
  }
  assert.deepEqual(diffVault(before, await snapshotVault(root), changes), [])
  assert.equal(diffVault(before, before, changes).length, 3)
  await writeFile(join(root, 'new', 'moved.md'), 'old\n')
  assert.equal(
    diffVault(before, await snapshotVault(root), changes)[0].path,
    'new/moved.md',
  )
})

test('snapshots record symlink identity without following outside files', {
  skip: process.platform === 'win32',
}, async (t) => {
  const root = await fixture(t)
  await mkdir(join(root, 'vault'))
  await writeFile(join(root, 'outside'), 'outside bytes')
  await symlink('../outside', join(root, 'vault', 'link'))
  const snapshot = await snapshotVault(join(root, 'vault'))
  assert.deepEqual(
    [...snapshot],
    [['link', { kind: 'symlink', target: '../outside' }]],
  )
})
