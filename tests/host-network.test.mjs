import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:https'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { getCACertificates, setDefaultCACertificates } from 'node:tls'
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib'
import {
  HostNetwork,
  isPublicAddress,
  readHostTextBody,
} from '../src/main/host-network.ts'

import { MAX_URL_LENGTH } from '../src/shared/host-network.ts'

const windowKey = {}
const postRequest = (extra = {}) => ({
  url: 'https://example.test/upload',
  method: 'POST',
  body: '{"note":"hëllo 🌱"}',
  ...extra,
})
test('POST requires exact declared public HTTPS origin before grants or DNS', async (t) => {
  for (const [url, origins] of [
    ['https://example.test/upload', []],
    ['https://example.test/upload', ['https://other.test']],
    ['https://example.test:444/upload', ['https://example.test']],
    ['https://other.example.test/upload', ['https://example.test']],
    ...[
      'localhost',
      '127.0.0.1',
      '[::1]',
      'intranet',
      'api.local',
      'api.lan',
      'api.internal',
      'home.arpa',
      'api.home.arpa',
      'api.localhost',
    ].map((name) => [`https://${name}/upload`, [`https://${name}`]]),
  ]) {
    const { host, destinations, lookups, transports } = fixture(t, {
      declaredOrigins: () => origins,
    })
    failure(
      await host.requestText('demo', windowKey, postRequest({ url })),
      'permission-denied',
    )
    assert.deepEqual(destinations, [])
    assert.deepEqual(lookups, [])
    assert.deepEqual(transports, [])
  }
})
test('POST validates literal method, body, credentials, and no arbitrary headers', async (t) => {
  const { host, destinations, lookups } = fixture(t, {
    declaredOrigins: () => ['https://example.test'],
  })
  for (const input of [
    null,
    [],
    {},
    { url: 'https://example.test/upload' },
    postRequest({ method: 'GET' }),
    postRequest({ method: 'post' }),
    postRequest({ body: undefined }),
    postRequest({ body: {} }),
    postRequest({ credentialKey: '../token' }),
    postRequest({ headers: { Authorization: 'Bearer injected' } }),
    postRequest({ redirect: 'follow' }),
    postRequest({ url: 'http://example.test/upload' }),
  ])
    failure(await host.requestText('demo', windowKey, input), 'invalid-request')
  assert.deepEqual(destinations, [])
  assert.deepEqual(lookups, [])
})
test('POST always asks fresh upload grant, independent of declared GET grants', async (t) => {
  let allow = true
  const { host, destinations, transports } = fixture(t, {
    declaredOrigins: () => ['https://example.test'],
    grantDestination: async () => allow,
  })
  assert.equal(
    (await host.request('demo', windowKey, { url: 'https://example.test/' }))
      .ok,
    true,
  )
  assert.equal(destinations.length, 0)
  const input = postRequest({ credentialKey: 'token' })
  assert.equal((await host.requestText('demo', windowKey, input)).ok, true)
  assert.equal((await host.requestText('demo', windowKey, input)).ok, true)
  allow = false
  failure(await host.requestText('demo', windowKey, input), 'permission-denied')
  assert.equal(transports.length, 3)
  assert.equal(destinations.length, 3)
  for (const grant of destinations)
    assert.deepEqual(grant, {
      addonId: 'demo',
      activationGeneration: 1,
      windowKey,
      operation: 'post-utf8',
      url: input.url,
      credentialKey: 'token',
      bodyBytes: Buffer.byteLength(input.body, 'utf8'),
    })
})
test('POST upload ceiling counts UTF-8 bytes before consent', async (t) => {
  const { host, destinations, transports } = fixture(t, {
    declaredOrigins: () => ['https://example.test'],
  })
  const body = 'é'.repeat(32 * 1024 * 1024)
  failure(
    await host.requestText(
      'demo',
      windowKey,
      postRequest({ body: `${body}x` }),
    ),
    'limit-exceeded',
  )
  assert.equal(destinations.length, 0)
  assert.equal(transports.length, 0)
  assert.equal(
    (await host.requestText('demo', windowKey, postRequest({ body }))).ok,
    true,
  )
  assert.equal(destinations[0].bodyBytes, 64 * 1024 * 1024)
  assert.equal(transports[0].body, body)
})
test('POST private DNS still requires separate pinned-address grant', async (t) => {
  const { host, destinations, privateGrants, transports } = fixture(t, {
    declaredOrigins: () => ['https://example.test'],
    resolve: async () => [{ address: '127.0.0.1', family: 4 }],
    grantPrivateAddress: async () => false,
  })
  failure(
    await host.requestText('demo', windowKey, postRequest()),
    'permission-denied',
  )
  assert.equal(destinations.length, 1)
  assert.deepEqual(privateGrants, [
    { ...destinations[0], address: '127.0.0.1' },
  ])
  assert.deepEqual(transports, [])
})
test('POST cancellation, stale owner/window, and late consent never upload', async (t) => {
  for (const scenario of ['abort', 'owner', 'window', 'generation']) {
    const started = deferred()
    const waiting = deferred()
    const { host, owners, windows, lookups, transports } = fixture(t, {
      declaredOrigins: () => ['https://example.test'],
      timeoutMs: 5000,
      grantDestination: async () => {
        started.resolve()
        return waiting.promise
      },
    })
    const controller = new AbortController()
    const pending = host.requestText(
      'demo',
      windowKey,
      postRequest(),
      controller.signal,
    )
    await started.promise
    if (scenario === 'abort') controller.abort()
    if (scenario === 'owner') host.stopOwner(owners.get('demo'))
    if (scenario === 'window') {
      windows.delete(windowKey)
      host.stopWindow(windowKey)
    }
    if (scenario === 'generation')
      owners.set('demo', { addonId: 'demo', activationGeneration: 2 })
    if (scenario === 'generation') waiting.resolve(true)
    failure(await pending, scenario === 'abort' ? 'cancelled' : 'stale')
    waiting.resolve(true)
    await new Promise(setImmediate)
    assert.deepEqual(lookups, [])
    assert.deepEqual(transports, [])
  }
})
test('POST shares stale credential and late response guards', async (t) => {
  const staleCredential = fixture(t, {
    declaredOrigins: () => ['https://example.test'],
    applyCredential: async () => ({ ok: false, code: 'stale' }),
  })
  failure(
    await staleCredential.host.requestText(
      'demo',
      windowKey,
      postRequest({ credentialKey: 'token' }),
    ),
    'stale',
  )
  assert.deepEqual(staleCredential.transports, [])

  const started = deferred()
  const release = deferred()
  const body = Readable.from([Buffer.from('private response')])
  const { host, owners } = fixture(t, {
    declaredOrigins: () => ['https://example.test'],
    transport: async () => {
      started.resolve()
      await release.promise
      return { status: 409, headers: {}, body }
    },
  })
  const pending = host.requestText('demo', windowKey, postRequest())
  await started.promise
  owners.set('demo', { addonId: 'demo', activationGeneration: 2 })
  release.resolve()
  failure(await pending, 'stale')
  assert.equal(body.destroyed, true)
})
test('real POST transport pins DNS, sends exact UTF-8 JSON, returns final statuses, and rejects redirects/echo/size/errors', async (t) => {
  const certificate = await readFile(
    join(import.meta.dirname, 'fixtures/host-network-upload-cert.pem'),
    'utf8',
  )
  const key = await readFile(
    join(import.meta.dirname, 'fixtures/host-network-localhost-key.pem'),
    'utf8',
  )
  const originalCAs = getCACertificates('default')
  setDefaultCACertificates([...originalCAs, certificate])
  t.after(() => setDefaultCACertificates(originalCAs))
  const seen = []
  const server = createServer(
    { cert: certificate, key },
    async (request, reply) => {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      seen.push({
        path: request.url,
        method: request.method,
        headers: request.headers,
        body: Buffer.concat(chunks),
      })
      const [, route, code] = request.url.split('/')
      if (route === 'drop') return request.socket.destroy()
      reply.setHeader('content-type', 'application/json; charset=utf-8')
      reply.statusCode = Number(code || 200)
      if (route === 'redirect') reply.setHeader('location', '/status/200')
      if (route === 'large') return reply.end('x'.repeat(1024 * 1024 + 1))
      if (route === 'bomb') {
        reply.setHeader('content-encoding', 'gzip')
        return reply.end(gzipSync(Buffer.alloc(1024 * 1024 + 1, 65)))
      }
      if (route === 'utf8') return reply.end(Buffer.from([0xff]))
      reply.end(
        route === 'echo' ? request.headers.authorization : '{"saved":true}',
      )
    },
  )
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const origin = `https://upload.example.test:${server.address().port}`
  const grants = []
  const privateGrants = []
  let allowed = true
  const host = new HostNetwork({
    currentOwner: () => ({ addonId: 'demo', activationGeneration: 1 }),
    declaredOrigins: () => [origin],
    isWindowLive: () => true,
    grantDestination: async (grant) => {
      grants.push(grant)
      return allowed
    },
    grantPrivateAddress: async (grant) => {
      privateGrants.push(grant)
      return true
    },
    applyCredential: async (_owner, _window, _key, apply) => {
      apply('host-only-secret', new AbortController().signal)
      return { ok: true, value: { applied: true } }
    },
    resolve: async (hostname) => {
      assert.equal(hostname, 'upload.example.test')
      return [{ address: '127.0.0.1', family: 4 }]
    },
  })
  t.after(() => host.dispose())
  const body = '{"note":"hëllo 🌱"}'
  const post = (path, extra = {}) =>
    host.requestText(
      'demo',
      windowKey,
      postRequest({
        url: origin + path,
        body,
        credentialKey: 'token',
        ...extra,
      }),
    )
  for (const status of [200, 201, 204, 304, 400, 401, 409, 413, 500, 599]) {
    assert.deepEqual(await post(`/status/${status}`), {
      ok: true,
      value: {
        url: `${origin}/status/${status}`,
        status,
        text: [204, 304].includes(status) ? '' : '{"saved":true}',
      },
    })
  }
  assert.deepEqual(
    await post('/status/200', { body: '', credentialKey: undefined }),
    {
      ok: true,
      value: {
        url: `${origin}/status/200`,
        status: 200,
        text: '{"saved":true}',
      },
    },
  )
  for (const status of [301, 302, 303, 307, 308]) {
    const count = seen.length
    failure(await post(`/redirect/${status}`), 'permission-denied')
    assert.equal(seen.length, count + 1)
  }
  for (const status of [200, 401, 500])
    failure(await post(`/echo/${status}`), 'unavailable')
  failure(await post('/large'), 'limit-exceeded')
  failure(await post('/bomb'), 'limit-exceeded')
  failure(await post('/utf8'), 'unavailable')
  failure(await post('/drop'), 'unavailable')
  for (const entry of seen) {
    const empty = entry.headers.authorization === undefined
    assert.equal(entry.method, 'POST')
    assert.equal(
      entry.headers['content-type'],
      'application/json; charset=utf-8',
    )
    assert.equal(
      entry.headers['content-length'],
      String(Buffer.byteLength(empty ? '' : body)),
    )
    assert.equal(entry.headers['transfer-encoding'], undefined)
    assert.equal(entry.headers.cookie, undefined)
    assert.deepEqual(entry.body, Buffer.from(empty ? '' : body))
    if (!empty)
      assert.equal(entry.headers.authorization, 'Bearer host-only-secret')
  }
  assert.equal(grants.length, seen.length)
  assert.equal(privateGrants.length, seen.length)
  assert.equal(grants[0].operation, 'post-utf8')
  assert.equal(grants[0].bodyBytes, Buffer.byteLength(body))
  assert.equal(grants[0].credentialKey, 'token')
  allowed = false
  const count = seen.length
  failure(await post('/status/200'), 'permission-denied')
  assert.equal(seen.length, count)
  assert.equal(privateGrants.length, count)
})
const publicAddress = { address: '8.8.8.8', family: 4 }

