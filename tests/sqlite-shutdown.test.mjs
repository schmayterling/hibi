import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { build } from 'esbuild'
import { CustomWordStore } from '../src/addons/dictionary/custom-word-store.ts'
import { stopNativeAddon } from '../src/main/addon-stop.ts'
import { installOwnedFailureReporter } from '../src/main/local-diagnostics/owned.ts'
import { waitForAsync } from './poll.mjs'

test('dictionary cleanup never abandons durable close at the generic deadline', {
  timeout: 10000,
}, async (t) => {
  const timers = []
  t.mock.method(globalThis, 'setTimeout', (callback) => {
    timers.push(callback)
    return 1
  })
  t.mock.method(globalThis, 'clearTimeout', () => {})
  t.mock.method(console, 'error', () => {})
  let release
  let finished = false
  const close = new Promise((resolve) => {
    release = resolve
  })
  const stopping = stopNativeAddon(
    {
      id: 'dictionary',
      stop: () => close,
    },
    true,
  ).then(() => {
    finished = true
  })
  await Promise.resolve()
  for (const timer of timers) timer()
  await new Promise(setImmediate)
  const abandoned = finished
  // Disabling stops waiting at the deadline; the close itself keeps running.
  const disabling = stopNativeAddon({ id: 'dictionary', stop: () => close })
  await Promise.resolve()
  for (const timer of timers) timer()
  await disabling
  release()
  await stopping
  assert.equal(abandoned, false)
})

test('a failed dictionary close is reported without holding quit or addon changes open', async (t) => {
  const logs = []
  t.mock.method(console, 'error', (...args) => logs.push(args))
  for (const quitting of [true, false])
    await stopNativeAddon(
      {
        id: 'dictionary',
        stop: () => Promise.reject(new Error('PRIVATE_CLOSE_ERROR')),
      },
      quitting,
    )
  assert.equal(logs.length, 2)
  assert.match(logs[0][0], /dictionary/)
})

async function fixture(t) {
  await mkdir('.scratch', { recursive: true })
  const root = await mkdtemp(resolve('.scratch/sqlite-close-'))
  const path = join(root, 'worker.mjs')
  await build({
    entryPoints: [resolve('src/addons/dictionary/custom-words-worker.ts')],
    outfile: path,
    bundle: true,
    platform: 'node',
    format: 'esm',
    banner: {
      js: `
import { DatabaseSync as TestDatabase } from 'node:sqlite'
import { existsSync as testExists, writeFileSync as testWrite } from 'node:fs'
import { workerData as testData } from 'node:worker_threads'
const testClose = TestDatabase.prototype.close
TestDatabase.prototype.close = function () {
  testWrite(testData.profile + '/closing', '1')
  while (testExists(testData.profile + '/hold')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
  if (testExists(testData.profile + '/fail')) throw new Error('PRIVATE_CLOSE_ERROR')
  testClose.call(this)
  testWrite(testData.profile + '/closed', '1')
}
`,
    },
  })
  await mkdir(join(root, 'dictionary-custom-words'), { recursive: true })
  const database = new DatabaseSync(
    join(root, 'dictionary-custom-words/words.sqlite'),
  )
  database.exec('PRAGMA journal_mode=WAL')
  database.close()
  const store = new CustomWordStore(path, root)
  t.after(async () => {
    await unlink(join(root, 'hold')).catch(() => {})
    await unlink(join(root, 'fail')).catch(() => {})
    await store.close().catch(() => {})
    await store.worker?.terminate()
    installOwnedFailureReporter(null)
  })
  await store.request('metadata')
  return { root, store, path }
}

test('sqlite shutdown drains accepted work, closes the database and reopens the profile', async (t) => {
  const { root, store, path } = await fixture(t)
  const { revision } = await store.request('metadata')
  const { token } = await store.request('change', { type: 'begin', revision })
  await store.request('change', {
    type: 'stage',
    token,
    upsert: [{ id: 'retained', word: 'durable' }],
    remove: [],
  })
  const pending = store.request('change', { type: 'commit', token })
  const closing = store.close()
  assert.equal(store.close(), closing)
  await assert.rejects(store.request('metadata'), /closed/)
  assert.equal((await pending).count, 1)
  await closing
  assert.equal(await readFile(join(root, 'closed'), 'utf8'), '1')
  assert.equal(store.worker, undefined)
  await assert.rejects(
    readFile(join(root, 'dictionary-custom-words/words.sqlite-wal')),
    { code: 'ENOENT' },
  )
  const check = new DatabaseSync(
    join(root, 'dictionary-custom-words/words.sqlite'),
  )
  assert.equal(check.prepare('PRAGMA quick_check').get().quick_check, 'ok')
  check.close()
  const reopened = new CustomWordStore(path, root)
  assert.equal((await reopened.request('metadata')).count, 1)
  assert.equal((await reopened.request('page', {})).words[0].word, 'durable')
  await reopened.close()
})

test('overdue WAL close reports once and keeps waiting without terminating sqlite', {
  timeout: 10000,
}, async (t) => {
  const { root, store } = await fixture(t)
  const reports = []
  installOwnedFailureReporter((code, error, detail) =>
    reports.push({ code, error, detail }),
  )
  await writeFile(join(root, 'hold'), '')
  let closed = false
  const closing = store.close().then(() => {
    closed = true
  })
  await waitForAsync(
    { evaluate: async (fn) => fn() },
    async () =>
      (await readFile(join(root, 'closing'), 'utf8').catch(() => '')) === '1',
  )
  await waitForAsync(
    { evaluate: async (fn) => fn() },
    () => reports.some((row) => row.code === 'SQLITE_CLOSE_WAITING'),
    undefined,
    { timeout: 4000 },
  )
  assert.equal(closed, false)
  assert.ok(store.worker)
  assert.equal(
    reports.filter((row) => row.code === 'SQLITE_CLOSE_WAITING').length,
    1,
  )
  await unlink(join(root, 'hold'))
  await closing
  assert.equal(await readFile(join(root, 'closed'), 'utf8'), '1')
})

test('failed sqlite close retains the worker for a safe retry', async (t) => {
  const { root, store } = await fixture(t)
  const reports = []
  installOwnedFailureReporter((code) => reports.push(code))
  await writeFile(join(root, 'fail'), '')
  await assert.rejects(store.close(), /PRIVATE_CLOSE_ERROR/)
  assert.ok(store.worker)
  assert.ok(reports.includes('SQLITE_CLOSE_FAILED'))
  await unlink(join(root, 'fail'))
  await store.close()
  assert.equal(await readFile(join(root, 'closed'), 'utf8'), '1')
})
