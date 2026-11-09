import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createServer } from 'vite'
import { fakeDom } from './obsidian/dom.mjs'

test('no-folder factories expose empty services and keep plugin classes and UI loadable', async (t) => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'hibi-empty-folder-api-'))
  t.after(() => rm(cacheDir, { recursive: true, force: true }))
  const events = new EventTarget()
  const globals = ['addEventListener', 'removeEventListener'].map((key) => [
    key,
    Object.getOwnPropertyDescriptor(globalThis, key),
  ])
  globalThis.addEventListener = events.addEventListener.bind(events)
  globalThis.removeEventListener = events.removeEventListener.bind(events)
  t.after(() => {
    for (const [key, descriptor] of globals)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
  })
  const server = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    cacheDir,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: 'custom',
  })
  t.after(() => server.close())
  for (const service of [
    'vault',
    'metadata',
    'workspace',
    'file-manager',
    'editor',
  ])
    await server.ssrLoadModule(
      '/src/addons/obsidian/api/' + service + '/index.ts',
    )
  fakeDom(t)
  const registry = await server.ssrLoadModule(
    '/src/addons/obsidian/api/registry.ts',
  )
  const cleanups = [],
    features = []
  const unexpected = () => {
    throw new Error('empty services must not access a folder')
  }
  const context = {
    app: {},
    register: (cleanup) => cleanups.push(cleanup),
    hibi: {
      workspace: { get: async () => null, subscribeChanges: unexpected },
      native: { query: unexpected, invoke: unexpected },
      documents: { listOpen: () => [], subscribe: unexpected },
      editorViews: {
        list: () => [],
        getActive: () => null,
        onDidChangeActive: unexpected,
      },
      editor: {
        onSyntaxChange: unexpected,
        registerSource: (feature) => {
          features.push(feature)
          return () => {}
        },
        registerFormatted: (feature) => {
          features.push(feature)
          return () => {}
        },
      },
      sidebar: { register: () => ({ open() {}, dispose() {} }) },
    },
  }
  t.after(() => {
    for (const cleanup of cleanups.reverse()) cleanup()
  })
  const contributions = await registry.createObsidianContributions(context)
  const api = Object.assign(
    {},
    ...contributions.map((contribution) => contribution.exports),
  )
  for (const name of [
    'Vault',
    'TAbstractFile',
    'TFile',
    'TFolder',
    'MetadataCache',
    'Workspace',
    'FileManager',
    'MarkdownView',
    'Editor',
    'ItemView',
  ])
    assert.equal(typeof api[name], 'function', name)
  const plugin = { register: (cleanup) => cleanups.push(cleanup) }
  for (const contribution of contributions) contribution.extendPlugin?.(plugin)
  const { vault, metadataCache, workspace, fileManager } = context.app
  assert.equal(vault.target, null)
  assert.equal(vault.configDir, undefined)
  assert.equal(vault.getName(), '')
  assert.ok(vault.getRoot() instanceof api.TFolder)
  assert.ok(vault.getRoot().isRoot())
  assert.deepEqual(vault.getRoot().children, [])
  assert.deepEqual(vault.getFiles(), [])
  assert.deepEqual(vault.getMarkdownFiles(), [])
  assert.equal(vault.getAbstractFileByPath(''), null)
  assert.equal(vault.getAbstractFileByPath('.obsidian/app.json'), null)
  assert.equal(await vault.adapter.exists('note.md'), false)
  assert.equal(await vault.adapter.stat('note.md'), null)
  assert.deepEqual(await vault.adapter.list(''), { files: [], folders: [] })
  const file = new api.TFile(vault, 'note.md')
  let called = false
  const operations = [
    () => vault.read(file),
    () => vault.cachedRead(file),
    () => vault.readBinary(file),
    () => vault.create('note.md', 'text'),
    () => vault.createBinary('image.png', new ArrayBuffer(1)),
    () => vault.createFolder('folder'),
    () => vault.modify(file, 'text'),
    () => vault.append(file, 'text'),
    () =>
      vault.process(file, (source) => {
        called = true
        return source + 'text'
      }),
    () => vault.rename(file, 'renamed.md'),
    () => vault.copy(file, 'copy.md'),
    () => vault.delete(file),
    () => vault.trash(file),
    () => vault.adapter.read('note.md'),
    () => vault.adapter.write('note.md', 'text'),
    () =>
      fileManager.processFrontMatter(file, (props) => {
        called = true
        props.title = 'text'
      }),
    () => fileManager.renameFile(file, 'renamed.md'),
    () => workspace.openLinkText('note', ''),
  ]
  for (const operation of operations)
    await assert.rejects(async () => operation(), /open a folder first/i)
  assert.equal(called, false)
  assert.throws(() => fileManager.getNewFileParent(''), /open a folder first/i)
  assert.equal(metadataCache.getCache('note.md'), null)
  assert.equal(metadataCache.getFileCache(file), null)
  assert.equal(metadataCache.getFirstLinkpathDest('note', ''), null)
  assert.deepEqual(Object.keys(metadataCache.resolvedLinks), [])
  assert.deepEqual(Object.keys(metadataCache.unresolvedLinks), [])
  assert.equal(workspace.getActiveFile(), null)
  assert.equal(workspace.getActiveLeaf(), null)
  assert.equal(workspace.activeEditor, null)
  assert.equal(workspace.getActiveViewOfType(api.MarkdownView), null)
  assert.deepEqual(workspace.getLeavesOfType('markdown'), [])
  assert.deepEqual(workspace.rootSplit.children, [])
  let ready = 0,
    fired = 0
  workspace.onLayoutReady(() => ready++)
  for (const name of [
    'file-open',
    'active-leaf-change',
    'layout-change',
    'editor-change',
    'quit',
  ])
    workspace.on(name, () => fired++)
  await workspace.refresh()
  workspace.trigger('editor-change')
  events.dispatchEvent(new Event('beforeunload'))
  assert.equal(ready, 1)
  assert.equal(fired, 0)
  // UI contributions remain usable without a folder.
  const leaf = workspace.getRightLeaf()
  class Panel extends api.ItemView {
    getViewType() {
      return 'empty-ui'
    }
  }
  const remove = workspace.registerView('empty-ui', (item) => new Panel(item))
  await leaf.setViewState({ type: 'empty-ui' })
  assert.ok(leaf.view instanceof Panel)
  leaf.detach()
  remove()
  assert.equal(fired, 0)
  assert.equal(features.length, 2)
  // The host recreates contributions when a folder opens; old handles stay empty.
  context.hibi.workspace.get = async () => ({
    id: 'next',
    workspaceGeneration: 2,
  })
  await assert.rejects(vault.create('later.md', 'text'), /open a folder first/i)
  assert.deepEqual(vault.getFiles(), [])
})
