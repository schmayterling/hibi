import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { signEnvelope, signingKey } from '../scripts/addon-signing.mjs'
import {
  ADDON_PACKAGE_TRUST_KEYS,
  ADDON_REVOCATIONS_URL,
} from '../src/shared/addon-trust.ts'

const DAY = 86400000
const { privateKey } = generateKeyPairSync('ed25519')
const key = signingKey(privateKey.export({ type: 'pkcs8', format: 'pem' }))
const envelope = (sequence, entries = []) =>
  signEnvelope(
    {
      type: 'hibi-addon-revocations',
      version: 1,
      sequence,
      issuedAt: new Date().toISOString(),
      entries,
    },
    key,
  )
const { outputFiles } = await build({
  entryPoints: [
    fileURLToPath(new URL('../src/main/addon-trust.ts', import.meta.url)),
  ],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
  plugins: [
    {
      name: 'trust-host',
      setup(bundle) {
        bundle.onResolve({ filter: /^electron$/ }, () => ({
          path: 'electron',
          namespace: 'trust',
        }))
        bundle.onLoad({ filter: /.*/, namespace: 'trust' }, () => ({
          contents:
            'export const {app,BrowserWindow,net}=globalThis.__trustHostElectron',
        }))
      },
    },
  ],
})
const evaluate = new Function(
  'require',
  'module',
  'exports',
  'setTimeout',
  'clearTimeout',
  'Date',
  'console',
  outputFiles[0].text,
)

async function host(t, { packaged = false, testFlag = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'hibi-trust-host-'))
  const keyFile = join(root, 'keys.json')
  await writeFile(keyFile, JSON.stringify(key.keys))
  const previousKeys = process.env.HIBI_TEST_ADDON_TRUST_KEYS
  const previousUrl = process.env.HIBI_TEST_ADDON_REVOCATIONS_URL
  process.env.HIBI_TEST_ADDON_TRUST_KEYS = keyFile
  process.env.HIBI_TEST_ADDON_REVOCATIONS_URL = 'http://127.0.0.1/test-list'
  const timers = new Set()
  const calls = []
  const messages = []
  const errors = []
  let response = envelope(1)
  let now = Date.now()
  let applied = 0
  const app = Object.assign(new EventEmitter(), {
    isPackaged: packaged,
    commandLine: { hasSwitch: () => testFlag },
    getPath: () => root,
  })
  globalThis.__trustHostElectron = {
    app,
    BrowserWindow: {
      getAllWindows: () =>
        [
          'app://hibi/',
          'app://hibi/addon-window.html',
          'https://untrusted.test/',
        ].map((url) => ({
          webContents: {
            isDestroyed: () => false,
            getURL: () => url,
            send: (...args) => messages.push({ url, args }),
          },
        })),
    },
    net: {
      fetch: async (url, options) => {
        calls.push({ url, options })
        if (response instanceof Error) throw response
        if (response instanceof Response) return response
        return new Response(
          typeof response === 'string' ? response : JSON.stringify(response),
        )
      },
    },
  }
  const setTimer = (fn, ms) => {
    const timer = { fn, ms, unref() {} }
    timers.add(timer)
    return timer
  }
  const module = { exports: {} }
  evaluate(
    createRequire(import.meta.url),
    module,
    module.exports,
    setTimer,
    (timer) => timers.delete(timer),
    class extends Date {
      static now() {
        return now
      }
    },
    { error: (...args) => errors.push(args) },
  )
  const api = module.exports
  await api.loadAddonTrust()
  const until = async (predicate) => {
    const deadline = Date.now() + 3000
    while (!predicate()) {
      assert.ok(Date.now() < deadline, 'trust host operation did not settle')
      await new Promise(setImmediate)
    }
  }
  const check = async () => {
    const timer = [...timers].find(({ ms }) => ms !== 15000)
    assert.ok(timer)
    timers.delete(timer)
    now += timer.ms
    timer.fn()
    await until(() => [...timers].some(({ ms }) => ms === DAY))
  }
  t.after(async () => {
    app.emit('will-quit')
    delete globalThis.__trustHostElectron
    if (previousKeys === undefined)
      delete process.env.HIBI_TEST_ADDON_TRUST_KEYS
    else process.env.HIBI_TEST_ADDON_TRUST_KEYS = previousKeys
    if (previousUrl === undefined)
      delete process.env.HIBI_TEST_ADDON_REVOCATIONS_URL
    else process.env.HIBI_TEST_ADDON_REVOCATIONS_URL = previousUrl
    await rm(root, { recursive: true, force: true })
  })
  return {
    api,
    root,
    calls,
    messages,
    errors,
    timers,
    check,
    applied: () => applied,
    start: () =>
      api.startAddonRevocations(async () => {
        applied++
      }),
    respond: (value) => {
      response = value
    },
  }
}

