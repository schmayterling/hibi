import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createServer } from 'vite'

test('native host composes vault handlers behind captured identity and activation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-native-composition-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const calls = []
  const state = { root, id: 'fixture', current: true, closed: 0, calls }
  globalThis.__obsidianComposition = state
  t.after(() => delete globalThis.__obsidianComposition)
  const dispatch = `const state = globalThis.__obsidianComposition
    const route = (name, check) => async input => {check();state.calls.push([name,input]);return name}
  `
  const sources = {
    electron: `export const app = {getPath: () => globalThis.__obsidianComposition.root}; export const dialog = {}`,
    './store': `export class ObsidianStore {} export const obsidianVaultIdentity = async () => globalThis.__obsidianComposition.id; export const discoverObsidianPlugins = async () => []; export const readObsidianPackage = async () => null`,
    '../../main/file-operation-dialog':
      'export const runFileDialog = async run => run()',
    './api/vault/native':
      dispatch +
      `export const closeVaultLists = () => state.closed++; export const createVaultNative = (_context, check) => ({queries:Object.fromEntries(['vaultInfo','vaultStat','vaultList'].map(name => [name,route(name,check)])), methods:Object.fromEntries(['vaultUpdateText','vaultCreateFolder','vaultAction'].map(name => [name,route(name,check)]))})`,
    './api/metadata/native':
      dispatch +
      `export const createMetadataNative = (_context,check) => ({queries:{obsidianMetadataFile:route('obsidianMetadataFile',check)}})`,
  }
  const server = await createServer({
    configFile: false,
    cacheDir: join(root, 'cache'),
    optimizeDeps: { noDiscovery: true },
    ssr: { noExternal: ['electron'] },
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: 'custom',
    plugins: [
      {
        name: 'composition-host',
        enforce: 'pre',
        resolveId(id, importer) {
          if (
            id === 'electron' ||
            (importer?.endsWith('/obsidian/native.ts') &&
              Object.hasOwn(sources, id))
          )
            return '\0composition:' + id
        },
        load(id) {
          if (id.startsWith('\0composition:')) return sources[id.slice(13)]
        },
      },
    ],
  })
  t.after(() => server.close())
  const { default: native } = await server.ssrLoadModule(
    '/src/addons/obsidian/native.ts',
  )
  const context = {
    isCurrent: () => state.current,
    workspace: { id: () => state.id, directory: () => state.root },
  }
  const routes = [
    ...['vaultInfo', 'vaultStat', 'vaultList', 'obsidianMetadataFile'].map(
      (name) => [native.queries, name],
    ),
    ...['vaultUpdateText', 'vaultCreateFolder', 'vaultAction'].map((name) => [
      native.methods,
      name,
    ]),
  ]
  for (const [handlers, name] of routes) {
    const input = {
      vaultId: 'fixture',
      target: { workspaceId: 'fixture', workspaceGeneration: 1 },
      path: 'note.md',
    }
    assert.equal(typeof handlers[name], 'function', name)
    assert.equal(await handlers[name](input, context), name)
    assert.deepEqual(calls.at(-1), [name, input])
    const before = calls.length
    for (const invalid of [
      { ...input, vaultId: 'other' },
      { ...input, vaultId: undefined },
    ])
      await assert.rejects(handlers[name](invalid, context), /vault again/)
    state.current = false
    await assert.rejects(
      handlers[name](input, context),
      /host or vault changed/,
    )
    state.current = true
    assert.equal(
      calls.length,
      before,
      'refused requests cannot reach service handlers',
    )
  }
  await native.stop()
  assert.equal(state.closed, 1)
})
