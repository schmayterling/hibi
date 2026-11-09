import assert from 'node:assert/strict'
import {
  mkdir,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { createServer } from 'vite'
import { fixtureVault } from './obsidian/harness.mjs'

async function snapshot(root) {
  const result = {}
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    result[entry.name] = entry.isSymbolicLink()
      ? { link: await readlink(path) }
      : entry.isDirectory()
        ? await snapshot(path)
        : (await readFile(path)).toString('hex')
  }
  return result
}

async function setup(t, native = false) {
  const fixture = await fixtureVault(t)
  const state = {
    profile: fixture.overlay,
    folder: null,
    identity: null,
    current: true,
    confirmations: [],
    choose: async () => ({ canceled: false, filePaths: [fixture.folder] }),
    confirm: async () => ({ response: 1 }),
    download: async () => {
      throw new Error('Unexpected download.')
    },
  }
  globalThis.__obsidianGlobalTest = state
  t.after(() => delete globalThis.__obsidianGlobalTest)
  const sources = {
    electron: `const state = globalThis.__obsidianGlobalTest
      export const app = { getPath: () => state.profile }
      export const dialog = {
        showOpenDialog: () => state.choose(),
        showMessageBox: options => {
          state.confirmations.push(options)
          return state.confirm(options)
        },
      }`,
    '../../main/file-operation-dialog':
      'export const runFileDialog = async run => run()',
    './api/vault/native': `export const closeVaultLists = () => {}
      export const createVaultNative = (_context,check) => ({
        queries: {vaultInfo: async () => {check();return 'vault'}}, methods: {},
      })`,
    './api/metadata/native':
      'export const createMetadataNative = () => ({queries: {}})',
    './community-native': `export const cancelCommunityRequest = () => ({cancelled:true})
      export const stopCommunityInstalls = () => {}
      export const communityTask = (_input, work) => work(new AbortController().signal)
      export const communityService = () => ({
        entry: async (_kind,id) => ({id}),
        plugin: entry => globalThis.__obsidianGlobalTest.download(entry),
      })`,
  }
  const server = await createServer({
    configFile: false,
    cacheDir: join(fixture.root, 'cache'),
    optimizeDeps: { noDiscovery: true, include: [] },
    ssr: { noExternal: ['electron'] },
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: 'custom',
    plugins: native
      ? [
          {
            name: 'global-store-native-fixture',
            enforce: 'pre',
            resolveId(id, importer) {
              if (
                id === 'electron' ||
                (importer?.endsWith('/obsidian/native.ts') &&
                  Object.hasOwn(sources, id))
              )
                return `\0global-test:${id}`
            },
            load(id) {
              if (id.startsWith('\0global-test:'))
                return sources[id.slice('\0global-test:'.length)]
            },
          },
        ]
      : [],
  })
  t.after(() => server.close())
  const storeModule = await server.ssrLoadModule(
    '/src/addons/obsidian/store.ts',
  )
  const context = {
    isCurrent: () => state.current,
    workspace: {
      id: () => state.identity,
      directory: () => state.folder,
    },
  }
  return {
    ...fixture,
    state,
    context,
    ...storeModule,
    ...(native
      ? await server.ssrLoadModule('/src/addons/obsidian/native.ts')
      : {}),
  }
}

test('global settings require explicit one-time import and never write to a vault', async (t) => {
  const f = await setup(t)
  const store = new f.ObsidianStore(join(f.overlay, 'global'), f.vault)
  const source = await f.readObsidianPackage(f.folder)
  const record = await store.install(source)
  assert.equal(record.origin, 'folder')
  assert.equal(await store.loadData('host-smoke'), null)
  await assert.rejects(
    readFile(join(store.root, 'state', 'host-smoke', 'data.json')),
    { code: 'ENOENT' },
  )
  assert.equal(await store.settingsOffer('host-smoke'), false)
  const offer = await store.settingsOffer('host-smoke', f.vault)
  assert.equal(offer.overwrite, false)
  assert.deepEqual(await store.importVaultData('host-smoke', f.vault, offer), {
    enabled: false,
    seeded: true,
  })
  assert.equal(await store.settingsOffer('host-smoke', f.vault), false)
  await store.saveData('host-smoke', { global: true })
  await assert.rejects(
    store.importVaultData('host-smoke', f.vault, offer),
    /changed|again/,
  )
  assert.deepEqual(await store.loadData('host-smoke'), { global: true })
  await f.assertUnchanged()
})

