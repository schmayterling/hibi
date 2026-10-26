import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'

const [index, addons] = await Promise.all([
  readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/main/addons.ts', import.meta.url), 'utf8'),
])
// Exercise the registered IPC handler and its actual lock/authorization code,
// without starting Electron or loading native addons.
const source = [
  'let fileOperation = null; let closing = false; let mainWindow = window;',
  index.slice(
    index.indexOf('function trustedWindow('),
    index.indexOf('const addonFileUnavailable'),
  ),
  index.slice(
    index.indexOf('const fileOperationUnavailable'),
    index.indexOf('async function serveAsset('),
  ),
  addons
    .slice(
      addons.indexOf('export function currentAddonOwner('),
      addons.indexOf('export function isAddonActivationCurrent('),
    )
    .replace('export function', 'function'),
  addons
    .slice(addons.indexOf('export async function invokeAddon('))
    .replace('export async function', 'async function'),
  index.slice(
    index.lastIndexOf('handle(', index.indexOf('ADDON_CHANNELS.invoke,')),
    index.lastIndexOf('handle(', index.indexOf('ADDON_CHANNELS.query,')),
  ),
  index.slice(
    index.lastIndexOf('handle(', index.indexOf('ADDON_CHANNELS.profile,')),
    index.lastIndexOf('handle(', index.indexOf('ADDON_WINDOW_CHANNELS.open,')),
  ),
].join('\n')
const deferred = () => {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function harness() {
  const frame = { url: 'app://hibi/' }
  const window = {
    webContents: {
      mainFrame: frame,
      send: (...args) => state.sent.push(args),
    },
  }
  const event = { sender: window.webContents, senderFrame: frame }
  const state = {
    enabled: true,
    generation: 1,
    lookups: 0,
    calls: [],
    profileCalls: [],
    dialog: false,
    loadGate: null,
    loads: 0,
    documentPath: '/notes/first.md',
    sent: [],
    document: { tabId: 'first', revision: 1 },
    workspace: Object.freeze({ workspaceId: 'first', workspaceGeneration: 1 }),
  }
  const handlers = new Map()
  const noop = () => null
  const bindings = {
    window,
    MEDIA_CHANNELS: { scopeChanged: 'media:scope-changed' },
    getDocumentPath: () => state.documentPath,
    pendingFileOperations: new Set(),
    fileOperationHasDialog: () => state.dialog,
    fileOperationDialogOpened: noop,
    withinFileOperation: async (operation) => operation(),
    rendererUrl: frame.url,
    isTrustedRendererUrl: (url, expected) => url === expected,
    handle: (channel, invoke) => {
      handlers.set(channel, invoke)
    },
    ADDON_CHANNELS: { invoke: 'addons:invoke', profile: 'addons:profile' },
    getAddonActivationGeneration: (id) => {
      assert.equal(typeof id, 'string')
      state.lookups++
      return state.enabled ? state.generation : null
    },
    isAddonActivationCurrent: (_id, generation) =>
      state.enabled && generation === state.generation,
    nativeAddon: async () => {
      state.loads++
      await state.loadGate?.promise
      return {
        profileMethods: {
          async run(input) {
            state.profileCalls.push(input.name)
            input.started?.resolve()
            await input.blocked?.promise
            return input.name
          },
        },
        methods: {
          async run(input) {
            state.calls.push(input.name)
            input.started?.resolve()
            await input.blocked?.promise
            if (input.fail) throw new Error('native failure')
            return input.name
          },
        },
      }
    },
    getDocument: () => state.document,
    getDocumentSource: () => ({
      snapshot: () => ({ document: state.document }),
    }),
    currentWorkspaceTarget: () => state.workspace,
    workspaceId: noop,
    workspaceRoot: noop,
    hasUnsavedDocuments: () => false,
  }
  const host = new Function(
    ...Object.keys(bindings),
    stripTypeScriptTypes(source) +
      '; return { hold: pending => lockFileOperation(window, () => pending), setWindow: value => { mainWindow = value }, pending: pendingFileOperations, close: async () => { closing = true; ' +
      index.match(
        /while \(pendingFileOperations.size\)\s+await Promise.all\(pendingFileOperations\)/,
      )[0] +
      ' } }',
  )(...Object.values(bindings))
  return {
    ...host,
    state,
    invoke: async (input, id = 'quick-note') =>
      handlers.get('addons:invoke')(event, id, 'run', input),
    profile: async (input, method = 'run') =>
      handlers.get('addons:profile')(event, 'quick-note', method, input),
  }
}

test('main addon invokes wait for file work and serialize after a rejected invoke', async () => {
  const h = harness()
  const capture = deferred()
  const first = deferred()
  const started = deferred()
  const held = h.hold(capture.promise)
  let settled = 0
  const requests = [
    h.invoke({ name: 'first', blocked: first, started, fail: true }),
    h.invoke({ name: 'second' }),
  ].map((request) =>
    request.then(
      (value) => {
        settled++
        return value
      },
      (error) => {
        settled++
        return error
      },
    ),
  )
  try {
    await setImmediate()
    assert.equal(settled, 0)
    assert.deepEqual(h.state.calls, [])
    capture.resolve()
    await held
    await started.promise
    assert.deepEqual(h.state.calls, ['first'])
    first.resolve()
    const [failure, success] = await Promise.all(requests)
    assert.match(failure.message, /native failure/)
    assert.equal(success, 'second')
    assert.equal(await h.invoke({ name: 'third' }), 'third')
    assert.deepEqual(h.state.calls, ['first', 'second', 'third'])
  } finally {
    capture.resolve()
    first.resolve()
    await Promise.all(requests)
  }
})

test('a queued addon invoke rechecks the current window', async () => {
  const h = harness()
  const capture = deferred()
  const held = h.hold(capture.promise)
  const request = h.invoke({ name: 'closed' }).catch((error) => error)
  h.setWindow(null)
  capture.resolve()
  await held
  assert.match((await request).message, /untrusted ipc sender/)
  assert.equal(h.state.loads, 0)
})

test('queued addon invokes cannot move to another document or workspace', async () => {
  for (const change of ['tab', 'document', 'workspace', 'generation']) {
    const h = harness()
    const capture = deferred()
    const held = h.hold(capture.promise)
    const request = h.invoke({ name: change }).catch((error) => error)
    if (change === 'tab') h.state.document = { tabId: 'second', revision: 1 }
    if (change === 'document')
      h.state.document = { tabId: 'first', revision: 2 }
    if (change === 'workspace')
      h.state.workspace = Object.freeze({
        workspaceId: 'second',
        workspaceGeneration: 2,
      })
    if (change === 'generation')
      h.state.workspace = Object.freeze({
        workspaceId: 'first',
        workspaceGeneration: 2,
      })
    capture.resolve()
    await held
    const result = await request
    assert.ok(result instanceof Error, change)
    assert.match(result.message, /document or workspace changed/, change)
    assert.equal(h.state.loads, 0, change)
    assert.equal(await h.invoke({ name: 'current' }), 'current')
  }
})

test('a queued addon invoke cannot cross an addon reactivation', async () => {
  const h = harness()
  const capture = deferred()
  const held = h.hold(capture.promise)
  const request = h
    .invoke({ name: 'previous activation' })
    .catch((error) => error)
  h.state.enabled = false
  h.state.generation++
  h.state.enabled = true
  capture.resolve()
  await held
  const result = await request
  assert.ok(result instanceof Error)
  assert.match(result.message, /disabled/)
  assert.equal(h.state.loads, 0)
  assert.equal(
    await h.invoke({ name: 'current activation' }),
    'current activation',
  )
})

test('invalid addon ids reject before activation lookup', async () => {
  const h = harness()
  await assert.rejects(h.invoke({}, {}), /Enable this addon/)
  assert.equal(h.state.lookups, 0)
})

test('a queued addon invoke rechecks addon authorization', async () => {
  const h = harness()
  const capture = deferred()
  const held = h.hold(capture.promise)
  const request = h.invoke({ name: 'disabled' }).catch((error) => error)
  h.state.enabled = false
  capture.resolve()
  await held
  assert.match((await request).message, /This addon was disabled/)
  assert.equal(h.state.loads, 0)
})

test('profile storage commits while a file dialog holds document operations', async () => {
  const h = harness()
  const gate = deferred()
  const held = h.hold(gate.promise)
  h.state.dialog = true
  try {
    assert.equal(await h.profile({ name: 'stored' }), 'stored')
    assert.deepEqual(h.state.profileCalls, ['stored'])
    await assert.rejects(
      h.invoke({ name: 'file action' }),
      /file operation is in progress/,
    )
    await assert.rejects(h.profile({}, 'constructor'), /does not support/)
  } finally {
    gate.resolve()
    await held
  }
})

test('profile storage rechecks sender and activation after loading its native handler', async () => {
  const h = harness()
  const gate = deferred()
  h.state.loadGate = gate
  const pending = h.profile({ name: 'old activation' }).catch((error) => error)
  await setImmediate()
  h.state.generation++
  gate.resolve()
  assert.match((await pending).message, /disabled/)
  assert.deepEqual(h.state.profileCalls, [])
  h.state.loadGate = null
  assert.equal(await h.profile({ name: 'current' }), 'current')
  h.setWindow(null)
  await assert.rejects(
    h.profile({ name: 'closed window' }),
    /untrusted ipc sender/,
  )
})

test('window close drains a pending profile commit and rejects later requests', async () => {
  const h = harness()
  const gate = deferred()
  const started = deferred()
  const pending = h.profile({ name: 'durable commit', blocked: gate, started })
  await started.promise
  assert.equal(h.pending.size, 1)
  let closed = false
  const closing = h.close().then(() => {
    closed = true
  })
  await setImmediate()
  assert.equal(closed, false)
  await assert.rejects(
    h.profile({ name: 'too late' }),
    /file operation is in progress/,
  )
  gate.resolve()
  assert.equal(await pending, 'durable commit')
  await closing
  assert.equal(h.pending.size, 0)
})
