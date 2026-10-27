import { Lexer, marked, type Token, Tokenizer, type TokensList } from 'marked'

/**
 * A reference label as the tokenizer matches it to definitions: whitespace
 * runs as one space, trimmed and case folded.
 */
export const referenceLabel = (label: string) =>
  label.replace(/\s+/g, ' ').trim().toLowerCase().toUpperCase().toLowerCase()

/**
 * Let the existing tokenizer normalize reference labels and distinguish images.
 * With `gfm`, a bare URL such as `www.example.com` is a link too.
 */
export function markdownLink(
  source: string,
  gfm = false,
): { href: string } | { label: string } | null {
  const labels = new WeakMap<Token, string>()
  class LinkTokenizer extends Tokenizer {
    override reflink(source: string, _links: TokensList['links']) {
      let label: string | undefined
      const links = new Proxy(Object.create(null), {
        get: (_target, name) => {
          if (typeof name !== 'string') return undefined
          label = name
          return { href: '', title: null }
        },
      })
      const token = super.reflink(source, links)
      if (token?.type === 'link' && label !== undefined)
        labels.set(token, label)
      return token
    }
  }
  const lexer = new Lexer({ gfm, tokenizer: new LinkTokenizer() })
  let target: { href: string } | { label: string } | null = null
  marked.walkTokens(lexer.inlineTokens(source), (token) => {
    if (token.type !== 'link' || target) return
    const label = labels.get(token)
    target = label === undefined ? { href: token.href } : { label }
  })
  return target
}
