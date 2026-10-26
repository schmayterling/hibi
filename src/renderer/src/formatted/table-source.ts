/*
 * GFM table rows read from their source text, split the way the formatted
 * view's parser splits them: a pipe after an odd run of backslashes is
 * escaped, and spaces around cell content are padding. Every range is an
 * exact source range, so rendered cells and edits map one to one.
 */

/** Trimmed cell content; an empty cell is the empty range where its text goes. */
export type TableCell = { from: number; to: number }

export type TableRow = {
  /** Positions of the row's cell-delimiting pipes. */
  pipes: number[]
  cells: TableCell[]
}

export type TableAlignment = 'left' | 'center' | 'right' | null

/** Cells of one row line; `offset` is the document position of `text`. */
export function parseRow(text: string, offset = 0): TableRow {
  const pipes: number[] = [],
    cells: TableCell[] = []
  let start = -1,
    end = -1,
    open = 0,
    first = true,
    escaped = false
  for (let i = 0; i < text.length; i++) {
    const next = text.charCodeAt(i)
    if (next === 124 /* | */ && !escaped) {
      // A leading pipe opens the first cell; every later one closes a cell.
      if (!first || start > -1) {
        const at =
          start > -1 ? start : Math.min(i, open + (text[open] === ' ' ? 1 : 0))
        cells.push({ from: offset + at, to: offset + (start > -1 ? end : at) })
      }
      first = false
      pipes.push(offset + i)
      start = end = -1
      open = i + 1
    } else if (escaped || (next !== 32 && next !== 9)) {
      if (start < 0) start = i
      end = i + 1
    }
    escaped = !escaped && next === 92 /* \ */
  }
  if (start > -1) cells.push({ from: offset + start, to: offset + end })
  return { pipes, cells }
}

/** Column alignments from a delimiter row's cell text. */
export function alignments(text: string): TableAlignment[] {
  return parseRow(text).cells.map(({ from, to }) => {
    const cell = text.slice(from, to)
    const left = cell.startsWith(':'),
      right = cell.length > 1 && cell.endsWith(':')
    return left && right ? 'center' : left ? 'left' : right ? 'right' : null
  })
}

/**
 * Inline Markdown of a cell: escaped pipes belong to the table, so they read
 * as pipes even inside code. `source` maps each content offset to its
 * offset in the cell's source text.
 */
export function cellContent(text: string): { text: string; source: number[] } {
  let content = ''
  const source: number[] = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && text[i + 1] === '|') continue
    source.push(i)
    content += text[i]
  }
  source.push(text.length)
  return { text: content, source }
}

/**
 * Where a table row's text starts on a line after the table's first: after
 * the markers of the quotes around the table, which list indentation can
 * precede. List indentation alone is padding the row skips.
 */
export function rowStart(line: string, quotes: number) {
  let at = 0
  for (let depth = 0; depth < quotes; depth++) {
    const marker = /^[ \t]*>[ \t]?/.exec(line.slice(at))
    if (!marker) break
    at += marker[0].length
  }
  return at
}

export type InlineMark = {
  from: number
  to: number
  attributes: Record<string, string>
}
export type InlineOp<W> =
  | { type: 'open'; mark: InlineMark }
  | { type: 'close' }
  | { type: 'text'; from: number; to: number }
  | { type: 'widget'; widget: W }

/**
 * A cell's decorations as nested spans, text and widgets in order, from one
 * sweep over the sorted boundaries: marks open and close where they start
 * and end, hidden ranges drop their text and replacing widgets stand in.
 */
export function planInline<W>(
  length: number,
  marks: readonly InlineMark[],
  hidden: readonly { from: number; to: number; widget: W | null }[],
  widgets: readonly { at: number; widget: W; side: number }[],
): InlineOp<W>[] {
  const points = new Set([0, length])
  for (const range of marks) points.add(range.from).add(range.to)
  for (const range of hidden) points.add(range.from).add(range.to)
  for (const { at } of widgets) points.add(at)
  const sorted = [...points]
    .filter((point) => point >= 0 && point <= length)
    .sort((a, b) => a - b)
  const starts = marks
    .filter((mark) => mark.to > mark.from)
    .sort((a, b) => a.from - b.from || b.to - a.to)
  const ends = new Map<number, number>()
  for (const mark of starts) ends.set(mark.to, (ends.get(mark.to) ?? 0) + 1)
  const gaps = hidden
    .filter((range) => range.to > range.from)
    .sort((a, b) => a.from - b.from)
  const inserts = [...widgets].sort((a, b) => a.at - b.at || a.side - b.side)
  const ops: InlineOp<W>[] = []
  // Marks over the current point, outermost first, and the spans now open.
  let active: InlineMark[] = []
  const open: InlineMark[] = []
  /** Active marks from this index on may differ from the open spans. */
  let changed = 0
  const enter = () => {
    let keep = Math.min(changed, open.length)
    while (keep < open.length && open[keep] === active[keep]) keep++
    while (open.length > keep) {
      open.pop()
      ops.push({ type: 'close' })
    }
    for (const mark of active.slice(keep)) {
      open.push(mark)
      ops.push({ type: 'open', mark })
    }
    changed = active.length
  }
  let next = 0,
    gap = 0,
    insert = 0,
    hiddenTo = -1
  for (let index = 0; index < sorted.length; index++) {
    const at = sorted[index]!,
      end = sorted[index + 1]
    // Nested marks end innermost first; others ending here leave in one pass.
    let leaving = ends.get(at) ?? 0
    while (leaving && active.length && active.at(-1)!.to <= at) {
      active.pop()
      leaving--
    }
    changed = Math.min(changed, active.length)
    if (leaving) {
      const first = active.findIndex((mark) => mark.to <= at)
      active = active.filter((mark) => mark.to > at)
      changed = Math.min(changed, first)
    }
    while (next < starts.length && starts[next]!.from <= at) {
      const mark = starts[next++]!
      if (mark.to > at) active.push(mark)
    }
    for (; insert < inserts.length && inserts[insert]!.at === at; insert++) {
      enter()
      ops.push({ type: 'widget', widget: inserts[insert]!.widget })
    }
    for (; gap < gaps.length && gaps[gap]!.from <= at; gap++) {
      const range = gaps[gap]!
      hiddenTo = Math.max(hiddenTo, range.to)
      if (range.widget !== null && range.from === at) {
        enter()
        ops.push({ type: 'widget', widget: range.widget })
      }
    }
    if (end === undefined || hiddenTo >= end) continue
    enter()
    ops.push({ type: 'text', from: at, to: end })
  }
  while (open.pop()) ops.push({ type: 'close' })
  return ops
}
