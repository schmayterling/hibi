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
const punctuation = /[\p{P}\p{S}]/u
const isSpace = (code: number) =>
  code < 0 || space.test(String.fromCharCode(code))

/** Marked's classes around a delimiter: 0 space or none, 1 punctuation or symbol, 2 other. */
function kind(point: number | undefined) {
  if (point === undefined) return 0
  const char = String.fromCodePoint(point)
  return space.test(char) ? 0 : punctuation.test(char) ? 1 : 2
}

/** The code point that ends before index `at` of `text`. */
function pointBefore(text: string, at: number) {
  if (at < 1) return undefined
  const pair = at > 1 ? (text.codePointAt(at - 2) ?? 0) : 0
  return pair > 0xffff ? pair : text.charCodeAt(at - 1)
}

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

/**
 * The characters of `text` that the rich view's strikethrough search doesn't
 * see. Marked hides escaped characters with their backslash, and code spans:
 * from the left, a backtick run and the next run of the same length; then it
 * hides each remaining run with the next one when their lengths match.
 */
function hiddenText(text: string) {
  const hidden = new Uint8Array(text.length)
  // The starts of the backtick runs of each length, for each span's closer.
  const runs = new Map<number, number[]>()
  for (let at = 0, start = -1; at <= text.length; at++) {
    subscriptWork.reads++
    if (text.charCodeAt(at) === 96) {
      if (start < 0) start = at
    } else if (start >= 0) {
      const starts = runs.get(at - start)
      if (starts) starts.push(start)
      else runs.set(at - start, [start])
      start = -1
    }
  }
  const ticks: number[] = []
  const next = new Map<number, number>()
  for (let at = 0; at < text.length; at++) {
    subscriptWork.reads++
    const code = text.charCodeAt(at)
    if (code === 92) {
      const point = text.codePointAt(at + 1)
      if (point !== undefined && kind(point) === 1) {
        const end = at + (point > 0xffff ? 3 : 2)
        hidden.fill(1, at, end)
        at = end - 1
      }
    } else if (code === 96) {
      let end = at + 1
      while (text.charCodeAt(end) === 96) end++
      subscriptWork.reads += end - at
      const size = end - at
      const starts = runs.get(size) ?? []
      let index = next.get(size) ?? 0
      while (index < starts.length && (starts[index] ?? 0) < end) index++
      ticks.push(at, size)
      const close = starts[index]
      if (close === undefined) {
        next.set(size, index)
        at = end - 1
      } else {
        ticks.push(close, size)
        next.set(size, index + 1)
        at = close + size - 1
      }
    }
  }
  for (let index = 0; index + 3 < ticks.length; index += 2)
    if (ticks[index + 1] === ticks[index + 3]) {
      hidden.fill(
        1,
        ticks[index],
        (ticks[index + 2] ?? 0) + (ticks[index + 3] ?? 0),
      )
      index += 2
    }
  return hidden
}

/**
 * An inline section's `~~` runs that the strikethrough search sees: their
 * starts; for each number of runs before a position, the first run after
 * them where more runs have closed than opened since; and the closers of the
 * strikethroughs read so far.
 */
const doubles = new WeakMap<
  InlineContext,
  { starts: number[]; closes: number[]; closers: Set<number>; next: number }
>()

function sectionDoubles(cx: InlineContext) {
  const { text } = cx
  const hidden = hiddenText(text)
  const starts: number[] = []
  // Closing runs minus opening runs, before any run and after each.
  const counts = [0]
  for (let at = 0; at < text.length; at++) {
    subscriptWork.reads++
    if (text.charCodeAt(at) !== 126 || hidden[at]) continue
    let end = at + 1
    while (text.charCodeAt(end) === 126) end++
    subscriptWork.reads += end - at
    if (end - at === 2) {
      const before = hidden[at - 1] ? 1 : kind(pointBefore(text, at))
      const after = hidden[end] ? 1 : kind(text.codePointAt(end))
      const count = counts.at(-1) ?? 0
      // Marked's flanking rules: a run before a letter, or between a space
      // and punctuation, opens; one between spaces does neither; the rest close.
      if (after === 2 ? before < 2 : before === 0 && after === 1)
        counts.push(count - 1)
      else counts.push(before || after ? count + 1 : count)
      starts.push(at)
    }
    at = end - 1
  }
  // For each count, the first later run with a higher one, by a stack of the
  // runs ahead whose counts rise.
  const closes = counts.map(() => -1)
  const ahead: number[] = []
  for (let index = counts.length - 1; index >= 0; index--) {
    const count = counts[index] ?? 0
    while (ahead.length && (counts[ahead.at(-1) ?? 0] ?? 0) <= count)
      ahead.pop()
    closes[index] = (ahead.at(-1) ?? 0) - 1
    ahead.push(index)
  }
  return { starts, closes, closers: new Set<number>(), next: 0 }
}

/**
 * Whether the rich view's strikethrough takes the `~~` at `pos`. Marked opens
 * one before a character that isn't a space, and before punctuation only
 * after a space or punctuation. It closes at the first `~~` after it that
 * closes more runs than open after it, skipping escapes and code spans, and
 * that closer is part of it too. Each section is scanned once, so every run's
 * answer costs a lookup.
 */
function strikes(cx: InlineContext, pos: number) {
  const at = pos - cx.offset
  if (doubles.get(cx)?.closers.has(at)) return true
  const after = kind(cx.text.codePointAt(at + 2))
  // Marked looks at the last UTF-16 unit before it, so half of an emoji.
  const before = kind(at ? cx.text.charCodeAt(at - 1) : undefined)
  if (after === 0 || (after === 1 && before === 2)) return false
  let section = doubles.get(cx)
  if (!section) {
    section = sectionDoubles(cx)
    doubles.set(cx, section)
  }
  const { starts, closes, closers } = section
  // Openers arrive in source order, so each run is passed only once.
  while (section.next < starts.length && (starts[section.next] ?? 0) < at + 2) {
    subscriptWork.reads++
    section.next++
  }
  const close = starts[closes[section.next] ?? -1]
  if (close === undefined) return false
  closers.add(close)
  return true
}

/** The end of `~text~` starting at `pos`, or -1. */
function subscriptEnd(cx: InlineContext, pos: number) {
  if (cx.char(pos + 1) === 126 || isSpace(cx.char(pos + 1))) return -1
  const close = tildeStop(cx, pos + 1)
  if (
    cx.char(close) !== 126 ||
    // Marked reads a strikethrough's text on its own, where a tilde right
    // before the strikethrough's closer ends the text.
    (cx.char(close + 1) === 126 &&
      !doubles.get(cx)?.closers.has(close + 1 - cx.offset)) ||
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
          // The rich view reads a `~~` that opens no strikethrough as a
          // tilde of text, and the next one may open a subscript.
          if (cx.char(pos + 2) === 126 || strikes(cx, pos)) return -1
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
