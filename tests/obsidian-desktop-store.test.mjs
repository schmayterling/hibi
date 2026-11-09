import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { createServer } from 'vite'
import { fixtureVault } from './obsidian/harness.mjs'

async function setup(t) {
  const fixture = await fixtureVault(t, 'host-smoke', { cleanup: false })
  const server = await createServer({
    configFile: false,
    cacheDir: join(fixture.root, 'cache'),
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: 'custom',
  })
  t.after(async () => {
    await server.close()
    try {
      await fixture.assertUnchanged()
    } finally {
      await fixture.dispose()
    }
  })
  const modules = await server.ssrLoadModule('/src/addons/obsidian/store.ts')
  const { parseObsidianManifest } = await server.ssrLoadModule(
    '/src/addons/obsidian/package.ts',
  )
  const store = new modules.ObsidianStore(join(fixture.overlay, 'global'))
  const source = (
    isDesktopOnly = false,
    fields = {},
    main = fixture.plugin.main,
  ) =>
    modules.readObsidianPackageBytes(
      Buffer.from(
        JSON.stringify({
          ...fixture.plugin.manifest,
          isDesktopOnly,
          ...fields,
        }),
      ),
      Buffer.from(main),
      Buffer.from('.fixture { color: red }'),
    )
  const recordPath = join(store.root, 'state', 'host-smoke', 'package.json')
  return {
    ...fixture,
    ...modules,
    parseObsidianManifest,
    store,
    source,
    raw: async () => JSON.parse(await readFile(recordPath, 'utf8')),
    writeRecord: (value) => writeFile(recordPath, JSON.stringify(value)),
  }
}

function ungranted(record) {
  assert.notEqual(record.fullAccess, true)
}

test('desktop manifests are accepted and isDesktopOnly remains a mandatory boolean', async (t) => {
  const f = await setup(t)
  for (const desktop of [true, false]) {
    assert.equal(f.source(desktop).manifest.isDesktopOnly, desktop)
    assert.equal(
      f.parseObsidianManifest({ ...f.plugin.manifest, isDesktopOnly: desktop })
        .isDesktopOnly,
      desktop,
    )
  }
  for (const invalid of [undefined, null, 0, 1, 'true', 'false', [], {}])
    assert.throws(
      () =>
        f.parseObsidianManifest({
          ...f.plugin.manifest,
          isDesktopOnly: invalid,
        }),
      /manifest/,
    )
})

test('desktop installation stays disabled until an explicit fourth-argument grant', async (t) => {
  const f = await setup(t)
  const source = f.source(true)
  const installed = await f.store.install(source)
  assert.equal(installed.enabled, false)
  ungranted(installed)
  ungranted(await f.raw())
  ungranted((await f.store.list())[0])
  for (const permission of [undefined, false, 'true', 1, {}]) {
    await assert.rejects(
      f.store.setEnabled('host-smoke', true, undefined, permission),
      /full.*access/i,
    )
    assert.equal((await f.store.list())[0].enabled, false)
    ungranted(await f.raw())
  }
  const enabled = await f.store.setEnabled('host-smoke', true, undefined, true)
  assert.equal(enabled.enabled, true)
  assert.equal(enabled.fullAccess, true)
  assert.equal(enabled.hash, source.hash)
  assert.equal((await f.raw()).fullAccess, true)
  const reopened = new f.ObsidianStore(f.store.root)
  assert.deepEqual(await reopened.list(), [enabled])
  assert.equal(
    (await reopened.enabledPackage('host-smoke', source.hash)).hash,
    source.hash,
  )
})

test('portable packages retain ordinary enable behavior and can explicitly gain and drop full access', async (t) => {
  const f = await setup(t)
  await f.store.install(f.source())
  let checks = 0
  const check = () => checks++
  ungranted(await f.store.setEnabled('host-smoke', true, check))
  assert.ok(checks > 0, 'third argument must remain the activation check')
  assert.equal((await f.store.list())[0].enabled, true)
  assert.equal(
    (await f.store.setEnabled('host-smoke', true, check, true)).fullAccess,
    true,
  )
  ungranted(await f.store.setEnabled('host-smoke', true))
  ungranted(await f.raw())
  assert.equal((await f.store.list())[0].enabled, true)
})

test('disable clears grants even with fullAccess true; re-enable never inherits consent', async (t) => {
  const f = await setup(t)
  for (const desktop of [true, false]) {
    await f.store.install(f.source(desktop))
    await f.store.setEnabled('host-smoke', true, undefined, true)
    const disabled = await f.store.setEnabled(
      'host-smoke',
      false,
      undefined,
      true,
    )
    assert.equal(disabled.enabled, false)
    ungranted(disabled)
    ungranted(await f.raw())
    ungranted((await f.store.list())[0])
    if (desktop)
      await assert.rejects(
        f.store.setEnabled('host-smoke', true),
        /full.*access/i,
      )
    else ungranted(await f.store.setEnabled('host-smoke', true))
  }
})

test('reinstall, update and rollback all start disabled without inherited grants', async (t) => {
  const f = await setup(t)
  const first = f.source(true)
  const updated = f.source(
    true,
    { version: '2.0.0' },
    `${f.plugin.main}\n// fixture update`,
  )
  assert.notEqual(first.hash, updated.hash)
  for (const source of [first, first, updated, first]) {
    const installed = await f.store.install(source)
    assert.equal(installed.enabled, false)
    assert.equal(installed.hash, source.hash)
    ungranted(installed)
    ungranted(await f.raw())
    await assert.rejects(
      f.store.setEnabled('host-smoke', true),
      /full.*access/i,
    )
    await f.store.setEnabled('host-smoke', true, undefined, true)
    assert.equal((await f.store.list())[0].fullAccess, true)
  }
  await f.store.setEnabled('host-smoke', false)
  await f.store.remove('host-smoke')
  ungranted(await f.store.install(first))
})