test('POST gives uploads the full network budget after destination and private consent', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const consent = deferred(),
    privateConsent = deferred(),
    sent = deferred(),
    reply = deferred()
  const { host } = fixture(t, {
    declaredOrigins: () => ['https://example.test'],
    grantDestination: () => consent.promise,
    resolve: async () => [{ address: '127.0.0.1', family: 4 }],
    grantPrivateAddress: () => privateConsent.promise,
    transport: async () => {
      sent.resolve()
      return reply.promise
    },
  })
  const pending = host.requestText('demo', windowKey, postRequest())
  await new Promise(setImmediate)
  t.mock.timers.tick(120_000)
  consent.resolve(true)
  await new Promise(setImmediate)
  t.mock.timers.tick(120_000)
  privateConsent.resolve(true)
  await sent.promise
  t.mock.timers.tick(11_000)
  reply.resolve(response(201, 'uploaded'))
  assert.equal((await pending).value.status, 201)

  const started = deferred(),
    stalled = deferred()
  const timeout = fixture(t, {
    declaredOrigins: () => ['https://example.test'],
    transport: async () => {
      started.resolve()
      return stalled.promise
    },
  })
  const expired = timeout.host.requestText('demo', windowKey, postRequest())
  await started.promise
  t.mock.timers.tick(60_001)
  failure(await expired, 'timeout')
  stalled.resolve(response())
})

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function response(status = 200, text = 'hello', headers = {}) {
  return { status, headers, body: Readable.from([Buffer.from(text)]) }
}

