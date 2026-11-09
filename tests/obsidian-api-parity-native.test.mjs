import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer, request } from 'node:http'
import test from 'node:test'
import { createServer as createViteServer } from 'vite'

async function modules(t) {
  const server = await createViteServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: 'custom',
    ssr: { noExternal: ['electron'] },
    plugins: [
      {
        name: 'parity-native-electron-fixture',
        enforce: 'pre',
        resolveId(id) {
          if (id === 'electron') return '\0parity-electron'
        },
        load(id) {
          if (id === '\0parity-electron')
            return 'export const net = { request() { throw new Error("Transport started after cancellation") } }'
        },
      },
    ],
  })
  t.after(() => server.close())
  return (path) =>
    server.ssrLoadModule(
      path === 'electron' ? path : '/src/addons/obsidian/api/' + path,
    )
}

test('native transport preserves binary over local HTTP and validates requests before sending', async (t) => {
  const load = await modules(t)
  const { requestBytes, validateRequest } = await load('network/transport.ts')
  let hits = 0
  const server = createServer(async (req, res) => {
    hits++
    const parts = []
    for await (const part of req) parts.push(part)
    res.setHeader('X-Fixture', 'native')
    res.end(Buffer.concat(parts))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  const url = 'http://127.0.0.1:' + server.address().port
  const netRequest = (options) =>
    request(options.url, { method: options.method, headers: options.headers })
  const bytes = new Uint8Array([0, 128, 255]).buffer
  const response = await requestBytes(
    { url, method: 'PATCH', body: bytes },
    netRequest,
    new AbortController().signal,
  )
  assert.deepEqual([...new Uint8Array(response.arrayBuffer)], [0, 128, 255])
  assert.equal(response.headers['x-fixture'], 'native')
  assert.equal(response.status, 200)
  assert.equal(hits, 1)
  assert.equal(
    validateRequest({ url, method: 'custom-Verb' }).options.method,
    'custom-Verb',
  )
  const normalized = validateRequest({
    url,
    contentType: 'fallback',
    headers: { 'content-type': 'explicit' },
  })
  assert.deepEqual(normalized.options.headers, { 'content-type': 'explicit' })
  for (const input of [
    { url: 'file:///private' },
    { url, method: 'GET\r\n' },
    { url, headers: { X: 'bad\r\nInjected: yes' } },
    { url, body: { bad: true } },
    { url, contentType: 'bad\n' },
    { url, headers: ['bad'] },
  ])
    assert.throws(() => validateRequest(input))
  assert.equal(hits, 1)
})

test('native transport bounds bodies, responses, time and redirects and handles disconnects', {
  timeout: 5000,
}, async (t) => {
  const load = await modules(t)
  const { requestBytes, REQUEST_LIMITS, validateRequest } = await load(
    'network/transport.ts',
  )
  const limits = {
    ...REQUEST_LIMITS,
    bodyBytes: 4,
    responseBytes: 4,
    redirects: 1,
  }
  assert.throws(
    () => validateRequest({ url: 'http://localhost', body: '12345' }, limits),
    /body limit/,
  )
  const server = createServer((req, res) => {
    if (req.url === '/large') res.end('12345')
    else if (req.url === '/disconnect') req.socket.destroy()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  const base = 'http://127.0.0.1:' + server.address().port
  const netRequest = (options) =>
    request(options.url, { method: options.method })
  await assert.rejects(
    requestBytes({ url: base + '/large' }, netRequest, t.signal, limits),
    /response limit/,
  )
  await assert.rejects(
    requestBytes({ url: base + '/hang' }, netRequest, t.signal, {
      ...limits,
      timeoutMs: 20,
    }),
    /time limit/,
  )
  await assert.rejects(
    requestBytes({ url: base + '/disconnect' }, netRequest, t.signal, limits),
    /socket|closed|reset/i,
  )
  const client = new EventEmitter()
  let aborted = 0
  client.abort = () => {
    aborted++
  }
  client.followRedirect = () => {
    client.emit('redirect', 302, 'GET', 'http://localhost/again')
  }
  client.end = () => {
    client.emit('redirect', 302, 'GET', 'http://localhost/first')
  }
  await assert.rejects(
    requestBytes({ url: base }, () => client, t.signal, limits),
    /redirect limit/,
  )
  assert.equal(aborted, 1)
  const signal = new AbortController()
  client.end = () => signal.abort()
  await assert.rejects(
    requestBytes({ url: base }, () => client, signal.signal),
    /cancel/i,
  )
  assert.equal(aborted, 2)
})

test('native protocol queue retains cold links, resolves pending subscriptions and cancels exactly one lifetime', async (t) => {
  const load = await modules(t)
  const queue = await load('protocol/native.ts')
  t.after(() => queue.stopObsidianProtocol())
  const first = { requestId: '11111111-1111-4111-8111-111111111111' }
  const second = { requestId: '22222222-2222-4222-8222-222222222222' }
  assert.equal(
    queue.queueObsidianProtocol('hibi://obsidian/fixture?flag', () => true),
    true,
  )
  assert.equal(
    await queue.nextObsidianProtocol(first, () => true),
    'hibi://obsidian/fixture?flag',
  )
  assert.equal(
    queue.queueObsidianProtocol('javascript:alert(1)', () => true),
    false,
  )
  const pending = queue.nextObsidianProtocol(first, () => true)
  await queue.cancelObsidianProtocol(second)
  queue.queueObsidianProtocol('obsidian://fixture?live', () => true)
  assert.equal(await pending, 'obsidian://fixture?live')
  const cancelled = queue.nextObsidianProtocol(second, () => true)
  await queue.cancelObsidianProtocol(second)
  assert.equal(await cancelled, null)
  const stopped = queue.nextObsidianProtocol(first, () => true)
  queue.stopObsidianProtocol()
  assert.equal(await stopped, null)
})

test('renderer cancellation rejects immediately and sends main cancellation before pending authorization settles', async (t) => {
  const load = await modules(t)
  const { Component } = await load('core/component.ts')
  const { createRequestUrl } = await load('network/index.ts')
  const owner = new Component()
  const pending = Promise.withResolvers()
  const calls = []
  const requestUrl = createRequestUrl(owner, 'fixture', (method, input) => {
    calls.push({ method, input })
    return method === 'requestUrl' ? pending.promise : Promise.resolve()
  })
  const response = requestUrl('http://localhost')
  owner.unload()
  await assert.rejects(response, /cancel|unload/i)
  assert.equal(calls[1].method, 'cancelRequestUrl')
  assert.equal(calls[0].input.requestId, calls[1].input.requestId)
  pending.reject(new Error('late native cancellation'))
})

test('Electron upload stream close before response does not abort the HTTP transaction', async (t) => {
  const load = await modules(t)
  const { requestBytes } = await load('network/transport.ts')
  const client = new EventEmitter()
  client.abort = () => assert.fail('upload finish must not abort HTTP')
  client.end = () => {
    client.emit('close')
    queueMicrotask(() => {
      const response = new EventEmitter()
      response.statusCode = 200
      response.headers = {}
      client.emit('response', response)
      response.emit('data', Buffer.from('ok'))
      response.emit('end')
    })
  }
  const result = await requestBytes(
    { url: 'http://localhost' },
    () => client,
    new AbortController().signal,
  )
  assert.equal(new TextDecoder().decode(result.arrayBuffer), 'ok')
})

test('native cancellation during authorization never starts transport and stop cancels every pending request', async (t) => {
  const load = await modules(t)
  const native = await load('network/native.ts')
  const capabilities = await load('network/capabilities.ts')
  t.after(() => native.stopRequestUrls())
  const capability = capabilities.mintPluginRequestCapability(
    'fixture',
    'a'.repeat(64),
    { senderId: 7, isCurrent: () => true },
  )
  const authorization = Promise.withResolvers()
  const input = {
    id: 'fixture',
    capability,
    requestId: crypto.randomUUID(),
    request: { url: 'http://localhost' },
  }
  const pending = native.requestUrlNative(input, () => authorization.promise, 7)
  await native.cancelRequestUrl(input, 7)
  authorization.resolve()
  await assert.rejects(pending, /abort|cancel/i)
  const second = Promise.withResolvers()
  const stopped = native.requestUrlNative(
    { ...input, requestId: crypto.randomUUID() },
    () => second.promise,
    7,
  )
  native.stopRequestUrls()
  second.resolve()
  await assert.rejects(stopped, /abort|cancel/i)
})

test('redirects to file and app schemes never reach followRedirect', async (t) => {
  const load = await modules(t)
  const { requestBytes } = await load('network/transport.ts')
  for (const url of ['file:///private/fixture', 'app://hibi/index.html']) {
    const client = new EventEmitter()
    let followed = 0
    client.abort = () => {}
    client.end = () => client.emit('redirect', 302, 'GET', url)
    client.followRedirect = () => {
      followed++
      const response = new EventEmitter()
      response.statusCode = 200
      response.headers = {}
      client.emit('response', response)
      response.emit('end')
    }
    await assert.rejects(
      requestBytes(
        { url: 'http://localhost' },
        () => client,
        new AbortController().signal,
      ),
      /HTTP or HTTPS/,
    )
    assert.equal(followed, 0)
  }
})

test('cold protocol queue expires old links and refuses links clicked while disabled', async (t) => {
  const load = await modules(t)
  const queue = await load('protocol/native.ts')
  t.after(() => queue.stopObsidianProtocol())
  let now = 1000
  t.mock.method(Date, 'now', () => now)
  const subscription = { requestId: crypto.randomUUID() }
  assert.equal(
    queue.queueObsidianProtocol('hibi://obsidian/stale', () => true, now),
    true,
  )
  now += 60000
  const pending = queue.nextObsidianProtocol(subscription, () => true)
  queue.queueObsidianProtocol('hibi://obsidian/fresh', () => true, now)
  assert.equal(await pending, 'hibi://obsidian/fresh')
  assert.equal(
    queue.queueObsidianProtocol('hibi://obsidian/disabled', () => false, now),
    false,
  )
})

test('network capabilities bind plugin, package, sender and activation and cannot be reused after release', async (t) => {
  const load = await modules(t)
  const capabilities = await load('network/capabilities.ts')
  const native = await load('network/native.ts')
  t.after(() => native.stopRequestUrls())
  let current = true
  const token = capabilities.mintPluginRequestCapability(
    'fixture',
    'a'.repeat(64),
    { senderId: 7, isCurrent: () => current },
  )
  const input = {
    id: 'fixture',
    capability: token,
    requestId: crypto.randomUUID(),
    request: { url: 'http://localhost' },
  }
  assert.equal(
    capabilities.requirePluginRequestCapability('fixture', token, 7).hash,
    'a'.repeat(64),
  )
  await assert.rejects(
    native.requestUrlNative(
      { ...input, capability: undefined },
      async () => {},
      7,
    ),
    /capability/,
  )
  await assert.rejects(
    native.requestUrlNative({ ...input, id: 'other' }, async () => {}, 7),
    /capability/,
  )
  await assert.rejects(native.cancelRequestUrl(input, 8), /capability/)
  await assert.rejects(
    native.releaseRequestUrl({ ...input, capability: 'forged' }, 7),
    /capability/,
  )
  current = false
  await assert.rejects(
    native.requestUrlNative(input, async () => {}, 7),
    /capability/,
  )
  current = true
  assert.throws(
    () => capabilities.requirePluginRequestCapability('fixture', token, 7),
    /capability/,
  )
  const next = capabilities.mintPluginRequestCapability(
    'fixture',
    'b'.repeat(64),
    { senderId: 7, isCurrent: () => true },
  )
  await native.releaseRequestUrl({ id: 'fixture', capability: next }, 7)
  await assert.rejects(
    native.cancelRequestUrl({ ...input, capability: next }, 7),
    /capability/,
  )
})

test('network concurrency admits 32 per plugin and bounds total work across plugins', async (t) => {
  const load = await modules(t)
  const capabilities = await load('network/capabilities.ts')
  const native = await load('network/native.ts')
  const authorization = Promise.withResolvers()
  t.after(() => {
    native.stopRequestUrls()
    authorization.resolve()
  })
  const pending = []
  const input = (id, capability) => ({
    id,
    capability,
    requestId: crypto.randomUUID(),
    request: { url: 'http://localhost' },
  })
  const rejected = async (promise, expected) => {
    let timer
    try {
      await assert.rejects(
        Promise.race([
          promise,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('request-limit fixture deadline')),
              250,
            )
          }),
        ]),
        expected,
      )
    } finally {
      clearTimeout(timer)
    }
  }
  for (let plugin = 0; plugin < 4; plugin++) {
    const id = 'fixture-' + plugin
    const capability = capabilities.mintPluginRequestCapability(
      id,
      'a'.repeat(64),
      { senderId: 7, isCurrent: () => true },
    )
    for (let index = 0; index < 32; index++)
      pending.push(
        native
          .requestUrlNative(
            input(id, capability),
            () => authorization.promise,
            7,
          )
          .catch((error) => error),
      )
    if (plugin === 0)
      await rejected(
        native.requestUrlNative(
          input(id, capability),
          () => authorization.promise,
          7,
        ),
        /for this plugin/,
      )
  }
  const capability = capabilities.mintPluginRequestCapability(
    'fixture-more',
    'a'.repeat(64),
    { senderId: 7, isCurrent: () => true },
  )
  await rejected(
    native.requestUrlNative(
      input('fixture-more', capability),
      () => authorization.promise,
      7,
    ),
    /Too many active plugin requests/,
  )
  native.stopRequestUrls()
  authorization.resolve()
  assert.ok(
    (await Promise.all(pending)).every((error) => /abort/i.test(error.message)),
  )
})

