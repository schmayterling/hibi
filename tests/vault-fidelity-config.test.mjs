import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  obsidianConfiguration,
  obsidianSettings,
} from '../src/main/workspace-obsidian.ts'
import { diffVault, fixtureVault, snapshotVault } from './vault-fidelity.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'hibi-config-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await fixtureVault(root)
  return root
}
test('default configuration wins over other valid profiles and reads settings without writes', async (t) => {
  const root = await fixture(t)
  await mkdir(join(root, '.custom'))
  await writeFile(
    join(root, '.custom/app.json'),
    '{"attachmentFolderPath":"wrong"}',
  )
  const before = await snapshotVault(root)
  const settings = await obsidianSettings(root)
  assert.equal(settings.directory, '.obsidian')
  assert.equal(settings.attachmentFolderPath, 'attachments')
  assert.equal(settings.newFileLocation, 'folder')
  assert.equal(settings.newLinkFormat, 'relative')
  assert.equal(settings.useMarkdownLinks, true)
  assert.equal(settings.alwaysUpdateLinks, true)
  assert.equal(settings.trashOption, 'local')
  assert.deepEqual(diffVault(before, await snapshotVault(root)), [])
})
test('custom configuration is detected; ambiguous profiles use defaults with notice', async (t) => {
  const root = await fixture(t)
  await rename(join(root, '.obsidian'), join(root, '.日本語'))
  assert.equal((await obsidianSettings(root)).directory, '.日本語')
  await mkdir(join(root, '.desktop'))
  await writeFile(join(root, '.desktop/appearance.json'), '{}')
  const before = await snapshotVault(root)
  const settings = await obsidianSettings(root)
  assert.equal(settings.directory, null)
  assert.match(settings.notice, /\.desktop.*\.日本語/)
  assert.equal(settings.attachmentFolderPath, '')
  assert.equal(settings.newFileLocation, 'root')
  assert.equal(settings.newLinkFormat, 'shortest')
  assert.equal(settings.useMarkdownLinks, false)
  assert.equal(settings.trashOption, 'system')
  assert.deepEqual(diffVault(before, await snapshotVault(root)), [])
})
test('malformed or symlink settings use system trash with visible notice', async (t) => {
  const root = await fixture(t)
  await writeFile(join(root, '.obsidian/app.json'), 'not json')
  assert.equal((await obsidianSettings(root)).trashOption, 'system')
  assert.match((await obsidianSettings(root)).notice, /Could not read/)
  await rm(join(root, '.obsidian/app.json'))
  await writeFile(join(root, 'outside.json'), '{"trashOption":"none"}')
  if (process.platform !== 'win32') {
    await symlink('../outside.json', join(root, '.obsidian/app.json'))
    assert.equal((await obsidianSettings(root)).trashOption, 'system')
    assert.match((await obsidianSettings(root)).notice, /Could not read/)
  }
})
test('unrelated dotfolders are not vaults', async (t) => {
  const root = await fixture(t)
  await rm(join(root, '.obsidian'), { recursive: true })
  await mkdir(join(root, '.other'))
  await writeFile(join(root, '.other/app.json'), '[]')
  assert.equal(await obsidianConfiguration(root), null)
  assert.equal(await obsidianSettings(root), null)
})
