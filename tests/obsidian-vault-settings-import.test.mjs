import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { createServer } from 'vite'
import { fixtureVault } from './obsidian/harness.mjs'

const id = 'host-smoke'
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
async function snapshot(root) {
  const result = {}
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    result[entry.name] = entry.isDirectory()
      ? await snapshot(path)
      : (await readFile(path)).toString('hex')
  }
  return result
}

async function setup(t, native = false) {
  const f = await fixtureVault(t)
  const state = {
    folder: f.vault,
    identity: null,
    current: true,
    profile: f.overlay,
  }
  globalThis.__obsidianImportTest = state
  t.after(() => delete globalThis.__obsidianImportTest)
  const stubs = {
    electron: `export const app = {getPath: () => globalThis.__obsidianImportTest.profile}
      export const dialog = {showMessageBox: () => {throw new Error('Unexpected native dialog.')}}`,
    '../../main/file-operation-dialog':
      'export const runFileDialog = async run => run()',
    './api/vault/native':
      'export const closeVaultLists = () => {}; export const createVaultNative = () => ({queries:{},methods:{}})',
    './api/metadata/native':
      'export const createMetadataNative = () => ({queries:{}})',
  }
  const server = await createServer({
    configFile: false,
    cacheDir: join(f.root, 'cache'),
    optimizeDeps: { noDiscovery: true, include: [] },
    ssr: { noExternal: ['electron'] },
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: 'custom',
    plugins: native
      ? [
          {
            name: 'vault-settings-native-fixture',
            enforce: 'pre',
            resolveId(name, importer) {
              if (
                name === 'electron' ||
                (importer?.endsWith('/obsidian/native.ts') &&
                  Object.hasOwn(stubs, name))
              )
                return `\0settings:${name}`
            },
            load(name) {
              if (name.startsWith('\0settings:'))
                return stubs[name.slice('\0settings:'.length)]
            },
          },
        ]
      : [],
  })
  t.after(() => server.close())
  const api = await server.ssrLoadModule('/src/addons/obsidian/store.ts')
  state.identity = await api.obsidianVaultIdentity(f.vault)
  const store = new api.ObsidianStore(join(f.overlay, 'global'))
  await store.install(await api.readObsidianPackage(f.folder))
  return {
    ...f,
    ...api,
    store,
    state,
    data: join(store.root, 'state', id, 'data.json'),
    receipts: join(store.root, 'state', id, 'settings-receipts.json'),
    backups: join(store.root, 'state', id, 'data-backups'),
    context: {
      isCurrent: () => state.current,
      workspace: { id: () => state.identity, directory: () => state.folder },
    },
    ...(native
      ? await server.ssrLoadModule('/src/addons/obsidian/native.ts')
      : {}),
  }
}

test('different existing settings stay offered; semantic JSON equality ignores key order', async (t) => {
  const f = await setup(t)
  await f.store.saveData(id, { global: true })
  const source = await readFile(join(f.folder, 'data.json'))
  const offer = await f.store.settingsOffer(id, f.vault)
  assert.deepEqual(offer, {
    overwrite: true,
    sourceHash: hash(source),
    globalHash: hash(await readFile(f.data)),
  })
  await f.store.saveData(id, { seeded: true, enabled: false })
  assert.equal(await f.store.settingsOffer(id, f.vault), false)
  await f.store.saveData(id, { seeded: true, enabled: true })
  assert.ok(await f.store.settingsOffer(id, f.vault))
  await f.assertUnchanged()
})

test('first import requires fingerprints, creates accepted receipt, and has no backup', async (t) => {
  const f = await setup(t)
  const offer = await f.store.settingsOffer(id, f.vault)
  assert.equal(offer.overwrite, false)
  assert.equal(offer.globalHash, null)
  assert.deepEqual(await f.store.importVaultData(id, f.vault, offer), {
    enabled: false,
    seeded: true,
  })
  await assert.rejects(readdir(f.backups), { code: 'ENOENT' })
  assert.deepEqual(JSON.parse(await readFile(f.receipts, 'utf8')), {
    [f.state.identity]: { action: 'accepted' },
  })
  const reopened = new f.ObsidianStore(f.store.root)
  await reopened.saveData(id, { changed: true })
  assert.equal(await reopened.settingsOffer(id, f.vault), false)
  await f.assertUnchanged()
  await writeFile(
    join(f.folder, 'data.json'),
    '{"source":"changed after acceptance"}',
  )
  const before = await snapshot(f.vault)
  assert.equal(await reopened.settingsOffer(id, f.vault), false)
  assert.deepEqual(await snapshot(f.vault), before)
})

test('overwrite needs explicit consent and current raw hashes; refusal changes no data or receipts', async (t) => {
  const f = await setup(t)
  await f.store.saveData(id, { global: true })
  const offer = await f.store.settingsOffer(id, f.vault)
  const before = await snapshot(f.store.root)
  await assert.rejects(
    f.store.importVaultData(id, f.vault, { ...offer, overwrite: false }),
    /overwrite|confirm/i,
  )
  await assert.rejects(
    f.store.importVaultData(id, f.vault, {
      ...offer,
      sourceHash: 'a'.repeat(64),
    }),
    /changed|again/i,
  )
  await assert.rejects(
    f.store.importVaultData(id, f.vault, { ...offer, globalHash: null }),
    /changed|again/i,
  )
  assert.deepEqual(await snapshot(f.store.root), before)
  await f.assertUnchanged()
})