test('script load tickets are single-use, short-lived and bound to sender, package and activation', async (t) => {
  const load = await modules(t)
  const capabilities = await load('network/capabilities.ts')
  t.after(() => capabilities.clearPluginRequestCapabilities())
  let now = 1000
  let current = true
  t.mock.method(Date, 'now', () => now)
  const scope = { senderId: 7, isCurrent: () => current }
  const hash = 'a'.repeat(64)
  const prepare = () =>
    capabilities.preparePluginScriptLoad('fixture', hash, scope)
  const consume = (nonce, id = 'fixture', packageHash = hash, senderId = 7) =>
    capabilities.consumePluginScriptLoad(id, packageHash, nonce, {
      senderId,
      isCurrent: () => true,
    })
  const nonce = prepare()
  assert.equal(consume(nonce, 'other'), undefined)
  assert.equal(consume(nonce, 'fixture', 'b'.repeat(64)), undefined)
  assert.equal(consume(nonce, 'fixture', hash, 8), undefined)
  assert.ok(consume(nonce))
  assert.equal(consume(nonce), undefined)
  assert.equal(consume(undefined), undefined)
  assert.equal(consume(crypto.randomUUID()), undefined)
  const expired = prepare()
  now += 60000
  assert.equal(consume(expired), undefined)
  const inactive = prepare()
  current = false
  assert.equal(consume(inactive), undefined)
  current = true
  assert.equal(consume(inactive), undefined, 'invalidated ticket cannot revive')
  const duplicate = prepare()
  const token = capabilities.mintPluginRequestCapability('fixture', hash, scope)
  assert.equal(
    consume(duplicate),
    undefined,
    'unsolicited script cannot replace a live plugin grant',
  )
  assert.equal(
    capabilities.requirePluginRequestCapability('fixture', token, 7).token,
    token,
  )
})

