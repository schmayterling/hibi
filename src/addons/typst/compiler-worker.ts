import { createHash } from 'node:crypto'
import { join, relative } from 'node:path'
import type { NodeCompiler } from '@myriaddreamin/typst-ts-node-compiler'
import { withinProject } from '../_shared/document-project'
import type { CompileJob } from './compiler'

let compiler: NodeCompiler | null = null
let compilerClass: typeof NodeCompiler | null = null
let previousEntry: string | null = null
let originals = new Map<string, Buffer>()
let fontKey = ''
process.parentPort.on('message', async ({ data }: { data: CompileJob }) => {
  try {
    if (!compilerClass) {
      process.parentPort.postMessage({ phase: 'loading-native' })
      compilerClass = (await import('@myriaddreamin/typst-ts-node-compiler'))
        .NodeCompiler
    }
    const fonts = data.files?.filter(([path]) =>
      /\.(ttf|otf|ttc|otc)$/i.test(path),
    )
    const fontHash = createHash('sha256')
    for (const [path, bytes] of fonts ?? []) fontHash.update(path).update(bytes)
    const nextFontKey = fonts ? fontHash.digest('hex') : fontKey
    if (!compiler || nextFontKey !== fontKey) {
      process.parentPort.postMessage({ phase: 'initializing-fonts' })
      compiler = compilerClass.create({
        workspace: data.sandbox,
        fontArgs: [
          { fontBlobs: fonts?.map(([, bytes]) => Buffer.from(bytes)) ?? [] },
        ],
      })
      fontKey = nextFontKey
    }
    if (data.files) {
      compiler.resetShadow()
      originals = new Map(
        data.files.map(([path, bytes]) => [
          join(data.sandbox, path),
          Buffer.from(bytes),
        ]),
      )
      for (const [path, bytes] of originals) compiler.mapShadow(path, bytes)
      previousEntry = null
    }
    const entry = join(data.sandbox, data.entry)
    if (previousEntry && previousEntry !== entry) {
      const original = originals.get(previousEntry)
      if (original) compiler.mapShadow(previousEntry, original)
      else compiler.unmapShadow(previousEntry)
    }
    previousEntry = entry
    compiler.mapShadow(
      entry,
      Buffer.from(
        data.block
          ? `#set page(width: auto, height: auto, margin: 8pt)\n${data.source}`
          : data.source,
      ),
    )
    process.parentPort.postMessage({ phase: 'compiling' })
    const result = compiler.compile({ mainFilePath: entry, resetRead: true })
    const rawDiagnostics = result.takeDiagnostics()?.shortDiagnostics ?? []
    const missing = rawDiagnostics.flatMap((error) => {
      const path = /^file not found \(searched at (.*)\)$/.exec(
        String(error.message),
      )?.[1]
      return path && withinProject(data.sandbox, path)
        ? [relative(data.sandbox, path)]
        : []
    })
    const diagnostics =
      rawDiagnostics.map((error) => ({
        message: String(error.message).replaceAll(data.sandbox, '.'),
        severity: error.severity === 1 ? 'error' : 'warning',
      })) ?? []
    if (!result.result) process.parentPort.postMessage({ diagnostics, missing })
    else {
      if (result.result.numOfPages > 200)
        throw new Error('Typst previews support up to 200 pages.')
      const svg = compiler.plainSvg(result.result)
      const pdf = data.pdf ? compiler.pdf(result.result) : undefined
      if (
        Buffer.byteLength(svg) > 20 * 1024 * 1024 ||
        (pdf && pdf.byteLength > 64 * 1024 * 1024)
      )
        throw new Error(
          'Typst output exceeds the 20 MiB preview or 64 MiB PDF limit.',
        )
      process.parentPort.postMessage({
        svg,
        pdf,
        pages: result.result.numOfPages,
        diagnostics,
      })
    }
    compiler.evictCache(10)
  } catch (error) {
    process.parentPort.postMessage({
      diagnostics: [
        {
          severity: 'error',
          message:
            error instanceof Error
              ? error.message
              : 'Typst compilation failed.',
        },
      ],
    })
  }
})
