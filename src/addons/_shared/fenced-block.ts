import { Lexer, Tokenizer } from 'marked'

/** Use Marked's fence parser so indentation, long fences, and raw source round-trip. */
export function fencedBlock(language: string, type: string) {
  // The lexer only installs Marked's rules; each call reads one fence, never
  // the rest of the note.
  const tokenizer = new Tokenizer()
  new Lexer({ tokenizer })
  return (source: string) => {
    const token = tokenizer.fences(source)
    if (token?.lang?.toLowerCase() !== language) return
    return { type, raw: token.raw, source: token.text }
  }
}
/** Marked already ends a paragraph at a fence line, where the block is tried
 * next. A search here would read the rest of the note for every paragraph, and
 * could split a line such as x```mermaid. */
export const fencedBlockStart = () => -1
export function fenceSource(language: string, source: string) {
  const ticks = '`'.repeat(
    Math.max(
      3,
      ...Array.from(source.matchAll(/`+/g), (match) => match[0].length + 1),
    ),
  )
  return `${ticks}${language}\n${source}\n${ticks}`
}