test('test keys and endpoint overrides require unpackaged build and explicit test switch', async (t) => {
  for (const mode of [
    { packaged: true, testFlag: true },
    { packaged: false, testFlag: false },
  ])
    await t.test(JSON.stringify(mode), async (t) => {
      const h = await host(t, mode)
      assert.deepEqual(h.api.addonTrustKeys(), ADDON_PACKAGE_TRUST_KEYS)
      h.start()
      await h.check()
      assert.equal(h.calls[0].url, ADDON_REVOCATIONS_URL)
      assert.equal(h.applied(), 0)
    })
})

test('trust preferences validate, persist, notify only trusted windows and pause network checks', async (t) => {
  const h = await host(t)
  for (const value of [null, {}, { allowUnsigned: 1, checkRevocations: false }])
    assert.throws(() => h.api.setAddonTrustSettings(value), /Could not change/)
  h.start()
  assert.equal([...h.timers][0].ms, 5000)
  await h.api.setAddonTrustSettings({
    allowUnsigned: true,
    checkRevocations: false,
  })
  assert.equal(h.timers.size, 0)
  assert.equal(h.calls.length, 0)
  assert.equal(h.messages.length, 2)
  assert.ok(
    h.messages.every(
      ({ args }) => args.length === 1 && args[0] === 'addons:trust-changed',
    ),
  )
  await h.api.loadAddonTrust()
  assert.deepEqual(h.api.getAddonTrustSettings(), {
    allowUnsigned: true,
    checkRevocations: false,
  })
  await h.api.setAddonTrustSettings({
    allowUnsigned: false,
    checkRevocations: true,
  })
  await h.check()
  const options = h.calls[0].options
  assert.equal(options.credentials, 'omit')
  assert.equal(options.redirect, 'error')
  assert.equal(options.cache, 'no-store')
  assert.ok(options.signal instanceof AbortSignal)
  await h.api.setAddonTrustSettings({
    allowUnsigned: true,
    checkRevocations: false,
  })
  await h.api.setAddonTrustSettings({
    allowUnsigned: true,
    checkRevocations: true,
  })
  assert.equal([...h.timers][0].ms, DAY)
})

test('network failures, oversized lists, rollback and equal-sequence changes retain signed offline cache', async (t) => {
  const h = await host(t)
  const accepted = envelope(3, [{ id: 'revoked', reason: 'Revoked fixture' }])
  h.respond(accepted)
  h.start()
  await h.check()
  assert.equal(h.applied(), 1)
  assert.deepEqual(h.api.getAddonRevocation({ id: 'revoked', version: '1' }), {
    reason: 'Revoked fixture.',
  })
  for (const value of [
    envelope(2),
    envelope(3),
    new Error('Offline fixture'),
    new Response('Not found', { status: 404 }),
    '{',
    'x'.repeat(256 * 1024 + 1),
    { ...envelope(4), signature: Buffer.alloc(64).toString('base64') },
  ]) {
    h.respond(value)
    await h.check()
    assert.equal(h.applied(), 1)
    assert.deepEqual(
      JSON.parse(
        await readFile(join(h.root, 'addon-revocations.json'), 'utf8'),
      ),
      accepted,
    )
  }
  await h.api.setAddonTrustSettings({
    allowUnsigned: false,
    checkRevocations: false,
  })
  await h.api.loadAddonTrust()
  assert.deepEqual(h.api.getAddonRevocation({ id: 'revoked', version: '1' }), {
    reason: 'Revoked fixture.',
  })
  assert.ok(h.errors.length >= 4)
})

test('main trusts the garden automation key for packages but not revocation lists', async (t) => {
  const h = await host(t, { packaged: true, testFlag: false })
  assert.equal(Object.hasOwn(h.api.addonTrustKeys(), '8dc7673025d00464'), true)
  h.respond({ ...envelope(1), keyId: '8dc7673025d00464' })
  h.start()
  await h.check()
  assert.equal(h.applied(), 0)
  assert.match(String(h.errors.at(-1)?.[1]?.message), /unknown key/)
})
