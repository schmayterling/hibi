import {
  type Closers,
  formulaLimit,
  inlineDisplayMathEnd,
  inlineMathEnd,
  pairLimit,
} from './inline-display.ts'

/**
 * A code span or formula that holds a line start of a paragraph: its opener,
 * the end of its closer, and whether it is math over the formula limit, which
 * stays text whole.
 */
export type SeamPair = { from: number; to: number; over: boolean }

/** ASCII punctuation a backslash escapes, as in @lezer/markdown. */
const escapable = new Set(
  Array.from('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~', (char) =>
    char.charCodeAt(0),
  ),
)

/**
 * How later lines of a block continue its containers: quote markers, and list
 * items' content columns past the base of the containers around them, as
 * lezer measures them on each line.
 */
export type Level = { quote: true } | { quote: false; value: number }

export const space = (code: number) => code === 32 || code === 9
export const nextColumn = (column: number, code: number) =>
  code === 9 ? column + 4 - (column % 4) : column + 1

/** Where a later line's content starts inside the containers, or -1 when they end before it. */
export function contentStart(levels: readonly Level[], text: string) {
  let pos = 0,
    column = 0,
    base = 0
  for (const level of levels) {
    if (level.quote) {
      while (space(text.charCodeAt(pos)))
        column = nextColumn(column, text.charCodeAt(pos++))
      if (text[pos] !== '>') return -1
      pos++
      column++
      if (space(text.charCodeAt(pos)))
        column = nextColumn(column, text.charCodeAt(pos++))
      base = column
    } else {
      // A blank line continues an item, but not a quote inside it.
      if (/^[ \t]*$/.test(text.slice(pos))) {
        pos = text.length
        continue
      }
      base += level.value
      while (column < base && space(text.charCodeAt(pos)))
        column = nextColumn(column, text.charCodeAt(pos++))
      if (column < base) return -1
    }
  }
  return pos
}

/** Units read, for complexity tests. */
export const seamWork = { units: 0 }

/**
 * The pair holding `to` after reading a paragraph's text from `from`, where
 * `open` holds `from` (or null), as the formatted view's inline parser pairs
 * that text: backslash escapes, then code spans and math, whichever opens
 * first. `text` is the paragraph from document position `offset` on, through
 * `pairLimit` past `to` or the paragraph's end; closers are looked for there.
 * `read.reach` grows to the furthest position a decision read, so an edit
 * after it keeps the result. In a quote or list item, `levels` are its
 * containers: a `$` can close math at a line's content start, as the
 * formatted view reads the line without their markers.
 *
 * ponytail: other inline syntax that hides a dollar or backtick, such as an
 * HTML tag or a link destination, reads as text here, and so does emphasis
 * or a link that opened before a formula and wins over it: one such formula
 * near a giant paragraph's top pairs every window after it otherwise.
 * Reading it means carrying emphasis and link delimiters in each checkpoint
 * as lezer pairs them, and giving a window that cuts an open one its
 * delimiters too.
 */
export function readSeams(
  text: string,
  offset: number,
  from: number,
  to: number,
  open: SeamPair | null,
  read: { reach: number },
  levels: readonly Level[] = [],
): SeamPair | null {
  let pos = from
  if (open) {
    read.reach = Math.max(read.reach, open.to)
    if (open.to > to) return open
    pos = open.to
  }
  const end = offset + text.length
  const code = (at: number) => text.charCodeAt(at - offset)
  // Runs of each backtick count: the first one found at or after the starts
  // asked so far, or -1 with how far none was found. Starts only grow, so
  // each run is read about once per count.
  const runs = new Map<number, { at: number; searched: number }>()
  const closingRun = (size: number, start: number) => {
    const limit = Math.min(end, start + pairLimit)
    const known = runs.get(size)
    if (known && known.at >= start) return known.at
    let i = known && known.at < 0 ? Math.max(start, known.searched) : start
    let at = -1
    for (; i < limit; i++) {
      if (code(i) !== 96) continue
      let length = 1
      while (i + length < end && code(i + length) === 96) length++
      seamWork.units += length
      if (length === size) {
        at = i
        break
      }
      i += length
    }
    // A run reaching past the limit was read whole: the next search starts after it.
    runs.set(size, { at, searched: at < 0 ? i : at })
    read.reach = Math.max(read.reach, at < 0 ? i : at + size)
    return at
  }
  const closers: Closers = { from: -1, at: -1 }
  // The text starts a line; the last line's content start, by line start.
  let line = -1,
    content = -1
  const lineStart = levels.length
    ? (at: number) => {
        const start = text.lastIndexOf('\n', at - 1) + 1
        if (start !== line) {
          const end = text.indexOf('\n', start)
          line = start
          content = contentStart(
            levels,
            text.slice(start, end < 0 ? undefined : end),
          )
        }
        return at - start === content
      }
    : undefined
  const stops = /[\\`$]/g
  while (pos < to) {
    stops.lastIndex = pos - offset
    const found = stops.exec(text)
    const at = found ? offset + found.index : end
    seamWork.units += Math.min(at, to) - pos
    if (at >= to) return null
    const char = code(at)
    if (char === 92) {
      const next = code(at + 1)
      pos = at + (next === 10 || escapable.has(next) ? 2 : 1)
      continue
    }
    let size = 1
    const display = char === 36 && code(at + 1) === 36
    let close: number
    if (char === 96) {
      while (code(at + size) === 96) size++
      // A run after an escaped backtick opens nothing, as in @lezer/markdown.
      const run = code(at - 1) === 96 ? -1 : closingRun(size, at + size)
      close = run < 0 ? -1 : run + size
    } else {
      size = display ? 2 : 1
      const found = display
        ? inlineDisplayMathEnd(text, at - offset)
        : inlineMathEnd(text, at - offset, closers, lineStart)
      close = found < 0 ? -1 : offset + found
      // An opener without a closer read up to the pair limit, unless its
      // first unit already ruled it out.
      const first = code(at + 1)
      const ruled = !display && (first === 32 || first === 9 || at + 1 >= end)
      read.reach = Math.max(
        read.reach,
        close >= 0 ? close : ruled ? at + 2 : Math.min(end, at + 4 + pairLimit),
      )
    }
    if (close < 0) {
      // Every backtick of an unpaired run opens nothing; a dollar, only itself.
      pos = at + (char === 96 ? size : 1)
      continue
    }
    const pair = {
      from: at,
      to: close,
      over: char === 36 && close - at - 2 * size > formulaLimit,
    }
    if (pair.to > to) return pair
    pos = pair.to
  }
  return null
}
