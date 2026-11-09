import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createServer } from 'vite'
import { fixtureVault } from './obsidian/harness.mjs'

let server, api, registry, cacheRoot
class Element extends EventTarget {
  children = []
  textContent = ''
  append(child) {
    child.remove()
    this.children.push(child)
    child.parent = this
  }
  prepend(child) {
    child.remove()
    this.children.unshift(child)
    child.parent = this
  }
  remove() {
    if (this.parent)
      this.parent.children = this.parent.children.filter(
        (child) => child !== this,
      )
    this.parent = null
  }
  setAttribute(name, value) {
    this[name] = value
  }
}
const windowEvents = new EventTarget()
test.before(async () => {
  cacheRoot = await mkdtemp(join(tmpdir(), 'hibi-workspace-api-cache-'))
  server = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    cacheDir: cacheRoot,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: 'custom',
  })
  api = await server.ssrLoadModule(
    '/src/addons/obsidian/api/workspace/index.ts',
  )
  registry = await server.ssrLoadModule('/src/addons/obsidian/api/registry.ts')
  globalThis.document = {
    body: new Element(),
    createElement: () => new Element(),
  }
  globalThis.addEventListener = windowEvents.addEventListener.bind(windowEvents)
  globalThis.removeEventListener =
    windowEvents.removeEventListener.bind(windowEvents)
})
test.after(async () => {
  await server.close()
  await rm(cacheRoot, { recursive: true, force: true })
  delete globalThis.document
  delete globalThis.addEventListener
  delete globalThis.removeEventListener
})

async function environment(t) {
  const fixture = await fixtureVault(t, 'workspace-api')
  const cleanups = [],
    panels = [],
    handlers = {}
  const file = { path: 'untouched.md', basename: 'untouched' }
  const other = { path: 'other.md', basename: 'other' }
  const first = {
    documentId: 'one',
    documentGeneration: 1,
    viewId: 'source',
    viewGeneration: 1,
  }
  const second = {
    documentId: 'one',
    documentGeneration: 1,
    viewId: 'rich',
    viewGeneration: 1,
  }
  const state = {
    active: first,
    targets: [first, second],
    activePath: file.path,
    path: file.path,
    stopped: 0,
  }
  const context = {
    app: {},
    register: (cleanup) => cleanups.push(cleanup),
    hibi: {
      documents: {
        listOpen: () => [
          {
            tabId: 'one',
            target: {
              documentId: 'one',
              documentGeneration: 1,
              contentVersion: 1,
            },
          },
        ],
        subscribe: (listener) => {
          handlers.document = listener
          return () => state.stopped++
        },
      },
      editorViews: {
        getActive: () => state.active,
        list: () => state.targets,
        onDidChangeActive: (listener) => {
          handlers.active = listener
          return () => state.stopped++
        },
      },
      workspace: {
        openFile: async (path) => {
          state.path = path
          state.activePath = path
        },
      },
      sidebar: {
        register: (view) => {
          const panel = { view, opened: 0, disposed: 0 }
          panels.push(panel)
          return { open: () => panel.opened++, dispose: () => panel.disposed++ }
        },
      },
    },
  }
  context.app.vault = {
    info: async () => ({
      activePath: state.activePath,
      documents: [{ tabId: 'one', path: state.path }],
    }),
    getFileByPath: (path) =>
      path === file.path ? file : path === other.path ? other : null,
  }
  context.app.metadataCache = {
    getFirstLinkpathDest: (path) => (path === 'other' ? other : null),
  }
  const workspace = new api.Workspace(context)
  context.app.workspace = workspace
  await workspace.start()
  t.after(() => {
    for (const cleanup of cleanups.reverse()) cleanup()
  })
  return {
    fixture,
    context,
    workspace,
    cleanups,
    panels,
    handlers,
    state,
    file,
    other,
    first,
    second,
  }
}

test('internal workspace refreshes cancel quietly on disposal and still report live failures', async (t) => {
  const errors = []
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'reportError')
  globalThis.reportError = (error) => errors.push(error)
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'reportError', previous)
    else delete globalThis.reportError
  })
  for (const stopped of [true, false]) {
    errors.length = 0
    const env = await environment(t)
    let reject, start
    const started = new Promise((resolve) => {
      start = resolve
    })
    const pending = new Promise((_resolve, rejectValue) => {
      reject = rejectValue
    })
    env.context.app.vault.info = async () => {
      start()
      return pending
    }
    const refresh = t.mock.method(env.workspace, 'refresh')
    const dispose = () => {
      for (const cleanup of env.cleanups.splice(0).reverse()) cleanup()
    }
    env.handlers.active()
    await started
    if (stopped) dispose()
    const error = new Error('Open this plugin vault again.')
    reject(error)
    await new Promise(setImmediate)
    assert.deepEqual(errors, stopped ? [] : [error])
    dispose()
    env.handlers.document()
    await new Promise(setImmediate)
    assert.equal(refresh.mock.calls.length, 1)
    await assert.rejects(
      env.workspace.openLinkText('other', 'untouched.md'),
      /stopped/,
    )
    await env.fixture.assertUnchanged()
  }
})

