import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'

test('installed addon network bridge asks for each destination and private address', {
  timeout: 45000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-network-bridge-'))
  const folder = join(profile, 'installed-addons', 'network-probe')
  await mkdir(folder, { recursive: true })
  await writeFile(
    join(folder, 'hibi-addon.json'),
    JSON.stringify({
      id: 'network-probe',
      name: 'Network probe',
      description: 'Host network bridge test addon.',
      kind: 'extension',
      apiVersion: 2,
      version: '1.0.0',
      defaultEnabled: true,
      startup: 'background',
      capabilities: [],
      authors: [{ displayName: 'Test' }],
      entry: 'index.js',
    }),
  )
  await writeFile(
    join(folder, 'index.js'),
    `export default () => ({
      start(context) {
        window.networkProbe = {
          get: (url, credentialKey) => context.host.network.getText({ url, ...(credentialKey ? { credentialKey } : {}) }),
          store: (key, secret) => context.host.credentials.store({ key, secret, mode: 'session' }),
        }
      },
      stop() { delete window.networkProbe },
    })`,
  )
  await writeFile(
    join(folder, '.hibi-install.json'),
    JSON.stringify({
      hash: 'a'.repeat(64),
      files: ['hibi-addon.json', 'index.js'],
      source: 'local',
    }),
  )
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'network-probe': true }),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  await app.evaluate(({ dialog }) => {
    globalThis.networkPrompts = []
    globalThis.networkResponses = [0]
    dialog.showMessageBox = async (_window, options) => {
      globalThis.networkPrompts.push({
        message: options.message,
        detail: options.detail,
      })
      return { response: globalThis.networkResponses.shift() ?? 0 }
    }
  })
  const page = await app.firstWindow()
  await page.waitForFunction(() => !!window.networkProbe)
  assert.deepEqual(
    await page.evaluate(() => window.networkProbe.get('http://example.com/')),
    { ok: false, code: 'invalid-request' },
  )
  assert.deepEqual(
    await page.evaluate(() =>
      window.networkProbe.get('https://example.com/note'),
    ),
    { ok: false, code: 'permission-denied' },
  )
  const first = await app.evaluate(() => globalThis.networkPrompts)
  assert.equal(first.length, 1)
  assert.match(first[0].detail, /https:\/\/example\.com\/note/)
  await app.evaluate(() => {
    globalThis.networkPrompts = []
    globalThis.networkResponses = [1, 0]
  })
  assert.deepEqual(
    await page.evaluate(() =>
      window.networkProbe.get('https://127.0.0.1/note'),
    ),
    { ok: false, code: 'permission-denied' },
  )
  const local = await app.evaluate(() => globalThis.networkPrompts)
  assert.equal(local.length, 2)
  assert.match(local[1].message, /local or private address/)
  assert.deepEqual(
    await page.evaluate(() =>
      window.networkProbe.store('api-token', 'bridge-only-secret'),
    ),
    { ok: true, value: { mode: 'session' } },
  )
  await app.evaluate(() => {
    globalThis.networkPrompts = []
    globalThis.networkResponses = [0]
  })
  assert.deepEqual(
    await page.evaluate(() =>
      window.networkProbe.get('https://example.com/auth', 'api-token'),
    ),
    { ok: false, code: 'permission-denied' },
  )
  const credentialPrompt = await app.evaluate(() => globalThis.networkPrompts)
  assert.equal(credentialPrompt.length, 1)
  assert.match(
    credentialPrompt[0].detail,
    /Credential: api-token \(bearer token\)/,
  )
  assert.equal(
    JSON.stringify(credentialPrompt).includes('bridge-only-secret'),
    false,
  )
  await app.evaluate(() => {
    globalThis.networkPrompts = []
    globalThis.networkResponses = [1, 0]
  })
  assert.deepEqual(
    await page.evaluate(() =>
      window.networkProbe.get('https://127.0.0.1/auth', 'api-token'),
    ),
    { ok: false, code: 'permission-denied' },
  )
  const privateCredentialPrompts = await app.evaluate(
    () => globalThis.networkPrompts,
  )
  assert.equal(privateCredentialPrompts.length, 2)
  assert.match(
    privateCredentialPrompts[1].detail,
    /Credential: api-token \(bearer token\)/,
  )
  assert.equal(
    JSON.stringify(privateCredentialPrompts).includes('bridge-only-secret'),
    false,
  )
  await app.evaluate(async ({ BrowserWindow, dialog }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents
    while (contents.isLoadingMainFrame())
      await new Promise((resolve) => setTimeout(resolve, 10))
    contents.emit('did-start-navigation', {}, 'app://hibi/', false, true)
    dialog.showMessageBox = () =>
      new Promise((resolve) => {
        globalThis.releaseNetworkGrant = resolve
      })
  })
  await page.evaluate(() => {
    window.pendingNetworkResult = undefined
    void window.networkProbe
      .get('https://example.com/pending')
      .then((result) => {
        window.pendingNetworkResult = result
      })
  })
  await app.evaluate(async ({ BrowserWindow }) => {
    while (!globalThis.releaseNetworkGrant)
      await new Promise((resolve) => setTimeout(resolve, 10))
    const contents = BrowserWindow.getAllWindows()[0].webContents
    contents.emit('did-start-navigation', {}, 'app://hibi/', false, true)
  })
  await page.waitForFunction(() => !!window.pendingNetworkResult, undefined, {
    timeout: 5000,
  })
  assert.equal(
    (await page.evaluate(() => window.pendingNetworkResult)).ok,
    false,
  )
  await app.evaluate(() => {
    globalThis.releaseNetworkGrant({ response: 0 })
  })
  await page.evaluate(() => window.hibi.setAddonEnabled('network-probe', false))
  assert.deepEqual(
    await page.evaluate(() =>
      window.hibi.getHostText('network-probe', { url: 'https://example.com/' }),
    ),
    { ok: false, code: 'stale' },
  )
})
