import assert from 'node:assert/strict'
import { mkdir, rm, rmdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { createServer, loadConfigFromFile } from 'vite'

const manifest = (id, extra = {}) => ({
  id,
  name: id,
  description: 'Definition probe',
  kind: 'extension',
  apiVersion: 2,
  version: '1.0.0',
  authors: [{ displayName: 'Test' }],
  ...extra,
})
const module = (source) => `data:text/javascript,${encodeURIComponent(source)}`
const fixture = `
  const definition = {
    flavors: [{ id: 'probe', name: 'Probe', kind: 'syntax', description: 'Probe', detect: () => false }],
    Settings: () => 'settings',
    start() { globalThis.definitionStarts.push(globalThis.definitionId) },
    stop() {},
  }
`
async function registry(t) {
  const { config } = await loadConfigFromFile(
    { command: 'serve', mode: 'test' },
    resolve('electron.vite.config.ts'),
  )
  const server = await createServer({
    configFile: false,
    plugins: config.renderer.plugins.filter(
      (plugin) => plugin.name === 'addon-catalog-renderer',
    ),
    root: resolve('.'),
    server: { middlewareMode: true },
    appType: 'custom',
  })
  t.after(() => server.close())
  const { addonRegistry } = await server.ssrLoadModule(
    '/src/renderer/src/addon-registry.ts',
  )
  t.after(() => addonRegistry.hydrate([]))
  const find = (id) =>
    addonRegistry.snapshot().find((addon) => addon.manifest.id === id)
  return { server, addonRegistry, find }
}

test('direct definitions and factories share one descriptor path', {
  timeout: 30000,
}, async (t) => {
  const { server, addonRegistry, find } = await registry(t)
  t.after(() => {
    delete globalThis.definitionStarts
    delete globalThis.definitionSdk
    delete globalThis.definitionFactoryCalls
  })
  globalThis.definitionStarts = []
  globalThis.definitionFactoryCalls = 0
  addonRegistry.hydrate([
    {
      // No capabilities: a factory would receive the legacy SDK, so a direct object must skip it.
      manifest: manifest('direct-probe'),
      url: module(
        `${fixture} export default { ...definition, manifest: { id: 'direct-probe' } }`,
      ),
      themes: [],
    },
    {
      manifest: manifest('factory-probe', { capabilities: [] }),
      url: module(
        `${fixture} export default (sdk) => { globalThis.definitionFactoryCalls++; globalThis.definitionSdk = sdk; return definition }`,
      ),
      themes: [],
    },
    {
      manifest: manifest('mismatch-probe'),
      url: module(
        `${fixture} export default { ...definition, manifest: { id: 'other' } }`,
      ),
      themes: [],
    },
    {
      manifest: manifest('shape-probe', { capabilities: [] }),
      url: module(`export default () => ({ start: true })`),
      themes: [],
    },
  ])
  const direct = find('direct-probe')
  const factory = find('factory-probe')
  assert.equal(direct.Settings, undefined)
  assert.equal(factory.flavors, undefined)
  assert.equal(globalThis.definitionFactoryCalls, 0)

  globalThis.definitionId = 'direct-probe'
  await direct.start({})
  globalThis.definitionId = 'factory-probe'
  await factory.start({})
  assert.deepEqual(globalThis.definitionStarts, [
    'direct-probe',
    'factory-probe',
  ])
  assert.equal(direct.Settings(), 'settings')
  assert.equal(factory.Settings(), 'settings')
  assert.deepEqual(
    direct.flavors.map((flavor) => flavor.id),
    factory.flavors.map((flavor) => flavor.id),
  )
  assert.equal(globalThis.definitionFactoryCalls, 1)
  assert.ok(globalThis.definitionSdk.documents)
  assert.equal(globalThis.definitionSdk.React, undefined)
  // The graph lists dynamic import targets; only evaluated modules carry an instance.
  assert.ok(
    ![...server.moduleGraph.idToModuleMap.values()].some(
      (node) => node.id.endsWith('/src/addons/sdk.ts') && node.ssrModule,
    ),
    'the legacy SDK must not load for direct definitions',
  )

  await assert.rejects(find('mismatch-probe').start({}), /do not match/)
  await assert.rejects(find('shape-probe').start({}), /cannot start/)

  // Retiring a package drops what its definition published.
  addonRegistry.hydrate([])
  assert.equal(direct.Settings, undefined)
  assert.equal(direct.flavors, undefined)
  assert.equal(find('direct-probe'), undefined)
})

test('stopping while the module loads never invokes its factory', {
  timeout: 30000,
}, async (t) => {
  const { addonRegistry, find } = await registry(t)
  let release
  globalThis.definitionGate = new Promise((resolve) => {
    release = resolve
  })
  globalThis.definitionFactoryCalls = 0
  t.after(() => {
    delete globalThis.definitionGate
    delete globalThis.definitionFactoryCalls
  })
  addonRegistry.hydrate([
    {
      manifest: manifest('cancel-probe', { capabilities: [] }),
      url: module(
        `await globalThis.definitionGate; export default () => { globalThis.definitionFactoryCalls++; return { start() {} } }`,
      ),
      themes: [],
    },
  ])
  const addon = find('cancel-probe')
  const starting = addon.start({})
  addon.stop()
  release()
  await starting
  assert.equal(globalThis.definitionFactoryCalls, 0)
})

test('source theme addons still register colors from start', {
  timeout: 30000,
}, async (t) => {
  const id = 'definition-theme-probe'
  const root = resolve('src/useraddons')
  const folder = resolve(root, id)
  await mkdir(folder, { recursive: true })
  t.after(async () => {
    await rm(folder, { recursive: true, force: true })
    // Leave a developer's own local addons alone.
    await rmdir(root).catch(() => {})
  })
  await writeFile(
    resolve(folder, 'manifest.ts'),
    `export default ${JSON.stringify(manifest(id, { kind: 'theme' }))}`,
  )
  await writeFile(
    resolve(folder, 'index.ts'),
    `import manifest from './manifest'
export default {
  manifest,
  start(context) {
    context.colorschemes.register({ id: 'probe', name: 'Probe', appearance: 'dark', colors: {} })
  },
}`,
  )
  const { find } = await registry(t)
  const registered = []
  await find(id).start({
    colorschemes: { register: (scheme) => registered.push(scheme.id) },
  })
  assert.deepEqual(registered, ['probe'])
})

test('declared themes precede runtime registration and duplicate IDs fail without replacing colors', async (t) => {
  const { server, addonRegistry, find } = await registry(t)
  const { createColorschemeStore } = await server.ssrLoadModule(
    '/src/ui/colorschemes.ts',
  )
  const previous = {
    document: globalThis.document,
    matchMedia: globalThis.matchMedia,
  }
  globalThis.document = { createElement: () => ({ dataset: {} }) }
  globalThis.matchMedia = () => ({ matches: false })
  t.after(() => Object.assign(globalThis, previous))
  const store = createColorschemeStore('collision-test', undefined, false)
  const scheme = {
    id: 'night',
    name: 'Declared night',
    appearance: 'dark',
    author: 'Test',
    license: { name: 'MIT', text: 'Permission notice' },
    colors: {
      background: '#111111',
      surface: '#222222',
      ink: '#eeeeee',
      muted: '#aaaaaa',
      accent: '#88cccc',
      border: '#333333',
    },
  }
  const id = 'collision-probe'
  addonRegistry.hydrate([
    {
      manifest: manifest(id),
      themes: [scheme],
      url: module(`export default {
      start(context) {
        context.colorschemes.register(${JSON.stringify({ ...scheme, name: 'Runtime replacement' })})
      }
    }`),
    },
  ])
  const cleanups = []
  const context = {
    colorschemes: {
      register(input) {
        const remove = store.register({ ...input, id: `${id}.${input.id}` })
        cleanups.push(remove)
        return remove
      },
    },
  }
  const addon = find(id)
  // useAddons owns cleanup after descriptor failure; exercise the same removers.
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(
      addon.start(context),
      /duplicate colorscheme: collision-probe.night/,
    )
    assert.equal(
      store.snapshot().schemes.find((entry) => entry.id === `${id}.night`).name,
      'Declared night',
    )
    addon.stop()
    for (const remove of cleanups.splice(0)) remove()
    assert.ok(
      !store.snapshot().schemes.some((entry) => entry.id.startsWith(`${id}.`)),
    )
  }
})

