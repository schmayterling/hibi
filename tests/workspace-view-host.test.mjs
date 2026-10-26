import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'

const bundle = await build({
  entryPoints: ['src/main/workspace.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  plugins: [
    {
      name: 'view-host',
      setup(build) {
        build.onResolve({ filter: /^electron$/ }, () => ({
          path: 'electron',
          namespace: 'view-host',
        }))
        build.onResolve({ filter: /^\.\/document$/ }, (args) =>
          args.importer.endsWith('/src/main/workspace.ts')
            ? { path: 'document', namespace: 'view-host' }
            : undefined,
        )
        build.onLoad({ filter: /.*/, namespace: 'view-host' }, ({ path }) => ({
          loader: 'js',
          contents:
            path === 'electron'
              ? `export const app = {
              getPath: () => globalThis.__viewProfile,
              getAppPath: () => process.cwd(),
            };
            export const dialog = {};
            export const shell = { trashItem: async () => {} };`
              : `export const closeDeletedDocuments = () => {};
            export const confirmDiscardAll = async () => true;
            export const getDocument = () => ({});
            export const getDocumentPath = () => null;
            export const getOpenDocumentMetadata = () => globalThis.__viewDocuments;
            export const getOpenDocuments = () => {
              globalThis.__viewMaterializations++;
              return [];
            };
            export const getDocumentTabs = () => [];
            export const getOpenDocumentVersions = () => [];
            export const getDocumentSourceFor = () => {};
            export const loadDocument = () => {};
            export const selectDocumentTab = () => {};`,
        }))
      },
    },
  ],
})
const module = { exports: {} }
new Function('module', 'exports', 'require', bundle.outputFiles[0].text)(
  module,
  module.exports,
  createRequire(import.meta.url),
)
const host = module.exports

test('private cursors finish retained trees while content and replacement scans advance', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hibi-view-host-')))
  globalThis.__viewProfile = root
  globalThis.__viewDocuments = []
  globalThis.__viewMaterializations = 0
  const folder = join(root, 'workspace')
  await mkdir(join(folder, 'notes'), { recursive: true })
  for (let i = 1; i <= 5; i++)
    await writeFile(join(folder, 'notes', `${i}.md`), '')
  t.after(async () => {
    try {
      const target = host.currentWorkspaceTarget()
      if (target) await host.deleteKnownWorkspace({}, target.workspaceId)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  const loaded = await host.loadWorkspace(folder)
  assert.deepEqual(
    loaded.entries,
    [],
    'native operations return headers by default',
  )
  const header = host.getWorkspaceHeader()
  assert.equal(
    host.readWorkspaceViewPage({ target: header.target }).code,
    'resync-needed',
  )
  assert.equal(
    host.readWorkspaceViewPage({
      target: { ...header.target, workspaceGeneration: -1 },
    }).code,
    'stale',
  )
  const request = {
    target: header.target,
    treeRevision: header.treeRevision,
    draftRevision: header.draftRevision,
    limit: 2,
  }
  const first = host.readWorkspaceViewPage(request)
  assert.equal(first.ok, true)
  assert.ok(first.value.nextCursor)

  const notified = await host.notifyWorkspaceContent(['.git/index'])
  assert.deepEqual(notified.entries, [])
  const changed = host.getWorkspaceHeader()
  assert.equal(changed.treeRevision, header.treeRevision)
  assert.ok(changed.sequence > header.sequence)

  await writeFile(join(folder, 'notes', '6.md'), '')
  assert.deepEqual((await host.refreshWorkspace()).entries, [])
  const latest = host.getWorkspaceHeader()
  assert.ok(latest.treeRevision > header.treeRevision)
  const paths = first.value.entries.map((entry) => entry.path)
  let cursor = first.value.nextCursor
  while (cursor) {
    const page = host.readWorkspaceViewPage({ ...request, cursor })
    assert.equal(page.ok, true)
    paths.push(...page.value.entries.map((entry) => entry.path))
    cursor = page.value.nextCursor
  }
  assert.deepEqual(paths, [
    'notes',
    ...Array.from({ length: 5 }, (_, i) => `notes/${i + 1}.md`),
  ])
  const fresh = host.readWorkspaceViewPage({
    target: latest.target,
    treeRevision: latest.treeRevision,
    draftRevision: latest.draftRevision,
    limit: 200,
  })
  assert.equal(fresh.ok, true)
  assert.ok(fresh.value.entries.some((entry) => entry.path === 'notes/6.md'))

  globalThis.__viewDocuments = [
    { file: join(folder, 'notes', '1.md'), dirty: true },
    { file: join(folder, 'notes', 'gone.md'), dirty: true },
    { file: join(folder, 'private.md'), dirty: true },
    { file: null, pendingPath: join(folder, 'notes', 'new.md'), dirty: true },
  ]
  const dirty = host.getWorkspaceHeader()
  assert.equal(dirty.treeRevision, latest.treeRevision)
  assert.ok(dirty.draftRevision > latest.draftRevision)
  const drafts = host.readWorkspaceViewPage({
    target: dirty.target,
    treeRevision: dirty.treeRevision,
    draftRevision: dirty.draftRevision,
    drafts: true,
  })
  assert.equal(drafts.ok, true)
  assert.deepEqual(
    drafts.value.entries.map((entry) => [entry.path, !!entry.pending]),
    [
      ['notes/1.md', false],
      ['notes/gone.md', false],
      ['private.md', false],
      ['notes/new.md', true],
    ],
  )
  assert.equal(
    globalThis.__viewMaterializations,
    0,
    'headers, native refresh and view pages never materialize open text',
  )
  assert.equal(host.getWorkspace(undefined, true).entries[0].children.length, 6)
  assert.equal(
    globalThis.__viewMaterializations,
    1,
    'legacy snapshots remain explicit',
  )
})
