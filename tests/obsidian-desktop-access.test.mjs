import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { createServer } from 'vite'
import { OBSIDIAN_DESKTOP as channels } from '../src/shared/obsidian-desktop.ts'

const hash = 'a'.repeat(64)
const plugin = () => ({
  manifest: {
    id: 'desktop',
    name: 'Desktop fixture',
    version: '1.0.0',
    minAppVersion: '1.0.0',
    author: 'Fixture author',
    description: 'Fixture.',
    isDesktopOnly: true,
  },
  hash,
  enabled: true,
  fullAccess: true,
})

async function setup(t, installed = []) {
  const listeners = new Map()
  const state = { installed, remote: [], reads: [], listeners }
  globalThis.__desktopAccessTest = state
  t.after(() => delete globalThis.__desktopAccessTest)
  const server = await createServer({
    configFile: false,
    appType: 'custom',
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: false, ws: false },
    ssr: { noExternal: ['electron', '@electron/remote'] },
    plugins: [
      {
        name: 'desktop-access-fixture',
        enforce: 'pre',
        resolveId(id, importer) {
          if (
            id === 'electron' ||
            id === '@electron/remote/main' ||
            (id === './native' && importer?.endsWith('/desktop-native.ts'))
          )
            return '\0desktop-test:' + id
        },
        load(id) {
          if (id === '\0desktop-test:electron')
            return `export const ipcMain = {on:(channel,callback)=>globalThis.__desktopAccessTest.listeners.set(channel,callback)}
          export class BrowserWindow {
            constructor(options){this.options=options;this.webContents={setWindowOpenHandler(){}}}
            once(_event,callback){this.closed=callback}
            isDestroyed(){return this.destroyed===true}
            destroy(){this.destroyed=true;this.closed?.()}
          }`
          if (id === '\0desktop-test:@electron/remote/main')
            return 'export const isInitialized = ()=>false; export const initialize=()=>globalThis.__desktopAccessTest.remote.push("initialize"); export const enable=(contents)=>globalThis.__desktopAccessTest.remote.push(contents.id)'
          if (id === '\0desktop-test:./native')
            return `export const obsidianGlobalStore = async()=>({store:{root:'/app-data/global',list:async()=>{const s=globalThis.__desktopAccessTest;if(s.listError)throw s.listError;return s.installed},enabledPackage:async(id,hash)=>{globalThis.__desktopAccessTest.reads.push([id,hash]);await globalThis.__desktopAccessTest.waiter?.();return {main:Buffer.from('module.exports = {}')}}}})`
        },
      },
    ],
  })
  t.after(() => server.close())
  const module = await server.ssrLoadModule(
    '/src/addons/obsidian/desktop-native.ts',
  )
  const events = []
  let current
  class Window extends EventEmitter {
    constructor(id, trusted = false) {
      super()
      this.id = id
      this.destroyed = false
      this.webContents = Object.assign(new EventEmitter(), {
        id,
        mainFrame: { url: 'app://hibi/index.html' },
        send: (channel, ...args) => {
          events.push([channel, ...args])
          if (channel === channels.capture) {
            queueMicrotask(() =>
              listeners.get(channels.captured)(
                event(this),
                args[0],
                { version: 1 },
                null,
              ),
            )
          }
        },
        getLastWebPreferences: () => ({
          sandbox: !trusted,
          contextIsolation: !trusted,
        }),
      })
    }
    isDestroyed() {
      return this.destroyed
    }
    isVisible() {
      return false
    }
    show() {}
    hide() {}
    destroy() {
      this.destroyed = true
      this.emit('closed')
    }
  }
  const event = (window = current) => ({
    sender: window.webContents,
    senderFrame: window.webContents.mainFrame,
  })
  current = new Window(
    1,
    installed.some((plugin) => plugin.fullAccess),
  )
  const order = []
  const hooks = {
    enabled: () => true,
    generation: () => 1,
    current: () => current,
    trusted: (wire) => {
      if (
        wire.sender !== current.webContents ||
        wire.senderFrame !== current.webContents.mainFrame
      )
        throw new Error('untrusted ipc sender')
    },
    prepare: async () => {
      order.push('prepare')
    },
    checkpoint: async () => {
      order.push('checkpoint')
    },
    create: (trusted) => {
      order.push('create')
      current = new Window(current.id + 1, trusted)
      queueMicrotask(async () => {
        await workspace.attach(current, trusted)
        if (state.waitReady) {
          state.waitReady()
          return
        }
        assert.deepEqual(workspace.restore(event()), {
          ui: { version: 1 },
          documents: ['kept buffer'],
        })
        workspace.ready(event())
      })
      return current
    },
    activate: (window) => {
      current = window
    },
    settled: () => {
      order.push('settled')
      state.settled?.()
    },
    documents: () => ['kept buffer'],
  }
  const workspace = new module.DesktopWorkspace(hooks)
  const settled = () =>
    new Promise((resolve) => {
      state.settled = resolve
    })
  return {
    state,
    listeners,
    module,
    capabilities: await server.ssrLoadModule(
      '/src/addons/obsidian/api/network/capabilities.ts',
    ),
    workspace,
    event,
    hooks,
    events,
    order,
    Window,
    current: () => current,
    settled,
  }
}

