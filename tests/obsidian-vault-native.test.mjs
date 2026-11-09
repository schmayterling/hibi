import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createServer } from 'vite'
import { fixtureVault } from './obsidian/harness.mjs'

let server, createVaultNative, closeVaultLists, cacheRoot
const target = { workspaceId: 'fixture', workspaceGeneration: 1 }
const state = {
  current: true,
  root: '',
  actions: [],
  entries: [],
  documents: [],
  active: null,
  windows: [],
}
test.before(async () => {
  cacheRoot = await mkdtemp(join(tmpdir(), 'hibi-vault-native-cache-'))
  globalThis.__vaultNativeTest = state
  const sources = {
    electron: `const host = globalThis.__vaultNativeTest; export const BrowserWindow = { getAllWindows: () => host.windows }; export const app = {getPath: () => host.root}`,
    workspace: `const host = globalThis.__vaultNativeTest; export const currentWorkspaceTarget = () => ({ workspaceId: 'fixture', workspaceGeneration: 1 }); export const isCurrentWorkspaceTarget = target => target?.workspaceId === 'fixture' && target?.workspaceGeneration === 1; export const workspaceChangeCursor = () => ({sequence: 1}); export const refreshWorkspace = async () => {}; export const listWorkspaceEntryPage = request => { if (request.sequence !== 1) return {ok:false,message:'stale sequence'}; return {ok:true,value:{entries:host.entries,sequence:1,nextCursor:null}} }`,
    document: `const host = globalThis.__vaultNativeTest; export const getDocumentPath = () => host.active; export const getOpenDocumentVersions = () => host.documents`,
    'workspace-files': `export const updateWorkspaceText = async (...args) => { if (args[5]) args[5](); globalThis.__vaultNativeTest.update = args; return {ok:true,value:{persisted:true}} }`,
    'workspace-actions': `export const workspaceAction = async (_window, request) => { globalThis.__vaultNativeTest.actions.push(request); return {path: request.path} }`,
  }
  server = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    cacheDir: cacheRoot,
    ssr: { noExternal: ['electron'] },
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: 'custom',
    plugins: [
      {
        name: 'vault-native-test',
        enforce: 'pre',
        resolveId(id, importer) {
          if (id === 'electron') return '\0vault-electron'
          if (importer?.endsWith('/vault/native.ts')) {
            const name = id.split('/').at(-1)
            if (sources[name]) return `\0vault-${name}`
          }
        },
        load(id) {
          if (id.startsWith('\0vault-')) return sources[id.slice(7)]
        },
      },
    ],
  })
  ;({ createVaultNative, closeVaultLists } = await server.ssrLoadModule(
    '/src/addons/obsidian/api/vault/native.ts',
  ))
})
test.after(async () => {
  await closeVaultLists()
  await server.close()
  await rm(cacheRoot, { recursive: true, force: true })
  delete globalThis.__vaultNativeTest
})

async function fixture(t) {
  const vault = await fixtureVault(t, 'vault-api')
  state.root = vault.vault
  state.current = true
  state.actions = []
  state.entries = [{ path: 'untouched.md', name: 'untouched.md', kind: 'file' }]
  state.documents = [
    { file: join(vault.vault, 'untouched.md'), tabId: 'one' },
    { file: join(vault.root, 'outside.md'), tabId: 'outside' },
  ]
  state.active = join(vault.vault, 'untouched.md')
  state.windows = [
    { isDestroyed: () => false, webContents: { getURL: () => 'app://hibi/' } },
  ]
  const handlers = createVaultNative({
    isCurrent: () => state.current,
    workspace: { directory: () => state.root, id: () => 'fixture' },
  })
  return { ...vault, ...handlers, input: { vaultId: 'fixture', target } }
}

test('native stat/list/info return relative descriptors and revalidate identity', async (t) => {
  const env = await fixture(t)
  const info = await env.queries.vaultInfo(env.input)
  assert.equal(info.configDir, '.obsidian')
  assert.equal(info.activePath, 'untouched.md')
  assert.deepEqual(info.documents, [{ path: 'untouched.md', tabId: 'one' }])
  const stat = await env.queries.vaultStat({
    ...env.input,
    path: 'untouched.md',
  })
  assert.equal(
    stat.stat.size,
    (await readFile(join(env.vault, 'untouched.md'))).length,
  )
  assert.equal(stat.kind, 'file')
  assert.equal(
    await env.queries.vaultStat({ ...env.input, path: 'absent.md' }),
    null,
  )
  assert.equal(
    (await env.queries.vaultList({ ...env.input, sequence: 1 })).entries[0]
      .path,
    'untouched.md',
  )
  await assert.rejects(
    env.queries.vaultList({ ...env.input, sequence: 2 }),
    /stale/,
  )
  await assert.rejects(
    env.queries.vaultInfo({ ...env.input, vaultId: 'other' }),
    /no longer open/,
  )
  await assert.rejects(
    env.queries.vaultInfo({
      ...env.input,
      target: { ...target, workspaceGeneration: 2 },
    }),
    /no longer open/,
  )
  state.current = false
  await assert.rejects(env.queries.vaultInfo(env.input), /changed/)
  const write = {
    ...env.input,
    path: 'untouched.md',
    expectedVersion: 'version',
    markdown: 'plugin',
  }
  state.current = true
  assert.equal((await env.methods.vaultUpdateText(write)).ok, true)
  assert.deepEqual(state.update.slice(0, 5), [
    target,
    write.path,
    write.expectedVersion,
    write.markdown,
    { allowMetadataReset: true },
  ])
  assert.equal(state.update[6], true)
  await env.assertUnchanged()
})