test('queued global edits and source changes invalidate old prompt before writes', async (t) => {
  const f = await setup(t)
  await f.store.saveData(id, { global: 1 })
  const offer = await f.store.settingsOffer(id, f.vault)
  const save = f.store.saveData(id, { global: 2 })
  const importing = f.store.importVaultData(id, f.vault, offer)
  await save
  await assert.rejects(importing, /changed|again/i)
  assert.deepEqual(await f.store.loadData(id), { global: 2 })
  const next = await f.store.settingsOffer(id, f.vault)
  await writeFile(join(f.folder, 'data.json'), '{"vault":"new"}\r\n')
  const beforeVault = await snapshot(f.vault)
  const beforeGlobal = await snapshot(f.store.root)
  await assert.rejects(
    f.store.importVaultData(id, f.vault, next),
    /changed|again/i,
  )
  assert.deepEqual(await snapshot(f.store.root), beforeGlobal)
  assert.deepEqual(await snapshot(f.vault), beforeVault)
})

test('backups preserve exact raw bytes and retain actual last three under same time and clock rollback', async (t) => {
  const f = await setup(t)
  let now = 1000
  t.mock.method(Date, 'now', () => now)
  const expected = []
  for (let index = 1; index <= 4; index++) {
    const vault = join(f.root, `other-${index}`)
    const folder = join(vault, '.obsidian', 'plugins', id)
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, 'data.json'), JSON.stringify({ vault: index }))
    const raw = Buffer.from(`{\r\n  "global": ${index}\r\n}\r\n`)
    await writeFile(f.data, raw)
    expected.push(raw)
    if (index === 3) now = 1
    const before = await snapshot(vault)
    const offer = await f.store.settingsOffer(id, vault)
    await f.store.importVaultData(id, vault, offer)
    assert.deepEqual(await snapshot(vault), before)
  }
  const names = (await readdir(f.backups)).sort()
  assert.deepEqual(names, ['1001.json', '1002.json', '1003.json'])
  assert.deepEqual(
    await Promise.all(names.map((name) => readFile(join(f.backups, name)))),
    expected.slice(-3),
  )
  await f.assertUnchanged()
})

test('dismissal receipt survives new store and suppresses only handled canonical vault', async (t) => {
  const f = await setup(t)
  const dataBefore = await f.store.loadData(id)
  await f.store.dismissVaultData(id, f.vault)
  assert.equal(await f.store.loadData(id), dataBefore)
  assert.deepEqual(JSON.parse(await readFile(f.receipts, 'utf8')), {
    [f.state.identity]: { action: 'dismissed' },
  })
  await writeFile(join(f.folder, 'data.json'), '{"vault":"changed later"}')
  const before = await snapshot(f.vault)
  const reopened = new f.ObsidianStore(f.store.root)
  assert.equal(await reopened.settingsOffer(id, f.vault), false)
  const other = join(f.root, 'other')
  await mkdir(join(other, '.obsidian', 'plugins', id), { recursive: true })
  await writeFile(
    join(other, '.obsidian', 'plugins', id, 'data.json'),
    '{"different":true}',
  )
  assert.ok(await reopened.settingsOffer(id, other))
  assert.deepEqual(await snapshot(f.vault), before)
})

test('malformed receipts and unsafe backup entries refuse imports without replacing global data', async (t) => {
  const f = await setup(t)
  await f.store.saveData(id, { global: true })
  await writeFile(f.receipts, '{"../escape":{"action":"accepted"}}')
  await assert.rejects(f.store.settingsOffer(id, f.vault), /receipt/i)
  await writeFile(
    f.receipts,
    JSON.stringify({ [f.state.identity]: { action: 'unknown' } }),
  )
  await assert.rejects(f.store.dismissVaultData(id, f.vault), /receipt/i)
  await rm(f.receipts)
  await mkdir(f.backups)
  const offer = await f.store.settingsOffer(id, f.vault)
  const prior = await readFile(f.data)
  const linked = join(f.backups, '1000.json')
  await symlink(f.data, linked)
  await assert.rejects(
    f.store.importVaultData(id, f.vault, offer),
    /regular files|symlink/i,
  )
  assert.deepEqual(await readFile(f.data), prior)
  await rm(linked)
  await writeFile(linked, Buffer.alloc(1024 * 1024 + 1))
  await assert.rejects(
    f.store.importVaultData(id, f.vault, offer),
    /size limit/i,
  )
  assert.deepEqual(await readFile(f.data), prior)
  await rm(linked)
  await writeFile(join(f.backups, 'keep.txt'), 'unrelated')
  await f.store.importVaultData(id, f.vault, offer)
  assert.equal(await readFile(join(f.backups, 'keep.txt'), 'utf8'), 'unrelated')
  await f.assertUnchanged()
})

