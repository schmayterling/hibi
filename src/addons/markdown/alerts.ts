import { Lexer, type MarkedExtension, Tokenizer } from 'marked'
import { blockContainers } from '../../shared/marked-blocks.ts'
import { quoteBlock, quoteReader } from '../../shared/marked-leaf-blocks.ts'
import { blockStart } from '../_shared/block-start.ts'
import { alertMarker } from './alert-marker.ts'

export { alertMarker } from './alert-marker.ts'

export const alertTypes = [
  'note',
  'tip',
  'important',
  'warning',
  'caution',
] as const
export function alertType(value: unknown): string | undefined {
  const type = typeof value === 'string' ? value.toLowerCase() : ''
  return /^[a-z][a-z0-9-]{0,39}$/.test(type) ? type : undefined
}
export const alertStart = blockStart(/ {0,3}>[ \t]*\[![a-zA-Z][a-zA-Z0-9-]*\]/)

export function alertToken(source: string) {
  if (!/^ {0,3}>[ \t]*\[!/i.test(source)) return
  // Use Markdown's own quote boundaries, including lazy continuation and nested blocks.
  const tokenizer = new Tokenizer()
  new Lexer({ gfm: true, tokenizer })
  const quote = tokenizer.blockquote(source)
  const marker = quote && alertMarker(quote.text)
  if (!quote || !marker) return
  return quoteBlock(
    {
      type: 'githubAlert',
      raw: quote.raw,
      alertType: marker[1]!.toLowerCase(),
      fold: marker[2],
      title: marker[3]?.trim() ?? '',
      text: quote.text.slice(marker[0].length),
    },
    quote.text,
  )
}

export const alertMarkdown: MarkedExtension = {
  tokenizer: blockContainers,
  extensions: [
    {
      name: 'githubAlert',
      level: 'block',
      tokenizer: quoteReader(function (source) {
        const token = alertToken(source)
        if (token) {
          const { text } = token
          const quote = { ...token, tokens: this.lexer.blockTokens(text) }
          return quoteBlock(quote, token)
        }
      }),
      renderer(token) {
        const type = alertType(token.alertType) ?? 'note'
        const title = String(token.title || type).replace(
          /[&<>"']/g,
          (character) =>
            ({
              '&': '&amp;',
              '<': '&lt;',
              '>': '&gt;',
              '"': '&quot;',
              "'": '&#39;',
            })[character] ?? character,
        )
        return `<blockquote class="github-alert" data-alert="${type}" data-fold="${token.fold ?? ''}"><p class="github-alert-title">${title}</p><div class="github-alert-body">${this.parser.parse(token.tokens ?? [])}</div></blockquote>\n`
      },
    },
  ],
}
