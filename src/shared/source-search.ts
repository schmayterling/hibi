import { foldSearchText } from './search-fold.ts'
import type { SourceSnapshot } from './source-buffer.ts'
import { normalizedChunks } from './source-projection.ts'

export type SourceMatch = Readonly<{
  from: number
  to: number
  precise: boolean
}>
export type SearchProgress = Readonly<{
  /** Normalized editor coordinates; map through the exact source snapshot before editing. */
  matches: readonly SourceMatch[]
  scanned: number
  total: number
}>
export type LiteralSearchOptions = { caseSensitive?: boolean; from?: number }

/** Linear, chunked literal search with CodeMirror's NFKD/case and non-overlap semantics. */
export function* searchSourceLiteral(
  source: SourceSnapshot,
  query: string,
  options: LiteralSearchOptions = {},
): Generator<SearchProgress, { scanned: number; total: number }> {
  if (typeof query !== 'string' || query.length > 65536)
    throw new Error('Find text exceeds the 65,536-character limit.')
  const normalize = options.caseSensitive
    ? (text: string) => text.normalize('NFKD')
    : (text: string) => foldSearchText(text.normalize('NFKD'))
  const needle = normalize(query)
  if (needle.length > 65536)
    throw new Error('Normalized find text exceeds the 65,536-character limit.')
  if (!needle) return { scanned: 0, total: 0 }
  const begin = options.from ?? 0,
    rawBegin = source.editorToRaw(begin)
  if (rawBegin === null || !source.isEditBoundary(rawBegin))
    throw new Error('Find starts outside a complete source character.')
  const failure = new Uint32Array(needle.length)
  for (let index = 1, prefix = 0; index < needle.length; index++) {
    while (prefix && needle[index] !== needle[prefix])
      prefix = failure[prefix - 1]!
    if (needle[index] === needle[prefix]) prefix++
    failure[index] = prefix
  }
  // Only query-length provenance is retained. No per-document-character map.
  const starts = new Float64Array(needle.length),
    exact = new Uint8Array(needle.length)
  let matched = 0,
    fed = 0,
    position = begin,
    total = 0,
    lastYield = begin,
    carry = ''
  let matches: SourceMatch[] = []
  function* chunks(from: number) {
    for (const chunk of normalizedChunks(source, from)) {
      let text = carry + chunk
      carry = ''
      if (/[\uD800-\uDBFF]$/.test(text)) {
        carry = text.slice(-1)
        text = text.slice(0, -1)
      }
      if (text) yield text
    }
    if (carry) yield carry
  }
  for (const chunk of chunks(rawBegin)) {
    for (const character of chunk) {
      const folded = normalize(character)
      let from = position,
        precise = true
      for (let index = 0; index < folded.length; index++) {
        const code = folded.charCodeAt(index),
          slot = fed % needle.length
        starts[slot] = from
        exact[slot] = Number(precise)
        fed++
        while (matched && needle.charCodeAt(matched) !== code)
          matched = failure[matched - 1]!
        if (needle.charCodeAt(matched) === code) matched++
        if (matched === needle.length) {
          const first = (fed - needle.length) % needle.length
          matches.push(
            Object.freeze({
              from: starts[first]!,
              to: position + character.length,
              precise: !!exact[first] && index === folded.length - 1,
            }),
          )
          total++
          matched = 0
          // SearchCursor.next advances past the entire original scalar,
          // including a remainder of an expanded character after a match.
          break
        }
        if (
          precise &&
          index < character.length &&
          character.charCodeAt(index) === code
        )
          from++
        else precise = false
      }
      position += character.length
      if (matches.length >= 128 || position - lastYield >= 8192) {
        yield Object.freeze({
          matches: Object.freeze(matches),
          scanned: position,
          total,
        })
        matches = []
        lastYield = position
      }
    }
  }
  if (matches.length || position !== lastYield)
    yield Object.freeze({
      matches: Object.freeze(matches),
      scanned: position,
      total,
    })
  return { scanned: position, total }
}
