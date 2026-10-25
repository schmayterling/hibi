import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'

const source = await readFile('src/addons/keybeats/index.ts', 'utf8')
const create = new Function(
  'environment',
  `const { lazy, defineAddon, manifest, navigator, Audio, loadEngine,
    requestIdleCallback, cancelIdleCallback } = environment
  ${stripTypeScriptTypes(source.slice(source.indexOf('let generation')))
    .replace('export default', 'return')
    .replace("import('./engine')", 'loadEngine()')}`,
)
const settle = () => new Promise((resolve) => setImmediate(resolve))

function fixture() {
  let enumerations = 0,
    starts = 0,
    stops = 0
  const callbacks = new Map(),
    warmups = []
  const addon = create({
    lazy() {},
    defineAddon: (addon) => addon,
    manifest: {},
    navigator: {
      mediaDevices: {
        async enumerateDevices() {
          enumerations++
          return []
        },
      },
    },
    Audio: class {
      constructor() {
        warmups.push(this)
        this.loads = 0
      }
      removeAttribute(name) {
        assert.equal(name, 'src')
        this.src = ''
      }
      load() {
        this.loads++
      }
    },
    async loadEngine() {
      return {
        startKeybeats() {
          starts++
          return () => stops++
        },
      }
    },
    requestIdleCallback(callback) {
      callbacks.set(1, callback)
      return 1
    },
    cancelIdleCallback(id) {
      callbacks.delete(id)
    },
  })
  return {
    addon,
    callbacks,
    warmups,
    async ready(event = 'canplaythrough') {
      warmups.at(-1)[`on${event}`]()
      await settle()
    },
    counts: () => ({ enumerations, starts, stops }),
  }
}

for (const event of ['canplaythrough', 'error']) {
  test(`startup waits for audio-only warm-up ${event} before idle construction`, async () => {
    const f = fixture()
    f.addon.start({ notify: assert.fail })
    await settle()
    assert.deepEqual(f.counts(), { enumerations: 0, starts: 0, stops: 0 })
    assert.equal(f.callbacks.size, 0)
    assert.equal(f.warmups.length, 1)
    const warm = f.warmups[0]
    assert.equal(warm.preload, 'auto')
    assert.match(warm.src, /^data:audio\/wav;base64,/)
    const wav = Buffer.from(warm.src.split(',')[1], 'base64')
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF')
    assert.equal(wav.toString('ascii', 8, 12), 'WAVE')
    assert.ok(wav.subarray(44).every((byte) => byte === 0))
    await f.ready(event)
    assert.equal(warm.src, '')
    assert.equal(warm.oncanplaythrough, null)
    assert.equal(warm.onerror, null)
    assert.equal(warm.loads, 1)
    assert.equal(f.callbacks.size, 1)
    f.callbacks.get(1)()
    assert.equal(f.counts().starts, 1)
    f.addon.stop()
    assert.equal(f.counts().stops, 1)
  })
}

test('stop releases pending warm-up and rejects its stale completion after restart', async () => {
  const f = fixture()
  f.addon.start({ notify: assert.fail })
  await settle()
  assert.equal(f.warmups.length, 1)
  const old = f.warmups[0],
    queued = old.oncanplaythrough
  f.addon.stop()
  assert.equal(old.src, '')
  assert.equal(old.loads, 1)
  assert.equal(old.oncanplaythrough, null)
  assert.equal(old.onerror, null)
  f.addon.start({ notify: assert.fail })
  queued()
  await settle()
  assert.equal(f.callbacks.size, 0)
  assert.equal(f.counts().starts, 0)
  assert.equal(old.loads, 1)
  await f.ready()
  assert.equal(f.callbacks.size, 1)
  f.addon.stop()
  assert.equal(f.callbacks.size, 0)
})

test('stop cancels idle preparation and invalidates a callback already queued for delivery', async () => {
  const f = fixture()
  f.addon.start({ notify: assert.fail })
  await settle()
  await f.ready()
  const queued = f.callbacks.get(1)
  assert.equal(typeof queued, 'function')
  f.addon.stop()
  assert.equal(f.callbacks.size, 0)
  queued()
  assert.equal(f.counts().starts, 0)
  f.addon.start({ notify: assert.fail })
  f.addon.stop()
  await settle()
  assert.equal(f.callbacks.size, 0)
  assert.equal(f.counts().starts, 0)
})
