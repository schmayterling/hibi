import type { Token } from 'marked'

const voidTags = new Set(
  'area base br col embed hr img input link meta param source track wbr'.split(
    ' ',
  ),
)

/** Keep paired inline HTML together without sending workspace markup to a DOM parser. */
export function preserveInlineHtml(tokens: Token[]) {
  if (!tokens.some((token) => token?.type === 'html' && !token.block))
    return tokens
  const stack: { name: string; index: number }[] = []
  const ends = new Map<number, number>()
  for (const [index, token] of tokens.entries()) {
    if (token.type !== 'html' || token.block) continue
    const tag = /^<(\/?)([a-z][\w:-]*)\b/i.exec(token.raw)
    if (!tag?.[2]) continue
    const name = tag[2].toLowerCase()
    if (tag[1]) {
      const start = stack.at(-1)
      if (start?.name === name) {
        stack.pop()
        ends.set(start.index, index)
      } else stack.length = 0
    } else if (!voidTags.has(name) && !/\/>$/.test(token.raw))
      stack.push({ name, index })
  }
  const result: Token[] = []
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] as Token
    if (token.type !== 'html' || token.block) {
      result.push(token)
      continue
    }
    const end = ends.get(index) ?? index
    const raw = tokens
      .slice(index, end + 1)
      .map((part) => part.raw)
      .join('')
    result.push({ type: 'rawHtmlInline', raw, text: raw })
    index = end
  }
  tokens.length = 0
  for (const token of result) tokens.push(token)
  return tokens
}
