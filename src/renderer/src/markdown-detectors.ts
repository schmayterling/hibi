import { Marked } from 'marked'
import { parser as github } from '../../addons/markdown/github-flavor-info.ts'
import { detector as math } from '../../addons/math/syntax.ts'
import { detector as textExtras } from '../../addons/text-extras/syntax.ts'
import { detector as typst } from '../../addons/typst/syntax.ts'
import { footnoteGrammar } from '../../shared/markdown-footnotes.ts'
import { BlockTokenizer, blockMarkdown } from '../../shared/marked-blocks.ts'
import { markedGithubFootnote } from '../../shared/marked-footnotes.ts'

footnoteGrammar.push(blockMarkdown)

for (const parser of [math, textExtras, typst]) {
  const lexer = parser.lexer.bind(parser)
  parser.lexer = (source, options) =>
    lexer(source, {
      ...parser.defaults,
      ...options,
      tokenizer: new BlockTokenizer(),
    })
}

github.lexer = (source, options) =>
  new Marked({ gfm: true }, markedGithubFootnote(), blockMarkdown).lexer(
    source,
    options,
  )
