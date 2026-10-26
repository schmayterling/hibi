import { Lexer, Tokenizer } from 'marked'

/** Use Marked's fence parser so indentation, long fences, and raw source round-trip. */
export function fencedBlock(language: string, type: string) {
  const tokenizer = new Tokenizer()
  new Lexer({ gfm: true, tokenizer })
  return (source: string) => {
    if (!/^ {0,3}(?:`{3,}|~{3,})/.test(source)) return
    const token = tokenizer.fences(source)
    if (!token || token.lang?.toLowerCase() !== language) return
    // Marked folds one following newline into the preceding block's raw text.
    const space = tokenizer.space(source.slice(token.raw.length))
    const raw = token.raw + (space?.raw === '\n' ? '\n' : '')
    return { type, raw, source: token.text }
  }
}
export function fenceSource(language: string, source: string) {
  let width = 3
  for (const match of source.matchAll(/`+/g))
    width = Math.max(width, match[0].length + 1)
  const ticks = '`'.repeat(width)
  return `${ticks}${language}\n${source}\n${ticks}`
}
