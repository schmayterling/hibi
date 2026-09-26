import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import { createServer } from 'vite'

test('stopping an installed addon releases its Settings closure but keeps flavor metadata', {
  timeout: 30000,
}, async (t) => {
  const server = await createServer({
    configFile: false,
    root: resolve('.'),
    server: { middlewareMode: true },
    appType: 'custom',
  })
  t.after(async () => {
    await server.close()
    delete globalThis.retentionFactoryCount
  })
  const { addonRegistry } = await server.ssrLoadModule(
    '/src/renderer/src/addon-registry.ts',
  )
  const source = `
    const flavor = {
      id: 'probe', name: 'Probe', kind: 'syntax',
      description: 'Retention probe', detect: () => false,
    }
    export default () => {
      const version = (globalThis.retentionFactoryCount ?? 0) + 1
      globalThis.retentionFactoryCount = version
      const payload = new Uint8Array(1024 * 1024)
      payload[0] = version
      function Settings() { return payload[0] }
      return { Settings, flavors: [flavor], start() {}, stop() {} }
    }
  `
  addonRegistry.hydrate([
    {
      manifest: {
        id: 'owner-retention-probe',
        name: 'Owner retention probe',
        description: 'Tests addon lifecycle retention',
        kind: 'extension',
        apiVersion: 2,
        version: '1.0.0',
        capabilities: [],
        authors: [{ displayName: 'Test' }],
      },
      url: `data:text/javascript,${encodeURIComponent(source)}`,
      themes: [],
    },
  ])
  t.after(() => addonRegistry.hydrate([]))
  const addon = addonRegistry
    .snapshot()
    .find(({ manifest }) => manifest.id === 'owner-retention-probe')
  assert.ok(addon)

  await addon.start({})
  assert.equal(addon.Settings(), 1)
  const flavors = addon.flavors
  const beforeStop = addonRegistry.snapshot()
  addon.stop()
  assert.equal(addon.Settings, undefined)
  assert.strictEqual(addon.flavors, flavors)
  assert.notStrictEqual(addonRegistry.snapshot(), beforeStop)

  await addon.start({})
  assert.equal(addon.Settings(), 2)
  const secondFlavors = addon.flavors
  addon.stop()
  assert.equal(addon.Settings, undefined)
  assert.strictEqual(addon.flavors, secondFlavors)
})