function fixture(t, overrides = {}) {
  const owners = new Map([
    ['demo', { addonId: 'demo', activationGeneration: 1 }],
    ['other', { addonId: 'other', activationGeneration: 1 }],
    ['third', { addonId: 'third', activationGeneration: 1 }],
  ])
  const windows = new Set([windowKey])
  const destinations = []
  const privateGrants = []
  const lookups = []
  const transports = []
  const credentials = new Map([['demo:token', 'host-only-secret']])
  const host = new HostNetwork({
    currentOwner: (id) => owners.get(id) ?? null,
    declaredOrigins: overrides.declaredOrigins,
    isWindowLive: (key) => windows.has(key),
    grantDestination: async (grant, signal) => {
      destinations.push(grant)
      return (await overrides.grantDestination?.(grant, signal)) ?? true
    },
    grantPrivateAddress: async (grant, signal) => {
      privateGrants.push(grant)
      return (await overrides.grantPrivateAddress?.(grant, signal)) ?? true
    },
    applyCredential: async (owner, key, credentialKey, apply) => {
      if (overrides.applyCredential)
        return overrides.applyCredential(owner, key, credentialKey, apply)
      const secret = credentials.get(`${owner.addonId}:${credentialKey}`)
      if (!secret) return { ok: false, code: 'not-found' }
      apply(secret, new AbortController().signal)
      return { ok: true, value: { applied: true } }
    },
    resolve: async (hostname) => {
      lookups.push(hostname)
      return (await overrides.resolve?.(hostname)) ?? [publicAddress]
    },
    transport: async (url, address, signal, bearer, body) => {
      transports.push({ url: url.href, address, signal, bearer, body })
      return (
        (await overrides.transport?.(url, address, signal, bearer, body)) ??
        response()
      )
    },
    ...(overrides.timeoutMs ? { timeoutMs: overrides.timeoutMs } : {}),
  })
  t.after(() => host.dispose())
  return {
    host,
    owners,
    windows,
    destinations,
    privateGrants,
    lookups,
    transports,
    credentials,
  }
}

function failure(result, code) {
  assert.equal(result.ok, false, JSON.stringify(result))
  assert.equal(result.code, code)
}

