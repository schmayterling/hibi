import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createServer } from 'vite'
import { readFixturePlugin } from './obsidian/harness.mjs'

// Review probes for the desktop full-access checkpoint (cb64b49d).
async function nativeHost(t) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'hibi-desktop-review-')),
  )
  t.after(() => rm(root, { recursive: true, force: true }))
  const state = { root, dialogs: [], response: 0 }
  globalThis.__desktopReview = state
  t.after(() => delete globalThis.__desktopReview)
  const server = await createServer({
    configFile: false,
    cacheDir: join(root, 'cache'),
    optimizeDeps: { noDiscovery: true, include: [] },
    ssr: { noExternal: ['electron', '@electron/remote'] },
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: 'custom',
    plugins: [
      {
        name: 'desktop-review',
        enforce: 'pre',
        resolveId(id) {
          if (id === 'electron') return '\0desktop-review:electron'
        },
        load(id) {
          if (id === '\0desktop-review:electron')
            return `const s = globalThis.__desktopReview
            export const app = {getPath: () => s.root}
            export const dialog = {showMessageBox: async (options) => {s.dialogs.push(options); return s.onDialog ? await s.onDialog(options) : {response: s.response}}}
            export const ipcMain = {on(){}, handle(){}}
            export class BrowserWindow {}
            export const net = {}
            export const session = {}
            export const shell = {}`
        },
      },
    ],
  })
  t.after(() => server.close())
  const { default: native, obsidianGlobalStore } = await server.ssrLoadModule(
    '/src/addons/obsidian/native.ts',
  )
  const { readObsidianPackageBytes } = await server.ssrLoadModule(
    '/src/addons/obsidian/store.ts',
  )
  const context = {
    senderId: 1,
    isCurrent: () => true,
    workspace: { id: () => 'w', directory: () => root },
  }
  const { store } = await obsidianGlobalStore()
  const fixture = await readFixturePlugin('host-smoke')
  const install = async (desktop = true, main = fixture.main) => {
    const data = readObsidianPackageBytes(
      Buffer.from(
        JSON.stringify({ ...fixture.manifest, isDesktopOnly: desktop }),
      ),
      Buffer.from(main),
      fixture.styles === null ? null : Buffer.from(fixture.styles),
    )
    await store.install(data)
    return data
  }
  return {
    native,
    store,
    context,
    state,
    install,
    root,
    load: (path) => server.ssrLoadModule('/src/addons/obsidian/' + path),
  }
}

async function consent(t, desktop) {
  const { native, store, context, state, install } = await nativeHost(t)
  const data = await install(desktop)
  // Any main-world script (an ordinary Obsidian plugin, an XSS) can make these two calls.
  const { token } = await native.queries.prepareFullAccess(
    { id: data.manifest.id, hash: data.hash },
    context,
  )
  let granted = false
  try {
    const result = await native.methods.enable(
      { id: data.manifest.id, enabled: true, fullAccess: true, token },
      context,
    )
    granted = result?.fullAccess === true
  } catch {}
  const [record] = await store.list()
  assert.equal(state.dialogs.length, 1)
  assert.equal(granted, false)
  assert.equal(record.enabled, false)
  assert.equal(record.fullAccess, undefined)
  assert.equal(state.dialogs[0].defaultId, 0)
  assert.equal(state.dialogs[0].cancelId, 0)
  assert.match(JSON.stringify(state.dialogs[0]), new RegExp(data.hash))
  await assert.rejects(
    native.methods.enable(
      { id: data.manifest.id, enabled: true, fullAccess: true, token },
      context,
    ),
    /changed/,
  )
  state.response = 1
  const next = await native.queries.prepareFullAccess(
    { id: data.manifest.id, hash: data.hash },
    context,
  )
  const accepted = await native.methods.enable(
    {
      id: data.manifest.id,
      enabled: true,
      fullAccess: true,
      token: next.token,
    },
    context,
  )
  assert.equal(accepted.fullAccess, true)
  await assert.rejects(
    native.methods.enable(
      {
        id: data.manifest.id,
        enabled: true,
        fullAccess: true,
        token: next.token,
      },
      context,
    ),
    /changed/,
  )
}
for (const desktop of [true, false])
  test(
    'native consent is required for ' +
      (desktop ? 'desktop' : 'portable') +
      ' full access',
    (t) => consent(t, desktop),
  )

