import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { transform } from 'esbuild'

const { code } = await transform(
  await readFile(
    new URL('../src/addons/dictionary/native.ts', import.meta.url),
    'utf8',
  ),
  { loader: 'ts', format: 'cjs' },
)
const require = createRequire(import.meta.url)

function nativeAddon(t) {
  const stores = []
  class PackStore {
    lists = 0
    closed = false
    closingStarted = false
    constructor() {
      stores.push(this)
      this.closing = new Promise((resolve) => {
        this.finishClose = () => {
          this.closed = true
          resolve()
        }
      })
    }
    list() {
      this.lists++
      return []
    }
    close() {
      this.closingStarted = true
      return this.closing
    }
  }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', code)(
    (id) => {
      switch (id) {
        case 'electron':
          return {
            app: {
              on() {},
              getPath: () => '/profile',
              getAppPath: () => '/app',
            },
          }
        case './manifest':
          return { id: 'dictionary' }
        case './pack-store':
          return { PackStore }
        case './pack-runtime':
        case './packs':
        case '../../shared/host-selected-io':
          return {}
        default:
          return require(id)
      }
    },
    module,
    module.exports,
  )
  const addon = module.exports.default
  t.after(() => {
    addon.stop()
    for (const store of stores) store.finishClose()
  })
  return { addon, stores }
}

test('disable during a queued re-enable prevents store resurrection and pack listing', async (t) => {
  const { addon, stores } = nativeAddon(t)
  await addon.queries.packs()
  addon.stop()
  const stale = assert.rejects(
    addon.queries.packs(),
    /Dictionary packs are closed/,
  )
  addon.stop()
  assert.equal(stores.length, 1)
  assert.equal(stores[0].closingStarted, true)
  stores[0].finishClose()
  await stale
  assert.equal(stores.length, 1)
  assert.equal(stores[0].lists, 1)
  t.diagnostic('1 store and 1 list before and after the second disable')

  await addon.queries.packs()
  assert.equal(stores.length, 2)
  assert.equal(stores[1].lists, 1)
})

test('re-enable waits for close and concurrent callers share the new store', async (t) => {
  const { addon, stores } = nativeAddon(t)
  await addon.queries.packs()
  addon.stop()
  const pending = Promise.all([addon.queries.packs(), addon.queries.packs()])
  await setImmediate()
  assert.equal(stores.length, 1)
  assert.equal(stores[0].closed, false)
  stores[0].finishClose()
  await pending
  assert.equal(stores.length, 2)
  assert.equal(stores[0].closed, true)
  assert.equal(stores[1].lists, 2)
})

test('stop invalidates a waiting first caller when no store exists', async (t) => {
  const { addon, stores } = nativeAddon(t)
  const stale = assert.rejects(
    addon.queries.packs(),
    /Dictionary packs are closed/,
  )
  addon.stop()
  await stale
  assert.equal(stores.length, 0)
})
