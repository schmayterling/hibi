import type {
  RenderedContainer,
  RenderedMatchContext,
  RenderedRange,
} from './rendered-text.ts'
import { foldSearchText } from './search-fold.ts'
import type { SourceSnapshot } from './source-buffer.ts'
import { normalizedChunks } from './source-projection.ts'

export type SourceMatch = Readonly<{
  from: number
  to: number
  precise: boolean
  segments?: readonly RenderedRange[]
  containers?: readonly RenderedContainer[]
  context?: RenderedMatchContext
}>
export type SearchProgress = Readonly<{
  /** Normalized editor coordinates; map through the exact source snapshot before editing. */
  matches: readonly SourceMatch[]
  scanned: number
  total: number
  /** Exact rendered restart phase before an unfinished query prefix. */
  restart?: number
}>
export type LiteralSearchOptions = { caseSensitive?: boolean; from?: number }

export function literalSearchQuery(
  query: string,
  caseSensitive = false,
): string {
  if (typeof query !== 'string' || query.length > 65536)
    throw new Error('Find text exceeds the 65,536-character limit.')
  const normalized = query.normalize('NFKD')
  const needle = caseSensitive ? normalized : foldSearchText(normalized)
  if (needle.length > 65536)
    throw new Error('Normalized find text exceeds the 65,536-character limit.')
  return needle
}

/** Both source and rendered search use the same folding, failure table and non-overlap phase. */
export class LiteralSearchMatcher {
  readonly needle: string
  readonly #normalize: (text: string) => string
  readonly #failure: Uint32Array
  readonly #starts: Float64Array
  readonly #ends: Float64Array | null
  readonly #exact: Uint8Array
  #matched = 0
  #fed = 0
  constructor(query: string, caseSensitive = false, provenance = false) {
    this.#normalize = caseSensitive
      ? (text) => text.normalize('NFKD')
      : (text) => foldSearchText(text.normalize('NFKD'))
    this.needle = literalSearchQuery(query, caseSensitive)
    this.#failure = new Uint32Array(this.needle.length)
    for (let index = 1, prefix = 0; index < this.needle.length; index++) {
      while (prefix && this.needle[index] !== this.needle[prefix])
        prefix = this.#failure[prefix - 1]!
      if (this.needle[index] === this.needle[prefix]) prefix++
      this.#failure[index] = prefix
    }
    this.#starts = new Float64Array(this.needle.length)
    this.#exact = new Uint8Array(this.needle.length)
    this.#ends = provenance ? new Float64Array(this.needle.length) : null
  }
  reset() {
    this.#matched = 0
  }
  restart(): number | undefined {
    return this.#matched
      ? this.#starts[(this.#fed - this.#matched) % this.needle.length]
      : undefined
  }
  feed(
    character: string,
    start: number,
    end: number,
    atom?: { first: boolean; last: boolean },
  ): SourceMatch | null {
    const folded = this.#normalize(character)
    let from = start,
      precise = atom?.first ?? true
    for (let index = 0; index < folded.length; index++) {
      const code = folded.charCodeAt(index),
        slot = this.#fed % this.needle.length
      this.#starts[slot] = from
      this.#exact[slot] = Number(precise)
      if (this.#ends) this.#ends[slot] = end
      this.#fed++
      while (this.#matched && this.needle.charCodeAt(this.#matched) !== code)
        this.#matched = this.#failure[this.#matched - 1]!
      if (this.needle.charCodeAt(this.#matched) === code) this.#matched++
      if (this.#matched === this.needle.length) {
        const first = (this.#fed - this.needle.length) % this.needle.length
        const segments: RenderedRange[] | undefined = this.#ends
          ? []
          : undefined
        if (this.#ends && segments) {
          for (let at = 0; at < this.needle.length; at++) {
            const offset = (first + at) % this.needle.length
            const range = {
              from: this.#starts[offset]!,
              to: this.#ends[offset]!,
            }
            const previous = segments.at(-1)
            if (previous && range.from <= previous.to)
              segments[segments.length - 1] = {
                from: previous.from,
                to: Math.max(previous.to, range.to),
              }
            else segments.push(range)
          }
        }
        this.#matched = 0
        // SearchCursor.next advances past the entire original scalar.
        return Object.freeze({
          from: this.#starts[first]!,
          to: end,
          precise:
            !!this.#exact[first] &&
            index === folded.length - 1 &&
            (atom?.last ?? true),
          ...(segments ? { segments: Object.freeze(segments) } : {}),
        })
      }
      if (
        !atom &&
        precise &&
        index < character.length &&
        character.charCodeAt(index) === code
      )
        from++
      else precise = false
    }
    return null
  }
}

/** Linear, chunked literal search with CodeMirror's NFKD/case and non-overlap semantics. */
export function* searchSourceLiteral(
  source: SourceSnapshot,
  query: string,
  options: LiteralSearchOptions = {},
): Generator<SearchProgress, { scanned: number; total: number }> {
  const matcher = new LiteralSearchMatcher(query, options.caseSensitive)
  if (!matcher.needle) return { scanned: 0, total: 0 }
  const begin = options.from ?? 0,
    rawBegin = source.editorToRaw(begin)
  if (rawBegin === null || !source.isEditBoundary(rawBegin))
    throw new Error('Find starts outside a complete source character.')
  let position = begin,
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
      const match = matcher.feed(
        character,
        position,
        position + character.length,
      )
      if (match) {
        matches.push(match)
        total++
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
