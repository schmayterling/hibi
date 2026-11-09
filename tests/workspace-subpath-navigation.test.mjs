import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'
import { DocumentRuntime } from '../src/renderer/src/document-runtime.ts'
import { EditorViewRegistry } from '../src/renderer/src/editor-view-api.ts'

const host = {}
globalThis.__subpathNavigation = host
const compiled = await build({
  entryPoints: ['src/renderer/src/workspace-subpath.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  plugins: [
    {
      name: 'subpath-runtime',
      setup(builder) {
        builder.onResolve(
          {
            filter:
              /^\.\/(?:document-runtime|editor-view-api|workspace-syntax-snapshot)$/,
          },
          (args) =>
            args.importer.endsWith('workspace-subpath.ts')
              ? { path: args.path, namespace: 'subpath-runtime' }
              : null,
        )
        builder.onLoad({ filter: /.*/, namespace: 'subpath-runtime' }, () => ({
          contents:
            'export const documentRuntime=globalThis.__subpathNavigation.runtime; export const editorViewRegistry=globalThis.__subpathNavigation.registry; export const captureWorkspaceSyntaxSnapshot=()=>({version:1})',
          resolveDir: resolve('.'),
          loader: 'js',
        }))
      },
    },
  ],
})
const instantiate = () => {
  const module = { exports: {} }
  new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(
    createRequire(import.meta.url),
    module,
    module.exports,
  )
  return module.exports
}
function fixture() {
  const text = '\ufeff# H 😀\r\n\r\nblock 😀 ^id\r\n'
  const document = {
    tabId: 'one',
    tabs: [],
    tabsEnabled: true,
    id: 'note',
    ephemeral: false,
    markdown: text,
    savedMarkdown: text,
    name: 'note.md',
    dirty: false,
    revision: 1,
    contentVersion: 0,
    canAutosave: true,
  }
  host.runtime = new DocumentRuntime({
    enqueue: () => {},
    onError: (error) => {
      throw error
    },
  })
  host.runtime.activate(document)
  host.registry = new EditorViewRegistry(host.runtime)
  const viewId = host.runtime.primaryViewId('one')
  let anchor = 0,
    head = 0
  const revealed = []
  const adapter = {
    surface: () => null,
    read: () => ({
      contentVersion: host.runtime.session('one').snapshot().version,
      anchor,
      head,
      length: text.replaceAll('\r', '').length,
    }),
    setSelection: (a, h) => {
      anchor = a
      head = h
      return true
    },
    reveal: (p) => {
      revealed.push(p)
      return true
    },
  }
  host.registry.register('one', viewId, 'source', adapter)
  host.registry.setActive(viewId, 'source')
  const unmount = host.runtime.registerView('one', viewId)
  const target = { workspaceId: 'folder', workspaceGeneration: 1 }
  const reply = {
    ok: true,
    value: {
      kind: 'resolve-subpath',
      path: 'note.md',
      target,
      version: 'disk:1',
      stale: false,
      resolved: {
        type: 'block',
        id: 'id',
        position: {
          start: { line: 2, col: 0, offset: text.indexOf('block') },
          end: { line: 2, col: 12, offset: text.length - 2 },
        },
      },
    },
  }
  let current = true,
    release
  const request = []
  globalThis.window = {
    hibi: {
      getWorkspaceHeader: async () => ({ target, activePath: 'note.md' }),
      queryWorkspaceReferences: async (input) => {
        request.push(input)
        if (release) await release
        return reply
      },
    },
  }
  const api = instantiate()
  return {
    document,
    text,
    reply,
    request,
    revealed,
    adapter,
    unmount,
    ...api,
    read: () => ({ anchor, head }),
    setCurrent: (value) => {
      current = value
    },
    isCurrent: () => current,
    pause: () => {
      let resume
      release = new Promise((resolve) => {
        resume = resolve
      })
      return resume
    },
  }
}
test.after(() => {
  delete globalThis.window
  delete globalThis.__subpathNavigation
})

test('encoded wiki heading and block subpaths survive file navigation', () => {
  const { linkSubpath } = fixture()
  assert.equal(
    linkSubpath('obsidian-wiki:' + encodeURIComponent('nöte#^id')),
    '#^id',
  )
  assert.equal(
    linkSubpath('obsidian-wiki:' + encodeURIComponent('nöte#H 😀')),
    '#H 😀',
  )
  assert.equal(linkSubpath('note.md#^id'), '#^id')
  assert.equal(linkSubpath('note%23name.md'), null)
  assert.equal(linkSubpath('obsidian-wiki:%ZZ'), null)
})

test('block navigation converts raw CRLF/BOM/UTF16 coordinates to captured editor', async () => {
  const env = fixture()
  assert.equal(
    await env.revealWorkspaceSubpath(
      env.document,
      '#^id',
      true,
      [],
      env.isCurrent,
    ),
    true,
  )
  const expected = env.text
    .slice(0, env.text.indexOf('block'))
    .replaceAll('\r', '').length
  assert.deepEqual(env.read(), { anchor: expected, head: expected })
  assert.deepEqual(env.revealed, [expected])
  assert.equal(env.request[0].kind, 'resolve-subpath')
  assert.equal(env.request[0].subpath, '#^id')
})

test('late block navigation cannot move changed selection, pane or document', async () => {
  for (const change of [
    (env) => env.adapter.setSelection(2, 2),
    (env) => env.setCurrent(false),
    (env) => env.unmount(),
    (env) => {
      env.document.dirty = true
      env.reply.value.version = 'disk:old'
    },
  ]) {
    const env = fixture()
    const release = env.pause()
    const pending = env.revealWorkspaceSubpath(
      env.document,
      '#^id',
      true,
      [],
      env.isCurrent,
    )
    await Promise.resolve()
    await Promise.resolve()
    change(env)
    release()
    assert.equal(await pending, false)
    assert.deepEqual(env.revealed, [])
  }
})

test('lazy link actions preserve queued work, split focus guards and encoded anchors', async () => {
  const env = fixture()
  const opened = [],
    anchors = [],
    pending = [],
    waiting = []
  globalThis.window.hibi.openDocumentLink = async (href, revision) => {
    opened.push({ href, revision })
    return { ...env.document, tabId: 'next', revision: 2 }
  }
  const context = {
    busy: { current: true },
    split: { current: null },
    focusPending: { current: false },
    document: { current: env.document },
    wait: (key, run) => waiting.push({ key, run }),
    focus: async () => {},
    open: (operation) => {
      const promise = operation()
      pending.push(promise)
      return promise.then(() => {})
    },
    anchor: (value) => anchors.push(value),
    hashtags: true,
    projections: [],
  }
  const href = 'obsidian-wiki:' + encodeURIComponent('other#^id')
  await env.openWorkspaceLink(href, 'one', 'left', context)
  assert.equal(waiting[0].key, 'link')
  assert.deepEqual(opened, [])
  waiting[0].run(false)
  assert.deepEqual(opened, [])
  context.busy.current = false
  await waiting[0].run(true)
  await Promise.all(pending)
  assert.deepEqual(opened, [{ href, revision: 1 }])
  assert.deepEqual(anchors, [{ tabId: 'next', revision: 2, anchor: '#^id' }])
  context.split.current = { left: 'other', right: 'one', active: 'left' }
  let focused = 0
  context.focus = async () => {
    focused++
    context.split.current = {
      left: 'other',
      right: 'replacement',
      active: 'right',
    }
  }
  await env.openWorkspaceLink(href, 'one', 'right', context)
  assert.equal(focused, 1)
  assert.equal(opened.length, 1)
})
