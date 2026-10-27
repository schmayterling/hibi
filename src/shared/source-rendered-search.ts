import { renderedDeletionRanges } from './rendered-replace.ts'
import type { RenderedContainer, RenderedTextIndex } from './rendered-text.ts'
import {
  LiteralSearchMatcher,
  type LiteralSearchOptions,
  type SearchProgress,
  type SourceMatch,
} from './source-search.ts'

/** Prepare replacement metadata only for a requested navigation result. */
export function* renderedMatch(
  projection: RenderedTextIndex,
  match: SourceMatch,
): Generator<void, SourceMatch> {
  const containers: RenderedContainer[] = []
  for (const container of projection.containers(match.from, match.to)) {
    if (container) containers.push(container)
    else yield
  }
  const deletion = renderedDeletionRanges({ ...match, containers }, true)
  const first = deletion?.find(
    (range) => range.from <= match.from && match.from < range.to,
  )
  const context = yield* projection.context(
    match.from,
    match.to,
    first?.to ?? match.segments![0]!.to,
  )
  return Object.freeze({
    ...match,
    containers: Object.freeze(containers),
    context,
  })
}

/** Resume from source coordinates using retained rendered runs, including inside marks. */
export function* searchRenderedLiteral(
  projection: RenderedTextIndex,
  query: string,
  options: LiteralSearchOptions & { details?: boolean } = {},
): Generator<SearchProgress, { scanned: number; total: number }> {
  const matcher = new LiteralSearchMatcher(query, options.caseSensitive, true)
  if (!matcher.needle) return { scanned: 0, total: 0 }
  if (!projection.validStart(options.from ?? 0))
    throw new Error('Find starts outside a complete source character.')
  let total = 0,
    scanned = options.from ?? 0,
    work = 0
  let matches: SourceMatch[] = []
  for (const run of projection.runs(options.from)) {
    if (run.barrier || run.text === '') {
      if (run.barrier) matcher.reset()
      scanned = run.to
      yield {
        matches: Object.freeze(matches),
        scanned,
        total,
        restart: matcher.restart() ?? scanned,
      }
      matches = []
      continue
    }
    const atomic = run.text !== undefined
    let at = run.from
    for (let from = run.from; from < run.to; ) {
      let text =
        run.text ?? projection.text(from, Math.min(from + 4096, run.to))
      const to = from + text.length
      if (!atomic && to < run.to && /[\uD800-\uDBFF]$/.test(text))
        text += projection.text(to, to + 1)
      let decodedAt = 0
      for (const character of text) {
        const sourceTo = atomic ? run.to : at + character.length
        const match = matcher.feed(
          character,
          atomic ? run.from : at,
          sourceTo,
          atomic
            ? {
                first: run.precise !== false && decodedAt === 0,
                last:
                  run.precise !== false &&
                  decodedAt + character.length === text.length,
              }
            : { first: true, last: true },
        )
        if (match) {
          if (options.details === false) matches.push(match)
          else {
            const work = renderedMatch(projection, match)
            for (;;) {
              const next = work.next()
              if (next.done) {
                matches.push(next.value)
                break
              }
              yield {
                matches: Object.freeze(matches),
                scanned,
                total,
                restart: matcher.restart() ?? scanned,
              }
              matches = []
            }
          }
          total++
          if (atomic) {
            scanned = Math.max(scanned, run.to)
            if (++work >= 1024 || matches.length >= 128) {
              work = 0
              yield {
                matches: Object.freeze(matches),
                scanned,
                total,
                restart: matcher.restart() ?? scanned,
              }
              matches = []
            }
            break
          }
        }
        at = sourceTo
        decodedAt += character.length
        scanned = Math.max(scanned, sourceTo)
        if (++work >= 1024 || matches.length >= 128) {
          work = 0
          yield {
            matches: Object.freeze(matches),
            scanned,
            total,
            restart: matcher.restart() ?? scanned,
          }
          matches = []
        }
      }
      if (atomic) break
      from += text.length
    }
  }
  scanned = projection.length
  yield {
    matches: Object.freeze(matches),
    scanned,
    total,
    restart: matcher.restart() ?? scanned,
  }
  return { scanned, total }
}
