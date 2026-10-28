import {
  flavorInfo as github,
  parser as githubParser,
} from '../../addons/markdown/github-flavor-info.ts'
import { detector as math } from '../../addons/math/syntax.ts'
import { detector as textExtras } from '../../addons/text-extras/syntax.ts'
import { detector as typst } from '../../addons/typst/syntax.ts'
import { hasFootnoteDefinitions } from '../../shared/markdown-footnotes.ts'
import { blockMarkdown } from '../../shared/marked-blocks.ts'

for (const parser of [githubParser, math, textExtras, typst])
  parser.use(blockMarkdown)

const detectGithub = github.detect
github.detect = (source) =>
  hasFootnoteDefinitions(source, blockMarkdown) || detectGithub(source)

export * from './slash-availability.ts'
