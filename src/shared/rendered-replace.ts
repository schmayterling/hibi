import { markdownLineStarts, markdownLiteral } from './markdown-literal.ts'
import type { RenderedRange } from './rendered-text.ts'
import type { SourceMatch } from './source-search.ts'

export type RenderedReplacement = Readonly<{
  from: number
  to: number
  text: string
  edits: readonly RenderedEdit[] | null
}>

/** Apply only the worker's grammar-verified plan for this exact source match. */
export function renderedReplaceEdits(
  match: SourceMatch,
  replacement: string,
  prepared?: RenderedReplacement,
): readonly RenderedEdit[] | null {
  return prepared?.from === match.from &&
    prepared.to === match.to &&
    prepared.text === replacement
    ? prepared.edits
    : null
}

export type RenderedEdit = Readonly<{
  from: number
  to: number
  insert: string
}>

/** Shared deletion plan also identifies the surviving source beside an insertion. */
export function renderedDeletionRanges(
  match: SourceMatch,
  replacement: boolean,
): readonly RenderedRange[] | null {
  const segments = match.segments
  if (!match.precise || !segments?.length) return null
  if (segments[0]!.from !== match.from || segments.at(-1)!.to !== match.to)
    return null
  const ranges: RenderedRange[] = []
  let end = 0
  for (const segment of segments) {
    if (
      !Number.isSafeInteger(segment.from) ||
      !Number.isSafeInteger(segment.to) ||
      segment.from < end ||
      segment.to <= segment.from
    )
      return null
    ranges.push(segment)
    end = segment.to
  }
  for (const container of match.containers ?? []) {
    if (
      match.from > container.visible.from ||
      match.to < container.visible.to
    ) {
      if (container.autolink) return null
      continue
    }
    const inherits =
      container.open.to <= match.from && match.from < container.close.from
    if (replacement && container.kind !== 'link' && inherits) continue
    ranges.push(container.open, container.close)
  }
  ranges.sort((a, b) => a.from - b.from || a.to - b.to)
  const joined: RenderedRange[] = []
  for (const range of ranges) {
    const previous = joined.at(-1)
    if (previous && range.from <= previous.to)
      joined[joined.length - 1] = {
        from: previous.from,
        to: Math.max(previous.to, range.to),
      }
    else joined.push(range)
  }
  return joined
}

/**
 * One normalized-source transaction. The first visible segment inherits its
 * marks; emptied links and marks without replacement content lose delimiters.
 * Map these coordinates through the matching snapshot before canonical edits.
 */
export function renderedReplacementCandidate(
  match: SourceMatch,
  replacement: string,
  escapeLiteral = false,
): readonly RenderedEdit[] | null {
  const context = match.context
  if (!context || typeof replacement !== 'string') return null
  const joined = renderedDeletionRanges(match, !!replacement)
  if (!joined) return null
  const point = joined.find(
    (range) => range.from <= match.from && match.from < range.to,
  )!.from
  let insert = replacement
  const code = context.code
  if (
    code?.width &&
    (replacement || match.from > code.from || match.to < code.to)
  ) {
    if (
      !replacement &&
      (code.leftTicks + code.rightTicks === code.width ||
        (match.from === code.from && code.rightTicks) ||
        (match.to >= code.to && code.leftTicks))
    )
      return null
    for (const run of replacement.matchAll(/`+/g)) {
      const start = run.index === 0,
        end = run.index + run[0].length === replacement.length
      if (
        (start && match.from === code.from) ||
        (end && match.to >= code.to) ||
        run[0].length +
          (start ? code.leftTicks : 0) +
          (end ? code.rightTicks : 0) ===
          code.width
      )
        return null
    }
  }
  if (!code && escapeLiteral) {
    const literal = markdownLiteral(replacement, context.after)
    const prefix =
      point - context.lineFrom <= context.linePrefix.length
        ? context.linePrefix.slice(0, point - context.lineFrom)
        : 'x'
    insert = markdownLineStarts(prefix + literal, prefix.length).slice(
      prefix.length,
    )
  }
  return joined.map((range) => ({
    ...range,
    insert: range.from <= match.from && match.from < range.to ? insert : '',
  }))
}
