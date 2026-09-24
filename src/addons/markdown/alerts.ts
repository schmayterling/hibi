import { Lexer, type MarkedExtension, Tokenizer } from 'marked'

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
export function alertMarker(text: string) {
  return /^\[!([a-z][a-z0-9-]*)\]([+-]?)[ \t]*([^\n]*)(?:\n|$)/i.exec(text)
}
export function alertStart(source: string) {
  return source.includes('[!')
    ? source.search(/^ {0,3}>[ \t]*\[![a-z][a-z0-9-]*\]/im)
    : -1
}

export function alertToken(source: string) {
  if (!/^ {0,3}>[ \t]*\[!/i.test(source)) return
  // Use Markdown's own quote boundaries, including lazy continuation and nested blocks.
  const tokenizer = new Tokenizer()
  new Lexer({ gfm: true, tokenizer })
  const quote = tokenizer.blockquote(source)
  const marker = quote && alertMarker(quote.text)
  if (!quote || !marker) return
  return {
    type: 'githubAlert',
    raw: quote.raw,
    alertType: marker[1]!.toLowerCase(),
    fold: marker[2],
    title: marker[3]?.trim() ?? '',
    text: quote.text.slice(marker[0].length),
  }
}

export const alertMarkdown: MarkedExtension = {
  extensions: [
    {
      name: 'githubAlert',
      level: 'block',
      tokenizer(source) {
        const token = alertToken(source)
        if (token)
          return { ...token, tokens: this.lexer.blockTokens(token.text) }
      },
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