test('migration preserves legacy bytes, selects sorted disabled copies and keeps existing global records/data', async (t) => {
  const f = await setup(t)
  const legacyRoot = join(f.overlay, 'vaults')
  const source = await f.readObsidianPackage(f.folder)
  const first = new f.ObsidianStore(join(legacyRoot, 'a'.repeat(64)), f.vault)
  const second = new f.ObsidianStore(join(legacyRoot, 'b'.repeat(64)), f.vault)
  await first.install(source)
  await first.saveData('host-smoke', { from: 'first' })
  await first.setEnabled('host-smoke', true)
  const legacyRecord = join(first.root, 'state', 'host-smoke', 'package.json')
  const legacyValue = JSON.parse(await readFile(legacyRecord, 'utf8'))
  delete legacyValue.origin
  await writeFile(legacyRecord, JSON.stringify(legacyValue))
  const otherVersion = f.readObsidianPackageBytes(
    Buffer.from(JSON.stringify({ ...source.manifest, version: '2.0.0' })),
    Buffer.from(`${source.main}\n// other version`),
    null,
  )
  await second.install(otherVersion)
  await second.saveData('host-smoke', { from: 'second' })
  const retained = join(first.root, 'state', 'removed-plugin')
  await mkdir(retained)
  await writeFile(join(retained, 'data.json'), '{"keep":"removed"}\r\n')
  const before = await snapshot(legacyRoot)
  const store = new f.ObsidianStore(join(f.overlay, 'global'))
  await store.migrateLegacy(legacyRoot)
  const [record] = await store.list()
  assert.equal(record.hash, source.hash)
  assert.equal(record.enabled, false)
  assert.equal(record.origin, 'vault')
  assert.deepEqual(await store.loadData('host-smoke'), { from: 'first' })
  assert.deepEqual(
    JSON.parse(
      await readFile(
        join(store.root, 'state', 'removed-plugin', 'data.json'),
        'utf8',
      ),
    ),
    { keep: 'removed' },
  )
  await store.saveData('host-smoke', { global: true })
  await store.setEnabled('host-smoke', true)
  await store.migrateLegacy(legacyRoot)
  assert.equal((await store.list())[0].enabled, true)
  assert.deepEqual(await store.loadData('host-smoke'), { global: true })
  await store.setEnabled('host-smoke', false)
  await store.remove('host-smoke')
  await store.migrateLegacy(legacyRoot)
  assert.deepEqual(
    await store.list(),
    [],
    'removal must not resurrect migrated plugins',
  )
  await store.install(source)
  assert.deepEqual(await store.loadData('host-smoke'), { global: true })
  assert.deepEqual(await snapshot(legacyRoot), before)
  await f.assertUnchanged()
})

test('migration rejects tampered packages, symlink roots and malformed data without altering originals', async (t) => {
  const f = await setup(t)
  const source = await f.readObsidianPackage(f.folder)
  const legacyRoot = join(f.overlay, 'vaults')
  const old = new f.ObsidianStore(join(legacyRoot, 'a'.repeat(64)), f.vault)
  await old.install(source)
  await old.saveData('host-smoke', { retained: true })
  const main = join(old.root, 'packages', 'host-smoke', source.hash, 'main.js')
  await writeFile(main, 'tampered')
  const before = await snapshot(legacyRoot)
  const store = new f.ObsidianStore(join(f.overlay, 'global'))
  await assert.rejects(store.migrateLegacy(legacyRoot), /hash/)
  assert.deepEqual(await store.list(), [])
  assert.deepEqual(await snapshot(legacyRoot), before)
  await writeFile(main, source.main)
  const data = join(old.root, 'state', 'host-smoke', 'data.json')
  await writeFile(data, Buffer.from([0xc3, 0x28]))
  await assert.rejects(store.migrateLegacy(legacyRoot), /encoded data|encoding/)
  await rm(data)
  await symlink(join(f.folder, 'data.json'), data)
  await assert.rejects(store.migrateLegacy(legacyRoot), /regular files/)
  const link = join(f.overlay, 'linked-vaults')
  await symlink(legacyRoot, link, 'dir')
  await assert.rejects(store.migrateLegacy(link), /regular directories|symlink/)
  await rm(data)
  await old.saveData('host-smoke', { retained: true })
  await store.install(source)
  await store.saveData('host-smoke', { existing: true })
  await store.setEnabled('host-smoke', true)
  await writeFile(main, 'still tampered')
  await writeFile(
    data,
    'invalid old data must not replace existing global data',
  )
  await store.migrateLegacy(legacyRoot)
  assert.equal((await store.list())[0].enabled, true)
  assert.deepEqual(await store.loadData('host-smoke'), { existing: true })
  await f.assertUnchanged()
})

