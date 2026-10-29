// Run outside CI: node --expose-gc scripts/probe-quote-parsing.mjs [MiB=50] [source-root] [shape] [export|count]
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Marked } from 'marked'

const size = Number(process.argv[2] ?? 50)
if (!Number.isFinite(size) || size <= 0) throw new Error('MiB must be positive')
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
}
const chosenShape = process.argv[4]
const chosenOperation = process.argv[5]
if (chosenShape && !(chosenShape in shapes))
  throw new Error('Unknown quote shape')
if (chosenOperation && !['export', 'count'].includes(chosenOperation))
  throw new Error('Unknown operation')
for (const [shape, unit] of Object.entries(shapes)) {
  if (chosenShape && chosenShape !== shape) continue
  const source = unit.repeat(Math.ceil((size * 1024 * 1024) / unit.length))
  for (const operation of ['export', 'count']) {
    if (chosenOperation && chosenOperation !== operation) continue
    globalThis.gc?.()
    const start = performance.now()
    blockScanCounters.units = 0
    blockScanCounters.quoteLines = 0
    let result
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
      result = {
        html: html.length,
        headings: (html.match(/<h\d/g) ?? []).length,
      }
    } else {
      result = countText(richText(source, syntax))
    }
    console.log(
      JSON.stringify({
        root,
        shape,
        operation,
        bytes: source.length,
        ms: Math.round(performance.now() - start),
        scanUnits: blockScanCounters.units,
        quoteLines: blockScanCounters.quoteLines,
        maxRssKiB: process.resourceUsage().maxRSS,
        result,
      }),
    )
  }
}
