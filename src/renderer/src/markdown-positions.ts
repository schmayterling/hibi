import type { Node as RichNode } from '@tiptap/pm/model'
import { marked, type Token } from 'marked'
import { sourceText } from './source-text.ts'
import { preserveDisabled } from './syntax-parser.ts'

/** Map visible token text, never link destinations, image alt text, or markup. */
export function markdownPositions(source: string, document: RichNode) {
  const original = sourceText(source),
    toSource = original.toSource
  source = original.text
  let text = ''
  const offsets: { from: number; to: number; source: number }[] = []
  function visit(tokens: readonly Token[], raw: string, base: number) {
    let cursor = 0
    for (const token of tokens) {
      const at = raw.indexOf(token.raw, cursor)
      if (at < 0) continue
      cursor = at + token.raw.length
      const offset = base + at
      if (token.type === 'image' || token.type === 'html') continue
      if (token.type === 'list') visit(token.items, token.raw, offset)
      else if (token.type === 'table') {
        const cells = [...token.header, ...token.rows.flat()]
        visit(
          cells.flatMap((cell) => cell.tokens),
          token.raw,
          offset,
        )
      } else if ('tokens' in token && token.tokens?.length)
        visit(token.tokens, token.raw, offset)
      else if (
        'text' in token &&
        typeof token.text === 'string' &&
        token.text
      ) {
        // Exact text only. Unmappable custom syntax is left unmarked rather than
        // guessing a position in a different word or markup delimiter.
        const start = token.raw.indexOf(token.text)
        if (start < 0) continue
        const previous = offsets.at(-1),
          from = text.length,
          to = from + token.text.length,
          source = offset + start
        if (
          previous &&
          previous.source + previous.to - previous.from === source
        )
          previous.to = to
        else offsets.push({ from, to, source })
        text += token.text
      }
    }
  }
  const tokens = marked.lexer(source)
  marked.walkTokens(tokens, preserveDisabled)
  visit(tokens, source, 0)
  // Each run represents consecutive normalized source/rich points. Convert to
  // original source coordinates at lookup, preserving CRLF gaps without expansion.
  const spans: { source: number; rich: number; length: number }[] = []
  const append = (source: number, rich: number, length: number) => {
    const previous = spans.at(-1)
    if (
      previous &&
      previous.source + previous.length === source &&
      previous.rich + previous.length === rich
    )
      previous.length += length
    else spans.push({ source, rich, length })
  }
  let cursor = 0,
    rangeIndex = 0
  document.descendants((node, pos) => {
    if (!node.isText || !node.text) return
    const start = text.indexOf(node.text, cursor)
    if (start < 0) return
    const end = start + node.text.length
    while (offsets[rangeIndex] && offsets[rangeIndex]!.to <= start) rangeIndex++
    let last = -1
    for (let index = rangeIndex; index < offsets.length; index++) {
      const range = offsets[index]!
      if (range.from >= end) break
      const from = Math.max(start, range.from),
        to = Math.min(end, range.to),
        source = range.source + from - range.from
      append(source, pos + from - start, to - from)
      last = source + to - from - 1
    }
    if (last >= 0) append(last + 1, pos + node.text.length, 1)
    cursor = end
  })
  if (!source.trim() && document.firstChild?.isTextblock) append(0, 1, 1)
  const coordinate = (
    span: (typeof spans)[number],
    offset: number,
    axis: 'source' | 'rich',
  ) => (axis === 'source' ? toSource(span.source + offset) : span.rich + offset)
  // The first run point at or after `position` on one axis.
  const locate = (position: number, axis: 'source' | 'rich') => {
    let low = 0,
      high = spans.length - 1
    while (low <= high) {
      const middle = (low + high) >>> 1
      const span = spans[middle]!
      if (coordinate(span, span.length - 1, axis) < position) low = middle + 1
      else high = middle - 1
    }
    const span = spans[low]
    let index = 0
    if (span) {
      high = span.length - 1
      while (index <= high) {
        const middle = (index + high) >>> 1
        if (coordinate(span, middle, axis) < position) index = middle + 1
        else high = middle - 1
      }
    }
    return { low, index }
  }
  const lookup = (position: number, from: 'source' | 'rich') => {
    const to = from === 'source' ? 'rich' : 'source'
    const { low, index } = locate(position, from)
    const span = spans[low]
    const before = span && index ? span : spans[low - 1],
      beforeIndex = span && index ? index - 1 : (before?.length ?? 1) - 1
    if (!before) return span ? coordinate(span, index, to) : null
    if (
      !span ||
      position - coordinate(before, beforeIndex, from) <=
        coordinate(span, index, from) - position
    )
      return coordinate(before, beforeIndex, to)
    return coordinate(span, index, to)
  }
  /** The closest source point this map knows, with its rich position: at or
   * before `offset` for side -1, at or after it for side 1. */
  const nearest = (offset: number, side: -1 | 1) => {
    const found = locate(offset, 'source')
    let span = spans[found.low],
      index = found.index
    if (side < 0 && (!span || coordinate(span, index, 'source') > offset)) {
      if (span && index) index--
      else {
        span = spans[found.low - 1]
        index = (span?.length ?? 0) - 1
      }
    }
    return span
      ? {
          source: coordinate(span, index, 'source'),
          rich: coordinate(span, index, 'rich'),
        }
      : null
  }
  return Object.assign(lookup, { nearest })
}

export type MarkdownPositionLookup = (
  source: string,
  document: RichNode,
) => (position: number, from: 'source' | 'rich') => number | null

/** One current map per editor/schema. History roots must not retain older maps. */
export function createMarkdownPositionCache(): typeof markdownPositions {
  let cached: {
    source: string
    document: RichNode
    map: ReturnType<typeof markdownPositions>
  } | null = null
  return (source, document) => {
    if (!cached || cached.document !== document || cached.source !== source)
      cached = { source, document, map: markdownPositions(source, document) }
    return cached.map
  }
}
