import {
  flavorInfo as github,
  parser as githubParser,
} from '../../addons/markdown/github-flavor-info.ts'
import { detector as math } from '../../addons/math/syntax.ts'
import { detector as textExtras } from '../../addons/text-extras/syntax.ts'
import { detector as typst } from '../../addons/typst/syntax.ts'
import { hasFootnoteDefinitions } from '../../shared/markdown-footnotes.ts'
import { BlockTokenizer, blockMarkdown } from '../../shared/marked-blocks.ts'

for (const parser of [githubParser, math, textExtras, typst]) {
  const lexer = parser.lexer.bind(parser)
  parser.lexer = (source, options) =>
    lexer(source, {
      ...parser.defaults,
      ...options,
      tokenizer: new BlockTokenizer(),
    })
}

const detectGithub = github.detect
github.detect = (source) =>
  hasFootnoteDefinitions(source, blockMarkdown) || detectGithub(source)

export * from './slash-availability.ts'
