import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'

test('installed addon uses host credential status without reading stored secrets', {
  timeout: 45000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-credentials-bridge-'))
  const folder = join(profile, 'installed-addons', 'credential-probe')
  await mkdir(folder, { recursive: true })
  await writeFile(
    join(folder, 'hibi-addon.json'),
    JSON.stringify({
      id: 'credential-probe',
      name: 'Credential probe',
      description: 'Host credential bridge test addon.',
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
        window.credentialProbe = {
          store: (key, secret, mode) => context.host.credentials.store({ key, secret, mode }),
          remove: key => context.host.credentials.remove({ key }),
          status: key => context.host.credentials.status({ key }),
        }
      },
      stop() { delete window.credentialProbe },
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
    JSON.stringify({ 'credential-probe': true }),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await page.waitForFunction(() => !!window.credentialProbe)
  const secret = 'synthetic-bridge-secret-123'
  const missing = await page.evaluate(() =>
    window.credentialProbe.status('api-token'),
  )
  assert.equal(missing.ok, true)
  assert.equal(missing.value.stored, 'missing')
  assert.equal(
    await page.evaluate(() =>
      Object.hasOwn(window.hibi, 'applyForApprovedRequest'),
    ),
    false,
  )
  assert.deepEqual(
    await page.evaluate(
      (value) => window.credentialProbe.store('api-token', value, 'session'),
      secret,
    ),
    { ok: true, value: { mode: 'session' } },
  )
  const session = await page.evaluate(() =>
    window.credentialProbe.status('api-token'),
  )
  assert.equal(session.value.stored, 'session')
  assert.equal(JSON.stringify(session).includes(secret), false)
  assert.deepEqual(
    await page.evaluate(() => window.credentialProbe.remove('api-token')),
    { ok: true, value: { removed: true } },
  )
  assert.equal(
    (await page.evaluate(() => window.credentialProbe.status('api-token')))
      .value.stored,
    'missing',
  )
  assert.deepEqual(
    await page.evaluate(() =>
      window.hibi.storeHostCredential('credential-probe', {
        key: 'api-token',
        secret: 'synthetic',
        mode: 'plain',
      }),
    ),
    { ok: false, code: 'invalid-request' },
  )

  if (missing.value.persistence === 'protected') {
    assert.deepEqual(
      await page.evaluate(
        (value) =>
          window.credentialProbe.store('api-token', value, 'persistent'),
        secret,
      ),
      { ok: true, value: { mode: 'persistent' } },
    )
    const encrypted = await readFile(
      join(profile, 'addon-credentials', 'credential-probe.json'),
      'utf8',
    )
    assert.equal(encrypted.includes(secret), false)
  } else {
    const denied = await page.evaluate(
      (value) => window.credentialProbe.store('api-token', value, 'persistent'),
      secret,
    )
    assert.deepEqual(denied, {
      ok: false,
      code:
        missing.value.persistence === 'unprotected'
          ? 'unprotected'
          : 'locked-or-unavailable',
    })
  }

  await page.evaluate(() =>
    window.hibi.setAddonEnabled('credential-probe', false),
  )
  assert.deepEqual(
    await page.evaluate(() =>
      window.hibi.getHostCredentialStatus('credential-probe', {
        key: 'api-token',
      }),
    ),
    { ok: false, code: 'stale' },
  )
  await page.evaluate(() =>
    window.hibi.setAddonEnabled('credential-probe', true),
  )
  await page.waitForFunction(() => !!window.credentialProbe)
  const afterEnable = await page.evaluate(() =>
    window.credentialProbe.status('api-token'),
  )
  assert.equal(afterEnable.ok, true)
  assert.equal(
    afterEnable.value.stored,
    missing.value.persistence === 'protected' ? 'persistent' : 'missing',
  )
  assert.equal(JSON.stringify(afterEnable).includes(secret), false)
  if (afterEnable.value.stored === 'persistent') {
    assert.deepEqual(
      await page.evaluate(() => window.credentialProbe.remove('api-token')),
      { ok: true, value: { removed: true } },
    )
  }
})