test('invalidation during authorization rechecks and revokes the grant before transport', async (t) => {
  const load = await modules(t)
  const capabilities = await load('network/capabilities.ts')
  const native = await load('network/native.ts')
  t.after(() => native.stopRequestUrls())
  let current = true
  const capability = capabilities.mintPluginRequestCapability(
    'fixture',
    'a'.repeat(64),
    {
      senderId: 7,
      isCurrent: () => current,
    },
  )
  const grant = capabilities.requirePluginRequestCapability(
    'fixture',
    capability,
    7,
  )
  const authorization = Promise.withResolvers()
  const response = native.requestUrlNative(
    {
      id: 'fixture',
      capability,
      requestId: crypto.randomUUID(),
      request: { url: 'http://localhost' },
    },
    () => authorization.promise,
    7,
  )
  current = false
  authorization.resolve()
  await assert.rejects(response, /capability/)
  assert.equal(grant.controller.signal.aborted, true)
})

test('releasing a grant aborts an in-flight request without renderer cancellation', {
  timeout: 5000,
}, async (t) => {
  const load = await modules(t)
  const capabilities = await load('network/capabilities.ts')
  const native = await load('network/native.ts')
  const { net } = await load('electron')
  t.after(() => native.stopRequestUrls())
  const started = Promise.withResolvers()
  const client = new EventEmitter()
  let aborted = 0
  client.end = () => started.resolve()
  client.abort = () => {
    aborted++
  }
  net.request = () => client
  const capability = capabilities.mintPluginRequestCapability(
    'fixture',
    'a'.repeat(64),
    {
      senderId: 7,
      isCurrent: () => true,
    },
  )
  const response = native.requestUrlNative(
    {
      id: 'fixture',
      capability,
      requestId: crypto.randomUUID(),
      request: { url: 'http://localhost' },
    },
    async () => {},
    7,
  )
  let timer
  t.after(() => clearTimeout(timer))
  const rejected = assert.rejects(
    Promise.race([
      response,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('grant-release fixture deadline')),
          250,
        )
      }),
    ]),
    /cancel/i,
  )
  await started.promise
  await native.releaseRequestUrl({ id: 'fixture', capability }, 7)
  await rejected
  assert.equal(aborted, 1)
})

test('queued protocol links and network grants stop belonging to an invalidated activation', async (t) => {
  const load = await modules(t)
  const queue = await load('protocol/native.ts')
  const capabilities = await load('network/capabilities.ts')
  t.after(() => {
    queue.stopObsidianProtocol()
    capabilities.clearPluginRequestCapabilities()
  })
  let active = true
  const token = capabilities.mintPluginRequestCapability(
    'fixture',
    'a'.repeat(64),
    { senderId: 7, isCurrent: () => active },
  )
  const signal = capabilities.requirePluginRequestCapability(
    'fixture',
    token,
    7,
  ).controller.signal
  queue.queueObsidianProtocol('hibi://obsidian/old-activation', () => active)
  active = false
  capabilities.revokeStalePluginRequestCapabilities()
  assert.equal(signal.aborted, true)
  assert.throws(
    () => capabilities.requirePluginRequestCapability('fixture', token, 7),
    /capability/,
  )
  const pending = queue.nextObsidianProtocol(
    { requestId: crypto.randomUUID() },
    () => true,
  )
  queue.queueObsidianProtocol('hibi://obsidian/current-activation', () => true)
  assert.equal(await pending, 'hibi://obsidian/current-activation')
})