test('settings and windows must be components, not elements', {
  timeout: 30000,
}, async (t) => {
  const { addonRegistry, find } = await registry(t)
  const exportsWith = (fields) =>
    module(`export default () => ({ start() {}, ${fields} })`)
  const memo = `{ $$typeof: Symbol.for('react.memo'), type: () => null }`
  const element = `{ $$typeof: Symbol.for('react.transitional.element'), type: 'div', props: {} }`
  const tagged = `{ $$typeof: Symbol('component') }`
  const cases = {
    'wrapper-probe': `Settings: ${memo}, windows: { main: ${memo} }`,
    'element-settings-probe': `Settings: ${element}`,
    'element-window-probe': `windows: { main: ${element} }`,
    'tagged-settings-probe': `Settings: ${tagged}`,
  }
  addonRegistry.hydrate(
    Object.entries(cases).map(([id, fields]) => ({
      manifest: manifest(id, { capabilities: [] }),
      url: exportsWith(fields),
      themes: [],
    })),
  )
  await find('wrapper-probe').start({})
  assert.equal(
    find('wrapper-probe').Settings.$$typeof,
    Symbol.for('react.memo'),
  )
  for (const id of Object.keys(cases).filter((id) => id !== 'wrapper-probe'))
    await assert.rejects(find(id).start({}), /cannot start/, id)
})
