import { existsSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import {
  addonDevelopmentStyles,
  developmentMetadata,
} from './scripts/addon-development'
import { addonCatalog } from './scripts/addon-packages'
import { analysisBundles, sandboxPreloads } from './scripts/analysis-bundles'
import { writeLicenses } from './scripts/licenses'
import {
  diagnosticsBuild,
  diagnosticsDefines,
} from './scripts/local-diagnostics-build'
import { startupBundle } from './scripts/startup-bundle'

if (!existsSync('docs/README.md'))
  throw new Error('Documentation is missing. Run npm run docs before building.')

const diagnosticArtifacts = diagnosticsBuild()
const mainOutput = resolve('out/main')

let licenseBuild = Promise.resolve<PromiseSettledResult<void>[]>([])
const drainLicenses = {
  order: 'pre' as const,
  sequential: true,
  async handler() {
    await licenseBuild
  },
}

export default defineConfig({
  main: {
    define: diagnosticsDefines(),
    plugins: [
      addonCatalog('main'),
      {
        name: 'watch-inline-assets',
        load: {
          order: 'pre',
          handler(id) {
            if (
              process.env.NODE_ENV_ELECTRON_VITE === 'development' &&
              /\?inline(?:&|$)/.test(id)
            )
              this.addWatchFile(id.replace(/\?.*$/, ''))
          },
        },
      },
      {
        name: 'app-licenses',
        buildStart() {
          licenseBuild = Promise.allSettled([writeLicenses()])
        },
        buildEnd: {
          order: 'post',
          sequential: true,
          async handler() {
            const [result] = await licenseBuild
            if (result?.status === 'rejected') throw result.reason
          },
        },
        closeBundle: drainLicenses,
        closeWatcher: drainLicenses,
      },
      analysisBundles(),
    ],
    build: {
      // Development workers load installed compilers directly.
      externalizeDeps:
        process.env.NODE_ENV_ELECTRON_VITE === 'development'
          ? {
              include: [
                '@markdoc/markdoc',
                '@mdx-js/mdx',
                'hast-util-to-html',
                'mdast-util-to-hast',
                'mdsvex',
                'react',
                'react-dom',
                'remark-gfm',
                'svelte',
              ],
            }
          : true,
      // Keep old lazy chunks available until the dev watcher restarts Electron.
      emptyOutDir: process.env.NODE_ENV_ELECTRON_VITE !== 'development',
      // unzipper's optional S3 adapter must stay lazy; hibi only opens local buffers.
      commonjsOptions: { ignore: ['@aws-sdk/client-s3'] },
      rollupOptions: {
        watch: {
          chokidar: {
            ignored: (path: string) => {
              const input = path.split(sep).join('/')
              if (
                process.env.NODE_ENV_ELECTRON_VITE === 'development' &&
                developmentMetadata.has(input) &&
                !input.endsWith('.md')
              )
                return true
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
          'documentation-worker': resolve(
            'src/addons/documentation/site-worker.ts',
          ),
          'import-worker': resolve('src/addons/_shared/import-worker.ts'),
          'workspace-text-worker': resolve('src/main/workspace-text-worker.ts'),
          'dictionary-pack-worker': resolve(
            'src/addons/dictionary/pack-worker.ts',
          ),
          'dictionary-custom-words-worker': resolve(
            'src/addons/dictionary/custom-words-worker.ts',
          ),
        },
      },
    },
  },
  preload: {
    plugins: [sandboxPreloads()],
    build: {
      // Keep the last preload available to renderers reloading during a rebuild.
      emptyOutDir: process.env.NODE_ENV_ELECTRON_VITE !== 'development',
      externalizeDeps: false,
      rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.cjs' } },
    },
  },
  renderer: {
    plugins: [
      addonCatalog('renderer'),
      addonDevelopmentStyles(),
      react(),
      startupBundle(),
      diagnosticArtifacts.renderer,
    ],
    worker: { format: 'es', plugins: () => [diagnosticArtifacts.worker()] },
    build: {
      target: 'chrome152',
      minify: 'esbuild',
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          'addon-window': resolve('src/renderer/addon-window.html'),
        },
      },
    },
    server: { host: '127.0.0.1' },
    // Development loads addons through a dynamic catalog import that the
    // dependency scan cannot follow. Without their entries, the first editor
    // load re-bundles their dependencies and reloads the window.
    optimizeDeps: {
      entries: [
        'index.html',
        'addon-window.html',
        '../addons/*/index.{ts,tsx}',
      ],
    },
  },
})
