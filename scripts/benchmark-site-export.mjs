import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { electron } from '../tests/electron.mjs'

const revision = process.argv[2]
const count = Number(process.env.HIBI_EXPORT_PAGES || 2000)
const bundle = await build({
  stdin: {
    contents: `export { prepareSite, siteFiles } from './src/addons/documentation/site.ts'
      export { exportOptions } from './src/addons/documentation/options.ts'
      export { SiteWorker } from './src/addons/documentation/site-runtime.ts'`,
    resolveDir: resolve('.'),
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
  plugins: revision
    ? [
        {
          name: 'baseline-site',
          setup(build) {
            build.onLoad({ filter: /documentation\/site.ts$/ }, () => ({
              contents: execFileSync(
                'git',
                ['show', revision + ':src/addons/documentation/site.ts'],
                { encoding: 'utf8' },
              ),
              loader: 'ts',
              resolveDir: resolve('src/addons/documentation'),
            }))
          },
        },
      ]
    : [],
})
const { mkdtemp, rm } = process.getBuiltinModule('node:fs/promises')
const { tmpdir } = process.getBuiltinModule('node:os')
const { join } = process.getBuiltinModule('node:path')
const profile = await mkdtemp(join(tmpdir(), 'hibi-export-bench-'))
const app = await electron.launch({
  args: [resolve('.'), '--user-data-dir=' + profile],
})
try {
  await app.firstWindow()
  const result = await app.evaluate(
    async ({ app }, { code, count, baseline }) => {
      const { createRequire } = process.getBuiltinModule('node:module')
      const { mkdtemp, rm } = process.getBuiltinModule('node:fs/promises')
      const { tmpdir } = process.getBuiltinModule('node:os')
      const { join } = process.getBuiltinModule('node:path')
      const module = { exports: {} }
      new Function('require', 'module', 'exports', code)(
        createRequire(join(app.getAppPath(), 'package.json')),
        module,
        module.exports,
      )
      const { prepareSite, siteFiles, exportOptions, SiteWorker } =
        module.exports
      const snapshot = {
        name: 'Export probe',
        pages: Array.from({ length: count }, (_, i) => ({
          path: i + '.md',
          markdown:
            '# Page ' +
            i +
            '\n\n## Section\n\n' +
            'Some unicode prose 日本語. '.repeat(220),
        })),
      }
      const template =
        '<!doctype html><html lang="en"><head><title>site</title><style>body{}</style></head><body><div id="root"></div><script id="workspace-data" type="application/json">__HIBI_WORKSPACE_DATA__</script><script>void 0</script></body></html>'
      const options = exportOptions({ graph: false })
      const directory = await mkdtemp(
        join(tmpdir(), 'hibi-export-bench-output-'),
      )
      let running = true,
        turns = 0,
        maxDelay = 0,
        last = performance.now(),
        bytes = 0
      const tick = () => {
        const now = performance.now()
        maxDelay = Math.max(maxDelay, now - last)
        last = now
        turns++
        if (running) setImmediate(tick)
      }
      setImmediate(tick)
      const start = performance.now()
      try {
        if (baseline) {
          const files = await siteFiles(
            template,
            prepareSite(snapshot, options),
          )
          for (const value of files.values()) bytes += Buffer.byteLength(value)
        } else {
          const worker = new SiteWorker(
            join(app.getAppPath(), 'out/main/documentation-worker.js'),
          )
          try {
            await worker.request({
              kind: 'start',
              directory,
              name: snapshot.name,
              paths: snapshot.pages.map((page) => page.path),
              options,
            })
            for (const page of snapshot.pages)
              await worker.request({ kind: 'page', page })
            const files = await worker.request({
              kind: 'finish',
              template,
              css: '',
              colorschemes: [],
              addons: [],
              password: '',
            })
            for (const file of files) bytes += file.bytes
          } finally {
            await worker.close()
          }
        }
        running = false
        await new Promise(setImmediate)
        return {
          mode: baseline ? 'baseline' : 'worker',
          pages: count,
          elapsedMs: performance.now() - start,
          mainMaxDelayMs: maxDelay,
          turns,
          peakRssMiB: process.resourceUsage().maxRSS / 1024,
          bytes,
          versions: process.versions,
        }
      } finally {
        running = false
        await rm(directory, { recursive: true, force: true })
      }
    },
    { code: bundle.outputFiles[0].text, count, baseline: !!revision },
  )
  console.log(JSON.stringify(result))
} finally {
  await app.close()
  await rm(profile, { recursive: true, force: true })
}