test('migration copies desktop packages disabled and leaves legacy grants and vault bytes untouched', async (t) => {
  const f = await setup(t)
  const legacyRoot = join(f.overlay, 'vaults')
  const legacy = new f.ObsidianStore(join(legacyRoot, 'a'.repeat(64)))
  const source = f.source(true)
  await legacy.install(source)
  await legacy.setEnabled('host-smoke', true, undefined, true)
  await legacy.saveData('host-smoke', { retained: true })
  const recordPath = join(legacy.root, 'state', 'host-smoke', 'package.json')
  const before = await readFile(recordPath)
  await f.store.migrateLegacy(legacyRoot)
  const [migrated] = await f.store.list()
  assert.equal(migrated.enabled, false)
  assert.equal(migrated.hash, source.hash)
  ungranted(migrated)
  ungranted(await f.raw())
  assert.deepEqual(await f.store.loadData('host-smoke'), { retained: true })
  assert.deepEqual(await readFile(recordPath), before)
  await assert.rejects(f.store.setEnabled('host-smoke', true), /full.*access/i)
})

test('malformed, unbound and disabled record fields cannot manufacture grants', async (t) => {
  const f = await setup(t)
  const source = f.source(true)
  await f.store.install(source)
  await f.store.setEnabled('host-smoke', true, undefined, true)
  const granted = await f.raw()
  for (const fullAccess of [undefined, false, null, 1, 'true', {}, []]) {
    await f.writeRecord({ ...granted, fullAccess })
    ungranted((await f.store.list())[0])
    await assert.rejects(
      f.store.enabledPackage('host-smoke', source.hash),
      /access|disabled/i,
    )
  }
  for (const fullAccessHash of [
    undefined,
    null,
    false,
    1,
    'b'.repeat(64),
    {},
  ]) {
    await f.writeRecord({ ...granted, fullAccessHash })
    ungranted((await f.store.list())[0])
    await assert.rejects(
      f.store.enabledPackage('host-smoke', source.hash),
      /access|disabled/i,
    )
  }
  await f.writeRecord({ ...granted, enabled: false })
  ungranted((await f.store.list())[0])
  await assert.rejects(
    f.store.enabledPackage('host-smoke', source.hash),
    /disabled/,
  )
  await f.store.setEnabled('host-smoke', false)
  ungranted(await f.raw())
})

test('changing installed hash or manifest metadata invalidates existing grant', async (t) => {
  const f = await setup(t)
  const first = f.source(true)
  await f.store.install(first)
  await f.store.setEnabled('host-smoke', true, undefined, true)
  const granted = await f.raw()
  const second = f.source(true, { version: '2.0.0' })
  await f.store.install(second)
  await f.writeRecord({
    ...granted,
    hash: second.hash,
    manifest: second.manifest,
  })
  ungranted((await f.store.list())[0])
  await assert.rejects(
    f.store.enabledPackage('host-smoke', second.hash),
    /access|disabled/i,
  )
  const changed = {
    ...granted,
    manifest: { ...granted.manifest, isDesktopOnly: false },
  }
  await f.writeRecord(changed)
  await assert.rejects(f.store.list(), /hash|manifest/i)
  await assert.rejects(f.store.setEnabled('host-smoke', true), /hash|manifest/i)
  await assert.rejects(
    f.store.setEnabled('host-smoke', true, undefined, true),
    /hash|manifest/i,
  )
  ungranted(await f.store.setEnabled('host-smoke', false))
})

test('tampered package assets cannot retain or obtain grants; ordinary disable still works', async (t) => {
  const f = await setup(t)
  const source = f.source(true)
  for (const [name, original, tampered] of [
    ['main.js', source.main, Buffer.from('module.exports = 123')],
    ['styles.css', source.styles, Buffer.from('.fixture { color: blue }')],
    [
      'manifest.json',
      source.manifestBytes,
      Buffer.from(JSON.stringify({ ...source.manifest, name: 'Changed' })),
    ],
  ]) {
    await f.store.install(source)
    await f.store.setEnabled('host-smoke', true, undefined, true)
    const path = join(f.store.root, 'packages', 'host-smoke', source.hash, name)
    await writeFile(path, tampered)
    await assert.rejects(f.store.list(), /hash|manifest/i)
    await assert.rejects(
      f.store.enabledPackage('host-smoke', source.hash),
      /hash|manifest/i,
    )
    await assert.rejects(
      f.store.setEnabled('host-smoke', true, undefined, true),
      /hash|manifest/i,
    )
    const disabled = await f.store.setEnabled('host-smoke', false)
    assert.equal(disabled.enabled, false)
    ungranted(disabled)
    ungranted((await f.store.list())[0])
    ungranted(await f.raw())
    await writeFile(path, original)
    await assert.rejects(
      f.store.setEnabled('host-smoke', true),
      /full.*access/i,
    )
  }
})

test('activation check can cancel a grant before persistence', async (t) => {
  const f = await setup(t)
  await f.store.install(f.source(true))
  let checks = 0
  await assert.rejects(
    f.store.setEnabled(
      'host-smoke',
      true,
      () => {
        if (++checks === 2) throw new Error('Fixture activation ended.')
      },
      true,
    ),
    /activation ended/,
  )
  assert.equal(checks, 2)
  assert.equal((await f.store.list())[0].enabled, false)
  ungranted(await f.raw())
  assert.equal(
    (await f.store.setEnabled('host-smoke', true, undefined, true)).fullAccess,
    true,
  )
})