test('address policy classifies public, private, reserved, and mapped addresses', () => {
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])
    assert.equal(isPublicAddress(address), true, address)
  for (const address of [
    '127.0.0.1',
    '10.0.0.1',
    '169.254.1.1',
    '192.0.2.1',
    '::1',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    'not-an-ip',
  ])
    assert.equal(isPublicAddress(address), false, address)
})

test('a destination grant precedes dns and a successful get pins its resolved address', async (t) => {
  const events = []
  const { host, destinations, privateGrants, lookups, transports } = fixture(
    t,
    {
      grantDestination: async () => {
        events.push('grant')
        return true
      },
      resolve: async () => {
        events.push('resolve')
        return [publicAddress, { address: '127.0.0.1', family: 4 }]
      },
      transport: async () => {
        events.push('transport')
        return response(200, 'hello world')
      },
    },
  )
  assert.deepEqual(
    await host.request('demo', windowKey, {
      url: 'https://example.test/path?q=1',
    }),
    {
      ok: true,
      value: {
        url: 'https://example.test/path?q=1',
        status: 200,
        text: 'hello world',
      },
    },
  )
  assert.deepEqual(events, ['grant', 'resolve', 'transport'])
  assert.deepEqual(destinations, [
    {
      addonId: 'demo',
      activationGeneration: 1,
      windowKey,
      operation: 'get-utf8',
      url: 'https://example.test/path?q=1',
    },
  ])
  assert.strictEqual(destinations[0].windowKey, windowKey)
  assert.deepEqual(lookups, ['example.test'])
  assert.deepEqual(privateGrants, [])
  assert.deepEqual(transports[0].address, publicAddress)
})

test('declared public origins allow repeated gets without destination dialogs', async (t) => {
  const { host, destinations, privateGrants, transports } = fixture(t, {
    declaredOrigins: (id) => (id === 'demo' ? ['https://example.test'] : []),
  })
  for (const path of ['/one', '/two?q=word'])
    assert.equal(
      (
        await host.request('demo', windowKey, {
          url: `https://example.test${path}`,
        })
      ).ok,
      true,
    )
  assert.deepEqual(destinations, [])
  assert.deepEqual(privateGrants, [])
  assert.equal(transports.length, 2)
  assert.ok(
    transports.every(
      ({ address, bearer }) =>
        address === publicAddress && bearer === undefined,
    ),
  )
  assert.equal(
    (await host.request('other', windowKey, { url: 'https://example.test/' }))
      .ok,
    true,
  )
  assert.equal(destinations.length, 1)
})

test('undeclared hosts, subdomains, and ports still need destination approval', async (t) => {
  const { host, destinations, lookups, transports } = fixture(t, {
    declaredOrigins: () => ['https://example.test:8443'],
    grantDestination: async () => false,
  })
  assert.equal(
    (
      await host.request('demo', windowKey, {
        url: 'https://example.test:8443/word',
      })
    ).ok,
    true,
  )
  for (const url of [
    'https://example.test/',
    'https://example.test:8444/',
    'https://sub.example.test:8443/',
    'https://example.test.evil.test:8443/',
  ])
    failure(await host.request('demo', windowKey, { url }), 'permission-denied')
  assert.equal(destinations.length, 4)
  assert.deepEqual(lookups, ['example.test'])
  assert.equal(transports.length, 1)
})

test('declared redirects skip dialogs but each undeclared hop still prompts', async (t) => {
  const { host, destinations, transports } = fixture(t, {
    declaredOrigins: () => ['https://example.test'],
    transport: async (url) => {
      if (url.pathname === '/start')
        return response(302, '', { location: '/same-origin' })
      if (url.pathname === '/same-origin')
        return response(302, '', { location: 'https://other.test/first' })
      if (url.pathname === '/first')
        return response(302, '', { location: '/final' })
      return response(200, 'redirected')
    },
  })
  assert.equal(
    (
      await host.request('demo', windowKey, {
        url: 'https://example.test/start',
      })
    ).ok,
    true,
  )
  assert.deepEqual(
    destinations.map(({ url, redirectFrom }) => ({ url, redirectFrom })),
    [
      {
        url: 'https://other.test/first',
        redirectFrom: 'https://example.test/same-origin',
      },
      {
        url: 'https://other.test/final',
        redirectFrom: 'https://other.test/first',
      },
    ],
  )
  assert.equal(transports.length, 4)
})

test('declared origins never bypass credential approval', async (t) => {
  let applied = false
  const { host, destinations, lookups, transports } = fixture(t, {
    declaredOrigins: () => ['https://example.test'],
    grantDestination: async () => false,
    applyCredential: async () => {
      applied = true
    },
  })
  failure(
    await host.request('demo', windowKey, {
      url: 'https://example.test/account',
      credentialKey: 'token',
    }),
    'permission-denied',
  )
  assert.equal(destinations.length, 1)
  assert.equal(destinations[0].credentialKey, 'token')
  assert.equal(applied, false)
  assert.deepEqual(lookups, [])
  assert.deepEqual(transports, [])
})

