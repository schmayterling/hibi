import { foldSearchText } from './search-fold.ts'
import {
  acceptedStorageChange,
  type SourceSnapshot,
  type SourceStorageChange,
} from './source-buffer.ts'
import {
  type LiteralSearchOptions,
  type SourceMatch,
  searchSourceLiteral,
} from './source-search.ts'

type RankedMatch = Readonly<{ match: SourceMatch; rank: number }>
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
  ) {
    this.#source = source
    this.#query = query
    this.#options = { caseSensitive: options.caseSensitive ?? false }
  }
  adoptStorage(change: SourceStorageChange) {
    if (!acceptedStorageChange(change) || change.before !== this.#source)
      throw new Error('Find storage change is stale or untrusted.')
    this.#source = change.after
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
  *build() {
    if (this.#complete) return this.state()
    this.#checkpoints.length = 0
    this.#total = 0
    this.#first = this.#last = null
    this.#highlightStarts.length = 1
    const query = this.#query.normalize('NFKD')
    const margin =
      (this.#options.caseSensitive ? query : foldSearchText(query)).length * 2
    let highlightScan = 0
    for (const batch of searchSourceLiteral(
      this.#source,
      this.#query,
      this.#options,
    )) {
      for (const match of batch.matches) {
        const ranked = Object.freeze({ match, rank: ++this.#total })
        this.#first ??= ranked
        this.#last = ranked
        if (this.#total % 1024 === 0) this.#checkpoints.push(ranked)
      }
      if (batch.scanned - highlightScan >= 8192) {
        // Restart after the last match, retaining any unfinished query prefix.
        let from = Math.max(this.#last?.match.to ?? 0, batch.scanned - margin)
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
    for (const batch of searchSourceLiteral(this.#source, this.#query, {
      ...this.#options,
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
    return Object.freeze({
      current,
      total: this.#total,
      previous: previous ?? this.#last,
      next: next ?? this.#first,
    })
  }
}
