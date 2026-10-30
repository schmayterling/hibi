import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { DiagnosticIngress } from '../src/main/local-diagnostics/ingress.ts'

test('a failed pre-entry observer preserves the normal renderer diagnostics bridge', async () => {
  const records = []
  const ingress = new DiagnosticIngress('debug', [], (wire) => {
    records.push(JSON.parse(wire))
    return true
  })
  const exposed = {}
  const { outputFiles } = await build({
    entryPoints: ['src/preload/index.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    define: { 'import.meta.env.DEV': 'false' },
    write: false,
  })
  new Function('require', 'process', outputFiles[0].text)(
    (id) => {
      assert.equal(id, 'electron')
      return {
        contextBridge: {
          executeInMainWorld() {
            throw new Error('pre-entry bridge unavailable')
          },
          exposeInMainWorld(name, api) {
            exposed[name] = api
          },
        },
        ipcRenderer: {
          invoke: async (_channel, ...args) => ingress.receive(true, ...args),
          on() {},
          removeListener() {},
          send() {},
        },
      }
    },
    { isMainFrame: true },
  )
  try {
    assert.ok(exposed.hibiTransport, 'document bridge remains available')
    assert.ok(exposed.hibiDiagnostics, 'normal diagnostics remain available')
    assert.equal(
      JSON.parse(await exposed.hibiDiagnostics.configuration()).profile,
      'debug',
    )
    assert.equal(
      exposed.hibiDiagnostics.record(
        JSON.stringify({
          code: 'RENDERER_ERROR',
          stackStatus: 'unavailable',
        }),
      ),
      true,
    )
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.ok(records.some((record) => record.code === 'RENDERER_ERROR'))
  } finally {
    ingress.dispose()
  }
})