test('declared origins resolving to private addresses retain both grants', async (t) => {
  for (const address of [
    { address: '10.0.0.1', family: 4 },
    { address: '127.0.0.1', family: 4 },
    { address: '169.254.1.1', family: 4 },
    { address: '::1', family: 6 },
    { address: 'fc00::1', family: 6 },
    { address: 'fe80::1', family: 6 },
    { address: '::ffff:127.0.0.1', family: 6 },
  ]) {
    for (const approveDestination of [false, true]) {
      const { host, destinations, privateGrants, transports } = fixture(t, {
        declaredOrigins: () => ['https://example.test'],
        resolve: async () => [address],
        grantDestination: async () => approveDestination,
        grantPrivateAddress: async () => false,
      })
      failure(
        await host.request('demo', windowKey, { url: 'https://example.test/' }),
        'permission-denied',
      )
      assert.equal(destinations.length, 1)
      assert.equal(privateGrants.length, Number(approveDestination))
      assert.deepEqual(transports, [])
    }
  }
})

test('declared origins recheck dns on same-origin redirects and pin public answers', async (t) => {
  let lookups = 0
  const privateAddress = { address: '127.0.0.1', family: 4 }
  const { host, destinations, privateGrants, transports } = fixture(t, {
    declaredOrigins: () => ['https://example.test'],
    resolve: async () =>
      ++lookups === 1 ? [privateAddress, publicAddress] : [privateAddress],
    transport: async () => response(302, '', { location: '/private' }),
    grantPrivateAddress: async () => false,
  })
  failure(
    await host.request('demo', windowKey, {
      url: 'https://example.test/start',
    }),
    'permission-denied',
  )
  assert.equal(destinations.length, 1)
  assert.equal(destinations[0].url, 'https://example.test/private')
  assert.equal(privateGrants.length, 1)
  assert.equal(transports.length, 1)
  assert.deepEqual(transports[0].address, publicAddress)
})

test('disabled declarations and owners expiring during dns cannot grant access', async (t) => {
  const { host, owners, destinations, lookups, transports } = fixture(t, {
    declaredOrigins: () => ['https://example.test'],
    resolve: async () => {
      owners.set('other', { addonId: 'other', activationGeneration: 2 })
      return [publicAddress]
    },
  })
  owners.delete('demo')
  for (const id of ['demo', 'other'])
    failure(
      await host.request(id, windowKey, { url: 'https://example.test/' }),
      'stale',
    )
  assert.deepEqual(destinations, [])
  assert.deepEqual(lookups, ['example.test'])
  assert.deepEqual(transports, [])
})

test('renderer input cannot supply declarations or change the get operation', async (t) => {
  const { host, destinations, lookups } = fixture(t, {
    declaredOrigins: () => ['https://example.test'],
  })
  for (const extra of [
    { origins: ['https://other.test'] },
    { network: { origins: ['https://other.test'] } },
    { method: 'POST' },
    { body: 'word' },
    { headers: { Authorization: 'Bearer secret' } },
  ])
    failure(
      await host.request('demo', windowKey, {
        url: 'https://example.test/',
        ...extra,
      }),
      'invalid-request',
    )
  assert.deepEqual(destinations, [])
  assert.deepEqual(lookups, [])
})

test('denied destination, missing owner, and dead window never reach transport', async (t) => {
  const { host, owners, windows, destinations, lookups, transports } = fixture(
    t,
    {
      grantDestination: async () => false,
    },
  )
  failure(
    await host.request('demo', windowKey, { url: 'https://example.test/' }),
    'permission-denied',
  )
  owners.delete('demo')
  failure(
    await host.request('demo', windowKey, { url: 'https://example.test/' }),
    'stale',
  )
  windows.delete(windowKey)
  failure(
    await host.request('other', windowKey, { url: 'https://example.test/' }),
    'stale',
  )
  assert.equal(destinations.length, 1)
  assert.deepEqual(lookups, [])
  assert.deepEqual(transports, [])
})

test('malformed requests and non-https destinations fail before a grant', async (t) => {
  const { host, destinations } = fixture(t)
  for (const input of [
    null,
    [],
    {},
    { url: 5 },
    { url: 'https://example.test/', extra: true },
    { url: 'https://example.test/', credentialKey: '' },
    { url: 'https://example.test/', credentialKey: '../token' },
    { url: 'https://example.test/', credentialKey: 1 },
    { url: 'http://example.test/' },
    { url: 'file:///tmp/note' },
    { url: 'https://user@example.test/' },
    { url: 'https://user:pass@example.test/' },
    { url: 'https://example.test/#fragment' },
    { url: ' https://example.test/' },
    { url: `https://example.test/${'x'.repeat(2048)}` },
  ])
    failure(await host.request('demo', windowKey, input), 'invalid-request')
  failure(
    await host.request('invalid.id', windowKey, {
      url: 'https://example.test/',
    }),
    'invalid-request',
  )
  assert.deepEqual(destinations, [])
})

test('host requests enforce the shared url length limit at the exact boundary', async (t) => {
  const { host, destinations, transports } = fixture(t)
  assert.equal(MAX_URL_LENGTH, 2048)
  const prefix = 'https://example.test/'
  const url = prefix + 'x'.repeat(MAX_URL_LENGTH - prefix.length)
  assert.equal((await host.request('demo', windowKey, { url })).ok, true)
  failure(
    await host.request('demo', windowKey, { url: `${url}x` }),
    'invalid-request',
  )
  assert.equal(destinations.length, 1)
  assert.equal(transports.length, 1)
})