test('sandbox-only workspace never initializes remote and cannot acquire real Node code', async (t) => {
  const ctx = await setup(t)
  assert.equal(await ctx.workspace.initialize(), false)
  await ctx.workspace.attach(ctx.current(), false)
  assert.deepEqual(ctx.state.remote, [])
  const wire = ctx.event()
  ctx.listeners.get(channels.acquire)(wire, 'desktop', hash)
  assert.match(wire.returnValue.error, /no full computer access/)
  const forged = { sender: {}, senderFrame: {} }
  ctx.listeners.get(channels.acquire)(forged, 'desktop', hash)
  assert.match(forged.returnValue.error, /untrusted/)
})

test('only enabled/hash-granted packages reach Node; revocation invalidates require before destroying old realm', async (t) => {
  const ctx = await setup(t, [plugin()])
  assert.equal(await ctx.workspace.initialize(), true)
  await ctx.workspace.attach(ctx.current(), true)
  assert.deepEqual(ctx.state.remote, ['initialize', 1])
  for (const [id, value] of [
    ['other', hash],
    ['desktop', 'b'.repeat(64)],
  ]) {
    const wire = ctx.event()
    ctx.listeners.get(channels.acquire)(wire, id, value)
    assert.match(wire.returnValue.error, /no full computer access/)
  }
  const accepted = ctx.event()
  ctx.listeners.get(channels.acquire)(accepted, 'desktop', hash)
  assert.equal(accepted.returnValue.source, 'module.exports = {}')
  assert.match(accepted.returnValue.filename, /desktop\/a{64}\/main.js$/)
  const previous = ctx.current()
  ctx.state.installed = [{ ...plugin(), enabled: false, fullAccess: false }]
  const done = ctx.settled()
  ctx.workspace.changed('desktop')
  const refused = ctx.event()
  ctx.listeners.get(channels.acquire)(refused, 'desktop', hash)
  assert.match(refused.returnValue.error, /no full computer access/)
  await done
  assert.equal(previous.isDestroyed(), true)
  assert.equal(ctx.workspace.trusted, false)
  assert.deepEqual(ctx.order, ['prepare', 'checkpoint', 'create', 'settled'])
  assert.deepEqual(ctx.state.remote, ['initialize', 1])
})

test('desktop networking authority is minted per load, bound to sender and activation, and aborted on revoke', async (t) => {
  const ctx = await setup(t, [plugin()])
  await ctx.workspace.initialize()
  await ctx.workspace.attach(ctx.current(), true)
  const { requirePluginRequestCapability } = ctx.capabilities
  const wire = ctx.event()
  ctx.listeners.get(channels.acquire)(wire, 'desktop', hash)
  const token = wire.returnValue.capability
  const grant = requirePluginRequestCapability(
    'desktop',
    token,
    ctx.current().webContents.id,
  )
  assert.equal(grant.hash, hash)
  assert.throws(
    () =>
      requirePluginRequestCapability(
        'other',
        token,
        ctx.current().webContents.id,
      ),
    /missing or expired/,
  )
  assert.throws(
    () => requirePluginRequestCapability('desktop', token, 42),
    /missing or expired/,
  )
  ctx.hooks.generation = () => 2
  assert.throws(
    () =>
      requirePluginRequestCapability(
        'desktop',
        token,
        ctx.current().webContents.id,
      ),
    /missing or expired/,
  )
  assert.equal(grant.controller.signal.aborted, true)
  const reload = ctx.event()
  ctx.listeners.get(channels.acquire)(reload, 'desktop', hash)
  const current = requirePluginRequestCapability(
    'desktop',
    reload.returnValue.capability,
    ctx.current().webContents.id,
  )
  assert.notEqual(reload.returnValue.capability, token)
  ctx.state.installed = []
  const done = ctx.settled()
  ctx.workspace.changed('desktop')
  assert.equal(current.controller.signal.aborted, true)
  await done
})