test('native mutations use shared actions and refuse config paths, escapes, symlinks and hidden subtrees', async (t) => {
  const env = await fixture(t)
  for (const path of [
    '../outside',
    '/absolute',
    '.obsidian',
    '.OBSIDIAN/note.md',
    'sub/.obsidian/file',
    'sub/../note.md',
    'c:/note.md',
    'C:x',
  ]) {
    await assert.rejects(env.methods.vaultCreateFolder({ ...env.input, path }))
    await assert.rejects(
      env.methods.vaultUpdateText({
        ...env.input,
        path,
        markdown: 'x',
        expectedVersion: 'version',
      }),
    )
    await assert.rejects(
      env.methods.vaultAction({ ...env.input, path, action: 'delete' }),
    )
  }
  await writeFile(join(env.root, 'outside.md'), 'outside')
  await symlink(join(env.root, 'outside.md'), join(env.vault, 'alias.md'))
  await assert.rejects(
    env.queries.vaultStat({ ...env.input, path: 'alias.md' }),
    /symbolic link/,
  )
  await assert.rejects(
    env.methods.vaultAction({
      ...env.input,
      path: 'alias.md',
      action: 'copy',
      destination: 'copy.md',
    }),
    /symbolic link/,
  )
  await rm(join(env.vault, 'alias.md'))
  await mkdir(join(env.root, 'outside-folder'))
  await symlink(
    join(env.root, 'outside-folder'),
    join(env.vault, 'alias-folder'),
  )
  await assert.rejects(
    env.methods.vaultCreateFolder({ ...env.input, path: 'alias-folder/new' }),
    /symbolic link/,
  )
  assert.deepEqual(await readdir(join(env.root, 'outside-folder')), [])
  await rm(join(env.vault, 'alias-folder'))
  await env.methods.vaultCreateFolder({ ...env.input, path: 'folder' })
  await mkdir(join(env.vault, 'folder', '.obsidian'))
  await writeFile(join(env.vault, 'folder', '.obsidian', 'data'), 'protected')
  await assert.rejects(
    env.methods.vaultAction({
      ...env.input,
      path: 'folder',
      action: 'copy',
      destination: 'copy',
    }),
    /configuration/,
  )
  assert.deepEqual(state.actions, [])
  await env.methods.vaultAction({
    ...env.input,
    path: 'untouched.md',
    action: 'rename',
    destination: 'new.md',
  })
  await env.methods.vaultAction({
    ...env.input,
    path: 'untouched.md',
    action: 'delete',
  })
  assert.deepEqual(
    state.actions.map(({ action, destination }) => [action, destination]),
    [
      ['rename', 'new.md'],
      ['delete', undefined],
    ],
  )
  await rm(join(env.vault, 'folder'), { recursive: true })
  assert.equal(await readFile(join(env.root, 'outside.md'), 'utf8'), 'outside')
  await env.assertUnchanged()
})