test('stored bearer use follows destination and private grants, with no redirect forwarding', async (t) => {
  const events = []
  const { host, destinations, privateGrants, transports } = fixture(t, {
    resolve: async () => [{ address: '127.0.0.1', family: 4 }],
    grantDestination: async () => {
      events.push('destination')
      return true
    },
    grantPrivateAddress: async () => {
      events.push('private')
      return true
    },
    applyCredential: async (_owner, _window, key, apply) => {
      events.push('credential')
      assert.equal(key, 'token')
      apply('host-only-secret', new AbortController().signal)
      return { ok: true, value: { applied: true } }
    },
    transport: async () => {
      events.push('transport')
      return response(302, '', { location: 'https://elsewhere.test/' })
    },
  })
  failure(
    await host.request('demo', windowKey, {
      url: 'https://example.test/start',
      credentialKey: 'token',
    }),
    'permission-denied',
  )
  assert.deepEqual(events, [
    'destination',
    'private',
    'credential',
    'transport',
  ])
  assert.equal(destinations[0].credentialKey, 'token')
  assert.equal(privateGrants[0].credentialKey, 'token')
  assert.equal(transports[0].bearer, 'host-only-secret')
  assert.equal(destinations.length, 1)
  assert.equal(transports.length, 1)
})

test('missing, denied, and wrong-owner credentials never reach transport', async (t) => {
  const { host, credentials, transports, destinations } = fixture(t)
  credentials.delete('demo:token')
  failure(
    await host.request('demo', windowKey, {
      url: 'https://example.test/',
      credentialKey: 'token',
    }),
    'unavailable',
  )
  credentials.set('other:token', 'other-secret')
  failure(
    await host.request('demo', windowKey, {
      url: 'https://example.test/',
      credentialKey: 'token',
    }),
    'unavailable',
  )
  assert.equal(transports.length, 0)
  assert.equal(destinations.length, 2)
})

test('invalid bearer values and stale vault results never reach transport', async (t) => {
  const invalid = fixture(t, {
    applyCredential: async (_owner, _window, _key, apply) => {
      apply('bad\r\nHeader: injected', new AbortController().signal)
      return { ok: true, value: { applied: true } }
    },
  })
  failure(
    await invalid.host.request('demo', windowKey, {
      url: 'https://example.test/',
      credentialKey: 'token',
    }),
    'unavailable',
  )
  assert.equal(invalid.transports.length, 0)

  const stale = fixture(t, {
    applyCredential: async () => ({ ok: false, code: 'stale' }),
  })
  failure(
    await stale.host.request('demo', windowKey, {
      url: 'https://example.test/',
      credentialKey: 'token',
    }),
    'stale',
  )
  assert.equal(stale.transports.length, 0)
})

