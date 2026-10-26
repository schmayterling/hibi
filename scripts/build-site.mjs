import { createHash } from 'node:crypto'
import { readFile, rename } from 'node:fs/promises'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { build } from 'vite'

const watching = process.argv.includes('--watch')
const licensePaths = [
  'geist/LICENSE.txt',
  'minisearch/LICENSE.txt',
  'dompurify/LICENSE',
  'dompurify/LICENSE-MPL',
  'react/LICENSE',
  'react-dom/LICENSE',
  'scheduler/LICENSE',
  'lucide-react/LICENSE',
  'marked/LICENSE',
  'katex/LICENSE',
  'd3-force/LICENSE',
  'd3-dispatch/LICENSE',
  'd3-quadtree/LICENSE',
  'd3-timer/LICENSE',
]
const licenses = (
  await Promise.all([
    ...licensePaths.map(
      async (path) =>
        `${path}\n${await readFile(resolve('node_modules', path), 'utf8')}`,
    ),
    ...['catppuccin', 'vscode', 'nord'].map((name) =>
      readFile(resolve('docs/licenses', `${name}.md`), 'utf8'),
    ),
  ])
)
  .join('\n\n')
  .replaceAll('-->', '--&gt;')
const result = await build({
  define: { 'process.env.NODE_ENV': '"production"' },
  configFile: false,
  root: resolve('src/site'),
  plugins: [
    react(),
    {
      name: 'self-contained-documentation',
      enforce: 'post',
      generateBundle(_options, bundle) {
        const js = Object.values(bundle)
          .filter((item) => item.type === 'chunk')
          .map((item) => item.code)
          .join('\n')
          .replaceAll('</script', '<\\/script')
        const css = Object.values(bundle)
          .filter(
            (item) => item.type === 'asset' && item.fileName.endsWith('.css'),
          )
          .map((item) => String(item.source))
          .join('\n')
        const hash = createHash('sha256').update(js).digest('base64')
        const policy = `default-src 'none'; worker-src blob:; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'`
        const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${policy}"><title>hibi documentation</title><style>${css}</style></head><body><div id="root"></div><script id="workspace-data" type="application/json">__HIBI_WORKSPACE_DATA__</script><script>${js}</script><!-- bundled licenses\n${licenses}\n--></body></html>`
        for (const key of Object.keys(bundle)) delete bundle[key]
        this.emitFile({
          type: 'asset',
          fileName: 'template.next.html',
          source: html,
        })
      },
      async writeBundle() {
        await rename(
          resolve('out/site/template.next.html'),
          resolve('out/site/template.html'),
        )
        process.send?.({ ready: true })
      },
    },
  ],
  build: {
    outDir: resolve('out/site'),
    emptyOutDir: !watching,
    lib: {
      entry: resolve('src/site/bootstrap.tsx'),
      formats: ['iife'],
      name: 'HibiDocumentation',
    },
    cssCodeSplit: false,
    watch: watching ? {} : null,
  },
})
if (watching && 'close' in result) {
  process.once('SIGTERM', () => {
    void result.close().then(() => process.exit())
  })
  process.once('SIGINT', () => {
    void result.close().then(() => process.exit())
  })
}
