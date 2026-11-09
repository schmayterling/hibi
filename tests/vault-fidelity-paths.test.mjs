import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { resolveDocumentMediaPath } from '../src/main/images.ts'
import * as policy from '../src/main/workspace-obsidian.ts'
import { diffVault, fixtureVault, snapshotVault } from './vault-fidelity.mjs'

async function fixture(t, settings) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'hibi-vault-paths-')),
  )
  t.after(() => rm(root, { recursive: true, force: true }))
  await fixtureVault(root, settings)
  return root
}
for (const [setting, path] of [
  ['', ''],
  ['attachments', 'attachments'],
  ['./', 'nested'],
  ['./images/deep', 'nested/images/deep'],
  ['images/deep', 'images/deep'],
]) {
  test(`attachment folder ${JSON.stringify(setting)} resolves under vault and media lookup agrees`, async (t) => {
    const root = await fixture(t, { attachmentFolderPath: setting })
    const note = join(root, 'nested/Target.md')
    const directory = await policy.obsidianAttachmentDirectory(root, note)
    assert.equal(directory, join(root, path))
    const bytes = await readFile(join(root, 'attachments/pixel.svg'))
    await writeFile(join(directory, 'unique.svg'), bytes)
    assert.equal(
      await resolveDocumentMediaPath('unique.svg', note, root),
      join(directory, 'unique.svg'),
    )
  })
}
for (const setting of [
  '../outside',
  '/../../outside',
  '.obsidian',
  './.obsidian',
  'a/../../outside',
  'a\\b',
]) {
  test(`attachment folder ${JSON.stringify(setting)} is rejected without writes`, async (t) => {
    const root = await fixture(t, { attachmentFolderPath: setting })
    const before = await snapshotVault(root)
    await assert.rejects(
      policy.obsidianAttachmentDirectory(root, join(root, 'nested/Target.md')),
    )
    assert.deepEqual(diffVault(before, await snapshotVault(root)), [])
  })
}
test('attachment folder symlink is rejected before creating descendants', {
  skip: process.platform === 'win32',
}, async (t) => {
  const root = await fixture(t, { attachmentFolderPath: './escape/child' })
  const outside = await mkdtemp(join(tmpdir(), 'hibi-outside-'))
  t.after(() => rm(outside, { recursive: true, force: true }))
  await symlink(outside, join(root, 'nested/escape'))
  await assert.rejects(
    policy.obsidianAttachmentDirectory(root, join(root, 'nested/Target.md')),
  )
  await assert.rejects(readFile(join(outside, 'child')), { code: 'ENOENT' })
})
for (const [location, expected] of [
  ['root', 'untitled.md'],
  ['folder', 'inbox/untitled.md'],
  ['current', 'nested/untitled.md'],
]) {
  test(`new-note default ${location} preserves explicitly selected path semantics`, async (t) => {
    const root = await fixture(t, { newFileLocation: location })
    const before = await snapshotVault(root)
    assert.equal(
      await policy.obsidianNewNotePath(
        root,
        join(root, 'nested/Target.md'),
        'untitled.md',
      ),
      join(root, expected),
    )
    assert.deepEqual(diffVault(before, await snapshotVault(root)), [])
  })
}
test('current-folder default falls back to root when previous note was outside vault', async (t) => {
  const root = await fixture(t, { newFileLocation: 'current' })
  assert.equal(
    await policy.obsidianNewNotePath(
      root,
      join(dirname(root), 'outside.md'),
      'untitled.md',
    ),
    join(root, 'untitled.md'),
  )
})