test('native file pages include attachments and UI-ignored trees without following hidden entries or symlinks', async (t) => {
  const env = await fixture(t)
  await mkdir(join(env.vault, 'assets'))
  await mkdir(join(env.vault, 'node_modules'))
  await writeFile(join(env.vault, 'node_modules', 'kept.txt'), 'visible')
  for (let index = 0; index < 205; index++)
    await writeFile(
      join(env.vault, 'assets', `${index}.bin`),
      new Uint8Array([index % 256, 0, 255]),
    )
  await writeFile(join(env.vault, '.hidden.md'), 'hidden')
  await symlink(join(env.vault, 'assets'), join(env.vault, 'alias'))
  const paths = [],
    cursors = new Set()
  let cursor = null
  do {
    const page = await env.queries.vaultList({
      ...env.input,
      sequence: 1,
      ...(cursor ? { cursor } : {}),
    })
    assert.ok(page.entries.length <= 100)
    paths.push(...page.entries.map((entry) => entry.path))
    cursor = page.nextCursor
    if (cursor) cursors.add(cursor)
  } while (cursor)
  assert.equal(new Set(paths).size, 209)
  assert.ok(cursors.size > 0)
  assert.ok(paths.includes('assets/204.bin'))
  assert.ok(paths.includes('node_modules/kept.txt'))
  assert.ok(
    !paths.some((path) => path.startsWith('.') || path.startsWith('alias')),
  )
  const shallow = await env.queries.vaultList({
    ...env.input,
    sequence: 1,
    recursive: false,
  })
  assert.deepEqual(
    new Set(shallow.entries.map((entry) => entry.path)),
    new Set(['assets', 'node_modules', 'untouched.md']),
  )
  const partial = await env.queries.vaultList({ ...env.input, sequence: 1 })
  assert.ok(partial.nextCursor)
  await closeVaultLists()
  await assert.rejects(
    env.queries.vaultList({
      ...env.input,
      sequence: 1,
      cursor: partial.nextCursor,
    }),
    /stale/,
  )
  await rm(join(env.vault, 'alias'))
  await rm(join(env.vault, '.hidden.md'))
  await rm(join(env.vault, 'assets'), { recursive: true })
  await rm(join(env.vault, 'node_modules'), { recursive: true })
  await env.assertUnchanged()
})

test('native APIs work in a plain folder and refuse hidden writes without a config directory', async (t) => {
  const env = await fixture(t)
  const stored = join(env.root, 'stored-profile')
  await rename(join(env.vault, '.obsidian'), stored)
  const info = await env.queries.vaultInfo(env.input)
  assert.equal(info.configDir, '.obsidian')
  assert.equal(info.settings, null)
  assert.equal(
    (await env.queries.vaultStat({ ...env.input, path: 'untouched.md' })).kind,
    'file',
  )
  assert.ok(
    (await env.queries.vaultList({ ...env.input, sequence: 1 })).entries.some(
      (item) => item.path === 'untouched.md',
    ),
  )
  await env.methods.vaultCreateFolder({ ...env.input, path: 'notes' })
  assert.deepEqual(await readdir(join(env.vault, 'notes')), [])
  for (const path of [
    '.obsidian/app.json',
    '.obsidian-old/app.json',
    '.tool/app.json',
    'notes/.secret.md',
  ]) {
    await assert.rejects(env.methods.vaultCreateFolder({ ...env.input, path }))
    await assert.rejects(
      env.methods.vaultUpdateText({
        ...env.input,
        path,
        expectedVersion: 'version',
        markdown: 'x',
      }),
    )
    await assert.rejects(
      env.methods.vaultAction({ ...env.input, path, action: 'delete' }),
    )
  }
  assert.deepEqual((await readdir(env.vault)).sort(), ['notes', 'untouched.md'])
  await rm(join(env.vault, 'notes'), { recursive: true })
  await rename(stored, join(env.vault, '.obsidian'))
  await env.assertUnchanged()
})

test('native handlers are constructible without a folder and reject file operations cleanly', async (t) => {
  const env = await fixture(t)
  state.root = null
  for (const [name, handler] of Object.entries({
    ...env.queries,
    ...env.methods,
  }))
    await assert.rejects(
      handler({ ...env.input, path: 'untouched.md', action: 'delete' }),
      /open a folder first/i,
      name,
    )
  state.root = env.vault
  await env.assertUnchanged()
})

test('custom configDir comes from shared detector and remains inaccessible', async (t) => {
  const env = await fixture(t)
  await rename(join(env.vault, '.obsidian'), join(env.vault, '.custom-vault'))
  await writeFile(
    join(env.vault, '.custom-vault', 'app.json'),
    '{"newLinkFormat":"relative"}',
  )
  await writeFile(join(env.vault, '.custom-vault', 'appearance.json'), '{}')
  const info = await env.queries.vaultInfo(env.input)
  assert.equal(info.configDir, '.custom-vault')
  assert.equal(info.settings.newLinkFormat, 'relative')
  await assert.rejects(
    env.queries.vaultStat({ ...env.input, path: '.custom-vault/app.json' }),
    /configuration/,
  )
  await assert.rejects(
    env.methods.vaultCreateFolder({ ...env.input, path: '.custom-vault/new' }),
    /configuration/,
  )
  await rm(join(env.vault, '.custom-vault', 'appearance.json'))
  await rm(join(env.vault, '.custom-vault', 'app.json'))
  await rename(join(env.vault, '.custom-vault'), join(env.vault, '.obsidian'))
  await env.assertUnchanged()
})
