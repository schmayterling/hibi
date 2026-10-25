import assert from 'node:assert/strict'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { transform } from 'esbuild'

const { code } = await transform(
  await readFile(
    new URL('../src/addons/mcp-server/server.ts', import.meta.url),
    'utf8',
  ),
  { loader: 'ts', format: 'cjs' },
)
const module = { exports: {} }
const require = createRequire(import.meta.url)
new Function('require', 'module', 'exports', code)(
  (id) =>
    id === './tools'
      ? {
          isObject: (value) =>
            value !== null &&
            typeof value === 'object' &&
            !Array.isArray(value),
        }
      : require(id),
  module,
  module.exports,
)
const { McpServer } = module.exports
const preferences = (port) => ({
  port,
  token: 'c'.repeat(32),
  allowEdits: true,
})

async function occupy(t) {
  const listener = createServer()
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  t.after(() => new Promise((resolve) => listener.close(resolve)))
  return listener
}

test('occupied port keeps relay calls bounded across long-poll windows', async (t) => {
  const listener = await occupy(t)
  const server = new McpServer('test')
  assert.equal(
    (await server.start(preferences(listener.address().port))).state,
    'error',
  )
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let running = true
  let calls = 0
  // Bound the broken loop too, so a regression cannot starve the test runner.
  const loop = (async () => {
    while (running && calls < 100) {
      calls++
      await server.relay()
    }
  })()
  try {
    await setImmediate()
    assert.equal(calls, 1)
    t.mock.timers.tick(24_999)
    await setImmediate()
    assert.equal(calls, 1)
    t.mock.timers.tick(1)
    await setImmediate()
    assert.equal(calls, 2)
    t.mock.timers.tick(25_000)
    await setImmediate()
    t.mock.timers.tick(10_000)
    await setImmediate()
    assert.equal(calls, 3)
    t.diagnostic(`${calls} relay calls across 60000 ms of simulated idle time`)
  } finally {
    running = false
    server.stop()
    await loop
  }
})

test('relay waits before listen and wakes on listening and stop', async (t) => {
  const server = new McpServer('test')
  t.after(() => server.stop())
  let settled = false
  const opening = server.start(preferences(0))
  const relay = server.relay().then((request) => {
    settled = true
    assert.equal(request, null)
  })
  await Promise.resolve()
  assert.equal(settled, false, 'relay must wait before listening')
  assert.equal((await opening).state, 'running')
  await setImmediate()
  assert.equal(settled, true, 'listening must wake the relay')
  await relay
  settled = false
  const stopped = server.relay().then(() => {
    settled = true
  })
  await setImmediate()
  assert.equal(settled, false)
  server.stop()
  await stopped
  assert.equal(settled, true)
})

test('relay wakes on bind failure and recovers on another port', async (t) => {
  const listener = await occupy(t)
  const server = new McpServer('test')
  t.after(() => server.stop())
  const opening = server.start(preferences(listener.address().port))
  const failing = server.relay()
  assert.equal((await opening).state, 'error')
  assert.equal(await failing, null)
  let settled = false
  const waiting = server.relay().then((request) => {
    settled = true
    return request
  })
  await setImmediate()
  assert.equal(settled, false)
  assert.equal((await server.start(preferences(0))).state, 'running')
  assert.equal(await waiting, null)
  const relay = server.relay()
  const edited = server.editOpenDocument('tab', [], () => {})
  assert.equal((await relay).tabId, 'tab')
  server.stop()
  assert.equal((await edited).ok, false)
})

test('queued edits wake relay once and failed replies never redeliver edits', async (t) => {
  const server = new McpServer('test')
  t.after(() => server.stop())
  await server.start(preferences(0))
  const relay = server.relay()
  const edits = [{ oldText: 'draft', newText: 'edited' }]
  const result = server.editOpenDocument('tab', edits, () => {})
  const request = await relay
  assert.equal(request.tabId, 'tab')
  assert.deepEqual(request.edits, edits)
  const reply = { id: request.id, ok: false, message: 'stale document' }
  let redelivered = false
  const next = server.relay({ reply }).then((request) => {
    redelivered = request !== null
  })
  assert.deepEqual(await result, reply)
  await setImmediate()
  assert.equal(redelivered, false)
  server.stop()
  await next
  assert.equal(redelivered, false)
})