test('global native operations install and serve without any folder and keep activation guards', async (t) => {
  const f = await setup(t, true)
  const native = f.default
  const selected = join(f.root, 'selected-plugin')
  await mkdir(selected)
  await writeFile(
    join(selected, 'manifest.json'),
    JSON.stringify(f.plugin.manifest),
  )
  await writeFile(join(selected, 'main.js'), f.plugin.main)
  await writeFile(join(selected, 'styles.css'), '.fixture { color: red }')
  f.state.choose = async () => ({ canceled: true, filePaths: [] })
  assert.equal(await native.methods.install({}, f.context), null)
  assert.equal(f.state.confirmations.length, 0)
  f.state.choose = async () => ({ canceled: false, filePaths: [selected] })
  f.state.confirm = async () => ({ response: 0 })
  assert.equal(await native.methods.install({}, f.context), null)
  f.state.confirm = async () => ({ response: 1 })
  assert.deepEqual(await native.queries.list(undefined, f.context), [])
  assert.deepEqual(await native.queries.discover(undefined, f.context), [])
  const installed = await native.methods.install({}, f.context)
  assert.equal(installed.origin, 'folder')
  assert.equal(installed.enabled, false)
  assert.equal(f.state.confirmations.length, 2)
  assert.match(f.state.confirmations[0].detail, /renderer access/)
  const { store } = await f.obsidianGlobalStore()
  assert.equal(store.root, join(f.overlay, 'obsidian', 'global'))
  const input = { id: 'host-smoke', vaultId: 'obsolete' }
  assert.equal(await native.queries.data(input, f.context), null)
  await native.methods.saveData(
    { ...input, value: { global: true } },
    f.context,
  )
  const plain = join(f.root, 'plain')
  await mkdir(plain)
  f.state.folder = plain
  f.state.identity = await f.obsidianVaultIdentity(plain)
  assert.equal((await native.queries.list(undefined, f.context)).length, 1)
  assert.deepEqual(await native.queries.data(input, f.context), {
    global: true,
  })
  await native.methods.enable({ ...input, enabled: true }, f.context)
  f.state.folder = null
  f.state.identity = null
  const url = `app://hibi/obsidian-plugins/global/host-smoke/${installed.hash}/main.js`
  const asset = await f.obsidianPluginAsset(new Request(url))
  assert.match(asset.body, new RegExp(`global:host-smoke:${installed.hash}`))
  assert.equal(asset.type, 'text/javascript; charset=utf-8')
  const css = await f.obsidianPluginAsset(
    new Request(url.replace('main.js', 'styles.css')),
  )
  assert.equal(css.body, '.fixture { color: red }')
  assert.equal(css.type, 'text/css; charset=utf-8')
  for (const invalid of [
    `${url}?x=1`,
    url.replace('/global/', `/${'a'.repeat(64)}/`),
    url.replace('host-smoke', 'other'),
    url.replace(installed.hash, 'b'.repeat(64)),
  ]) {
    const result = await f
      .obsidianPluginAsset(new Request(invalid))
      .catch(() => null)
    assert.equal(result, null)
  }
  assert.equal(
    await f.obsidianPluginAsset(new Request(url, { method: 'POST' })),
    null,
  )
  await native.methods.enable({ ...input, enabled: false }, f.context)
  await assert.rejects(f.obsidianPluginAsset(new Request(url)), /disabled/)
  f.state.confirm = async () => {
    f.state.current = false
    return { response: 1 }
  }
  await assert.rejects(
    native.methods.enable({ id: 'host-smoke', enabled: true }, f.context),
    /host.*changed/,
  )
  assert.equal((await store.list())[0].enabled, false)
  await assert.rejects(native.queries.data(input, f.context), /host.*changed/)
  f.state.current = true
  await native.methods.remove(input, f.context)
  assert.deepEqual(await native.queries.list(undefined, f.context), [])
  await f.assertUnchanged()
})

