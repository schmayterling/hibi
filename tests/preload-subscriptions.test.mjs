import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const evaluate = new Function(
  'require',
  'process',
  await readFile(new URL('../out/preload/index.cjs', import.meta.url), 'utf8'),
)

const evaluateAddonWindow = new Function(
  'require',
  'process',
  await readFile(
    new URL('../out/preload/addon-window.cjs', import.meta.url),
    'utf8',
  ),
)

test('garden startup requests survive an immediately disposed subscription', async () => {
  const pending = [{ id: 'typing-speed', install: true }]
  const transport = Object.assign(new EventEmitter(), {
    invoke: async (channel) =>
      channel === 'addons:garden-requests' ? pending.splice(0) : null,
    send() {},
  })
  const exposed = new Map()
  evaluate(
    () => ({
      ipcRenderer: transport,
      contextBridge: { exposeInMainWorld: exposed.set.bind(exposed) },
    }),
    { isMainFrame: true },
  )
  const api = exposed.get('hibiTransport')
  const discarded = [],
    received = []
  const stop = api.onAddonGardenRequest((value) => discarded.push(value))
  stop()
  const keep = api.onAddonGardenRequest((value) => received.push(value))
  await new Promise((done) => setImmediate(done))
  assert.deepEqual(discarded, [])
  assert.deepEqual(received, [{ id: 'typing-speed', install: true }])
  assert.equal(transport.listenerCount('addons:garden-pending'), 1)
  keep()
  assert.equal(transport.listenerCount('addons:garden-pending'), 0)
})

for (const [method, channel, arity = 1] of [
  ['onAddonReload', 'addons:reload'],
  ['onGlobalShortcut', 'global-shortcut:invoked'],
  ['onUpdateChanged', 'updates:changed'],
  ['onAddonStorageChanged', 'addon-storage:changed'],
  ['onWorkspaceListChanged', 'workspace:list-changed'],
  ['onAddonHotkeysChanged', 'addon-hotkeys:changed'],
  ['onAddonCommand', 'addon-hotkeys:invoke'],
  ['onCommand', 'app:command'],
  ['onAddonWindowClosed', 'addon-windows:closed', 2],
  ['onOpenSettings', 'background:settings', 0],
  ['onExternalDocuments', 'document:external-pending', 0],
  ['onStates', 'addon-windows:states-changed'],
])
  test(`${method} strips events and disposes only its own subscription`, () => {
    const transport = Object.assign(new EventEmitter(), {
      invoke: async () => null,
      send() {},
    })
    const exposed = new Map()
    const preload = method === 'onStates' ? evaluateAddonWindow : evaluate
    preload(
      () => ({
        ipcRenderer: transport,
        contextBridge: { exposeInMainWorld: exposed.set.bind(exposed) },
      }),
      { isMainFrame: true },
    )
    const api =
      method === 'onStates'
        ? exposed.get('hibiAddonWindow').seal()
        : exposed.get('hibiTransport')
    const initialListeners = transport.listenerCount(channel)
    const calls = []
    const callback = (...args) => calls.push(args)
    const stop = api[method](callback)
    const keep = api[method](callback)
    const event = { sender: transport }
    const payload = Object.freeze({ id: 'probe' })
    const expected = [payload, 'extra'].slice(0, arity)
    transport.emit(channel, event, payload, 'extra')
    assert.deepEqual(calls, [expected, expected])
    assert.equal(calls[0][0], expected[0])
    assert.equal(stop(), undefined)
    stop()
    assert.equal(transport.listenerCount(channel), initialListeners + 1)
    transport.emit(channel, event, payload, 'extra')
    assert.deepEqual(calls, [expected, expected, expected])
    keep()
    transport.emit(channel, event, payload)
    assert.equal(transport.listenerCount(channel), initialListeners)
    assert.equal(calls.length, 3)
  })
