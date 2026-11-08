import assert from 'node:assert/strict'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { createServer } from 'vite'
import { fixtureVault } from './obsidian/harness.mjs'

test('obsidian packages and overlays stay outside the source vault', async (t) => {
  const server = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
  })
  t.after(() => server.close())
  const {
    ObsidianStore,
    readObsidianPackage,
    discoverObsidianPlugins,
    obsidianVaultIdentity,
  } = await server.ssrLoadModule('/src/addons/obsidian/store.ts')
  const fixture = await fixtureVault(t)
  const store = new ObsidianStore(
    join(fixture.overlay, 'plugins'),
    fixture.vault,
  )
  assert.deepEqual(await store.list(), [])
  assert.deepEqual(await discoverObsidianPlugins(fixture.vault), [
    { id: 'host-smoke', name: 'Host smoke' },
  ])
  const source = await readObsidianPackage(fixture.folder)
  const installed = await store.install(source)
  assert.equal(installed.enabled, false)
  await assert.rejects(
    store.enabledPackage('host-smoke', source.hash),
    /disabled/,
  )
  assert.deepEqual(await store.loadData('host-smoke'), {
    enabled: false,
    seeded: true,
  })
  await Promise.all([
    store.saveData('host-smoke', { enabled: true }),
    store.loadData('host-smoke'),
  ])
  assert.deepEqual(await store.loadData('host-smoke'), { enabled: true })
  await store.setEnabled('host-smoke', true)
  assert.equal(
    (await store.enabledPackage('host-smoke', source.hash)).hash,
    source.hash,
  )
  await assert.rejects(store.remove('host-smoke'), /Disable/)
  await store.setEnabled('host-smoke', false)
  await store.remove('host-smoke')
  assert.deepEqual(await store.list(), [])
  await store.install(source)
  assert.deepEqual(await store.loadData('host-smoke'), { enabled: true })
  await assert.rejects(
    store.saveData('host-smoke', 'x'.repeat(1024 * 1024)),
    /1 MiB/,
  )
  const secondVault = join(fixture.root, 'second-vault')
  await mkdir(secondVault)
  assert.notEqual(
    await obsidianVaultIdentity(secondVault),
    await obsidianVaultIdentity(fixture.vault),
  )
  const second = new ObsidianStore(join(fixture.overlay, 'second'), secondVault)
  await second.install(source)
  assert.equal(await second.loadData('host-smoke'), null)
  await fixture.assertUnchanged()
  assert.equal(
    await readFile(join(fixture.folder, 'data.json'), 'utf8'),
    '{"enabled":false,"seeded":true}\r\n',
  )
})

test('package reader refuses desktop-only, oversized, invalid utf-8, symlink and remote css assets', async (t) => {
  const server = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
  })
  t.after(() => server.close())
  const { readObsidianPackage } = await server.ssrLoadModule(
    '/src/addons/obsidian/store.ts',
  )
  const { validatePluginCss, parseObsidianManifest, wrapObsidianPlugin } =
    await server.ssrLoadModule('/src/addons/obsidian/package.ts')
  const fixture = await fixtureVault(t)
  const folder = join(fixture.root, 'selected')
  await mkdir(folder)
  await writeFile(
    join(folder, 'manifest.json'),
    JSON.stringify(fixture.plugin.manifest),
  )
  await writeFile(join(folder, 'main.js'), fixture.plugin.main)
  const original = await readObsidianPackage(folder)
  assert.throws(
    () =>
      parseObsidianManifest({ ...fixture.plugin.manifest, id: '../escape' }),
    /manifest/,
  )
  assert.throws(
    () =>
      parseObsidianManifest({
        ...fixture.plugin.manifest,
        isDesktopOnly: true,
      }),
    /Desktop-only/,
  )
  await writeFile(join(folder, 'main.js'), Buffer.from([0xc3, 0x28]))
  await assert.rejects(readObsidianPackage(folder), /encoded data|encoding/)
  await writeFile(join(folder, 'main.js'), Buffer.alloc(5 * 1024 * 1024 + 1))
  await assert.rejects(readObsidianPackage(folder), /size limit/)
  await writeFile(join(folder, 'main.js'), fixture.plugin.main)
  for (const css of [
    '@import "remote.css";',
    'div { background: url(https://example.test/x); }',
    '@im/**/port "remote.css";',
    '@\\69mport "x";',
    'div { --x: javascript:alert(1); }',
  ])
    assert.throws(() => validatePluginCss(css), /CSS/)
  await writeFile(join(folder, 'styles.css'), 'body { color: red }')
  const styled = await readObsidianPackage(folder)
  assert.notEqual(styled.hash, original.hash)
  assert.match(
    wrapObsidianPlugin(fixture.plugin.main, 'fixture'),
    /bridge\.require/,
  )
  const linked = join(fixture.root, 'linked')
  await mkdir(linked)
  await writeFile(
    join(linked, 'manifest.json'),
    JSON.stringify(fixture.plugin.manifest),
  )
  await symlink(join(folder, 'main.js'), join(linked, 'main.js'))
  await assert.rejects(readObsidianPackage(linked), /regular files/)
  const linkFolder = join(fixture.root, 'link-folder')
  await symlink(folder, linkFolder, 'dir')
  await assert.rejects(readObsidianPackage(linkFolder), /regular directories/)
  await fixture.assertUnchanged()
})

test('stored package integrity is checked before enabling or serving', async (t) => {
  const server = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
  })
  t.after(() => server.close())
  const { ObsidianStore, readObsidianPackage } = await server.ssrLoadModule(
    '/src/addons/obsidian/store.ts',
  )
  const fixture = await fixtureVault(t)
  const root = join(fixture.overlay, 'installed')
  const store = new ObsidianStore(root, fixture.vault)
  const source = await readObsidianPackage(fixture.folder)
  await store.install(source)
  await writeFile(
    join(root, 'packages', 'host-smoke', source.hash, 'main.js'),
    'module.exports = 123',
  )
  await assert.rejects(store.setEnabled('host-smoke', true), /hash/)
  await fixture.assertUnchanged()
})
