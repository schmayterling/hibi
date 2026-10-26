import type { InlineContext, MarkdownConfig } from '@lezer/markdown'

/*
 * Obsidian's wikilinks, embeds and highlights for the formatted view's
 * syntax tree, accepting what the rich view's tokenizers in `obsidian.ts`
 * accept: `[[target]]`, `[[target|label]]` and `![[…]]` on one line without
 * `]` inside, and `==text==` whose text starts and ends with a non-space.
 */

/** Characters the inline scans and patterns read, for complexity tests. */
export const obsidianWork = { reads: 0 }

/** A wikilink or embed as the rich view reads it, with its label's place in the source. */
export type WikiParts = {
  embed: boolean
  /** The target, trimmed, with any `#heading`. */
  target: string
  /** The shown label: the alias, or else the target, trimmed. */
  label: string
  labelFrom: number
  labelTo: number
}

/** A wikilink or embed's parts, when `source` is exactly one. */
export function wikiParts(source: string): WikiParts | null {
  obsidianWork.reads += source.length
  const embed = source.startsWith('!')
  const open = embed ? 3 : 2
  const inner = source.slice(open, -2)
  if (!inner || /[\]\r\n]/.test(inner)) return null
  // As `split('|', 2)` reads it: text after a second bar is dropped.
  const bar = inner.indexOf('|')
  const target = bar < 0 ? inner : inner.slice(0, bar)
  if (!target.trim()) return null
  const next = bar < 0 ? -1 : inner.indexOf('|', bar + 1)
  const alias = bar < 0 ? '' : inner.slice(bar + 1, next < 0 ? undefined : next)
  const [from, shown] = alias.trim() ? [open + bar + 1, alias] : [open, target]
  const lead = shown.length - shown.trimStart().length
  return {
    embed,
    target: target.trim(),
    label: shown.trim(),
    labelFrom: from + lead,
    labelTo: from + lead + shown.trim().length,
  }
}

const space = /\s/
const isSpace = (code: number) =>
  code < 0 || space.test(String.fromCharCode(code))

/**
 * Each inline section's last scans. Openers come in document order, so a
 * scan never reads text an earlier one read: a position inside the last
 * scanned span shares its answer.
 */
type Scans = {
  /** No `]` or line break in `[from, stop)`; `stop` is one, or the end. */
  bracket: { from: number; stop: number }
  /** The first highlight closer after `from` is `at`, or none before the line break at `to`. */
  closer: { from: number; to: number; at: number }
}
const scans = new WeakMap<InlineContext, Scans>()

function scansOf(cx: InlineContext) {
  let found = scans.get(cx)
  if (!found) {
    found = {
      bracket: { from: -1, stop: -2 },
      closer: { from: -1, to: -2, at: -1 },
    }
    scans.set(cx, found)
  }
  return found
}

/** The first `]`, line break or section end at or after `pos`. */
function bracketStop(cx: InlineContext, pos: number) {
  const cache = scansOf(cx).bracket
  if (pos >= cache.from && pos <= cache.stop) return cache.stop
  let at = pos
  for (; at < cx.end; at++) {
    obsidianWork.reads++
    const code = cx.char(at)
    if (code === 93 || code === 10 || code === 13) break
  }
  cache.from = pos
  cache.stop = at
  return at
}

/** The end of `[[…]]`, or `![[…]]` with `embed`, starting at `pos`, or -1. */
function wikiEnd(cx: InlineContext, pos: number, embed: boolean) {
  const open = pos + (embed ? 3 : 2)
  if (cx.char(open - 2) !== 91 || cx.char(open - 1) !== 91) return -1
  const stop = bracketStop(cx, open)
  if (stop === open || cx.char(stop) !== 93 || cx.char(stop + 1) !== 93)
    return -1
  // The target, before any `|`, needs a non-space. Only the spaces after the
  // brackets are read: the next opener's brackets end them, so no two
  // openers read the same text.
  for (let at = open; at < stop; at++) {
    obsidianWork.reads++
    const code = cx.char(at)
    if (code === 124) return -1
    if (!isSpace(code)) return stop + 2
  }
  return -1
}

/**
 * The end of `==text==` starting at `pos`, or -1. Like the rich view's
 * pattern, a longer text wins: the first `==` after a non-space at least two
 * characters in, before the line ends, or else a one-character text.
 */
function highlightEnd(cx: InlineContext, pos: number) {
  if (cx.char(pos + 1) !== 61 || isSpace(cx.char(pos + 2))) return -1
  const from = pos + 3
  const cache = scansOf(cx).closer
  let found = -1
  if (cache.from <= from && cache.at > from) found = cache.at
  else if (!(cache.from <= from && cache.at < 0 && from <= cache.to)) {
    let at = from
    for (; at < cx.end; at++) {
      obsidianWork.reads++
      const code = cx.char(at)
      if (code === 10 || code === 13) break
      if (
        at > from &&
        code === 61 &&
        cx.char(at + 1) === 61 &&
        !isSpace(cx.char(at - 1))
      ) {
        found = at
        break
      }
    }
    cache.from = from
    cache.to = at
    cache.at = found
  }
  if (found >= 0) return found + 2
  return cx.char(from) === 61 && cx.char(from + 1) === 61 ? from + 2 : -1
}

/** The obsidian flavor's inline syntax. */
export const obsidianSyntax: MarkdownConfig = {
  defineNodes: [
    { name: 'WikiLink' },
    { name: 'WikiEmbed' },
    { name: 'WikiMark' },
    { name: 'Highlight' },
    { name: 'HighlightMark' },
  ],
  parseInline: [
    {
      name: 'WikiEmbed',
      before: 'Image',
      parse(cx, next, pos) {
        if (next !== 33) return -1
        const end = wikiEnd(cx, pos, true)
        if (end < 0) return -1
        return cx.addElement(
          cx.elt('WikiEmbed', pos, end, [
            cx.elt('WikiMark', pos, pos + 3),
            cx.elt('WikiMark', end - 2, end),
          ]),
        )
      },
    },
    {
      name: 'WikiLink',
      before: 'Link',
      parse(cx, next, pos) {
        if (next !== 91) return -1
        const end = wikiEnd(cx, pos, false)
        if (end < 0) return -1
        return cx.addElement(
          cx.elt('WikiLink', pos, end, [
            cx.elt('WikiMark', pos, pos + 2),
            cx.elt('WikiMark', end - 2, end),
          ]),
        )
      },
    },
    {
      name: 'Highlight',
      before: 'Emphasis',
      parse(cx, next, pos) {
        if (next !== 61) return -1
        const end = highlightEnd(cx, pos)
        if (end < 0) return -1
        return cx.addElement(
          cx.elt('Highlight', pos, end, [
            cx.elt('HighlightMark', pos, pos + 2),
            cx.elt('HighlightMark', end - 2, end),
          ]),
        )
      },
    },
  ],
}