test('vault discovery suggests enabled plugins; explicit imports capture current folder', async (t) => {
  const f = await setup(t, true)
  f.state.folder = f.vault
  f.state.identity = await f.obsidianVaultIdentity(f.vault)
  const suggestions = join(f.vault, '.obsidian', 'community-plugins.json')
  await writeFile(suggestions, JSON.stringify(['host-smoke']))
  const before = await snapshot(f.vault)
  const entries = await f.default.queries.discover({}, f.context)
  assert.equal(entries[0].suggested, true)
  const installed = await f.default.methods.installVault(
    { id: 'host-smoke' },
    f.context,
  )
  assert.equal(installed.origin, 'vault')
  const input = { id: 'host-smoke' }
  assert.equal(await f.default.queries.data(input, f.context), null)
  const offer = await f.default.queries.settingsOffer(input, f.context)
  assert.equal(offer.overwrite, false)
  await f.default.methods.importVaultData(
    { ...input, ...offer, vaultId: f.state.identity },
    f.context,
  )
  assert.equal(await f.default.queries.settingsOffer(input, f.context), false)
  assert.deepEqual(await f.default.queries.data(input, f.context), {
    enabled: false,
    seeded: true,
  })
  assert.deepEqual(await snapshot(f.vault), before)
  f.state.confirm = async () => {
    f.state.folder = null
    f.state.identity = null
    return { response: 1 }
  }
  await assert.rejects(
    f.default.methods.installVault(input, f.context),
    /host or vault changed/,
  )
  assert.deepEqual(await snapshot(f.vault), before)
})

test('community download lifetime follows addon across folder changes and stop invalidates candidates', async (t) => {
  const f = await setup(t, true)
  const packageData = await f.readObsidianPackage(f.folder)
  const source = {
    repo: 'fixture/plugin',
    release: '1.0.0',
    hashes: { manifest: 'a'.repeat(64), main: 'b'.repeat(64), styles: null },
  }
  f.state.download = async () => {
    f.state.folder = f.vault
    f.state.identity = await f.obsidianVaultIdentity(f.vault)
    return { packageData, source }
  }
  const candidate = await f.default.profileMethods.downloadCommunity(
    { id: 'host-smoke', requestId: 'fixture-download' },
    f.context,
  )
  f.state.folder = null
  f.state.identity = null
  const installed = await f.default.methods.installCommunity(
    { id: 'host-smoke', key: candidate.key },
    f.context,
  )
  assert.equal(installed.origin, 'community')
  assert.deepEqual(installed.source, source)
  let previousCurrent = true
  const previous = { ...f.context, isCurrent: () => previousCurrent }
  const expiredActivation = await f.default.profileMethods.downloadCommunity(
    { id: 'host-smoke', requestId: 'old-activation' },
    previous,
  )
  previousCurrent = false
  await assert.rejects(
    f.default.methods.installCommunity(
      { id: 'host-smoke', key: expiredActivation.key },
      f.context,
    ),
    /host.*changed/,
  )
  const stale = await f.default.profileMethods.downloadCommunity(
    { id: 'host-smoke', requestId: 'stale-download' },
    f.context,
  )
  await f.default.stop()
  await assert.rejects(
    f.default.methods.installCommunity(
      { id: 'host-smoke', key: stale.key },
      f.context,
    ),
    /expired/,
  )
  await f.assertUnchanged()
})