test('first grant flushes before replacement and enables remote only on new trusted webContents', async (t) => {
  const ctx = await setup(t)
  await ctx.workspace.initialize()
  const previous = ctx.current()
  ctx.state.installed = [plugin()]
  const done = ctx.settled()
  ctx.workspace.changed('desktop')
  await done
  assert.equal(previous.isDestroyed(), true)
  assert.equal(ctx.workspace.trusted, true)
  assert.deepEqual(ctx.state.remote, ['initialize', 2])
  assert.deepEqual(ctx.order, ['prepare', 'checkpoint', 'create', 'settled'])
})

test('a new full-access grant in an already trusted workspace refreshes its execution realm', async (t) => {
  const ctx = await setup(t, [plugin()])
  await ctx.workspace.initialize()
  await ctx.workspace.attach(ctx.current(), true)
  const previous = ctx.current()
  ctx.state.installed = [
    plugin(),
    { ...plugin(), manifest: { ...plugin().manifest, id: 'second' } },
  ]
  ctx.workspace.changed('second', true)
  await new Promise(setImmediate)
  assert.notEqual(ctx.current(), previous)
  assert.equal(previous.isDestroyed(), true)
  assert.equal(ctx.workspace.trusted, true)
})

test('a disk read begun before revocation cannot restore the revoked grant', async (t) => {
  const ctx = await setup(t, [plugin()])
  let release, reached
  const paused = new Promise((resolve) => {
    release = resolve
  })
  const started = new Promise((resolve) => {
    reached = resolve
  })
  ctx.state.waiter = () => {
    reached()
    return paused
  }
  const initializing = ctx.workspace.initialize()
  await started
  ctx.state.installed = []
  ctx.workspace.changed('desktop')
  release()
  assert.equal(await initializing, false)
  const wire = ctx.event()
  ctx.listeners.get(channels.acquire)(wire, 'desktop', hash)
  assert.match(wire.returnValue.error, /no full computer access/)
})

test('unconfirmed flush keeps original realm and every buffer, without enabling remote', async (t) => {
  const ctx = await setup(t)
  await ctx.workspace.initialize()
  const previous = ctx.current()
  ctx.hooks.prepare = async () => {
    throw new Error('fixture journal failed')
  }
  ctx.state.installed = [plugin()]
  const done = ctx.settled()
  ctx.workspace.changed('desktop')
  await done
  assert.equal(ctx.current(), previous)
  assert.equal(previous.isDestroyed(), false)
  assert.equal(ctx.workspace.trusted, false)
  assert.deepEqual(ctx.state.remote, [])
  assert.ok(
    ctx.events.some(
      ([channel, message]) =>
        channel === channels.resume && /journal failed/.test(message),
    ),
  )
})

test('retired renderer cannot finish, abort or receive another renderer’s workspace handoff', async (t) => {
  const ctx = await setup(t)
  await ctx.workspace.initialize()
  const previous = ctx.current()
  ctx.hooks.trusted = (wire) => {
    if (
      wire.sender !== previous.webContents &&
      wire.sender !== ctx.current().webContents
    )
      throw new Error('untrusted ipc sender')
  }
  const creating = new Promise((resolve) => {
    ctx.state.waitReady = resolve
  })
  ctx.state.installed = [plugin()]
  const done = ctx.settled()
  ctx.workspace.changed('desktop')
  await creating
  const retired = ctx.event(previous)
  assert.equal(ctx.workspace.restore(retired), null)
  ctx.workspace.ready(retired)
  ctx.workspace.abort(retired, 'stale renderer')
  await new Promise(setImmediate)
  assert.equal(previous.isDestroyed(), false)
  assert.equal(ctx.order.includes('settled'), false)
  assert.deepEqual(ctx.workspace.restore(ctx.event()), {
    ui: { version: 1 },
    documents: ['kept buffer'],
  })
  ctx.workspace.ready(ctx.event())
  await done
  assert.equal(previous.isDestroyed(), true)
})

test('unverifiable startup inventory falls back to a sandbox and reports the failure', async (t) => {
  const ctx = await setup(t, [plugin()])
  ctx.state.listError = new Error('fixture unreadable grant store')
  const reports = []
  t.mock.method(console, 'error', (...args) => reports.push(args))
  assert.equal(await ctx.workspace.initialize(), false)
  await ctx.workspace.attach(ctx.current(), false)
  assert.deepEqual(ctx.state.remote, [])
  assert.match(String(reports[0]), /keeping the sandbox/)
})

