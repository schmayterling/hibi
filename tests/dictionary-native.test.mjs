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
    closeCalls = 0
    closeError
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
      this.closeCalls++
      this.closingStarted = true
      if (this.closeError) return Promise.reject(this.closeError)
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
        case './custom-word-store':
          return {
            CustomWordStore: class extends PackStore {
              request() {
                return []
              }
            },
          }
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
  t.after(async () => {
    for (const store of stores) store.closeError = undefined
    const stopping = addon.stop()
    for (const store of stores) store.finishClose()
    await stopping
  })
  return { addon, stores }
}

// Close retries back off on Date.now; tests move it by hand.
function clock(t) {
  let now = 0
  t.mock.method(Date, 'now', () => now)
  return (ms) => {
    now += ms
  }
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

test('disable during a waiting custom-word request cannot resurrect its storage worker', async (t) => {
  const { addon, stores } = nativeAddon(t)
  await addon.queries.customWords({})
  addon.stop()
  const stale = assert.rejects(
    addon.queries.customWords({}),
    /Dictionary packs are closed/,
  )
  addon.stop()
  assert.equal(stores.length, 1)
  stores[0].finishClose()
  await stale
  assert.equal(stores.length, 1)
  await addon.queries.customWords({})
  assert.equal(stores.length, 2)
})

test('the next open retries failed dictionary close once for concurrent pack and word callers', async (t) => {
  const { addon, stores } = nativeAddon(t)
  const advance = clock(t)
  await addon.queries.packs()
  await addon.queries.customWords({})
  const [packs, words] = stores
  words.closeError = new Error('close failed')
  packs.finishClose()
  await assert.rejects(addon.stop(), /close failed/)
  assert.equal(words.closeCalls, 1)

  words.closeError = undefined
  advance(1000)
  const reopened = Promise.all([
    addon.queries.packs(),
    addon.queries.customWords({}),
    addon.queries.customWords({}),
  ])
  void reopened.catch(() => {})
  await setImmediate()
  assert.equal(words.closeCalls, 2)
  assert.equal(stores.length, 2, 'no new worker before the old close finishes')
  words.finishClose()
  await reopened
  assert.equal(stores.length, 4, 'one replacement per store')
  assert.equal(words.closed, true)
})

test('a persistent close failure keeps storage for later recovery without opening twice', async (t) => {
  const { addon, stores } = nativeAddon(t)
  const advance = clock(t)
  await addon.queries.customWords({})
  const [words] = stores
  words.closeError = new Error('close failed')
  await assert.rejects(addon.stop(), /close failed/)
  advance(1000)
  await assert.rejects(addon.queries.customWords({}), /close failed/)
  assert.equal(words.closeCalls, 2)
  assert.equal(stores.length, 1)
  words.closeError = undefined
  advance(2000)
  const reopened = addon.queries.customWords({})
  words.finishClose()
  await reopened
  assert.equal(words.closeCalls, 3)
  assert.equal(stores.length, 2)
})

test('disable during close recovery invalidates the waiting open', async (t) => {
  const { addon, stores } = nativeAddon(t)
  const advance = clock(t)
  await addon.queries.customWords({})
  const [words] = stores
  words.closeError = new Error('close failed')
  await assert.rejects(addon.stop(), /close failed/)
  words.closeError = undefined
  advance(1000)
  const stale = assert.rejects(
    addon.queries.customWords({}),
    /Dictionary packs are closed/,
  )
  void stale.catch(() => {})
  await setImmediate()
  const stopped = addon.stop()
  words.finishClose()
  await Promise.all([stale, stopped])
  assert.equal(stores.length, 1)
})

test('a close that keeps failing retries once per bounded backoff window, not per request wave', async (t) => {
  const { addon, stores } = nativeAddon(t)
  const advance = clock(t)
  await addon.queries.customWords({})
  const [words] = stores
  words.closeError = new Error('close failed')
  await assert.rejects(addon.stop(), /close failed/)
  assert.equal(words.closeCalls, 1)
  // Waves inside the window reject with the retained error and send no close.
  for (let wave = 0; wave < 3; wave++)
    await assert.rejects(
      Promise.all([addon.queries.customWords({}), addon.queries.packs()]),
      /close failed/,
    )
  assert.equal(words.closeCalls, 1)
  assert.equal(stores.length, 1)
  // Windows double from one second and stay capped at thirty.
  for (const window of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    const attempts = words.closeCalls
    advance(window - 1)
    await assert.rejects(addon.queries.customWords({}), /close failed/)
    assert.equal(words.closeCalls, attempts)
    advance(1)
    await assert.rejects(addon.queries.customWords({}), /close failed/)
    assert.equal(words.closeCalls, attempts + 1)
  }
  // A successful close resets the schedule.
  words.closeError = undefined
  advance(30000)
  const reopened = addon.queries.customWords({})
  words.finishClose()
  await reopened
  assert.equal(stores.length, 2)
  const [, next] = stores
  next.closeError = new Error('close failed')
  await assert.rejects(addon.stop(), /close failed/)
  advance(1000)
  await assert.rejects(addon.queries.customWords({}), /close failed/)
  assert.equal(next.closeCalls, 2)
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
