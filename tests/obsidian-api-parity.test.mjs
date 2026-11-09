import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'vite'
import { fakeDom } from './obsidian/dom.mjs'

async function modules(t) {
  const server = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: 'custom',
  })
  t.after(() => server.close())
  return (path) => server.ssrLoadModule('/src/addons/obsidian/' + path)
}

test('requestUrl preserves binary bodies, headers, shortcuts, content type and HTTP error policy', async (t) => {
  const load = await modules(t)
  const { createRequestUrl } = await load('api/core/network.ts')
  const { Component } = await load('api/core/component.ts')
  const owner = new Component()
  const calls = []
  let status = 200
  const bytes = new TextEncoder().encode('{"ok":"✓"}')
  const native = {
    async invoke(method, input) {
      calls.push({ method, input })
      return {
        status,
        headers: { 'x-fixture': 'yes' },
        arrayBuffer: bytes.buffer,
      }
    },
  }
  const requestUrl = createRequestUrl(owner, 'fixture', native.invoke)
  t.after(() => owner.unload())
  const body = new Uint8Array([0, 128, 255]).buffer
  const result = requestUrl({
    url: 'http://127.0.0.1/upload',
    method: 'PATCH',
    body,
    contentType: 'application/octet-stream',
    headers: { 'X-Token': 'fixture' },
  })
  const response = await result
  assert.equal(response.status, 200)
  assert.deepEqual(response.headers, { 'x-fixture': 'yes' })
  assert.deepEqual(new Uint8Array(response.arrayBuffer), bytes)
  assert.deepEqual(response.json, { ok: '✓' })
  assert.equal(await result.text, response.text)
  assert.deepEqual(await result.json, response.json)
  assert.deepEqual(await result.arrayBuffer, response.arrayBuffer)
  assert.equal(calls[0].method, 'requestUrl')
  assert.deepEqual(calls[0].input.request.body, body)
  assert.equal(calls[0].input.request.contentType, 'application/octet-stream')
  status = 404
  await assert.rejects(requestUrl('http://127.0.0.1/missing'), /404/)
  assert.equal(
    (await requestUrl({ url: 'http://127.0.0.1/missing', throw: false }))
      .status,
    404,
  )
  status = 302
  assert.equal(
    (await requestUrl('http://127.0.0.1/redirect-without-location')).status,
    302,
  )
  owner.unload()
  const before = calls.length
  await assert.rejects(requestUrl('http://127.0.0.1/stale'), /unloaded|cancel/i)
  assert.equal(calls.length, before)
})

test('protocol handlers decode parameters and unregister on component unload', async (t) => {
  const load = await modules(t)
  const { Plugin } = await load('api/core/plugin.tsx')
  const { Component } = await load('api/core/component.ts')
  fakeDom(t)
  const app = {}
  const owner = new Component()
  const plugin = new Plugin(
    app,
    { id: 'fixture' },
    { owner, hibi: {}, isCurrent: () => !owner.isUnloaded },
  )
  const seen = []
  plugin.registerObsidianProtocolHandler('fixture-action', (params) =>
    seen.push(params),
  )
  const { dispatchObsidianProtocol } = await load('api/protocol/index.ts')
  assert.equal(
    await dispatchObsidianProtocol(
      app,
      'obsidian://fixture-action?title=a%20b&flag&action=forged&__proto__=safe',
    ),
    true,
  )
  assert.equal(seen[0].action, 'fixture-action')
  assert.equal(seen[0].title, 'a b')
  assert.equal(seen[0].flag, 'true')
  assert.equal(seen[0].__proto__, 'safe')
  assert.equal(
    await dispatchObsidianProtocol(
      app,
      'hibi://obsidian/fixture-action?x=%E2%9C%93',
    ),
    true,
  )
  assert.equal(seen[1].x, '✓')
  owner.unload()
  assert.equal(
    await dispatchObsidianProtocol(app, 'obsidian://fixture-action'),
    false,
  )
  assert.equal(seen.length, 2)
})

test('core exports real moment with shared window identity and restores globals on unload', async (t) => {
  const load = await modules(t)
  const { createCoreApi } = await load('api/core/index.ts')
  const { Component } = await load('api/core/component.ts')
  const document = fakeDom(t)
  const owner = new Component()
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'moment')
  t.after(() => {
    owner.unload()
    if (previous) Object.defineProperty(globalThis, 'moment', previous)
    else Reflect.deleteProperty(globalThis, 'moment')
  })
  const api = createCoreApi(
    { owner, hibi: {}, isCurrent: () => true },
    {},
    { id: 'fixture', name: 'Fixture' },
  )
  assert.equal(typeof api.moment, 'function')
  assert.equal(api.moment, globalThis.moment)
  assert.equal(
    api.moment.utc('2024-02-29').add(1, 'year').format('YYYY-MM-DD'),
    '2025-02-28',
  )
  assert.equal(api.moment.duration(90, 'minutes').asHours(), 1.5)
  assert.equal(api.moment('2024-02-30', 'YYYY-MM-DD', true).isValid(), false)
  const { loadMomentLocale } = await load('api/moment/index.ts')
  await loadMomentLocale('fr')
  assert.equal(api.moment.locale('fr'), 'fr')
  assert.equal(api.moment('2024-01-01').format('MMMM'), 'janvier')
  api.moment.locale('en')
  assert.equal(document.head.children.length, 0)
  owner.unload()
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(globalThis, 'moment'),
    previous,
  )
})

