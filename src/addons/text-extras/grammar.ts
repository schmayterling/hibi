import { Marked, type MarkedExtension, type Token } from 'marked'
import { inlineStart } from '../../shared/marked-inline-start.ts'
import { blockStart } from '../_shared/block-start.ts'
import { textExtrasDetection } from './flavor-info.ts'

export function subscriptToken(source: string) {
  const match = /^~(?!~)([^\s~](?:[^~\n]*?[^\s~])?)~(?!~)/.exec(source)
  return match && { type: 'subscript', raw: match[0], text: match[1]! }
}
export function subtextToken(source: string) {
  const match = /^-# ([^\n]*)(?:\n|$)/.exec(source)
  return match && { type: 'subtext', raw: match[0], text: match[1]! }
}
export const subtextStart = blockStart(/-# /)
/** Strong emphasis that stays bold where `__text__` would be underline. */
const bold = new WeakSet<Token>()
export function keepBold(token: Token) {
  bold.add(token)
}
/**
 * Whether a token is `__text__`, which is underline instead of bold. It
 * stays Marked's strong emphasis, so every tokenizer reads it by the same
 * rules. Runs of three or more underscores keep their meaning, like
 * `___bold italic___`, whose strong emphasis Marked reads on its own as
 * `__bold italic__`: ask about a token before the tokens inside it.
 */
export function underlineToken(token: Token) {
  if (token.type !== 'strong' && token.type !== 'em') return false
  if (token.raw.startsWith('___')) {
    const inner = token.tokens?.[0]
    if (inner && inner.raw === token.text) bold.add(inner)
    return false
  }
  return (
    token.type === 'strong' && token.raw.startsWith('__') && !bold.has(token)
  )
}
export const textExtrasMarkdown: MarkedExtension = {
  extensions: [
    {
      name: 'strong',
      renderer(token) {
        return underlineToken(token as Token)
          ? `<u>${this.parser.parseInline(token.tokens ?? [])}</u>`
          : false
      },
    },
    {
      // Seen before the strong emphasis inside a run of three underscores.
      name: 'em',
      renderer(token) {
        underlineToken(token as Token)
        return false
      },
    },
    {
      name: 'subscript',
      level: 'inline',
      ...inlineStart('~', function (source) {
        const token = subscriptToken(source)
        if (token)
          return { ...token, tokens: this.lexer.inlineTokens(token.text) }
      }),
      renderer(token) {
        return `<sub>${this.parser.parseInline(token.tokens ?? [])}</sub>`
      },
    },
    {
      name: 'subtext',
      level: 'block',
      start: subtextStart,
      tokenizer(source) {
        const token = subtextToken(source)
        if (token)
          return { ...token, tokens: this.lexer.inlineTokens(token.text) }
      },
      renderer(token) {
        return `<p class="markdown-subtext">${this.parser.parseInline(token.tokens ?? [])}</p>\n`
      },
    },
  ],
}
export const detector = new Marked(textExtrasMarkdown)
export function detectTextExtras(source: string) {
  if (!/~|-#|__/.test(source)) return false
  let found = false
  detector.walkTokens(detector.lexer(source), (token) => {
    found ||=
      token.type === 'subscript' ||
      token.type === 'subtext' ||
      underlineToken(token)
  })
  return found
}
textExtrasDetection.read = detectTextExtras
