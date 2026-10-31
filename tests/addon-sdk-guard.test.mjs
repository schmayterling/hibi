import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'vite'

const updateRequired =
  'This addon was made for an earlier version of Hibi. Ask its author for an update to addon API 3.'
const manifest = (fields) => ({
  id: 'sdk-proof',
  name: 'SDK proof',
  description: 'SDK compatibility fixture',
  kind: 'extension',
  version: '1.0.0',
  apiVersion: 3,
  authors: [{ displayName: 'Test' }],
  entry: 'index.js',
  ...fields,
})

test('sdk capability matrix', async (t) => {
  const server = await createServer({
    configFile: false,
    cacheDir: '.cache/addon-sdk-guard',
    server: { middlewareMode: true },
    appType: 'custom',
  })
  t.after(() => server.close())
  const { loadAddonSdk } = await server.ssrLoadModule(
    '/src/addons/sdk-loader.ts',
  )
  const { normalizeDefinition } = await server.ssrLoadModule(
    '/src/renderer/src/addon-definition.ts',
  )
  const { parseAddonManifest } = await server.ssrLoadModule(
    '/src/shared/addon-manifest.ts',
  )
  for (const requested of [
    [],
    ['ui'],
    ['source'],
    ['markdown'],
    ['formatted'],
    ['ui', 'source', 'markdown'],
  ])
    await t.test(`capabilities ${JSON.stringify(requested)}`, async () => {
      const { manifest: accepted } = parseAddonManifest(
        manifest({ capabilities: requested }),
      )
      const sdk = await loadAddonSdk(accepted.capabilities)
      assert.equal(typeof sdk.documents.projectionRange, 'function')
      assert.equal(!!sdk.React?.createElement, requested.includes('ui'))
      assert.equal(!!sdk.ui?.Button, requested.includes('ui'))
      assert.equal(!!sdk.markdown?.Marked, requested.includes('markdown'))
      assert.equal(
        !!sdk.codeMirror?.state.EditorState,
        requested.includes('source') || requested.includes('formatted'),
      )
      assert.equal(!!sdk.codeMirror?.markdown, requested.includes('formatted'))
      const definition = await normalizeDefinition(
        () => ({ start() {} }),
        accepted,
      )
      assert.equal(typeof definition.start, 'function')
    })
  await t.test('earlier apis and the rich sdk ask for an update', () => {
    for (const fields of [
      { apiVersion: 1 },
      { apiVersion: 2, capabilities: [] },
      { capabilities: ['rich'] },
      { capabilities: ['rich', 'formatted'] },
      { capabilities: [], activation: 'rich' },
    ])
      assert.throws(() => parseAddonManifest(manifest(fields)), {
        message: updateRequired,
      })
  })
  await t.test('factories without capabilities ask for an update', async () => {
    const { manifest: accepted } = parseAddonManifest(manifest({}))
    assert.equal(accepted.capabilities, undefined)
    let ran = false
    await assert.rejects(
      normalizeDefinition(() => {
        ran = true
        return { start() {} }
      }, accepted),
      { message: updateRequired },
    )
    assert.equal(ran, false)
    // Object exports load no SDK and need no capabilities.
    const definition = await normalizeDefinition({ start() {} }, accepted)
    assert.equal(typeof definition.start, 'function')
  })
})