test('folder lifetime refusal after backup keeps prior data and removes unused backup', async (t) => {
  const f = await setup(t)
  await f.store.saveData(id, { global: 'keep' })
  const offer = await f.store.settingsOffer(id, f.vault)
  const before = await readFile(f.data)
  t.mock.method(Date, 'now', () => 2000)
  const check = () => {
    if (existsSync(join(f.backups, '2000.json')))
      throw new Error('The folder changed.')
  }
  await assert.rejects(
    f.store.importVaultData(id, f.vault, offer, check),
    /folder changed/,
  )
  assert.deepEqual(await readFile(f.data), before)
  assert.deepEqual(await readdir(f.backups), [])
  await assert.rejects(readFile(f.receipts), { code: 'ENOENT' })
  await f.assertUnchanged()
})

test('settings sources, receipts and backup directories refuse links and oversized metadata', async (t) => {
  const f = await setup(t)
  await f.store.saveData(id, { global: 'keep' })
  const offer = await f.store.settingsOffer(id, f.vault)
  const before = await readFile(f.data)
  const decoy = join(f.root, 'decoy.json')
  await writeFile(decoy, '{}')
  await symlink(decoy, f.receipts)
  await assert.rejects(f.store.dismissVaultData(id, f.vault), /regular files/)
  await assert.rejects(
    f.store.importVaultData(id, f.vault, offer),
    /regular files/,
  )
  await rm(f.receipts)
  await writeFile(f.receipts, Buffer.alloc(1024 * 1024 + 1))
  await assert.rejects(f.store.settingsOffer(id, f.vault), /size limit/)
  await rm(f.receipts)
  const linkedFolder = join(f.root, 'linked-backups')
  await mkdir(linkedFolder)
  await symlink(linkedFolder, f.backups, 'dir')
  await assert.rejects(
    f.store.importVaultData(id, f.vault, offer),
    /regular directories|symlink/,
  )
  assert.deepEqual(await readdir(linkedFolder), [])
  assert.deepEqual(await readFile(f.data), before)
  await rm(f.backups)
  const source = join(f.folder, 'data.json')
  await rm(source)
  await symlink(decoy, source)
  const decoyBefore = await readFile(decoy)
  await assert.rejects(f.store.settingsOffer(id, f.vault), /regular files/)
  assert.deepEqual(await readFile(decoy), decoyBefore)
  assert.deepEqual(await readFile(f.data), before)
})

test('settings import follows unique custom configuration without modifying it', async (t) => {
  const f = await setup(t)
  await rename(join(f.vault, '.obsidian'), join(f.vault, '.custom'))
  await writeFile(join(f.vault, '.custom', 'app.json'), '{}')
  await writeFile(join(f.vault, '.custom', 'community-plugins.json'), '[]')
  const before = await snapshot(f.vault)
  const offer = await f.store.settingsOffer(id, f.vault)
  assert.ok(offer)
  await f.store.importVaultData(id, f.vault, offer)
  assert.deepEqual(await snapshot(f.vault), before)
})

test('native import/dismiss require prompt vault identity and validate fingerprint input', async (t) => {
  const f = await setup(t, true)
  const { store } = await f.obsidianGlobalStore()
  await store.install(await f.readObsidianPackage(f.folder))
  const offer = await f.default.queries.settingsOffer({ id }, f.context)
  const input = { id, vaultId: f.state.identity, ...offer }
  for (const bad of [
    { ...input, overwrite: 'yes' },
    { ...input, sourceHash: 'invalid' },
    { ...input, globalHash: 42 },
    { ...input, sourceHash: undefined },
    { ...input, vaultId: undefined },
  ])
    await assert.rejects(
      f.default.methods.importVaultData(bad, f.context),
      /settings|vault|request|again/i,
    )
  await assert.rejects(
    f.default.methods.dismissVaultData({ id }, f.context),
    /vault|request|again/i,
  )
  const other = join(f.root, 'switched')
  await mkdir(join(other, '.obsidian', 'plugins', id), { recursive: true })
  await writeFile(
    join(other, '.obsidian', 'plugins', id, 'data.json'),
    await readFile(join(f.folder, 'data.json')),
  )
  f.state.folder = other
  f.state.identity = await f.obsidianVaultIdentity(other)
  const before = await snapshot(store.root)
  await assert.rejects(
    f.default.methods.importVaultData(input, f.context),
    /vault|again/i,
  )
  await assert.rejects(
    f.default.methods.dismissVaultData(input, f.context),
    /vault|again/i,
  )
  assert.deepEqual(await snapshot(store.root), before)
  f.state.folder = f.vault
  f.state.identity = input.vaultId
  assert.deepEqual(await f.default.methods.importVaultData(input, f.context), {
    enabled: false,
    seeded: true,
  })
  await f.default.methods.dismissVaultData(input, f.context)
  assert.deepEqual(
    JSON.parse(
      await readFile(
        join(store.root, 'state', id, 'settings-receipts.json'),
        'utf8',
      ),
    ),
    { [f.state.identity]: { action: 'accepted' } },
  )
  await f.assertUnchanged()
})
