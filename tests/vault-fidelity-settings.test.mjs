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
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'
import { diffVault, fixtureVault, snapshotVault } from './vault-fidelity.mjs'

const bundle = await build({
  stdin: {
    contents:
      "export * from './src/main/workspace-metadata.ts'; export * from './src/main/workspace-layout.ts'; export { WorkspaceTextIndex } from './src/main/workspace-text-index.ts'",
    resolveDir: process.cwd(),
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
  write: false,
  plugins: [
    {
      name: 'profile',
      setup(b) {
        b.onResolve({ filter: /^electron$/ }, () => ({
          path: 'electron',
          namespace: 'profile',
        }))
        b.onLoad({ filter: /.*/, namespace: 'profile' }, () => ({
          contents: 'export const app = __profileApp',
        }))
      },
    },
  ],
})
const require = createRequire(import.meta.url)
async function fixture(t, config = '.obsidian') {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), 'hibi-vault-policy-')),
  )
  t.after(() => rm(directory, { recursive: true, force: true }))
  const root = join(directory, 'vault')
  const profile = join(directory, 'profile')
  await fixtureVault(root)
  if (config !== '.obsidian') {
    const { rename } = await import('node:fs/promises')
    await rename(join(root, '.obsidian'), join(root, config))
  }
  let worker = false
  const profileApp = {
    getPath: () => {
      if (worker) throw new Error('Electron is unavailable in a worker')
      return profile
    },
  }
  const module = { exports: {} }
  new Function(
    'module',
    'exports',
    'require',
    '__profileApp',
    bundle.outputFiles[0].text,
  )(
    module,
    module.exports,
    (id) =>
      id === 'electron' ? { app: { getPath: () => profile } } : require(id),
    profileApp,
  )
  return {
    root,
    profile,
    directory,
    asWorker: () => {
      worker = true
    },
    ...module.exports,
  }
}
test('remote image cache stays outside obsidian vault', async (t) => {
  const f = await fixture(t)
  await mkdir(f.profile)
  const before = await snapshotVault(f.root)
  const { remoteImageResponse } = await import('../src/main/remote-images.ts')
  const bytes = Buffer.from('89504e470d0a1a0a00000001', 'hex')
  const response = await remoteImageResponse(
    'https://fidelity.test/image.png',
    {
      workspace: f.root,
      note: join(f.root, 'syntax.md'),
      data: f.profile,
    },
    async () =>
      new Response(bytes, { headers: { 'content-type': 'image/png' } }),
  )
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
  assert.deepEqual(diffVault(before, await snapshotVault(f.root)), [])
})

test('text-search worker reads profile ignore rules without importing Electron', async (t) => {
  const f = await fixture(t)
  await mkdir(f.profile, { recursive: true })
  await f.writeWorkspaceText(f.root, f.WORKSPACE_IGNORE, 'syntax.md\n')
  const before = await snapshotVault(f.root)
  f.asWorker()
  const index = await f.WorkspaceTextIndex.open({
    root: f.root,
    database: join(f.profile, 'search.sqlite'),
    dataDirectory: f.profile,
    extensions: ['md'],
  })
  const matches = []
  // Closed before the fixture's own cleanup: Windows can't delete an open database.
  try {
    const query = index.createQuery('paragraph', [])
    let result
    do {
      result = await index.page(query, 100)
      matches.push(...result.matches)
    } while (result.hasMore)
  } finally {
    await index.close()
  }
  assert.ok(matches.some((match) => match.path === 'crlf.md'))
  assert.ok(!matches.some((match) => match.path === 'syntax.md'))
  assert.deepEqual(diffVault(before, await snapshotVault(f.root)), [])
})

const manifest = (name) =>
  JSON.stringify({
    version: 1,
    name,
    description: '',
    icon: '',
    defaultFile: '',
  })

