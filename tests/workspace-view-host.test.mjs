import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'

const bundle = await build({
  stdin: {
    contents:
      (await readFile('src/main/workspace.ts', 'utf8')) +
      '\nexport { queueWatcherEvent, reconcileWatcherEvents }; export { createWorkspaceView } from "../renderer/src/workspace-view"',
    loader: 'ts',
    sourcefile: resolve('src/main/workspace.ts'),
    resolveDir: resolve('src/main'),
  },
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

test('steady content events during one tree change do not repeat tree pages or unchanged revisions', async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'hibi-content-scan-')),
  )
  globalThis.__viewProfile = root
  globalThis.__viewDocuments = []
  globalThis.__viewMaterializations = 0
  const folder = join(root, 'notes')
  await mkdir(folder)
  for (let index = 0; index < 205; index++)
    await writeFile(join(folder, `note-${index}.md`), '')
  const fs = process.getBuiltinModule('node:fs')
  const io = process.getBuiltinModule('node:fs/promises')
  t.mock.method(fs, 'watch', () => ({
    on() {
      return this
    },
    close() {},
  }))
  syncBuiltinESMExports()
  t.after(async () => {
    try {
      const target = host.currentWorkspaceTarget()
      if (target) await host.deleteKnownWorkspace({}, target.workspaceId)
    } finally {
      t.mock.restoreAll()
      syncBuiltinESMExports()
      await rm(root, { recursive: true, force: true })
    }
  })
  await host.loadWorkspace(folder)
  let pages = 0
  const states = []
  const view = host.createWorkspaceView(
    {
      getWorkspaceHeader: async () => host.getWorkspaceHeader(),
      readWorkspaceViewPage: async (request) => {
        if (!request.drafts) pages++
        return host.readWorkspaceViewPage(request)
      },
    },
    (state) => states.push(state),
  )
  await view.refresh()
  pages = 0
  states.length = 0
  const initial = host.getWorkspaceHeader()
  const changes = []
  host.observeWorkspace((change) => {
    changes.push(change)
    void view.refresh()
  })
  t.after(() => host.observeWorkspace(() => {}))
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const opendir = io.opendir
  let scans = 0
  let release
  let start
  const held = new Promise((resolve) => {
    release = resolve
  })
  const started = new Promise((resolve) => {
    start = resolve
  })
  t.mock.method(io, 'opendir', async (path, ...args) => {
    if (path === folder) {
      scans++
      if (scans === 1) {
        start()
        await held
      }
    }
    return opendir(path, ...args)
  })
  syncBuiltinESMExports()
  await rename(join(folder, 'note-0.md'), join(folder, 'renamed.md'))
  const changed = host.refreshWorkspace(['note-0.md', 'renamed.md'])
  await started
  try {
    for (let edit = 0; edit < 8; edit++) {
      await writeFile(join(folder, 'note-1.md'), String(edit))
      host.queueWatcherEvent(folder, initial.target, 'change', 'note-1.md')
      await host.reconcileWatcherEvents(folder, initial.target)
      await view.refresh()
    }
    assert.equal(pages, 0)
  } finally {
    release()
  }
  await changed
  // One deliberate unchanged scan also drains any already queued scan cohort.
  await host.refreshWorkspace()
  await view.refresh()
  assert.equal(scans, 2, 'one changed scan plus one explicit unchanged scan')
  assert.equal(host.getWorkspaceHeader().treeRevision, initial.treeRevision + 1)
  assert.equal(changes.filter((change) => change.kind === 'tree').length, 1)
  assert.equal(
    pages,
    2,
    'one two-page traversal; content and unchanged scans reuse it',
  )
  assert.equal(states.filter((state) => state?.treePending).length, 1)

  changes.length = 0
  const beforeMetadata = host.getWorkspaceHeader().treeRevision
  await mkdir(join(folder, '.hibi'))
  await writeFile(
    join(folder, '.hibi/workspace.json'),
    JSON.stringify({
      version: 1,
      name: 'updated name',
      description: '',
      icon: '',
      defaultFile: '',
    }),
  )
  await host.refreshWorkspace(['.hibi/workspace.json'])
  await view.refresh()
  assert.equal(changes.filter((change) => change.kind === 'tree').length, 1)
  assert.equal(host.getWorkspaceHeader().treeRevision, beforeMetadata)
  assert.equal(
    pages,
    2,
    'manifest notifications do not replay explorer entries',
  )
  assert.equal(states.at(-1).name, 'updated name')
})

test('watcher flush starts within one second while content events keep arriving', async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'hibi-watch-deadline-')),
  )
  globalThis.__viewProfile = root
  globalThis.__viewDocuments = []
  globalThis.__viewMaterializations = 0
  const folder = join(root, 'notes')
  await mkdir(folder)
  await writeFile(join(folder, 'one.md'), '')
  const fs = process.getBuiltinModule('node:fs')
  const io = process.getBuiltinModule('node:fs/promises')
  t.mock.method(fs, 'watch', () => ({
    on() {
      return this
    },
    close() {},
  }))
  syncBuiltinESMExports()
  t.after(async () => {
    try {
      const target = host.currentWorkspaceTarget()
      if (target) await host.deleteKnownWorkspace({}, target.workspaceId)
    } finally {
      host.observeWorkspace(() => {})
      t.mock.restoreAll()
      syncBuiltinESMExports()
      await rm(root, { recursive: true, force: true })
    }
  })
  await host.loadWorkspace(folder)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let now = 0
  t.mock.method(performance, 'now', () => now)
  const starts = []
  const lstat = io.lstat
  t.mock.method(io, 'lstat', (path, ...args) => {
    if (path === join(folder, '.hibi')) starts.push(now)
    return lstat(path, ...args)
  })
  syncBuiltinESMExports()
  const target = host.currentWorkspaceTarget()
  let published
  const changed = new Promise((resolve) => {
    published = resolve
  })
  host.observeWorkspace((change) => {
    if (change.kind === 'tree') published()
  })
  await writeFile(join(folder, 'new.md'), '')
  host.queueWatcherEvent(folder, target, 'rename', 'new.md')
  for (let event = 0; event < 6; event++) {
    now += 150
    t.mock.timers.tick(150)
    host.queueWatcherEvent(folder, target, 'change', 'one.md')
  }
  assert.deepEqual(starts, [])
  now = 999
  t.mock.timers.tick(99)
  assert.deepEqual(starts, [])
  now = 1000
  t.mock.timers.tick(1)
  assert.equal(starts[0], 1000)
  host.queueWatcherEvent(folder, target, 'change', 'one.md')
  await changed
  assert.ok(host.workspaceEntries().some((entry) => entry.path === 'new.md'))
})
