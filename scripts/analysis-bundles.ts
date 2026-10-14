import { resolve } from 'node:path'
import { build } from 'esbuild'
import type { Plugin } from 'vite'
import { readAddonPackages } from './addon-packages'

/** Bundle analysis separately so its imports never become main-renderer dependencies. */
export function analysisBundles(): Plugin {
  const moduleId = 'virtual:hibi-analysis'
  return {
    name: 'analysis-bundles',
    resolveId(id) {
      if (id === moduleId) return `\0${moduleId}`
    },
    async load(id) {
      if (id !== `\0${moduleId}`) return
      const bundles: Record<string, string> = {}
      const packages = await readAddonPackages(undefined, (file) =>
        this.addWatchFile(file),
      )
      for (const { manifest, analysis } of packages) {
        if (!analysis) continue
        const result = await build({
          entryPoints: [analysis],
          bundle: true,
          format: 'esm',
          platform: 'browser',
          write: false,
          metafile: true,
          minify: true,
          target: 'chrome152',
        })
        for (const file of Object.keys(result.metafile.inputs))
          this.addWatchFile(resolve(file))
        bundles[manifest.id] = result.outputFiles[0]!.text
      }
      return `export default ${JSON.stringify(bundles)}`
    },
  }
}
/** Bundle each extra preload as one file; sandboxed preloads cannot load chunks. */
export function sandboxPreloads(): Plugin {
  const entries = {
    'analysis.cjs': 'src/preload/analysis.ts',
    'addon-window.cjs': 'src/preload/addon-window.ts',
  }
  return {
    name: 'sandbox-preloads',
    async generateBundle() {
      for (const [fileName, entry] of Object.entries(entries)) {
        const result = await build({
          entryPoints: [entry],
          bundle: true,
          format: 'cjs',
          platform: 'node',
          external: ['electron'],
          write: false,
          metafile: true,
          target: 'node24',
        })
        for (const file of Object.keys(result.metafile.inputs))
          this.addWatchFile(resolve(file))
        this.emitFile({
          type: 'asset',
          fileName,
          source: result.outputFiles[0]!.text,
        })
      }
    },
  }
}
