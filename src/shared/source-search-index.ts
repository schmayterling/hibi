import type { RenderedTextIndex } from './rendered-text.ts'
import {
  acceptedStorageChange,
  type SourceSnapshot,
  type SourceStorageChange,
} from './source-buffer.ts'
import {
  renderedMatch,
  searchRenderedLiteral,
} from './source-rendered-search.ts'
import {
  type LiteralSearchOptions,
  literalSearchQuery,
  type SourceMatch,
  searchSourceLiteral,
} from './source-search.ts'

type RankedMatch = Readonly<{ match: SourceMatch; rank: number }>
export type SearchViewport = Readonly<{
  from: number
  to: number
  limit?: number
}>
export type SearchHighlights = Readonly<{
  matches: readonly SourceMatch[]
  next: number | null
}>
export type SearchLocation = Readonly<{
  current: number
  total: number
  previous: RankedMatch | null
  next: RankedMatch | null
}>

/** Sparse restart points retain rank without retaining every match. */
export class SourceSearchIndex {
  #source: SourceSnapshot
  readonly #query: string
  readonly #options: LiteralSearchOptions
  readonly #rendered: RenderedTextIndex | undefined
  readonly #checkpoints: RankedMatch[] = []
  readonly #highlightStarts: number[] = [0]
  #first: RankedMatch | null = null
  #last: RankedMatch | null = null
  #total = 0
  #complete = false
  constructor(
    source: SourceSnapshot,
    query: string,
    options: LiteralSearchOptions = {},
    rendered?: RenderedTextIndex,
  ) {
    this.#source = source
    this.#query = query
    this.#options = { caseSensitive: options.caseSensitive ?? false }
    this.#rendered = rendered
  }
  adoptStorage(change: SourceStorageChange) {
    if (!acceptedStorageChange(change) || change.before !== this.#source)
      throw new Error('Find storage change is stale or untrusted.')
    this.#source = change.after
    this.#rendered?.adoptSource(change.after)
  }
  state() {
    return Object.freeze({
      total: this.#total,
      complete: this.#complete,
      first: this.#first,
      last: this.#last,
      checkpoints: this.#checkpoints.length,
    })
  }
  highlightStarts(): readonly number[] {
    return this.#highlightStarts
  }
  *#search(
    options: LiteralSearchOptions & { details?: boolean } = this.#options,
  ) {
    return yield* this.#rendered
      ? searchRenderedLiteral(this.#rendered, this.#query, options)
      : searchSourceLiteral(this.#source, this.#query, options)
  }
  *build() {
    if (this.#complete) return this.state()
    const query = literalSearchQuery(this.#query, this.#options.caseSensitive)
    if (this.#rendered && query)
      for (const _step of this.#rendered.build())
        yield Object.freeze({ scanned: 0, total: 0 })
    this.#checkpoints.length = 0
    this.#total = 0
    this.#first = this.#last = null
    this.#highlightStarts.length = 1
    const margin = query.length * 2
    let highlightScan = 0
    for (const batch of this.#search({ ...this.#options, details: false })) {
      for (const match of batch.matches) {
        const ranked = Object.freeze({ match, rank: ++this.#total })
        this.#first ??= ranked
        this.#last = ranked
        if (this.#total % 1024 === 0) this.#checkpoints.push(ranked)
      }
      if (batch.scanned - highlightScan >= 8192) {
        // Restart after the last match, retaining any unfinished query prefix.
        let from =
          batch.restart ??
          Math.max(this.#last?.match.to ?? 0, batch.scanned - margin)
        const raw = this.#source.editorToRaw(from)!
        if (!this.#source.isEditBoundary(raw)) from--
        this.#highlightStarts.push(from)
        highlightScan = batch.scanned
      }
      yield Object.freeze({ scanned: batch.scanned, total: this.#total })
    }
    this.#complete = true
    return this.state()
  }
  *replacement(from: number, to: number, text: string) {
    if (this.#rendered) {
      for (const batch of this.#search({
        ...this.#options,
        from,
        details: false,
      })) {
        for (const match of batch.matches) {
          if (match.from !== from || match.to !== to)
            return { from, to, text, edits: null }
          const detailed = yield* renderedMatch(this.#rendered, match)
          return yield* this.#rendered.prepareReplacement(detailed, text)
        }
        yield
      }
    }
    return { from, to, text, edits: null }
  }
  *highlights(viewport: SearchViewport): Generator<void, SearchHighlights> {
    if (!this.#complete) throw new Error('Find coverage is incomplete.')
    const { from, to, limit = 512 } = viewport
    if (
      !Number.isSafeInteger(from) ||
      !Number.isSafeInteger(to) ||
      from < 0 ||
      to < from ||
      to > this.#source.normalizedLength ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 512
    )
      throw new Error('Find selection is outside its source snapshot.')
    let lo = 0,
      hi = this.#highlightStarts.length
    while (lo < hi) {
      const middle = (lo + hi) >>> 1
      if (this.#highlightStarts[middle]! <= from) lo = middle + 1
      else hi = middle
    }
    const matches: SourceMatch[] = []
    for (const batch of this.#search({
      ...this.#options,
      details: false,
      from: this.#highlightStarts[Math.max(0, lo - 1)]!,
    })) {
      for (const match of batch.matches) {
        if (match.from >= to) return { matches, next: null }
        if (match.to <= from) continue
        if (matches.length === limit) return { matches, next: match.from }
        matches.push(match)
      }
      yield
    }
    return { matches, next: null }
  }
  *locate(from: number, to: number): Generator<void, SearchLocation> {
    if (!this.#complete) throw new Error('Find coverage is incomplete.')
    if (
      !Number.isSafeInteger(from) ||
      !Number.isSafeInteger(to) ||
      from < 0 ||
      to < from ||
      to > this.#source.normalizedLength
    )
      throw new Error('Find selection is outside its source snapshot.')
    let lo = 0,
      hi = this.#checkpoints.length
    while (lo < hi) {
      const middle = Math.floor((lo + hi) / 2)
      if (this.#checkpoints[middle]!.match.to <= from) lo = middle + 1
      else hi = middle
    }
    const checkpoint = lo ? this.#checkpoints[lo - 1]! : null
    let rank = checkpoint?.rank ?? 0,
      current = 0,
      previous = checkpoint,
      next: RankedMatch | null = null
    for (const batch of this.#search({
      ...this.#options,
      details: false,
      from: checkpoint?.match.to ?? 0,
    })) {
      for (const match of batch.matches) {
        const ranked = Object.freeze({ match, rank: ++rank })
        if (match.to <= from) previous = ranked
        if (match.from === from && match.to === to) current = rank
        if (match.from >= to) {
          next = ranked
          break
        }
      }
      yield
      if (next) break
    }
    previous ??= this.#last
    next ??= this.#first
    if (this.#rendered) {
      if (previous)
        previous = {
          ...previous,
          match: yield* renderedMatch(this.#rendered, previous.match),
        }
      if (next)
        next = {
          ...next,
          match: yield* renderedMatch(this.#rendered, next.match),
        }
    }
    return Object.freeze({
      current,
      total: this.#total,
      previous: previous ?? this.#last,
      next: next ?? this.#first,
    })
  }
}