test('one tampered full-access package does not make every plugin list (and revoke) throw', async (t) => {
  const { native, store, context, install, root } = await nativeHost(t)
  const data = await install()
  await store.setEnabled(data.manifest.id, true, undefined, true)
  await writeFile(
    join(
      root,
      'obsidian',
      'global',
      'packages',
      data.manifest.id,
      data.hash,
      'main.js',
    ),
    'module.exports = 1',
  )
  // startup: DesktopWorkspace.initialize -> refresh -> store.list; settings: revokeFullAccess -> store.list
  await assert.doesNotReject(
    store.list(),
    'store.list rejects: startup initialize() and createWindow never run',
  )
  await assert.doesNotReject(
    native.methods.revokeFullAccess({}, context),
    'revoke all is unreachable while a granted package is tampered',
  )
})

test('trusted workspace refuses normal script tickets and assets even for an installed enabled package', async (t) => {
  const ctx = await nativeHost(t)
  const data = await ctx.install()
  await ctx.store.setEnabled(data.manifest.id, true, undefined, true)
  const { DesktopWorkspace } = await ctx.load('desktop-native.ts')
  const workspace = new DesktopWorkspace({
    enabled: () => true,
    generation: () => 1,
    current: () => null,
    trusted() {},
  })
  assert.equal(await workspace.initialize(), true)
  const { preparePluginScriptLoad } = await ctx.load(
    'api/network/capabilities.ts',
  )
  const scope = { senderId: 1, isCurrent: () => true }
  const nonce = preparePluginScriptLoad(data.manifest.id, data.hash, scope)
  const { obsidianPluginAsset } = await ctx.load('native.ts')
  assert.equal(
    await obsidianPluginAsset(
      new Request(
        'app://obsidian-plugins/obsidian-plugins/global/' +
          data.manifest.id +
          '/' +
          data.hash +
          '/main.js?load=' +
          nonce,
      ),
      scope,
    ),
    null,
  )
  await assert.rejects(
    ctx.native.profileMethods.preparePluginLoad(
      { id: data.manifest.id, hash: data.hash },
      ctx.context,
    ),
    /need full computer access/,
  )
})

for (const timing of ['dialog', 'store queue'])
  test(
    'consent naming package A cannot grant package B replaced in the ' + timing,
    async (t) => {
      const ctx = await nativeHost(t)
      const a = await ctx.install()
      const { token } = await ctx.native.queries.prepareFullAccess(
        { id: a.manifest.id, hash: a.hash },
        ctx.context,
      )
      let b
      const replace = async () => {
        b = await ctx.install(
          true,
          'module.exports = class extends require("obsidian").Plugin { /* changed B */ }',
        )
      }
      if (timing === 'dialog') {
        ctx.state.onDialog = async () => {
          await replace()
          return { response: 1 }
        }
      } else {
        ctx.state.response = 1
        const enable = ctx.store.setEnabled.bind(ctx.store)
        ctx.store.setEnabled = async (...args) => {
          await replace()
          return enable(...args)
        }
      }
      await assert.rejects(
        ctx.native.methods.enable(
          { id: a.manifest.id, enabled: true, fullAccess: true, token },
          ctx.context,
        ),
        /changed|review/i,
      )
      const [record] = await ctx.store.list()
      assert.notEqual(a.hash, b.hash)
      assert.equal(record.hash, b.hash)
      assert.equal(record.enabled, false)
      assert.equal(record.fullAccess, undefined)
    },
  )
