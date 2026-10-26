import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'

const index = await readFile(
  new URL('../src/main/index.ts', import.meta.url),
  'utf8',
)
const source = [
  'let fileOperation = null; let closing = false; let mainWindow = window;',
  index.slice(
    index.indexOf('function trustedWindow('),
    index.indexOf('async function serveAsset('),
  ),
  index.slice(
    index.lastIndexOf('handle(', index.indexOf('WORKSPACE_CHANNELS.readText,')),
    index.lastIndexOf('handle(', index.indexOf('WORKSPACE_CHANNELS.index,')),
  ),
].join('\n')
const target = { workspaceId: 'notes', workspaceGeneration: 1 }
const operations = {
  readText: ['readWorkspaceText', target, 'note.md'],
  readBinary: ['readWorkspaceBinary', target, 'image.bin'],
  createText: ['createWorkspaceText', target, 'new.md', '# new'],
  createBinary: [
    'createWorkspaceBinary',
    target,
    'new.bin',
    new Uint8Array([7]),
  ],
  updateText: [
    'updateWorkspaceText',
    target,
    'note.md',
    'version',
    '# replacement',
    { allowMetadataReset: true },
  ],
  renameFile: [
    'renameWorkspaceFile',
    target,
    'note.md',
    'renamed.md',
    'version',
  ],
  trashFile: ['trashWorkspaceFile', target, 'note.md', 'version'],
}
const reads = ['readText', 'readBinary']
const mutations = Object.keys(operations).filter(
  (name) => !reads.includes(name),
)
const unavailable = {
  ok: false,
  code: 'disposed',
  message: 'This addon is no longer active.',
}

function harness(t) {
  const frame = { url: 'app://hibi/' }
  const window = {
    webContents: {
      mainFrame: frame,
      send: (...args) => state.sent.push(args),
    },
  }
  const event = { sender: window.webContents, senderFrame: frame }
  const handlers = new Map()
  const state = {
    enabled: true,
    generation: 1,
    lookups: 0,
    calls: [],
    trashed: [],
    documentPath: '/notes/first.md',
    document: { revision: 1 },
    sent: [],
    started: Promise.withResolvers(),
    pause: null,
    result: {
      ok: true,
      value: { markdown: 'private', bytes: new Uint8Array([7]) },
    },
  }
  t.after(() => state.pause?.resolve())
  const bindings = {
    window,
    MEDIA_CHANNELS: { scopeChanged: 'media:scope-changed' },
    getDocumentPath: () => state.documentPath,
    getDocument: () => state.document,
    pendingFileOperations: new Set(),
    fileOperationHasDialog: () => false,
    fileOperationDialogOpened: () => null,
    withinFileOperation: async (operation) => operation(),
    rendererUrl: frame.url,
    isTrustedRendererUrl: (url, expected) => url === expected,
    handle: (channel, handler) => handlers.set(channel, handler),
    WORKSPACE_CHANNELS: Object.fromEntries(
      Object.keys(operations).map((name) => [name, name]),
    ),
    getAddonActivationGeneration: (id) => {
      assert.equal(id, 'example')
      state.lookups++
      return state.enabled ? state.generation : null
    },
    isAddonActivationCurrent: (id, generation) =>
      id === 'example' && state.enabled && generation === state.generation,
    shell: { trashItem: async (file) => state.trashed.push(file) },
  }
  for (const [name, [service]] of Object.entries(operations))
    bindings[service] = async (...args) => {
      state.calls.push(args)
      state.started.resolve()
      await state.pause?.promise
      return mutations.includes(name) && !args.at(-1)()
        ? unavailable
        : state.result
    }
  const host = new Function(
    ...Object.keys(bindings),
    stripTypeScriptTypes(source) +
      '; return { hold: pending => lockFileOperation(window, () => pending) }',
  )(...Object.values(bindings))
  return {
    ...host,
    state,
    invoke: async (name, owner = 'example') =>
      handlers.get(name)(event, owner, ...operations[name].slice(1)),
  }
}

test('a held document path change sends exactly one media scope notification', async (t) => {
  const h = harness(t)
  const changed = Promise.withResolvers()
  const release = Promise.withResolvers()
  t.after(release.resolve)
  const held = h.hold(
    Promise.resolve().then(async () => {
      h.state.documentPath = '/notes/renamed.md'
      h.state.document.revision = 2
      changed.resolve()
      await release.promise
    }),
  )
  const queued = h.hold(Promise.resolve())
  await changed.promise
  assert.deepEqual(h.state.sent, [])
  release.resolve()
  await Promise.all([held, queued])
  assert.deepEqual(h.state.sent, [['media:scope-changed', 2]])
})

for (const name of reads)
  for (const change of ['restart', 'disable'])
    test(`${name} discards a paused read after owner ${change}`, async (t) => {
      const h = harness(t)
      h.state.pause = Promise.withResolvers()
      const pending = h.invoke(name)
      await h.state.started.promise
      if (change === 'restart') h.state.generation++
      else h.state.enabled = false
      h.state.pause.resolve()
      assert.deepEqual(await pending, unavailable)
      assert.equal(h.state.calls.length, 1)
    })

for (const name of Object.keys(operations)) {
  test(`${name} preserves active request arguments and results`, async (t) => {
    const h = harness(t)
    assert.equal(await h.invoke(name), h.state.result)
    const args = h.state.calls[0]
    const forwarded = reads.includes(name) ? args : args.slice(0, -1)
    if (name === 'trashFile') {
      const trash = forwarded.pop()
      await trash('removed.md')
      assert.deepEqual(h.state.trashed, ['removed.md'])
    }
    assert.deepEqual(forwarded, operations[name].slice(1))
    assert.equal(h.state.lookups, 1)
  })

  test(`${name} refuses invalid and inactive owners before file work`, async (t) => {
    const h = harness(t)
    for (const owner of [null, {}, 7])
      assert.deepEqual(await h.invoke(name, owner), unavailable)
    assert.equal(h.state.lookups, 0)
    h.state.enabled = false
    assert.deepEqual(await h.invoke(name), unavailable)
    assert.equal(h.state.calls.length, 0)
  })

  for (const change of ['restart', 'disable'])
    test(`${name} captures its owner before waiting through ${change}`, async (t) => {
      const h = harness(t)
      const gate = Promise.withResolvers()
      t.after(gate.resolve)
      const held = h.hold(gate.promise)
      const pending = h.invoke(name)
      assert.equal(h.state.lookups, 1)
      assert.equal(h.state.calls.length, 0)
      if (change === 'restart') h.state.generation++
      else h.state.enabled = false
      gate.resolve()
      await held
      assert.deepEqual(await pending, unavailable)
      assert.equal(h.state.calls.length, 1)
      h.state.enabled = true
      assert.equal(await h.invoke(name), h.state.result)
    })
}

for (const name of mutations)
  for (const change of ['restart', 'disable'])
    test(`${name} keeps its commit guard tied to the captured owner after ${change}`, async (t) => {
      const h = harness(t)
      h.state.pause = Promise.withResolvers()
      const pending = h.invoke(name)
      await h.state.started.promise
      if (change === 'restart') h.state.generation++
      else h.state.enabled = false
      h.state.pause.resolve()
      assert.deepEqual(await pending, unavailable)
    })