test('real HTTPS transport sends bearer only after grants and blocks reflected secret', async (t) => {
  const certificate = await readFile(
    join(import.meta.dirname, 'fixtures/host-network-localhost-cert.pem'),
    'utf8',
  )
  const key = await readFile(
    join(import.meta.dirname, 'fixtures/host-network-localhost-key.pem'),
    'utf8',
  )
  const originalCAs = getCACertificates('default')
  setDefaultCACertificates([...originalCAs, certificate])
  t.after(() => setDefaultCACertificates(originalCAs))
  const seen = []
  const server = createServer({ cert: certificate, key }, (request, reply) => {
    seen.push({
      path: request.url,
      authorization: request.headers.authorization,
      cookie: request.headers.cookie,
      userAgent: request.headers['user-agent'],
    })
    reply.setHeader('content-type', 'text/plain; charset=utf-8')
    reply.end(
      request.url === '/reflect'
        ? request.headers.authorization
        : 'approved response',
    )
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const port = server.address().port
  const events = []
  const host = new HostNetwork({
    currentOwner: () => ({ addonId: 'demo', activationGeneration: 1 }),
    isWindowLive: () => true,
    grantDestination: async () => {
      events.push('destination')
      return true
    },
    grantPrivateAddress: async () => {
      events.push('private')
      return true
    },
    applyCredential: async (_owner, _window, _key, apply) => {
      events.push('credential')
      apply('host-only-secret', new AbortController().signal)
      return { ok: true, value: { applied: true } }
    },
    resolve: async () => [{ address: '127.0.0.1', family: 4 }],
    userAgent: 'Hibi/test (https://example.test)',
  })
  t.after(() => host.dispose())
  const request = (path) =>
    host.request('demo', windowKey, {
      url: `https://localhost:${port}${path}`,
      credentialKey: 'token',
    })
  assert.equal((await request('/plain')).ok, true)
  failure(await request('/reflect'), 'unavailable')
  assert.deepEqual(events, [
    'destination',
    'private',
    'credential',
    'destination',
    'private',
    'credential',
  ])
  assert.deepEqual(seen, [
    {
      path: '/plain',
      authorization: 'Bearer host-only-secret',
      cookie: undefined,
      userAgent: 'Hibi/test (https://example.test)',
    },
    {
      path: '/reflect',
      authorization: 'Bearer host-only-secret',
      cookie: undefined,
      userAgent: 'Hibi/test (https://example.test)',
    },
  ])
})

test('private and local names require separate grants for exact pinned addresses', async (t) => {
  const { host, privateGrants, transports } = fixture(t, {
    resolve: async (hostname) =>
      hostname === 'intranet.local'
        ? [publicAddress]
        : [{ address: '127.0.0.1', family: 4 }],
    grantPrivateAddress: async (grant) => grant.address !== '127.0.0.1',
  })
  failure(
    await host.request('demo', windowKey, { url: 'https://example.test/' }),
    'permission-denied',
  )
  assert.deepEqual(privateGrants[0], {
    addonId: 'demo',
    activationGeneration: 1,
    windowKey,
    operation: 'get-utf8',
    url: 'https://example.test/',
    address: '127.0.0.1',
  })
  assert.equal(transports.length, 0)

  const allowed = await host.request('demo', windowKey, {
    url: 'https://intranet.local/',
  })
  assert.equal(allowed.ok, true)
  assert.deepEqual(privateGrants[1], {
    addonId: 'demo',
    activationGeneration: 1,
    windowKey,
    operation: 'get-utf8',
    url: 'https://intranet.local/',
    address: '8.8.8.8',
  })
  assert.deepEqual(transports[0].address, publicAddress)
})

test('shared local suffixes retain request grants after hostname normalization', async (t) => {
  const { host, privateGrants } = fixture(t)
  const local = [
    'intranet',
    'localhost',
    'API.LOCALHOST.',
    'server.local',
    'server.lan',
    'server.internal',
    'router.home.arpa',
  ]
  for (const hostname of local)
    assert.equal(
      (await host.request('demo', windowKey, { url: `https://${hostname}/` }))
        .ok,
      true,
    )
  assert.equal(privateGrants.length, local.length)
  for (const hostname of [
    'localhost.example.test',
    'home.arpa',
    '8.8.8.8',
    '[2606:4700:4700::1111]',
  ])
    assert.equal(
      (await host.request('demo', windowKey, { url: `https://${hostname}/` }))
        .ok,
      true,
    )
  assert.equal(privateGrants.length, local.length)
})

test('each redirect gets a new destination and private-address grant', async (t) => {
  const { host, destinations, privateGrants, transports } = fixture(t, {
    resolve: async (hostname) =>
      hostname === 'intranet.local'
        ? [{ address: '127.0.0.1', family: 4 }]
        : [publicAddress],
    transport: async (url) =>
      url.hostname === 'example.test'
        ? response(302, '', { location: 'https://intranet.local/final' })
        : response(200, 'redirected'),
  })
  const result = await host.request('demo', windowKey, {
    url: 'https://example.test/start',
  })
  assert.deepEqual(result, {
    ok: true,
    value: {
      url: 'https://intranet.local/final',
      status: 200,
      text: 'redirected',
    },
  })
  assert.deepEqual(destinations, [
    {
      addonId: 'demo',
      activationGeneration: 1,
      windowKey,
      operation: 'get-utf8',
      url: 'https://example.test/start',
    },
    {
      addonId: 'demo',
      activationGeneration: 1,
      windowKey,
      operation: 'get-utf8',
      url: 'https://intranet.local/final',
      redirectFrom: 'https://example.test/start',
    },
  ])
  assert.deepEqual(privateGrants, [
    {
      ...destinations[1],
      address: '127.0.0.1',
    },
  ])
  assert.deepEqual(
    transports.map(({ address }) => address),
    [publicAddress, { address: '127.0.0.1', family: 4 }],
  )
})

test('redirects cannot downgrade or exceed the hop limit', async (t) => {
  const downgrade = fixture(t, {
    transport: async () =>
      response(302, '', { location: 'http://example.test/unsafe' }),
  })
  failure(
    await downgrade.host.request('demo', windowKey, {
      url: 'https://example.test/',
    }),
    'invalid-request',
  )
  assert.equal(downgrade.destinations.length, 1)

  const loop = fixture(t, {
    transport: async () => response(302, '', { location: '/again' }),
  })
  failure(
    await loop.host.request('demo', windowKey, {
      url: 'https://example.test/',
    }),
    'limit-exceeded',
  )
  assert.equal(loop.destinations.length, 4)
  assert.equal(loop.transports.length, 4)
})

test('non-success status is returned without its body', async (t) => {
  let body
  const { host } = fixture(t, {
    transport: async () => {
      body = Readable.from([Buffer.from('secret body')])
      return { status: 403, headers: {}, body }
    },
  })
  assert.deepEqual(
    await host.request('demo', windowKey, { url: 'https://example.test/' }),
    { ok: false, code: 'http-status', status: 403 },
  )
  assert.equal(body.destroyed, true)
})

test('utf-8 reader handles supported encodings and rejects unsafe text', async () => {
  const plain = Buffer.from('hëllo')
  for (const [encoding, compressed] of [
    ['identity', plain],
    ['gzip', gzipSync(plain)],
    ['deflate', deflateSync(plain)],
    ['br', brotliCompressSync(plain)],
  ])
    assert.equal(
      await readHostTextBody(
        Readable.from([compressed]),
        {
          'content-encoding': encoding,
          'content-type': 'text/plain; charset=utf-8',
        },
        new AbortController().signal,
      ),
      'hëllo',
      encoding,
    )

  for (const [bytes, headers] of [
    [Buffer.from([0xff]), {}],
    [Buffer.from('a\0b'), {}],
    [plain, { 'content-type': 'text/plain; charset=iso-8859-1' }],
    [plain, { 'content-encoding': 'compress' }],
  ])
    await assert.rejects(
      readHostTextBody(
        Readable.from([bytes]),
        headers,
        new AbortController().signal,
      ),
      (error) => error?.code === 'unavailable',
    )
})

test('raw and decoded byte limits reject oversized bodies and compression bombs', async () => {
  const tooLarge = Buffer.alloc(2 * 1024 * 1024 + 1, 65)
  const decodedBomb = Buffer.alloc(1024 * 1024 + 1, 65)
  for (const [bytes, headers] of [
    [Buffer.from('x'), { 'content-length': String(tooLarge.length) }],
    [Buffer.from('x'), { 'content-length': 'not-a-length' }],
    [tooLarge, {}],
    [gzipSync(decodedBomb), { 'content-encoding': 'gzip' }],
    [deflateSync(decodedBomb), { 'content-encoding': 'deflate' }],
    [brotliCompressSync(decodedBomb), { 'content-encoding': 'br' }],
  ])
    await assert.rejects(
      readHostTextBody(
        Readable.from([bytes]),
        headers,
        new AbortController().signal,
      ),
      (error) => error?.code === 'limit-exceeded',
    )
})

test('external abort, timeout, and owner/window expiry stop pending work', async (t) => {
  for (const scenario of ['abort', 'timeout', 'owner', 'window']) {
    const started = deferred()
    const waiting = deferred()
    const { host, owners, windows } = fixture(t, {
      timeoutMs: scenario === 'timeout' ? 20 : 5_000,
      grantDestination: async () => {
        started.resolve()
        return waiting.promise
      },
    })
    const controller = new AbortController()
    const request = host.request(
      'demo',
      windowKey,
      { url: 'https://example.test/' },
      controller.signal,
    )
    await started.promise
    if (scenario === 'abort') controller.abort()
    if (scenario === 'owner') {
      const owner = owners.get('demo')
      owners.delete('demo')
      host.stopOwner(owner)
    }
    if (scenario === 'window') {
      windows.delete(windowKey)
      host.stopWindow(windowKey)
    }
    failure(
      await request,
      {
        abort: 'cancelled',
        timeout: 'timeout',
        owner: 'stale',
        window: 'stale',
      }[scenario],
    )
    waiting.resolve(true)
  }
})

test('stale identity after transport cannot deliver text or leave its body open', async (t) => {
  const started = deferred()
  const release = deferred()
  const body = Readable.from([Buffer.from('private response')])
  const { host, owners, windows } = fixture(t, {
    transport: async () => {
      started.resolve()
      await release.promise
      return { status: 200, headers: {}, body }
    },
  })
  const pending = host.request('demo', windowKey, {
    url: 'https://example.test/',
  })
  await started.promise
  owners.set('demo', { addonId: 'demo', activationGeneration: 2 })
  windows.delete(windowKey)
  release.resolve()
  failure(await pending, 'stale')
  assert.equal(body.destroyed, true)
})

test('transport response arriving after cancellation closes its body', async (t) => {
  const started = deferred()
  const lateReply = deferred()
  const body = Readable.from([Buffer.from('late response')])
  const { host } = fixture(t, {
    transport: async () => {
      started.resolve()
      return lateReply.promise
    },
  })
  const controller = new AbortController()
  const pending = host.request(
    'demo',
    windowKey,
    { url: 'https://example.test/' },
    controller.signal,
  )
  await started.promise
  controller.abort()
  failure(await pending, 'cancelled')
  assert.equal(body.destroyed, false)
  lateReply.resolve({ status: 200, headers: {}, body })
  await new Promise(setImmediate)
  assert.equal(body.destroyed, true)
})

test('active limits prevent one owner or all owners from flooding pending requests', async (t) => {
  const gate = deferred()
  const started = []
  const { host, destinations } = fixture(t, {
    transport: async (_url, _address, signal) => {
      started.push(signal)
      await gate.promise
      return response()
    },
  })
  const request = (owner) =>
    host.request(owner, windowKey, { url: 'https://example.test/' })
  const pending = [
    request('demo'),
    request('demo'),
    request('other'),
    request('other'),
  ]
  failure(await request('demo'), 'busy')
  failure(await request('third'), 'busy')
  gate.resolve()
  for (const result of await Promise.all(pending)) assert.equal(result.ok, true)
  assert.equal(started.length, 4)
  assert.equal(destinations.length, 4)
})

test('aborted unresolved resolvers remain capped across new requests', async (t) => {
  let started
  const { host, destinations, lookups, transports } = fixture(t, {
    resolve: async () => {
      started.resolve()
      return new Promise(() => {})
    },
  })
  for (let index = 0; index < 16; index++) {
    started = deferred()
    const controller = new AbortController()
    const pending = host.request(
      'demo',
      windowKey,
      { url: 'https://example.test/' },
      controller.signal,
    )
    await started.promise
    controller.abort()
    failure(await pending, 'cancelled')
  }

  failure(
    await host.request('demo', windowKey, {
      url: 'https://example.test/',
    }),
    'busy',
  )
  assert.equal(destinations.length, 16)
  assert.equal(lookups.length, 16)
  assert.equal(transports.length, 0)
})