test('workspace maps active leaves to document identity and emits lifecycle changes', async (t) => {
  const env = await environment(t)
  const { workspace, state } = env
  const events = []
  for (const name of [
    'file-open',
    'active-leaf-change',
    'layout-change',
    'editor-change',
    'quit',
  ])
    workspace.on(name, (...args) => events.push([name, ...args]))
  let ready = 0
  workspace.onLayoutReady(() => ready++)
  assert.equal(ready, 1)
  assert.equal(workspace.getActiveFile(), env.file)
  const first = workspace.getLeaf()
  assert.equal(first.file(), env.file)
  assert.equal(first.target(), env.first)
  assert.equal(workspace.rootSplit.children.length, 2)
  assert.equal(workspace.rootSplit.getRoot(), workspace.rootSplit)
  class MarkdownView {
    constructor(leaf) {
      this.leaf = leaf
      this.file = leaf.file()
      this.editor = {}
    }
    getViewType() {
      return 'markdown'
    }
  }
  const views = new Map()
  const remove = workspace.setMarkdownViewFactory((leaf) => {
    if (!views.has(leaf)) views.set(leaf, new MarkdownView(leaf))
    return views.get(leaf)
  })
  assert.ok(workspace.getActiveViewOfType(MarkdownView) instanceof MarkdownView)
  assert.equal(workspace.activeEditor.file, env.file)
  assert.equal(workspace.getLeavesOfType('markdown').length, 2)
  state.active = env.second
  await workspace.refresh()
  assert.notEqual(workspace.getActiveLeaf(), first)
  assert.equal(
    events.filter(([name]) => name === 'active-leaf-change').length,
    1,
  )
  await workspace.openLinkText('other', 'untouched.md')
  assert.equal(workspace.getActiveFile(), env.other)
  assert.ok(
    events.some(([name, file]) => name === 'file-open' && file === env.other),
  )
  state.targets = [env.second]
  await workspace.refresh()
  assert.equal(first.target(), null)
  assert.ok(events.some(([name]) => name === 'layout-change'))
  workspace.trigger('editor-change', { editor: true })
  windowEvents.dispatchEvent(new Event('beforeunload'))
  assert.ok(events.some(([name]) => name === 'quit'))
  assert.ok(events.some(([name]) => name === 'editor-change'))
  await assert.rejects(
    workspace.openLinkText('missing', 'untouched.md'),
    /does not resolve/,
  )
  assert.throws(() => workspace.getLeaf('window'), /unsupported/)
  remove()
  assert.equal(workspace.activeEditor, null)
  await env.fixture.assertUnchanged()
})

test('handwritten ItemView plugin uses addon side panel and unloads exact registrations', async (t) => {
  const env = await environment(t)
  // Match the host order: services create first, then extend every plugin before onload.
  const contributions = await registry.createObsidianContributions(env.context)
  const contribution = contributions.find((item) => item.exports?.Workspace)
  class Plugin {
    cleanups = []
    register(cleanup) {
      this.cleanups.push(cleanup)
    }
  }
  const module = { exports: {} }
  new Function('require', 'module', env.fixture.plugin.main)(
    () => ({ Plugin, ...api }),
    module,
  )
  const plugin = new module.exports()
  plugin.app = env.context.app
  contribution.extendPlugin(plugin)
  await plugin.onload()
  const workspace = env.context.app.workspace
  assert.equal(env.panels.length, 1)
  assert.equal(env.panels[0].view.side, 'right')
  assert.equal(env.panels[0].opened, 1)
  assert.equal(
    plugin.leaf.view.contentEl.textContent,
    'Custom view hosted by Hibi.',
  )
  assert.equal(workspace.getLeavesOfType('fixture-panel')[0], plugin.leaf)
  const leaves = []
  workspace.iterateAllLeaves((leaf) => {
    leaves.push(leaf)
  })
  assert.equal(leaves.length, 3)
  for (const cleanup of plugin.cleanups.reverse()) cleanup()
  assert.equal(env.panels[0].disposed, 1)
  assert.equal(workspace.getLeavesOfType('fixture-panel').length, 0)
  await assert.rejects(
    plugin.leaf.setViewState({ type: 'fixture-panel' }),
    /Unsupported view type/,
  )
  await env.fixture.assertUnchanged()
})
