import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'

const bundle = build({
  entryPoints: ['src/main/autosave-preferences.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  external: ['electron'],
  format: 'cjs',
})
async function runtime(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'hibi-autosave-settings-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const require = createRequire(import.meta.url)
  const module = { exports: {} }
  const state = { hold: null, fail: false, failRead: false, syncs: 0 }
  const files = {
    ...fs,
    readFile: (...args) => {
      if (state.failRead)
        throw Object.assign(new Error('unreadable setting'), { code: 'EACCES' })
      return fs.readFile(...args)
    },
    open: async (...args) => {
      const handle = await fs.open(...args)
      if (String(args[0]).endsWith('.tmp')) {
        const sync = handle.sync.bind(handle)
        handle.sync = async () => {
          state.syncs++
          if (state.hold) await state.hold
          if (state.fail) throw new Error('disk refused setting')
          await sync()
        }
      }
      return handle
    },
  }
  new Function(
    'require',
    'module',
    'exports',
    (await bundle).outputFiles[0].text,
  )(
    (id) =>
      id === 'electron'
        ? { app: { getPath: () => root } }
        : id === 'node:fs/promises'
          ? files
          : require(id),
    module,
    module.exports,
  )
  return {
    root,
    state,
    setting: module.exports.autosavePreferences,
    disk: async () =>
      JSON.parse(await fs.readFile(join(root, 'autosave.json'), 'utf8')),
  }
}

test('safety preference migrates explicit off and ignores stale DOMStorage thereafter', async (t) => {
  const { setting, disk, state } = await runtime(t)
  assert.deepEqual(await setting('get', null), { enabled: true, delay: 2000 })
  assert.deepEqual(await setting('get', '{"enabled":false,"delay":1000}'), {
    enabled: false,
    delay: 1000,
  })
  assert.deepEqual(await disk(), { enabled: false, delay: 1000 })
  assert.deepEqual(await setting('get', '{"enabled":true}'), {
    enabled: false,
    delay: 1000,
  })
  assert.equal(state.syncs, 1)
  await setting('set', { enabled: true, delay: 5000 })
  // Once migrated, the main file wins even over a stale legacy off.
  assert.deepEqual(await setting('get', '{"enabled":false}'), {
    enabled: true,
    delay: 5000,
  })
  assert.deepEqual(await setting('get', null), { enabled: true, delay: 5000 })
  for (const invalid of [
    null,
    {},
    { enabled: 'no', delay: 2000 },
    { enabled: false, delay: 3 },
  ])
    await assert.rejects(setting('set', invalid), /Invalid autosave/)
  assert.deepEqual(await disk(), { enabled: true, delay: 5000 })
})

test('setting waits for file sync, failure preserves old setting, next write recovers', async (t) => {
  const { setting, state, disk, root } = await runtime(t)
  await setting('set', { enabled: true, delay: 2000 })
  let release
  state.hold = new Promise((resolve) => {
    release = resolve
  })
  let completed = false
  const pending = setting('set', { enabled: false, delay: 1000 }).then(() => {
    completed = true
  })
  while (state.syncs < 2) await new Promise(setImmediate)
  assert.equal(completed, false)
  assert.equal((await disk()).enabled, true)
  release()
  await pending
  assert.equal((await disk()).enabled, false)
  state.hold = null
  state.fail = true
  await assert.rejects(
    setting('set', { enabled: true, delay: 2000 }),
    /disk refused/,
  )
  assert.equal((await disk()).enabled, false)
  assert.deepEqual(await fs.readdir(root), ['autosave.json'])
  state.fail = false
  await setting('set', { enabled: true, delay: 10000 })
  assert.deepEqual(await disk(), { enabled: true, delay: 10000 })
  await fs.writeFile(join(root, 'autosave.json'), 'broken')
  assert.equal((await setting('get', null)).enabled, false)
  state.failRead = true
  assert.equal((await setting('get', '{"enabled":true}')).enabled, false)
})

test('migration failure starts off, preserves legacy choice, and retries when writable', async (t) => {
  const { setting, state, root, disk } = await runtime(t)
  state.fail = true
  const legacy = '{"enabled":true,"delay":1000}'
  assert.deepEqual(await setting('get', legacy), {
    enabled: false,
    delay: 2000,
  })
  await assert.rejects(fs.readFile(join(root, 'autosave.json')), {
    code: 'ENOENT',
  })
  state.fail = false
  assert.deepEqual(await setting('get', legacy), { enabled: true, delay: 1000 })
  assert.deepEqual(await disk(), { enabled: true, delay: 1000 })
})
test('orphan temp cleanup keeps the saved setting file and its value', async (t) => {
  const { setting, root, disk } = await runtime(t)
  await fs.writeFile(
    join(root, 'autosave.json'),
    JSON.stringify({ enabled: false, delay: 5000 }),
  )
  await fs.writeFile(
    join(root, '.autosave.json.00000000-0000-0000-0000-000000000001.tmp'),
    'unfinished',
  )
  assert.deepEqual(await setting('get', null), { enabled: false, delay: 5000 })
  assert.deepEqual(await fs.readdir(root), ['autosave.json'])
  assert.deepEqual(await disk(), { enabled: false, delay: 5000 })
})

test("oversized legacy starts off and only this setting's orphan temps are removed", async (t) => {
  const { setting, root } = await runtime(t)
  await fs.writeFile(
    join(root, '.autosave.json.00000000-0000-0000-0000-000000000001.tmp'),
    'unfinished',
  )
  await fs.writeFile(join(root, 'other.tmp'), 'keep')
  assert.deepEqual(await setting('get', 'x'.repeat(2048)), {
    enabled: false,
    delay: 2000,
  })
  assert.deepEqual(await fs.readdir(root), ['other.tmp'])
})