test('obsidian metadata reads existing hibi files without modifying vault, then persists in profile', async (t) => {
  const f = await fixture(t)
  await mkdir(join(f.root, '.hibi'))
  await writeFile(join(f.root, '.hibi/workspace.json'), manifest('legacy'))
  await writeFile(join(f.root, '.hibi/ignore'), 'old-ignore\r\n')
  await writeFile(
    join(f.root, '.hibi/layout.json'),
    JSON.stringify({
      version: 1,
      documents: {
        'table.md': { tables: [{ key: '0:a', columns: [180], rows: null }] },
      },
    }),
  )
  const before = await snapshotVault(f.root)
  assert.equal((await f.workspaceMetadata(f.root)).manifest.name, 'legacy')
  assert.equal((await f.readTableLayout(f.root, 'table.md'))[0].columns[0], 180)
  assert.deepEqual(diffVault(before, await snapshotVault(f.root)), [])
  await f.writeWorkspaceText(f.root, f.WORKSPACE_MANIFEST, manifest('overlay'))
  await f.writeWorkspaceText(f.root, f.WORKSPACE_IGNORE, 'new-ignore\n')
  await f.writeTableLayout(f.root, 'table.md', [
    { key: '0:a', columns: [220], rows: null },
  ])
  assert.equal((await f.workspaceMetadata(f.root)).manifest.name, 'overlay')
  assert.equal((await f.workspaceMetadata(f.root)).ignore, 'new-ignore\n')
  assert.equal((await f.readTableLayout(f.root, 'table.md'))[0].columns[0], 220)
  assert.deepEqual(diffVault(before, await snapshotVault(f.root)), [])
})

test('obsidian manifest creation and layout never create hibi state in fresh vault', async (t) => {
  const f = await fixture(t)
  const before = await snapshotVault(f.root)
  await f.writeWorkspaceText(
    f.root,
    f.WORKSPACE_MANIFEST,
    manifest('first'),
    true,
  )
  await f.writeWorkspaceText(f.root, f.WORKSPACE_IGNORE, 'ignored\n')
  await f.writeTableLayout(f.root, 'table.md', [
    { key: '0:a', columns: [220], rows: null },
  ])
  await assert.rejects(
    f.writeWorkspaceText(
      f.root,
      f.WORKSPACE_MANIFEST,
      manifest('second'),
      true,
    ),
    { code: 'EEXIST' },
  )
  assert.deepEqual(diffVault(before, await snapshotVault(f.root)), [])
})

test('custom config directory also externalizes metadata and protects config bytes', async (t) => {
  const f = await fixture(t, '.profile-日本語')
  const before = await snapshotVault(f.root)
  await f.writeWorkspaceText(f.root, f.WORKSPACE_MANIFEST, manifest('custom'))
  assert.equal((await f.workspaceMetadata(f.root)).manifest.name, 'custom')
  assert.deepEqual(diffVault(before, await snapshotVault(f.root)), [])
})

test('a symlinked default config keeps vault state external and settings read-only', {
  skip: process.platform === 'win32',
}, async (t) => {
  const f = await fixture(t)
  const { rename } = await import('node:fs/promises')
  const outside = join(f.directory, 'outside-config')
  await rename(join(f.root, '.obsidian'), outside)
  await symlink(outside, join(f.root, '.obsidian'))
  const before = await snapshotVault(f.root)
  const outsideBefore = await snapshotVault(outside)
  await f.writeWorkspaceText(f.root, f.WORKSPACE_MANIFEST, manifest('overlay'))
  assert.deepEqual(diffVault(before, await snapshotVault(f.root)), [])
  assert.deepEqual(diffVault(outsideBefore, await snapshotVault(outside)), [])
})

test('metadata vault identity uses canonical path and isolates different vaults', {
  skip: process.platform === 'win32',
}, async (t) => {
  const f = await fixture(t)
  const alias = join(f.directory, 'alias')
  await symlink(f.root, alias)
  await f.writeWorkspaceText(alias, f.WORKSPACE_MANIFEST, manifest('same'))
  assert.equal((await f.workspaceMetadata(f.root)).manifest?.name, 'same')
  const other = join(f.directory, 'other')
  await fixtureVault(other)
  assert.equal((await f.workspaceMetadata(other)).manifest, null)
  assert.equal(
    await readFile(join(f.root, '.obsidian/community-plugins.json'), 'utf8'),
    '["fixture-plugin"]\n',
  )
})
