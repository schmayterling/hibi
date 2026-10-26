import type {
  BlockContext,
  InlineContext,
  Line,
  MarkdownConfig,
} from '@lezer/markdown'

/*
 * Text extras for the formatted view's syntax tree, accepting what the rich
 * view's tokenizers in `syntax.ts` accept: `~subscript~` (one tilde on each
 * side, no tilde inside, non-space at both ends, on one line) and `-# small
 * text` lines.
 */

/** Characters the subscript scan reads, for complexity tests. */
export const subscriptWork = { reads: 0 }

const space = /\s/
const isSpace = (code: number) =>
  code < 0 || space.test(String.fromCharCode(code))

/**
 * The first `~`, line break or section end at or after `pos`. A scan from
 * an opener ends at the next tilde, where the next opener can be, so scans
 * never read the same text.
 */
function tildeStop(cx: InlineContext, pos: number) {
  let at = pos
  for (; at < cx.end; at++) {
    subscriptWork.reads++
    const code = cx.char(at)
    if (code === 126 || code === 10 || code === 13) break
  }
  return at
}

/** Each inline section's last scan for a strikethrough closer. */
const doubles = new WeakMap<InlineContext, { from: number; at: number }>()

/**
 * The first `~~` at or after `from` that could close a strikethrough, or -1.
 * Openers come in document order, so the last scan's answer serves every
 * position up to it and no text is read twice.
 */
function closingDouble(cx: InlineContext, from: number) {
  let cache = doubles.get(cx)
  if (!cache) {
    cache = { from: Number.POSITIVE_INFINITY, at: -1 }
    doubles.set(cx, cache)
  }
  if (cache.from <= from && (cache.at < 0 || cache.at >= from)) return cache.at
  let found = -1
  for (let at = from; at < cx.end; at++) {
    subscriptWork.reads++
    const before = cx.char(at - 1)
    if (
      cx.char(at) === 126 &&
      cx.char(at + 1) === 126 &&
      cx.char(at + 2) !== 126 &&
      before !== 126 &&
      before !== 92 &&
      !isSpace(before)
    ) {
      found = at
      break
    }
  }
  cache.from = from
  cache.at = found
  return found
}

/** The end of `~text~` starting at `pos`, or -1. */
function subscriptEnd(cx: InlineContext, pos: number) {
  if (cx.char(pos + 1) === 126 || isSpace(cx.char(pos + 1))) return -1
  const close = tildeStop(cx, pos + 1)
  if (
    cx.char(close) !== 126 ||
    cx.char(close + 1) === 126 ||
    isSpace(cx.char(close - 1))
  )
    return -1
  return close + 1
}

/** `-# ` at the start of a line's content, unindented. */
const isSubtext = (line: Line) =>
  line.next === 45 &&
  line.text.charCodeAt(line.pos + 1) === 35 &&
  line.text.charCodeAt(line.pos + 2) === 32 &&
  line.indent === line.baseIndent

export const subscriptSyntax: MarkdownConfig = {
  defineNodes: [{ name: 'Subscript' }, { name: 'SubscriptMark' }],
  parseInline: [
    {
      name: 'Subscript',
      // Before GitHub's strikethrough, which also starts at a tilde.
      before: 'Emphasis',
      parse(cx, next, pos) {
        if (next !== 126) return -1
        let from = pos
        if (cx.char(pos + 1) === 126) {
          // The rich view reads a `~~` that no strikethrough closes as a
          // tilde of text, and the next one may open a subscript.
          if (cx.char(pos + 2) === 126 || closingDouble(cx, pos + 3) >= 0)
            return -1
          from = pos + 1
        }
        const end = subscriptEnd(cx, from)
        if (end < 0) return -1
        return cx.addElement(
          cx.elt('Subscript', from, end, [
            cx.elt('SubscriptMark', from, from + 1),
            ...cx.parser.parseInline(cx.slice(from + 1, end - 1), from + 1),
            cx.elt('SubscriptMark', end - 1, end),
          ]),
        )
      },
    },
  ],
}

export const subtextSyntax: MarkdownConfig = {
  defineNodes: [{ name: 'Subtext', block: true }, { name: 'SubtextMark' }],
  parseBlock: [
    {
      name: 'Subtext',
      before: 'HorizontalRule',
      parse(cx: BlockContext, line: Line) {
        if (!isSubtext(line)) return false
        const from = cx.lineStart + line.pos
        const text = line.text.slice(line.pos + 3)
        const end = cx.lineStart + line.text.length
        cx.nextLine()
        cx.addElement(
          cx.elt('Subtext', from, end, [
            cx.elt('SubtextMark', from, from + 3),
            ...cx.parser.parseInline(text, from + 3),
          ]),
        )
        return true
      },
      // Like the rich view, a small-text line ends a paragraph.
      endLeaf: (_cx, line) => isSubtext(line),
    },
  ],
}
