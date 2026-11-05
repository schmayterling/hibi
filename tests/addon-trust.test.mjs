import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { signEnvelope, signingKey } from '../scripts/addon-signing.mjs'
import { inventoryAddonDirectory } from '../src/main/addon-inventory.ts'
import { addonFileHashes } from '../src/main/addon-trust-crypto.ts'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'hibi-addon-trust-'))
  const profile = join(root, 'profile')
  const { privateKey } = generateKeyPairSync('ed25519')
  const key = signingKey(privateKey.export({ type: 'pkcs8', format: 'pem' }))
  const keyFile = join(root, 'test-public-keys.json')
  await writeFile(keyFile, JSON.stringify(key.keys))
  let app
  const launch = async (url) => {
    app = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${profile}`],
      env: {
        ...process.env,
        HIBI_TEST_ADDON_TRUST_KEYS: keyFile,
        ...(url ? { HIBI_TEST_ADDON_REVOCATIONS_URL: url } : {}),
      },
    })
    const page = await app.firstWindow()
    await waitForDocumentEditor(app, page)
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    return { app, page }
  }
  const packageFolder = async (id, signed = false) => {
    const folder = join(root, id)
    await mkdir(folder)
    const manifest = {
      id,
      name: id,
      description: 'Trust fixture',
      version: '1.0.0',
      kind: 'extension',
      apiVersion: 3,
      capabilities: [],
      authors: [{ displayName: 'Test' }],
      entry: 'index.js',
    }
    await writeFile(join(folder, 'hibi-addon.json'), JSON.stringify(manifest))
    await writeFile(join(folder, 'README.md'), '# Trust fixture')
    await writeFile(
      join(folder, 'index.js'),
      `export default () => ({
      start() { window.trustFixtureStarts = (window.trustFixtureStarts || 0) + 1; },
      stop() { window.trustFixtureStops = (window.trustFixtureStops || 0) + 1; }
    })`,
    )
    if (signed)
      await writeFile(
        join(folder, 'hibi-addon.sig.json'),
        JSON.stringify(
          signEnvelope(
            {
              type: 'hibi-addon-signature',
              version: 1,
              id,
              addonVersion: '1.0.0',
              files: await addonFileHashes(
                await inventoryAddonDirectory(folder),
              ),
              signedAt: new Date().toISOString(),
            },
            key,
          ),
        ),
      )
    return folder
  }
  t.after(async () => {
    if (app) await app.close()
    await rm(root, { recursive: true, force: true })
  })
  return {
    profile,
    key,
    launch,
    packageFolder,
    close: async () => {
      await app.close()
      app = undefined
    },
  }
}

async function select(app, folder) {
  await app.evaluate(({ dialog }, source) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [source],
    })
  }, folder)
}

test('unsigned installs require opt-in; signed installs record trust and tampering blocks replacements', {
  timeout: 60000,
}, async (t) => {
  const f = await fixture(t)
  const unsigned = await f.packageFolder('unsigned-fixture')
  const signed = await f.packageFolder('signed-fixture', true)
  const { app, page } = await f.launch()
  assert.deepEqual(
    await page.evaluate(() => window.hibi.getAddonTrustSettings()),
    { allowUnsigned: false, checkRevocations: true },
  )
  for (const value of [
    null,
    {},
    { allowUnsigned: 'yes', checkRevocations: false },
    { allowUnsigned: false, checkRevocations: false, url: 'http://localhost/' },
  ])
    await assert.rejects(
      page.evaluate((value) => window.hibi.setAddonTrustSettings(value), value),
      /Could not change addon trust settings/,
    )
  await page.evaluate(() =>
    window.hibi.setAddonTrustSettings({
      allowUnsigned: false,
      checkRevocations: false,
    }),
  )
  await select(app, unsigned)
  await assert.rejects(
    page.evaluate(() => window.hibi.installAddon()),
    /Allow unsigned addons.*Settings.*Addon Manager.*Security/s,
  )
  assert.deepEqual(
    await page.evaluate(() => window.hibi.getInstalledAddons()),
    [],
  )
  await page.evaluate(() => {
    window.trustChangeCount = 0
    window.hibi.onAddonTrustChanged(() => {
      window.trustChangeCount++
    })
  })
  await page.evaluate(() =>
    window.hibi.setAddonTrustSettings({
      allowUnsigned: true,
      checkRevocations: false,
    }),
  )
  await page.waitForFunction(() => window.trustChangeCount > 0)
  await page.evaluate(() => window.hibi.installAddon())
  let installed = await page.evaluate(() => window.hibi.getInstalledAddons())
  assert.equal(installed[0].trust, 'unsigned')
  assert.equal(installed[0].source, 'local')
  await page.evaluate(() =>
    window.hibi.setAddonTrustSettings({
      allowUnsigned: false,
      checkRevocations: false,
    }),
  )
  await assert.rejects(
    page.evaluate(() => window.hibi.installAddon()),
    /unsigned/,
  )
  await page.evaluate(() =>
    window.hibi.setAddonEnabled('unsigned-fixture', true),
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getAddonStates())).find(
      ({ id }) => id === 'unsigned-fixture',
    ).enabled,
    true,
  )
  await select(app, signed)
  await page.evaluate(() => window.hibi.installAddon())
  installed = await page.evaluate(() => window.hibi.getInstalledAddons())
  assert.equal(
    installed.find(({ manifest }) => manifest.id === 'signed-fixture').trust,
    'signed',
  )
  const record = JSON.parse(
    await readFile(
      join(
        f.profile,
        'installed-addons',
        'signed-fixture',
        '.hibi-install.json',
      ),
      'utf8',
    ),
  )
  assert.equal(record.trust, 'signed')
  await writeFile(join(signed, 'index.js'), 'throw new Error("Tampered")')
  await assert.rejects(
    page.evaluate(() => window.hibi.installAddon()),
    /signature does not match its files/,
  )
  await page.evaluate(() =>
    window.hibi.setAddonTrustSettings({
      allowUnsigned: true,
      checkRevocations: false,
    }),
  )
  await assert.rejects(
    page.evaluate(() => window.hibi.installAddon()),
    /signature does not match its files/,
  )
  await page.evaluate(() =>
    window.hibi.setAddonTrustSettings({
      allowUnsigned: false,
      checkRevocations: false,
    }),
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getInstalledAddons())).length,
    2,
  )
  assert.deepEqual(
    JSON.parse(
      await readFile(join(f.profile, 'addon-trust-settings.json'), 'utf8'),
    ),
    { allowUnsigned: false, checkRevocations: false },
  )
})

test('signed remote revocations disable installed versions, forbid enabling and installs, and survive offline restart', {
  timeout: 60000,
}, async (t) => {
  const f = await fixture(t)
  const folder = await f.packageFolder('revoked-fixture', true)
  let envelope
  let requests = 0
  const pending = new Set()
  const reply = (response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(envelope))
  }
  const server = createServer((request, response) => {
    requests++
    assert.equal(request.headers.cookie, undefined)
    assert.equal(request.headers.authorization, undefined)
    if (envelope) reply(response)
    else pending.add(response)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections()
    return new Promise((resolve) => server.close(resolve))
  })
  const url = `http://127.0.0.1:${server.address().port}/revocations.json`
  let { app, page } = await f.launch(url)
  await select(app, folder)
  await page.evaluate(() => window.hibi.installAddon())
  // A direct API install skips the chooser, so reload to list the package.
  await page.reload()
  await waitForDocumentEditor(app, page)
  await page.evaluate(() => {
    window.trustChangeCount = 0
    window.hibi.onAddonTrustChanged(() => {
      window.trustChangeCount++
    })
  })
  // Enable through settings so the renderer actually starts the addon.
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^addon manager$/i }).click()
  // The controlled toggle updates after IPC; check() asserts too early.
  await page.locator('#addon-revoked-fixture').click()
  await page.waitForFunction(() => window.trustFixtureStarts === 1)
  assert.equal(
    (await page.evaluate(() => window.hibi.getAddonStates())).find(
      ({ id }) => id === 'revoked-fixture',
    ).enabled,
    true,
  )
  envelope = signEnvelope(
    {
      type: 'hibi-addon-revocations',
      version: 1,
      sequence: 2,
      issuedAt: new Date().toISOString(),
      entries: [
        {
          id: 'revoked-fixture',
          versions: ['1.0.0'],
          reason: '  security fixture  ',
        },
      ],
    },
    f.key,
  )
  for (const response of pending) reply(response)
  pending.clear()
  await waitForAsync(
    page,
    async () =>
      (await window.hibi.getInstalledAddons()).some(
        (addon) =>
          addon.manifest.id === 'revoked-fixture' &&
          addon.revoked?.reason === 'Security fixture.',
      ) &&
      (await window.hibi.getAddonStates()).some(
        (addon) => addon.id === 'revoked-fixture' && !addon.enabled,
      ),
  )
  await page.waitForFunction(() => window.trustChangeCount > 0)
  // The trust change event stops the running renderer addon and locks its toggle.
  await page.waitForFunction(() => window.trustFixtureStops === 1)
  await waitForAsync(page, () => {
    const box = document.querySelector('#addon-revoked-fixture')
    return box && !box.checked && box.disabled
  })
  await assert.rejects(
    page.evaluate(() =>
      window.hibi.setAddonEnabled('revoked-fixture', true, true),
    ),
    /revoked.*Security fixture/,
  )
  await assert.rejects(
    page.evaluate(() => window.hibi.installAddon()),
    /revoked.*Security fixture/,
  )
  assert.equal(requests, 1)
  const cached = JSON.parse(
    await readFile(join(f.profile, 'addon-revocations.json'), 'utf8'),
  )
  assert.deepEqual(cached, envelope)
  await f.close()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  // Prove the signed cache enforces revocation rather than merely retaining a disabled preference.
  await writeFile(
    join(f.profile, 'addons.json'),
    JSON.stringify({ 'revoked-fixture': true }),
  )
  ;({ app, page } = await f.launch(url))
  const installed = await page.evaluate(() => window.hibi.getInstalledAddons())
  assert.deepEqual(installed[0].revoked, { reason: 'Security fixture.' })
  assert.equal(installed[0].trust, 'signed')
  assert.equal(
    (await page.evaluate(() => window.hibi.getAddonStates())).find(
      ({ id }) => id === 'revoked-fixture',
    ).enabled,
    false,
  )
  assert.equal(await page.evaluate(() => window.trustFixtureStarts), undefined)
  await assert.rejects(
    page.evaluate(() => window.hibi.setAddonEnabled('revoked-fixture', true)),
    /revoked.*Security fixture/,
  )
  await page.evaluate(() =>
    window.hibi.setAddonTrustSettings({
      allowUnsigned: false,
      checkRevocations: false,
    }),
  )
  await assert.rejects(
    page.evaluate(() => window.hibi.setAddonEnabled('revoked-fixture', true)),
    /revoked/,
  )
})
