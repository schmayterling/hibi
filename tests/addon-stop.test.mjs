import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'
import { stopNativeAddon } from '../src/main/addon-stop.ts'

test('native cleanup is awaited, bounded, and late rejection stays handled', async (t) => {
  const timers = new Set()
  const logs = []
  t.mock.method(globalThis, 'setTimeout', (run, delay) => {
    assert.equal(delay, 2000)
    const timer = { run }
    timers.add(timer)
    return timer
  })
  t.mock.method(globalThis, 'clearTimeout', (timer) => timers.delete(timer))
  t.mock.method(console, 'error', (...args) => logs.push(args))
  let release, reject
  const held = new Promise((resolve) => {
    release = resolve
  })
  let finished = false
  const stopping = stopNativeAddon({ id: 'normal', stop: () => held }).then(
    () => {
      finished = true
    },
  )
  await Promise.resolve()
  assert.equal(finished, false)
  release()
  await stopping
  assert.equal(timers.size, 0)
  assert.equal(logs.length, 0)
  const never = new Promise((_, fail) => {
    reject = fail
  })
  const timed = stopNativeAddon({ id: 'stalled', stop: () => never })
  await Promise.resolve()
  assert.equal(timers.size, 1)
  for (const timer of timers) timer.run()
  await timed
  assert.equal(timers.size, 0)
  assert.match(logs[0][0], /stalled.*2 seconds/)
  reject(new Error('late cleanup failure'))
  await new Promise(setImmediate)
  await stopNativeAddon({
    id: 'throws',
    stop() {
      throw new Error('broken')
    },
  })
  assert.match(logs[1][0], /throws/)
  assert.equal(timers.size, 0)
})

test('a failed native stop is reported and cannot cancel the quit', async (t) => {
  const index = await readFile(
    new URL('../src/main/index.ts', import.meta.url),
    'utf8',
  )
  const source = index.slice(
    index.indexOf('let nativeStopping:'),
    index.indexOf('const openOwnedAddonWindow'),
  )
  let handler,
    attempts = 0,
    quits = 0
  const failure = new Error('storage still open')
  const logs = []
  t.mock.method(console, 'error', (...args) => logs.push(args))
  const event = { preventDefault() {} }
  const app = {
    on(_name, listener) {
      handler = listener
    },
    quit() {
      quits++
      handler(event)
    },
  }
  const pending = new Function(
    'app',
    'stopNativeAddons',
    'globalShortcuts',
    'background',
    stripTypeScriptTypes(source) + '; return () => nativeStopping;',
  )(
    app,
    async () => {
      attempts++
      throw failure
    },
    { clear() {} },
    { dispose() {} },
  )
  handler(event)
  await pending()
  await new Promise(setImmediate)
  // Every window is already closed at will-quit; nothing is left to request a retry.
  assert.equal(attempts, 1)
  assert.equal(quits, 1)
  assert.ok(logs.some((args) => args.includes(failure)))
})

test('quit resumes after a never-resolving native stop reaches its deadline', async (t) => {
  const index = await readFile(
    new URL('../src/main/index.ts', import.meta.url),
    'utf8',
  )
  const source = index.slice(
    index.indexOf('let nativeStopping:'),
    index.indexOf('const openOwnedAddonWindow'),
  )
  let handler,
    timer,
    quit = 0,
    prevented = 0,
    cleaned = 0
  t.mock.method(globalThis, 'setTimeout', (run, delay) => {
    assert.equal(delay, 2000)
    timer = run
    return 1
  })
  t.mock.method(globalThis, 'clearTimeout', () => {})
  t.mock.method(console, 'error', () => {})
  const event = {
    preventDefault() {
      prevented++
    },
  }
  const app = {
    on(name, listener) {
      assert.equal(name, 'will-quit')
      handler = listener
    },
    quit() {
      quit++
      handler(event)
    },
  }
  const stopNativeAddons = () =>
    stopNativeAddon({ id: 'stalled', stop: () => new Promise(() => {}) })
  const pending = new Function(
    'app',
    'stopNativeAddons',
    'globalShortcuts',
    'background',
    stripTypeScriptTypes(source) + '; return () => nativeStopping;',
  )(
    app,
    stopNativeAddons,
    {
      clear() {
        cleaned++
      },
    },
    {
      dispose() {
        cleaned++
      },
    },
  )
  handler(event)
  await Promise.resolve()
  assert.equal(quit, 0)
  assert.equal(prevented, 1)
  timer()
  await pending()
  await new Promise(setImmediate)
  assert.equal(quit, 1)
  assert.equal(cleaned, 2)
})
