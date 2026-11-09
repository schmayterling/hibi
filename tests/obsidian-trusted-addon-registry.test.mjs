import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'vite'

test('trusted workspace holds installed addon renderer code while bundled addons stay available', async (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { hibiObsidianDesktop: {} },
  })
  const probe = { installed: 0, bundled: 0 }
  globalThis.__trustedAddonProbe = probe
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
    delete globalThis.__trustedAddonProbe
  })
  const server = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: 'custom',
    server: { middlewareMode: true, hmr: false, ws: false },
    plugins: [
      {
        name: 'trusted-addon-fixture',
        resolveId(id) {
          if (id.startsWith('virtual:hibi-addon-catalog/'))
            return '\0trusted-catalog:' + id
        },
        load(id) {
          if (id.startsWith('\0trusted-catalog:'))
            return 'export default [{ manifest: { id:"bundled", name:"Bundled", version:"1.0.0", apiVersion:3, kind:"extension" }, source:"built-in", load: async()=>({default:{start(){globalThis.__trustedAddonProbe.bundled++}}}) }]'
        },
      },
    ],
  })
  t.after(() => server.close())
  const { addonRegistry } = await server.ssrLoadModule(
    '/src/renderer/src/addon-registry.ts',
  )
  const source =
    'globalThis.__trustedAddonProbe.installed++; export default {start(){}}'
  addonRegistry.hydrate([
    {
      manifest: {
        id: 'installed-probe',
        name: 'Installed probe',
        version: '1.0.0',
        apiVersion: 3,
        kind: 'extension',
        capabilities: [],
      },
      url:
        'data:text/javascript;base64,' + Buffer.from(source).toString('base64'),
      source: 'third-party',
      themes: [],
    },
  ])
  const installed = addonRegistry
    .snapshot()
    .find((entry) => entry.manifest.id === 'installed-probe')
  await assert.rejects(installed.start({}), /paused.*full computer access/i)
  assert.equal(probe.installed, 0)
  assert.equal(addonRegistry.paused('installed-probe'), true)
  const bundled = addonRegistry
    .snapshot()
    .find((entry) => entry.manifest.id === 'bundled')
  await bundled.start({})
  assert.equal(probe.bundled, 1)
  assert.equal(addonRegistry.paused('bundled'), false)
  delete window.hibiObsidianDesktop
  await installed.start({})
  assert.equal(probe.installed, 1)
})
