import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import base from '../../electron.vite.config'

// Dedicated test builds only. Production config never reads these controls.
const output = process.env.HIBI_O11Y_TEST_OUTPUT
if (!output?.startsWith('/') || resolve(output) === resolve('.'))
  throw new Error('An isolated absolute output directory is required')
const disabled = process.env.HIBI_O11Y_TEST_MODE === 'off'
const probe = process.env.HIBI_O11Y_TEST_PROBE === '1'
const stress = process.env.HIBI_O11Y_TEST_STRESS === '1'
const stubs = new Map(
  [
    [
      'src/main/local-diagnostics/runtime.ts',
      'export class LocalDiagnostics { start() {} observeWindow() {} observeAsset(url, load) { return load() } menuItems() { return [] } report() {} async flush() {} }',
    ],
    [
      'src/main/local-diagnostics/owned.ts',
      'export const diagnosticServiceName = role => "hibi " + role; export const attachDiagnosticService = () => {}; export const expectDiagnosticStop = () => {}; export const reportOwnedFailure = () => {}; export const reportAnalysisProcessFailure = () => {};',
    ],
    [
      'src/preload/local-diagnostics.ts',
      'export class DiagnosticProducer { configuration = Promise.resolve(null); record() { return false } }; export const installStartupDiagnostics = () => () => {}',
    ],
    [
      'src/renderer/src/local-diagnostics.ts',
      'export const installRendererDiagnostics = () => () => {}; export const reportRendererFailure = () => {};',
    ],
  ].map(([path = '', source = '']) => [resolve(path), source]),
)
const control = (): Plugin => ({
  name: 'test-only-diagnostic-control',
  enforce: 'pre',
  load(id) {
    return disabled ? stubs.get(id) : undefined
  },
  transform(code, id) {
    if (!stress || id !== resolve('src/main/local-diagnostics/runtime.ts'))
      return
    const marker = disabled
      ? 'export class LocalDiagnostics {'
      : 'constructor() {'
    if (code.split(marker).length !== 2)
      throw new Error('Diagnostic stress fixture no longer matches its owner')
    return code.replace(
      marker,
      disabled
        ? `${marker} constructor() { globalThis.__hibiDiagnosticStress = this; }`
        : `${marker} globalThis.__hibiDiagnosticStress = this;`,
    )
  },
})
export default defineConfig({
  ...base,
  main: {
    ...base.main,
    plugins: [control(), ...(base.main?.plugins ?? [])],
    build: {
      ...base.main?.build,
      outDir: resolve(output, 'out/main'),
      rollupOptions: {
        ...base.main?.build?.rollupOptions,
        input: {
          index: resolve(
            probe
              ? 'tests/fixtures/local-diagnostics-packaged.ts'
              : 'src/main/index.ts',
          ),
          'typst-worker': resolve('src/addons/typst/compiler-worker.ts'),
          'format-worker': resolve('src/addons/_shared/format-worker.ts'),
        },
      },
    },
  },
  preload: {
    ...base.preload,
    plugins: [control(), ...(base.preload?.plugins ?? [])],
    build: { ...base.preload?.build, outDir: resolve(output, 'out/preload') },
  },
  renderer: {
    ...base.renderer,
    plugins: [control(), ...(base.renderer?.plugins ?? [])],
    build: { ...base.renderer?.build, outDir: resolve(output, 'out/renderer') },
  },
})
