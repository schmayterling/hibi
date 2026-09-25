import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib'
import {
  HostNetwork,
  isPublicAddress,
  readHostTextBody,
} from '../src/main/host-network.ts'

const windowKey = {}
const publicAddress = { address: '8.8.8.8', family: 4 }

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
  const host = new HostNetwork({
    currentOwner: (id) => owners.get(id) ?? null,
    isWindowLive: (key) => windows.has(key),
    grantDestination: async (grant, signal) => {
      destinations.push(grant)
      return (await overrides.grantDestination?.(grant, signal)) ?? true
    },
    grantPrivateAddress: async (grant, signal) => {
      privateGrants.push(grant)
      return (await overrides.grantPrivateAddress?.(grant, signal)) ?? true
    },
    resolve: async (hostname) => {
      lookups.push(hostname)
      return (await overrides.resolve?.(hostname)) ?? [publicAddress]
    },
    transport: async (url, address, signal) => {
      transports.push({ url: url.href, address, signal })
      return (await overrides.transport?.(url, address, signal)) ?? response()
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
