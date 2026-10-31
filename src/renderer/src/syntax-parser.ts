import type { Marked, Token } from 'marked'
import { escapeCode } from './code-languages.ts'
import { markdownSyntax } from './markdown-syntax.ts'

export function preserveDisabled(token: Token) {
  const feature = markdownSyntax.disabledFeature(token)
  // Marked concatenates callback results; [] avoids copying growing undefined arrays.
  if (!feature) return []
  Object.assign(token, {
    type: feature.level === 'block' ? 'hibiLiteralBlock' : 'hibiLiteralInline',
    text: feature.level === 'block' ? token.raw.replace(/\n+$/, '') : token.raw,
    tokens: [],
  })
  return []
}

/** Disabled syntax exports as written, on Marked's exported HTML path. */
export function installSyntaxPreferences(parser: Marked) {
  const BaseLexer = parser.Lexer
  class SyntaxLexer<
    ParserOutput = string,
    RendererOutput = string,
  > extends BaseLexer<ParserOutput, RendererOutput> {
    lex(source: string) {
      const tokens = super.lex(source)
      parser.walkTokens(tokens, preserveDisabled)
      return tokens
    }
  }
  parser.Lexer = SyntaxLexer
  parser.use({
    walkTokens(token) {
      preserveDisabled(token)
    },
    extensions: [
      {
        name: 'hibiLiteralBlock',
        renderer: (token) =>
          `<div class="hibi-literal-block">${escapeCode(String(token.text))}</div>\n`,
      },
      {
        name: 'hibiLiteralInline',
        renderer: (token) =>
          `<span class="hibi-literal-inline">${escapeCode(String(token.text))}</span>`,
      },
    ],
  })
  return parser
}
