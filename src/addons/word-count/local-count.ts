import type { Token } from 'marked'
import type { SemanticRegion } from '../../shared/markdown-semantic-tokens.ts'
import type { SourceSnapshot } from '../../shared/source-buffer.ts'
import { SourceOwners } from '../../shared/source-owners.ts'
import { countText } from './count.ts'

// these characters can change Markdown ownership, references or inline tokens.
const syntax = /[\r\n\t\\`&*_!#[\]<>~^$+=|-]/

/** count proven plain source without materializing it or passing it to marked's block regexps. */
export function plainSource(source: SourceSnapshot, from: number, to: number) {
  if (source.lineAt(from)?.to !== to) return null
  let pending = '',
    last = '',
    first = true,
    words = 0,
    characters = 0
  for (const chunk of source.chunks(from, to)) {
    if (
      syntax.test(chunk) ||
      /[:@]/.test(chunk) ||
      /www\./i.test(last + chunk) ||
      (first && !/^\S/.test(chunk))
    )
      return null
    first = false
    const cuts = [...chunk.matchAll(/ (?=[a-zA-Z0-9])/g)]
    const cut = cuts.at(-1)
    const end = cut
      ? cut.index + 1
      : last.endsWith(' ') && /^[a-zA-Z0-9]/.test(chunk)
        ? 0
        : -1
    if (end >= 0) {
      const count = countText(pending + chunk.slice(0, end))
      words += count.words
      characters += count.characters
      pending = chunk.slice(end)
    } else pending += chunk
    last = (last + chunk).slice(-3)
  }
  const count = countText(pending)
  return {
    words: words + count.words,
    characters: characters + count.characters,
  }
}

/** inline ownership retained as lengths, without source strings or lexer payloads. */
export function plainParagraph(
  tokens: readonly Token[],
  region: SemanticRegion,
) {
  if (region.members.length !== 1 || region.owner.kind !== 'markdown:Paragraph')
    return null
  const body = tokens.filter((token) => token.type !== 'space')
  const token = body[0]
  if (body.length !== 1 || token?.type !== 'paragraph' || !token.tokens)
    return null
  const raw = token.raw.replace(/\n+$/, '')
  if (
    raw.length !== region.owner.length ||
    /[\r\n]/.test(raw) ||
    !/^\S/.test(raw)
  )
    return null
  const spans = token.tokens
    .map((inline) => ({
      kind:
        inline.type === 'text' && !syntax.test(inline.raw) ? 'plain' : 'syntax',
      length: inline.raw.length,
    }))
    .filter((span) => span.length)
  if (spans.reduce((sum, span) => sum + span.length, 0) !== raw.length)
    return null
  if (spans.length === 1 && spans[0]?.kind === 'plain') return raw.length
  return spans.some((span) => span.kind === 'plain')
    ? new SourceOwners(spans)
    : null
}

/**
 * recount between stable word and grapheme boundaries. A space followed by an
 * ascii letter/digit breaks both, including beside combining marks and emoji.
 * never cut a word, surrogate pair, grapheme or Markdown token at a fixed size.
 */
export function localCount(
  source: SourceSnapshot,
  from: number,
  to: number,
  insert: string,
  base: number,
  spans: number | SourceOwners,
) {
  const span =
    typeof spans === 'number'
      ? {
          from: 0,
          to: spans,
          index: 0,
          owner: { kind: 'plain', length: spans },
        }
      : spans.at(from - base)
  if (span?.owner.kind !== 'plain') return null
  const start = base + span.from,
    end = base + span.to
  if (from < start || to > end || syntax.test(insert)) return null
  // ponytail: a run without stable spaces needs its whole segmentation context;
  // composable unicode segmentation summaries would bound edits within that run.
  let left = from,
    right = to
  while (left > start) {
    const at = Math.max(start, left - 256)
    const text = source.sliceRaw(at, Math.min(end, left + 1))
    const cuts = [...text.matchAll(/ (?=[a-zA-Z0-9])/g)]
    const cut = cuts.findLast((match) => at + match.index + 1 < from)
    if (cut) {
      left = at + cut.index + 1
      break
    }
    left = at
  }
  while (right < end) {
    const at = Math.max(start, right - 1)
    const limit = Math.min(end, right + 256)
    const text = source.sliceRaw(at, limit)
    const cut = [...text.matchAll(/ (?=[a-zA-Z0-9])/g)].find(
      (match) => at + match.index + 1 > to,
    )
    if (cut) {
      right = at + cut.index + 1
      break
    }
    right = limit
  }
  // an inline syntax edge need not be a visible word or grapheme boundary.
  if (
    (left === start && span.from > 0) ||
    (right === end &&
      span.to < (typeof spans === 'number' ? spans : spans.length))
  )
    return null
  const before = source.sliceRaw(left, right)
  const after = `${before.slice(0, from - left)}${insert}${before.slice(to - left)}`
  // indentation, punctuation or deletion can change paragraph ownership.
  if (
    left === base &&
    (!/^\S/.test(after) || /^\d{1,9}[.)](?:\s|$)/.test(after))
  )
    return null
  // url/email recognition can change when ordinary letters are edited beside these.
  if (
    /[:@]/.test(before) ||
    /[:@]/.test(insert) ||
    /www\./i.test(before) ||
    /www\./i.test(after)
  )
    return null
  const oldCount = countText(before),
    newCount = countText(after)
  return {
    words: newCount.words - oldCount.words,
    characters: newCount.characters - oldCount.characters,
    units: before.length + after.length,
    spans:
      typeof spans === 'number'
        ? spans + insert.length - (to - from)
        : spans.update(span.index, {
            ...span.owner,
            length: span.owner.length + insert.length - (to - from),
          }),
  }
}
