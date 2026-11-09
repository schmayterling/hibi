import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer, request } from 'node:http'
import test from 'node:test'
import { createServer as createViteServer } from 'vite'

async function modules(t) {
  const server = await createViteServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
  })
  t.after(() => server.close())
  return (path) => server.ssrLoadModule('/src/addons/obsidian/api/' + path)
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

test('native transport bounds bodies, responses, time and redirects and handles disconnects', async (t) => {
  const load = await modules(t)
  const { requestBytes, REQUEST_LIMITS, validateRequest } = await load(
    'network/transport.ts',
  )
  const limits = {
    ...REQUEST_LIMITS,
    bodyBytes: 4,
    responseBytes: 4,
    timeoutMs: 20,
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
    requestBytes(
      { url: base + '/large' },
      netRequest,
      new AbortController().signal,
      limits,
    ),
    /response limit/,
  )
  await assert.rejects(
    requestBytes(
      { url: base + '/hang' },
      netRequest,
      new AbortController().signal,
      limits,
    ),
    /time limit/,
  )
  await assert.rejects(
    requestBytes(
      { url: base + '/disconnect' },
      netRequest,
      new AbortController().signal,
      limits,
    ),
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
    requestBytes(
      { url: base },
      () => client,
      new AbortController().signal,
      limits,
    ),
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
    queue.queueObsidianProtocol('hibi://obsidian/fixture?flag'),
    true,
  )
  assert.equal(
    await queue.nextObsidianProtocol(first),
    'hibi://obsidian/fixture?flag',
  )
  assert.equal(queue.queueObsidianProtocol('javascript:alert(1)'), false)
  const pending = queue.nextObsidianProtocol(first)
  await queue.cancelObsidianProtocol(second)
  queue.queueObsidianProtocol('obsidian://fixture?live')
  assert.equal(await pending, 'obsidian://fixture?live')
  const cancelled = queue.nextObsidianProtocol(second)
  await queue.cancelObsidianProtocol(second)
  assert.equal(await cancelled, null)
  const stopped = queue.nextObsidianProtocol(first)
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
