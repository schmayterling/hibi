// Run outside CI: node --expose-gc scripts/probe-quote-parsing.mjs [MiB[,MiB...]=50] [source-root] [shape] [export|count]
import { resolve } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { Marked } from 'marked'

const sizes = (process.argv[2] ?? '50').split(',').map(Number)
if (sizes.some((size) => !Number.isFinite(size) || size <= 0))
  throw new Error('MiB must be positive')
const root = resolve(process.argv[3] ?? '.')
const load = (path) => import(pathToFileURL(`${root}/src/${path}`).href)
const { blockMarkdown, blockScanCounters } = await load(
  'shared/marked-blocks.ts',
)
const { alertMarkdown } = await load('addons/markdown/alerts.ts')
const { mathTokens } = await load('addons/math/syntax.ts')
const { textExtrasMarkdown } = await load('addons/text-extras/syntax.ts')
const { typstTokens } = await load('addons/typst/syntax.ts')
const { markedGithubFootnote } = await load('shared/marked-footnotes.ts')
const { richText } = await load('addons/word-count/formatted-text.ts')
const { countText } = await load('addons/word-count/count.ts')
const { defaultNoteSyntax } = await load('shared/note-syntax.ts')
const syntax = {
  ...defaultNoteSyntax,
  gfm: true,
  alerts: true,
  textExtras: true,
  math: true,
  typst: true,
  mermaid: true,
  disabledFeatures: [],
}

const shapes = {
  giant: '> a\n> $$\n> x\n> $$\n> -# s\n',
  lazy: '> # h\n> p\nlazy\n',
  paragraph: '> p\nlazy\n',
  code: '> p\n    lazy\n',
  list: '> - a\nlazy\n',
}
const chosenShape = process.argv[4]
const chosenOperation = process.argv[5]
if (chosenShape && !(chosenShape in shapes))
  throw new Error('Unknown quote shape')
if (chosenOperation && !['export', 'count'].includes(chosenOperation))
  throw new Error('Unknown operation')

function probe(size, shape, unit, operation) {
  const source = unit.repeat(Math.ceil((size * 1024 * 1024) / unit.length))
  globalThis.gc?.()
  const start = performance.now()
  const cpuStart = process.cpuUsage()
  blockScanCounters.units = 0
  blockScanCounters.quoteLines = 0
  let result
  let parseMs
  let countMs = 0
  let rssAfterParseKiB
  let heapAfterParseKiB
  if (operation === 'export') {
    const parser = new Marked(
      { gfm: true, breaks: false },
      blockMarkdown,
      alertMarkdown,
      markedGithubFootnote(),
      mathTokens,
      textExtrasMarkdown,
      typstTokens,
    )
    // Match export's block grammar without compiling each formula or diagram.
    parser.use({
      extensions: [
        { name: 'blockMath', renderer: (token) => `<m>${token.latex}</m>` },
      ],
    })
    const html = parser.parse(source, { async: false })
    parseMs = performance.now() - start
    result = {
      html: html.length,
      headings: (html.match(/<h\d/g) ?? []).length,
    }
  } else {
    const text = richText(source, syntax)
    parseMs = performance.now() - start
    const memory = process.memoryUsage()
    rssAfterParseKiB = Math.round(memory.rss / 1024)
    heapAfterParseKiB = Math.round(memory.heapUsed / 1024)
    const countStart = performance.now()
    result = countText(text)
    countMs = performance.now() - countStart
  }
  const ms = performance.now() - start
  const cpu = process.cpuUsage(cpuStart)
  return {
    root,
    shape,
    operation,
    bytes: source.length,
    ms: Math.round(ms),
    msPerMiB: Math.round((ms / size) * 100) / 100,
    cpuMs: Math.round((cpu.user + cpu.system) / 1000),
    parseMs: Math.round(parseMs),
    countMs: Math.round(countMs),
    scanUnits: blockScanCounters.units,
    quoteLines: blockScanCounters.quoteLines,
    maxRssKiB: process.resourceUsage().maxRSS,
    rssAfterParseKiB,
    heapAfterParseKiB,
    result,
  }
}

for (const size of sizes) {
  for (const [shape, unit] of Object.entries(shapes)) {
    if (
      chosenShape ? chosenShape !== shape : shape === 'code' || shape === 'list'
    )
      continue
    for (const operation of ['export', 'count']) {
      if (chosenOperation && chosenOperation !== operation) continue
      const row = probe(size, shape, unit, operation)
      // End the probe's stack frame before checking for retained parse data.
      await setImmediate()
      globalThis.gc?.()
      const memory = process.memoryUsage()
      row.rssAfterGcKiB = Math.round(memory.rss / 1024)
      row.heapAfterGcKiB = Math.round(memory.heapUsed / 1024)
      // maxRSS is the process-wide high-water mark, cumulative in a size series.
      row.maxRssKiB = process.resourceUsage().maxRSS
      console.log(JSON.stringify(row))
    }
  }
}
