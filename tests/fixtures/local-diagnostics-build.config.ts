import { readFileSync } from 'node:fs'
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
// Stand-ins typecheck against the modules they replace, so drift fails
// `npm run typecheck` instead of the off build's start.
const stubs = new Map(
  [
    ['src/main/local-diagnostics/runtime.ts', 'runtime.ts'],
    ['src/main/local-diagnostics/owned.ts', 'owned.ts'],
    ['src/preload/local-diagnostics.ts', 'preload.ts'],
    ['src/renderer/src/local-diagnostics.ts', 'renderer.ts'],
  ].map(([path = '', file = '']) => [
    resolve(path),
    resolve('tests/fixtures/local-diagnostics-off', file),
  ]),
)
const control = (): Plugin => ({
  name: 'test-only-diagnostic-control',
  enforce: 'pre',
  load(id) {
    const stub = disabled && stubs.get(id)
    return stub ? readFileSync(stub, 'utf8') : undefined
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