test('protocol built-ins use current Hibi vault and preserve explicit empty values', async (t) => {
  const load = await modules(t)
  const { dispatchObsidianProtocol } = await load('api/protocol/index.ts')
  const { parseObsidianProtocol } = await load('api/protocol/parse.ts')
  const parsed = parseObsidianProtocol(
    'obsidian://fixture?flag&empty=&plus=a+b&encoded=a%2Bb',
  )
  assert.deepEqual(parsed, {
    flag: 'true',
    empty: '',
    plus: 'a b',
    encoded: 'a+b',
    action: 'fixture',
  })
  const calls = []
  const file = { path: 'created.md' }
  const app = {
    vault: {
      getName: () => 'Fixture',
      async create(path, text) {
        calls.push(['create', path, text])
        return file
      },
    },
    workspace: {
      async openLinkText(...args) {
        calls.push(['open', ...args])
      },
      getLeaf(newPane) {
        return {
          async openFile(value) {
            calls.push(['new', newPane, value])
          },
        }
      },
    },
  }
  assert.equal(
    await dispatchObsidianProtocol(app, 'obsidian://open?vault=Fixture'),
    true,
  )
  assert.deepEqual(calls, [])
  assert.equal(
    await dispatchObsidianProtocol(
      app,
      'obsidian://open?vault=Fixture&file=note',
    ),
    true,
  )
  assert.equal(
    await dispatchObsidianProtocol(
      app,
      'hibi://obsidian/new?name=created&content=',
    ),
    true,
  )
  assert.deepEqual(calls, [
    ['open', 'note', '', false],
    ['create', 'created.md', ''],
    ['new', false, file],
  ])
  await assert.rejects(
    dispatchObsidianProtocol(app, 'obsidian://open?vault=Other&file=secret'),
    /linked vault/,
  )
  await assert.rejects(
    dispatchObsidianProtocol(app, 'obsidian://search?query=needle'),
    /no Hibi equivalent/,
  )
})

test('calling Plugin.unload directly cancels its requests and refuses stale API references', async (t) => {
  const load = await modules(t)
  const { createCoreApi } = await load('api/core/index.ts')
  const { Component } = await load('api/core/component.ts')
  fakeDom(t)
  const owner = new Component()
  t.after(() => owner.unload())
  const pending = Promise.withResolvers()
  const calls = []
  window.hibi = {
    invokeAddonProfile(_addon, method, input) {
      calls.push({ method, input })
      return method === 'requestUrl' ? pending.promise : Promise.resolve()
    },
  }
  const api = createCoreApi(
    { owner, hibi: {}, isCurrent: () => !owner.isUnloaded },
    {},
    { id: 'fixture', name: 'Fixture' },
  )
  const plugin = new api.Plugin()
  const result = api.requestUrl('http://localhost')
  const cancelled = assert.rejects(result, /cancel|unload/i)
  plugin.unload()
  assert.equal(calls[1]?.method, 'cancelRequestUrl')
  await cancelled
  await assert.rejects(api.requestUrl('http://localhost/stale'), /unloaded/)
  assert.throws(
    () => plugin.registerObsidianProtocolHandler('stale', () => {}),
    /unloaded/,
  )
  pending.reject(new Error('late cancellation'))
})

test('protocol action names retain valid namespaced and encoded public API strings', async (t) => {
  const load = await modules(t)
  const { Plugin } = await load('api/core/plugin.tsx')
  const { Component } = await load('api/core/component.ts')
  const { dispatchObsidianProtocol } = await load('api/protocol/index.ts')
  const owner = new Component()
  t.after(() => owner.unload())
  const app = {}
  const plugin = new Plugin(
    app,
    { id: 'fixture' },
    { owner, hibi: {}, isCurrent: () => !owner.isUnloaded },
  )
  const seen = []
  for (const action of ['plugin.action.v1', 'résumé']) {
    plugin.registerObsidianProtocolHandler(action, (params) =>
      seen.push(params.action),
    )
    assert.equal(
      await dispatchObsidianProtocol(
        app,
        'obsidian://' + encodeURIComponent(action),
      ),
      true,
    )
    assert.equal(
      await dispatchObsidianProtocol(
        app,
        'hibi://obsidian/' + encodeURIComponent(action),
      ),
      true,
    )
  }
  assert.deepEqual(seen, [
    'plugin.action.v1',
    'plugin.action.v1',
    'résumé',
    'résumé',
  ])
})

test('reusing request options cannot change an earlier request HTTP error policy', async (t) => {
  const load = await modules(t)
  const { createRequestUrl } = await load('api/core/network.ts')
  const { Component } = await load('api/core/component.ts')
  const owner = new Component()
  t.after(() => owner.unload())
  const response = Promise.withResolvers()
  const requestUrl = createRequestUrl(owner, 'fixture', () => response.promise)
  const options = { url: 'http://localhost', throw: true }
  const first = requestUrl(options)
  options.throw = false
  const second = requestUrl(options)
  response.resolve({
    status: 404,
    headers: {},
    arrayBuffer: new ArrayBuffer(0),
  })
  await assert.rejects(first, /404/)
  assert.equal((await second).status, 404)
})
