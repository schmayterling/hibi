import { isAbsolute, relative, resolve, sep } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import { analysisBundles, analysisPreload } from './scripts/analysis-bundles'
import { writeLicenses } from './scripts/licenses'
import {
  diagnosticsBuild,
  diagnosticsDefines,
} from './scripts/local-diagnostics-build'
import { startupBundle } from './scripts/startup-bundle'

const diagnosticArtifacts = diagnosticsBuild()
const mainOutput = resolve('out/main')

export default defineConfig({
  main: {
    define: diagnosticsDefines(),
    plugins: [
      { name: 'app-licenses', buildStart: writeLicenses },
      analysisBundles(),
    ],
    build: {
      // Keep old lazy chunks available until the dev watcher restarts Electron.
      emptyOutDir: process.env.NODE_ENV_ELECTRON_VITE !== 'development',
      // unzipper's optional S3 adapter must stay lazy; hibi only opens local buffers.
      commonjsOptions: { ignore: ['@aws-sdk/client-s3'] },
      rollupOptions: {
        watch: {
          chokidar: {
            ignored: (path: string) => {
              const part = relative(mainOutput, path)
              return (
                part === '' ||
                (part !== '..' &&
                  !part.startsWith(`..${sep}`) &&
                  !isAbsolute(part))
              )
            },
          },
        },
        input: {
          index: resolve('src/main/index.ts'),
          'typst-worker': resolve('src/addons/typst/compiler-worker.ts'),
          'format-worker': resolve('src/addons/_shared/format-worker.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [analysisPreload()],
    build: {
      externalizeDeps: false,
      rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.cjs' } },
    },
  },
  renderer: {
    plugins: [react(), startupBundle(), diagnosticArtifacts.renderer],
    worker: { format: 'es', plugins: () => [diagnosticArtifacts.worker()] },
    build: { target: 'chrome152', minify: 'esbuild' },
    server: { host: '127.0.0.1' },
  },
})