test('failed revocation stays visibly pending and retries without losing the old buffers', {
  timeout: 5000,
}, async (t) => {
  const ctx = await setup(t, [plugin()])
  await ctx.workspace.initialize()
  await ctx.workspace.attach(ctx.current(), true)
  const previous = ctx.current()
  let failures = 1
  ctx.hooks.prepare = async () => {
    if (failures-- > 0) throw new Error('fixture unconfirmed edits')
  }
  ctx.state.installed = []
  const first = ctx.settled()
  ctx.workspace.changed('desktop')
  await first
  assert.equal(ctx.workspace.status.revoking, true)
  assert.equal(previous.isDestroyed(), false)
  const retry = ctx.settled()
  await retry
  assert.equal(previous.isDestroyed(), true)
  assert.equal(ctx.workspace.trusted, false)
  assert.equal(ctx.workspace.status.revoking, false)
})

test('previous trusted webContents cannot acquire Node during a trusted to trusted handoff', async (t) => {
  const ctx = await setup(t, [plugin()])
  await ctx.workspace.initialize()
  await ctx.workspace.attach(ctx.current(), true)
  const previous = ctx.current()
  ctx.hooks.trusted = (wire) => {
    if (
      wire.sender !== previous.webContents &&
      wire.sender !== ctx.current().webContents
    )
      throw new Error('untrusted ipc sender')
  }
  const creating = new Promise((resolve) => {
    ctx.state.waitReady = resolve
  })
  ctx.state.installed = [
    plugin(),
    { ...plugin(), manifest: { ...plugin().manifest, id: 'second' } },
  ]
  const done = ctx.settled()
  ctx.workspace.changed('second', true)
  await creating
  try {
    const retired = ctx.event(previous)
    ctx.listeners.get(channels.acquire)(retired, 'desktop', hash)
    assert.match(retired.returnValue.error, /no full computer access/)
  } finally {
    ctx.workspace.ready(ctx.event())
    await done
  }
})

test('consent challenges are single-use, hash-bound, expiry/lifetime checked', async (t) => {
  const ctx = await setup(t)
  const { fullAccessChallenge, consumeFullAccessChallenge } = ctx.module
  let alive = true
  const check = () => {
    if (!alive) throw new Error('fixture addon stopped')
  }
  const prompt = fullAccessChallenge(plugin(), check)
  assert.throws(
    () =>
      consumeFullAccessChallenge(prompt.token, {
        ...plugin(),
        hash: 'b'.repeat(64),
      }),
    /changed/,
  )
  assert.throws(
    () => consumeFullAccessChallenge(prompt.token, plugin()),
    /changed/,
  )
  const valid = fullAccessChallenge(plugin(), check)
  consumeFullAccessChallenge(valid.token, plugin())
  assert.throws(
    () => consumeFullAccessChallenge(valid.token, plugin()),
    /changed/,
  )
  const stopped = fullAccessChallenge(plugin(), check)
  alive = false
  assert.throws(
    () => consumeFullAccessChallenge(stopped.token, plugin()),
    /stopped/,
  )
  alive = true
  const expires = fullAccessChallenge(plugin(), check)
  const future = Date.now() + 120001
  t.mock.method(Date, 'now', () => future)
  assert.throws(
    () => consumeFullAccessChallenge(expires.token, plugin()),
    /changed/,
  )
})

test('remote popup constructors stay sandboxed and their renderer dies with the trusted parent', async (t) => {
  const ctx = await setup(t, [plugin()])
  await ctx.workspace.initialize()
  await ctx.workspace.attach(ctx.current(), true)
  const children = []
  for (const name of ['BrowserWindow', 'electron', 'electron/main']) {
    const event = {}
    ctx
      .current()
      .webContents.emit(
        name === 'BrowserWindow' ? 'remote-get-builtin' : 'remote-require',
        event,
        name,
      )
    const Constructor =
      name === 'BrowserWindow'
        ? event.returnValue
        : event.returnValue.BrowserWindow
    const child = new Constructor({
      webPreferences: {
        sandbox: false,
        contextIsolation: false,
        nodeIntegration: true,
      },
    })
    children.push(child)
    assert.equal(child.options.webPreferences.sandbox, true)
    assert.equal(child.options.webPreferences.contextIsolation, true)
    assert.equal(child.options.webPreferences.nodeIntegration, false)
    assert.equal(child.options.webPreferences.nodeIntegrationInWorker, false)
    assert.equal(child.options.webPreferences.nodeIntegrationInSubFrames, false)
  }
  ctx.current().webContents.emit('destroyed')
  for (const child of children) assert.equal(child.isDestroyed(), true)
})
