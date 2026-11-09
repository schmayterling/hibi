import assert from 'node:assert/strict'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import * as policy from '../src/main/workspace-obsidian.ts'
import * as links from '../src/main/workspace-obsidian-links.ts'
import { diffVault, snapshotVault } from './vault-fidelity.mjs'

async function vault(t, files, settings = {}) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'hibi-fidelity-review-')),
  )
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, '.obsidian'))
  await writeFile(join(root, '.obsidian/app.json'), JSON.stringify(settings))
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), text)
  }
  return root
}

for (const [folder, expected] of [
  ['/', ''],
  ['/attachments', 'attachments'],
]) {
  test(`vault-root attachment setting ${folder}`, async (t) => {
    const root = await vault(
      t,
      { 'notes/n.md': '' },
      { attachmentFolderPath: folder },
    )
    assert.equal(
      await policy.obsidianAttachmentDirectory(root, join(root, 'notes/n.md')),
      join(root, expected),
    )
  })
}

test('vault-root new note folder and case-folded protected config', async (t) => {
  const root = await vault(
    t,
    { 'notes/n.md': '' },
    { newFileLocation: 'folder', newFileFolderPath: '/inbox' },
  )
  assert.equal(
    await policy.obsidianNewNotePath(
      root,
      join(root, 'notes/n.md'),
      'new.md',
      true,
    ),
    join(root, 'inbox/new.md'),
  )
  await assert.rejects(
    policy.assertObsidianContentPath(
      root,
      join(root, '.OBSIDIAN/plugins/x.md'),
    ),
    /read-only/,
  )
})

test('generic dotfolder app settings alone do not change workspace identity', async (t) => {
  const root = await vault(t, {
    '.other/app.json': '{}',
    '.more/appearance.json': '{}',
  })
  await rm(join(root, '.obsidian'), { recursive: true })
  const before = await snapshotVault(root)
  assert.equal(await policy.obsidianConfiguration(root), null)
  assert.deepEqual(diffVault(before, await snapshotVault(root)), [])
  await writeFile(join(root, '.other/appearance.json'), '{}')
  assert.equal((await policy.obsidianConfiguration(root)).directory, '.other')
})

test('unreadable non-referrer names its file; invalid UTF-8 non-referrers do not block renames', async (t) => {
  const root = await vault(t, {
    'a.md': '[[t]]',
    't.md': '',
    'bad.md': Buffer.from([0xff, 0x41]),
  })
  const before = await snapshotVault(root)
  const plan = await links.prepareObsidianLinkUpdates(root, 't.md', 'u.md')
  await plan.verify()
  assert.deepEqual(diffVault(before, await snapshotVault(root)), [])
  await chmod(join(root, 'bad.md'), 0o000)
  try {
    // Windows modes only mark files read-only; they stay readable there.
    if (
      await readFile(join(root, 'bad.md')).then(
        () => false,
        () => true,
      )
    )
      await assert.rejects(
        links.prepareObsidianLinkUpdates(root, 't.md', 'u.md'),
        /bad\.md/,
      )
  } finally {
    await chmod(join(root, 'bad.md'), 0o600)
  }
})

for (const kind of ['file', 'directory']) {
  test(`read-only referrer ${kind} refuses before any move or edit`, async (t) => {
    const root = await vault(t, {
      'a/one.md': '[[t]]',
      't.md': '',
      'z/two.md': '[[t]]',
    })
    const path = join(root, kind === 'file' ? 'z/two.md' : 'z')
    await chmod(path, kind === 'file' ? 0o444 : 0o555)
    try {
      const before = await snapshotVault(root)
      await assert.rejects(
        links.prepareObsidianLinkUpdates(root, 't.md', 'u.md'),
        /z\/two\.md.*read-only|z\/two\.md.*writ/i,
      )
      assert.deepEqual(diffVault(before, await snapshotVault(root)), [])
      assert.equal(await readFile(join(root, 'a/one.md'), 'utf8'), '[[t]]')
    } finally {
      await chmod(path, kind === 'file' ? 0o644 : 0o755)
    }
  })
}

test('formatting a non-vault link does not traverse unrelated unreadable folders', async (t) => {
  const root = await vault(t, { 'restricted/file.md': '' })
  await rm(join(root, '.obsidian'), { recursive: true })
  await chmod(join(root, 'restricted'), 0o000)
  try {
    assert.equal(
      await links.formatObsidianLink(
        root,
        join(root, 'r.md'),
        'file.md',
        'shown',
      ),
      null,
    )
  } finally {
    await chmod(join(root, 'restricted'), 0o755)
  }
})

test('empty default config remains protected through a case-variant save path', async (t) => {
  const root = await vault(t, {})
  await rm(join(root, '.obsidian/app.json'))
  const before = await snapshotVault(root)
  await assert.rejects(
    policy.assertObsidianContentPath(
      root,
      join(root, '.OBSIDIAN/plugins/new.md'),
    ),
    /read-only/,
  )
  assert.deepEqual(diffVault(before, await snapshotVault(root)), [])
})
