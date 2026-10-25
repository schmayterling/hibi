import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'

const source = await readFile('src/addons/keybeats/index.ts', 'utf8')
const create = new Function(
  'environment',
  `const { lazy, defineAddon, manifest, navigator, loadEngine,
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
  const callbacks = new Map()
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
  return { addon, callbacks, counts: () => ({ enumerations, starts, stops }) }
}

test('startup prepares output at idle without enumerating devices or waiting for input', async () => {
  const f = fixture()
  f.addon.start({ notify: assert.fail })
  await settle()
  assert.deepEqual(f.counts(), { enumerations: 0, starts: 0, stops: 0 })
  assert.equal(f.callbacks.size, 1)
  f.callbacks.get(1)()
  assert.equal(f.counts().starts, 1)
  f.addon.stop()
  assert.equal(f.counts().stops, 1)
})

test('stop cancels idle preparation and invalidates a callback already queued for delivery', async () => {
  const f = fixture()
  f.addon.start({ notify: assert.fail })
  await settle()
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
