import { Marked, type MarkedExtension } from 'marked'
import { blockStart } from '../_shared/block-start.ts'

export function subscriptToken(source: string) {
  const match = /^~(?!~)([^\s~](?:[^~\n]*?[^\s~])?)~(?!~)/.exec(source)
  return match && { type: 'subscript', raw: match[0], text: match[1]! }
}
export function subtextToken(source: string) {
  const match = /^-# ([^\n]*)(?:\n|$)/.exec(source)
  return match && { type: 'subtext', raw: match[0], text: match[1]! }
}
export const subtextStart = blockStart(/-# /)
export const textExtrasMarkdown: MarkedExtension = {
  extensions: [
    {
      name: 'subscript',
      level: 'inline',
      start: (source) => source.indexOf('~'),
      tokenizer(source) {
        const token = subscriptToken(source)
        if (token)
          return { ...token, tokens: this.lexer.inlineTokens(token.text) }
      },
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
const detector = new Marked(textExtrasMarkdown)
export function detectTextExtras(source: string) {
  if (!source.includes('~') && !source.includes('-#')) return false
  let found = false
  detector.walkTokens(detector.lexer(source), (token) => {
    if (token.type === 'subscript' || token.type === 'subtext') found = true
    return []
  })
  return found
}
