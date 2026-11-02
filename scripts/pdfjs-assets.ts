import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Plugin } from 'vite'

const root = resolve('node_modules/pdfjs-dist')

// pdf.js loads these at run time by name, so they can't be hashed bundle assets.
// The WebAssembly builds stay out: the app's policy has no 'wasm-unsafe-eval',
// so the viewer uses pdf.js's script versions of the same decoders instead.
function shipped() {
  const files: string[] = []
  for (const name of readdirSync(resolve(root, 'standard_fonts')))
    files.push(`standard_fonts/${name}`)
  // Predefined CMaps map character codes for CJK fonts a file does not embed.
  for (const name of readdirSync(resolve(root, 'cmaps')))
    files.push(`cmaps/${name}`)
  for (const name of readdirSync(resolve(root, 'wasm')))
    if (/_nowasm_fallback\.js$/.test(name) || name.startsWith('LICENSE'))
      files.push(`wasm/${name}`)
  return files
}

/** Ships the pdf.js decoders, font data and CMaps the PDF viewer loads by URL. */
export function pdfjsAssets(): Plugin {
  const files = shipped()
  return {
    name: 'pdfjs-assets',
    generateBundle() {
      for (const file of files)
        this.emitFile({
          type: 'asset',
          fileName: `pdfjs/${file}`,
          source: readFileSync(resolve(root, file)),
        })
    },
    configureServer(server) {
      server.middlewares.use('/pdfjs', (request, response, next) => {
        const file = decodeURIComponent(
          (request.url ?? '').split('?')[0] ?? '',
        ).replace(/^\//, '')
        if (!files.includes(file)) return next()
        response.setHeader(
          'Content-Type',
          file.endsWith('.js')
            ? 'text/javascript; charset=utf-8'
            : 'application/octet-stream',
        )
        response.end(readFileSync(resolve(root, file)))
      })
    },
  }
}
