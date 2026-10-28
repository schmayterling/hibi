import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'vite'

const updateRequired =
  'This addon uses the previous formatted editor SDK. Update its formatted-view features for the current editor before using them here.'
const capabilities = [
  undefined,
  [],
  ['rich'],
  ['formatted'],
  ['rich', 'formatted'],
]
const manifest = (apiVersion, capabilities) => ({
  id: 'sdk-proof',
  name: 'SDK proof',
  description: 'SDK compatibility fixture',
  kind: 'extension',
  version: '1.0.0',
  apiVersion,
  capabilities,
  authors: [{ displayName: 'Test' }],
  entry: 'index.js',
})

for (const formatted of [true, false]) {
  test(`${formatted ? 'formatted' : 'legacy'} engine sdk capability matrix`, async (t) => {
    const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { getItem: () => (formatted ? 'codemirror' : null) },
    })
    t.after(() => {
      if (storage) Object.defineProperty(globalThis, 'localStorage', storage)
      else delete globalThis.localStorage
    })
    const server = await createServer({
      configFile: false,
      cacheDir: '.cache/addon-sdk-guard',
      server: { middlewareMode: true },
      appType: 'custom',
    })
    t.after(() => server.close())
    const { legacySdk } = await server.ssrLoadModule('/src/addons/sdk-host.ts')
    let legacyLoads = 0
    // even a configured legacy provider cannot bypass the formatted engine guard.
    legacySdk.all = () => {
      legacyLoads++
      return server.ssrLoadModule('/src/addons/sdk.ts')
    }
    legacySdk.rich = () => {
      legacyLoads++
      return import('@tiptap/core')
    }
    const { loadAddonSdk } = await server.ssrLoadModule(
      '/src/addons/sdk-loader.ts',
    )
    const { normalizeDefinition } = await server.ssrLoadModule(
      '/src/renderer/src/addon-definition.ts',
    )
    const { parseAddonManifest } = await server.ssrLoadModule(
      '/src/shared/addon-manifest.ts',
    )
    for (const apiVersion of [1, 2, 3]) {
      for (const requested of capabilities) {
        await t.test(
          `api ${apiVersion}, capabilities ${JSON.stringify(requested) ?? 'omitted'}`,
          async () => {
            const parse = () =>
              parseAddonManifest(manifest(apiVersion, requested))
            if (apiVersion < 3 && requested?.includes('formatted')) {
              assert.throws(parse, /invalid SDK capabilities/)
              return
            }
            const { manifest: accepted } = parse()
            const sdk = await loadAddonSdk(accepted.capabilities, formatted)
            assert.equal(typeof sdk.documents.projectionRange, 'function')
            if (requested === undefined || requested.includes('rich')) {
              if (formatted) {
                assert.throws(() => sdk.tiptap, { message: updateRequired })
                await assert.rejects(
                  normalizeDefinition((host) => {
                    void host.tiptap
                    return { start() {} }
                  }, accepted),
                  { message: updateRequired },
                )
              } else {
                assert.equal(typeof sdk.tiptap.Extension.create, 'function')
                const definition = await normalizeDefinition((host) => {
                  assert.equal(host.tiptap, sdk.tiptap)
                  return { start() {} }
                }, accepted)
                assert.equal(typeof definition.start, 'function')
              }
            } else assert.equal(sdk.tiptap, undefined)
            assert.equal(!!sdk.React?.createElement, requested === undefined)
            assert.equal(!!sdk.ui?.Button, requested === undefined)
            assert.equal(!!sdk.markdown?.Marked, requested === undefined)
            assert.equal(
              !!sdk.codeMirror?.state.EditorState,
              requested === undefined || requested.includes('formatted'),
            )
            assert.equal(
              !!sdk.codeMirror?.markdown,
              !!requested?.includes('formatted'),
            )
          },
        )
      }
    }
    if (formatted) {
      assert.equal(legacyLoads, 0)
      assert.deepEqual(
        [...server.moduleGraph.idToModuleMap.values()]
          .filter(
            (node) => node.ssrModule && /src\/addons\/sdk\.ts$/.test(node.id),
          )
          .map((node) => node.id),
        [],
      )
    } else assert.ok(legacyLoads > 0)
  })
}
