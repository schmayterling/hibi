import { renderedDeletionRanges } from './rendered-replace.ts'
import type { RenderedContainer, RenderedTextIndex } from './rendered-text.ts'
import {
  LiteralSearchMatcher,
  type LiteralSearchOptions,
  type SearchProgress,
  type SourceMatch,
} from './source-search.ts'

/** Resume from source coordinates using retained rendered runs, including inside marks. */
export function* searchRenderedLiteral(
  projection: RenderedTextIndex,
  query: string,
  options: LiteralSearchOptions = {},
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
                first: decodedAt === 0,
                last: decodedAt + character.length === text.length,
              }
            : { first: true, last: true },
        )
        if (match) {
          const containers: RenderedContainer[] = []
          for (const container of projection.containers(match.from, match.to)) {
            if (container) containers.push(container)
            if (!container || ++work >= 1024) {
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
          const deletion = renderedDeletionRanges(
            { ...match, containers },
            true,
          )
          const first = deletion?.find(
            (range) => range.from <= match.from && match.from < range.to,
          )
          const contextWork = projection.context(
            match.from,
            match.to,
            first?.to ?? match.segments![0]!.to,
          )
          let context = contextWork.next()
          while (!context.done) {
            yield {
              matches: Object.freeze(matches),
              scanned,
              total,
              restart: matcher.restart() ?? scanned,
            }
            matches = []
            context = contextWork.next()
          }
          matches.push(
            Object.freeze({
              ...match,
              containers: Object.freeze(containers),
              context: context.value,
            }),
          )
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
