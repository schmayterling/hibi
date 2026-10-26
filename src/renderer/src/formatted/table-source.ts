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

/**
 * A cell's text between its delimiters, padding included: what a cell
 * editor edits. `end` is the end of the row's line.
 */
export function cellSpan(row: TableRow, index: number, end: number) {
  const cell = row.cells[index]
  if (!cell) return null
  let from = cell.from,
    to = end,
    closed = false
  for (const pipe of row.pipes)
    if (pipe < cell.from) from = pipe + 1
    else if (pipe >= cell.to) {
      to = pipe
      closed = true
      break
    }
  return { from, to, closed }
}

/**
 * Changes to a cell's text that keep it one cell, as the rich editor
 * escaped cells: a backslash before each unescaped pipe, `<br>` for line
 * breaks, and a space after a final backslash that would escape the next
 * delimiter (`closed`).
 */
export function cellFixes(text: string, closed: boolean): TableChange[] {
  const changes: TableChange[] = []
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const next = text[i]!
    if (next === '|' && !escaped) changes.push({ from: i, to: i, insert: '\\' })
    else if (next === '\n' || next === '\r')
      changes.push({ from: i, to: i + 1, insert: next === '\n' ? '<br>' : '' })
    escaped = !escaped && next === '\\'
  }
  if (escaped && closed)
    changes.push({ from: text.length, to: text.length, insert: ' ' })
  return changes
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

/** A table's lines: 0 is the header, 1 the delimiter row, then the body rows. */
export type TableText = {
  lines: number
  line(index: number): { from: number; text: string }
  /** Where the table starts on its first line, after container markers. */
  start: number
  /** Quotes around the table, whose markers start its later lines. */
  quotes: number
}

export type TableChange = { from: number; to: number; insert: string }

/**
 * A source edit of a table, and the cell where the edited cell, row or
 * column is afterwards, as a line index and column.
 */
export type TableEdit = {
  changes: TableChange[]
  cell: { line: number; column: number } | null
}

type Line = TableRow & {
  from: number
  /** Where the row's text starts after quote markers and indentation. */
  start: number
  end: number
  text: string
}

function line(table: TableText, index: number): Line {
  const { from, text } = table.line(index)
  const at = index ? rowStart(text, table.quotes) : table.start
  const start = from + at + /^[ \t]*/.exec(text.slice(at))![0].length
  return {
    ...parseRow(text.slice(at), from + at),
    from,
    start,
    end: from + text.length,
    text,
  }
}

/** Quote markers and indentation that start the table's later lines. */
const prefix = (table: TableText) => {
  const row = line(table, 1)
  return row.text.slice(0, row.start - row.from)
}

const emptyRow = (columns: number) => `|${'  |'.repeat(columns)}`

/** The pipes around a cell, or -1 at a row end without one. */
function pipesAround(row: Line, cell: TableCell) {
  let left = -1,
    right = -1
  for (const pipe of row.pipes)
    if (pipe < cell.from) left = pipe
    else if (pipe >= cell.to) {
      right = pipe
      break
    }
  return { left, right }
}

/** Text appended after a row's last cell, adding the cells in `values`. */
function appendCells(row: Line, values: readonly string[]): TableChange {
  const last = row.cells.at(-1)
  const trailing = last
    ? pipesAround(row, last).right
    : (row.pipes.at(-1) ?? -1)
  const cells = values.map((value) => (value ? ` ${value} |` : '  |')).join('')
  return trailing >= 0
    ? { from: trailing + 1, to: trailing + 1, insert: cells }
    : { from: row.end, to: row.end, insert: ` |${cells}` }
}

/** Insert an empty row before or after line `at`; above the header, the new row becomes the header. */
export function insertRow(
  table: TableText,
  at: number,
  after: boolean,
): TableEdit {
  const columns = line(table, 0).cells.length
  if (at === 0 && !after) {
    const header = line(table, 0),
      delimiter = line(table, 1)
    return {
      changes: [
        { from: header.start, to: header.end, insert: emptyRow(columns) },
        {
          from: delimiter.end,
          to: delimiter.end,
          insert: `\n${prefix(table)}${header.text.slice(header.start - header.from)}`,
        },
      ],
      cell: { line: 0, column: 0 },
    }
  }
  const reference = line(table, after ? Math.max(at, 1) : at)
  const text = `${prefix(table)}${emptyRow(columns)}`
  return after
    ? {
        changes: [
          { from: reference.end, to: reference.end, insert: `\n${text}` },
        ],
        cell: { line: Math.max(at, 1) + 1, column: 0 },
      }
    : {
        changes: [
          { from: reference.from, to: reference.from, insert: `${text}\n` },
        ],
        cell: { line: at, column: 0 },
      }
}

/** Delete line `at`; deleting the header makes the first row the header. Null when the table would be empty. */
export function deleteRow(table: TableText, at: number): TableEdit | null {
  if (at === 0) {
    if (table.lines < 3) return null
    const header = line(table, 0),
      delimiter = line(table, 1),
      first = line(table, 2)
    // A header has as many cells as the delimiter row, or it is no table.
    const width = delimiter.cells.length,
      count = first.cells.length
    const text = (from: number, to: number) =>
      first.text.slice(from - first.from, to - first.from)
    let promoted = text(first.start, first.end)
    if (count < width) {
      const pad = appendCells(first, Array(width - count).fill(''))
      promoted =
        text(first.start, pad.from) + pad.insert + text(pad.from, first.end)
    }
    return {
      changes: [
        { from: header.start, to: header.end, insert: promoted },
        { from: delimiter.end, to: first.end, insert: '' },
        ...(count > width
          ? [appendCells(delimiter, Array(count - width).fill('---'))]
          : []),
      ],
      cell: { line: 0, column: 0 },
    }
  }
  const row = line(table, at)
  return {
    changes: [{ from: line(table, at - 1).end, to: row.end, insert: '' }],
    cell:
      table.lines > 3
        ? { line: Math.min(at, table.lines - 2), column: 0 }
        : { line: 0, column: 0 },
  }
}

/** Insert an empty column before or after `column`. */
export function insertColumn(
  table: TableText,
  column: number,
  after: boolean,
): TableEdit {
  const at = after ? column + 1 : column
  const changes: TableChange[] = []
  for (let index = 0; index < table.lines; index++) {
    const row = line(table, index)
    const value = index === 1 ? '---' : ''
    const cell = row.cells[at]
    if (!cell) {
      // Rows short of the column keep their implicit empty cells.
      if (row.cells.length === at) changes.push(appendCells(row, [value]))
      continue
    }
    const { left } = pipesAround(row, cell)
    const text = value ? ` ${value} |` : '  |'
    changes.push(
      left >= 0
        ? { from: left + 1, to: left + 1, insert: text }
        : { from: row.start, to: row.start, insert: `|${text} ` },
    )
  }
  return { changes, cell: { line: -1, column: at } }
}

/** Delete `column`. Null when it is the table's only column. */
export function deleteColumn(
  table: TableText,
  column: number,
): TableEdit | null {
  const columns = line(table, 0).cells.length
  if (columns < 2) return null
  const changes: TableChange[] = []
  for (let index = 0; index < table.lines; index++) {
    const row = line(table, index)
    if (columns === 2) {
      // One column needs outer pipes, or its header and delimiter read as a
      // heading. The column is deleted as in wider tables and only missing
      // pipes are added, so the cell left, even an empty one, keeps its
      // place and its sizes follow it.
      const cell = row.cells[column]
      let removed: TableChange | null = null
      if (cell) {
        const { left, right } = pipesAround(row, cell)
        removed =
          left >= 0
            ? { from: left, to: right >= 0 ? right : row.end, insert: '' }
            : {
                from: row.start,
                to: right >= 0 ? right + 1 : row.end,
                insert: '',
              }
      }
      const text = (from: number, to: number) =>
        row.text.slice(from - row.from, to - row.from)
      const rest = removed
        ? text(row.start, removed.from) + text(removed.to, row.end)
        : text(row.start, row.end)
      if (!rest.trim()) {
        changes.push({ from: row.start, to: row.end, insert: '|' })
        continue
      }
      const added: TableChange[] = []
      if (!rest.trimStart().startsWith('|')) {
        if (removed?.from === row.start) removed.insert = '|'
        else added.push({ from: row.start, to: row.start, insert: '| ' })
      }
      if (!rest.trimEnd().endsWith('|')) {
        if (removed?.to === row.end) removed.insert += '|'
        else added.push({ from: row.end, to: row.end, insert: ' |' })
      }
      changes.push(...(removed ? [removed] : []), ...added)
      continue
    }
    const cell = row.cells[column]
    if (!cell) continue
    const { left, right } = pipesAround(row, cell)
    let change: TableChange =
      left >= 0
        ? { from: left, to: right >= 0 ? right : row.end, insert: '' }
        : { from: row.start, to: right >= 0 ? right + 1 : row.end, insert: '' }
    // A row left with only spaces would end the table.
    const rest =
      row.text.slice(row.start - row.from, change.from - row.from) +
      row.text.slice(change.to - row.from)
    if (!rest.trim()) change = { from: row.start, to: row.end, insert: '|' }
    changes.push(change)
  }
  return {
    changes,
    cell: {
      line: -1,
      column: Math.max(0, Math.min(column, columns - 2)),
    },
  }
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

const delimiterRow = /^\|?(?:[ \t]*:?-+:?[ \t]*\|)+(?:[ \t]*:?-+:?[ \t]*)?$/
const quoteMarker = /^ {0,3}>[ \t]?/
const heading = /^#{1,6}(?:[ \t]|$)/
const listMarker = /^(?:[-+*]|\d{1,9}[.)])(?:[ \t]+|$)/

/**
 * How many GFM tables start in these lines: a line with a pipe, then a
 * delimiter row with as many cells, outside fenced code. Like the formatted
 * view's parser, a table may start after quote and list markers, and a
 * fence ends with its closing marker or with the quote or list item around
 * it. A table's count of the tables before it is its ordinal, part of the
 * key its stored sizes have.
 */
export function countTables(lines: Iterable<string>) {
  let count = 0,
    fence: { marker: string; quotes: number; indent: number } | null = null,
    previous: string | null = null,
    // The container (quote depth and list column) of the table the lines are in.
    table: string | null = null,
    // The content column of the list item the lines are in, 0 outside lists.
    list = 0
  for (const raw of lines) {
    const lead = raw.length - raw.trimStart().length
    let quotes = 0,
      at = 0
    for (
      let marker = quoteMarker.exec(raw);
      marker;
      marker = quoteMarker.exec(raw.slice(at))
    ) {
      quotes++
      at += marker[0].length
    }
    const text = raw.slice(at)
    const indent = text.length - text.trimStart().length
    const line = text.slice(indent)
    if (fence) {
      if (quotes >= fence.quotes && (!line || indent >= fence.indent)) {
        const marker = /^(`{3,}|~{3,})[ \t]*$/.exec(line)?.[1]
        if (
          marker &&
          marker[0] === fence.marker[0] &&
          marker.length >= fence.marker.length
        )
          fence = null
        continue
      }
      // Its quote or list item ended, and the fence with it.
      fence = null
    }
    const item = listMarker.exec(line)?.[0]
    if (item) list = indent + item.length
    else if (line && Math.max(lead, indent) < list) list = 0
    // Quotes inside the list item come after its marker.
    let content = item ? line.slice(item.length) : line
    for (
      let marker = quoteMarker.exec(content);
      marker && item;
      marker = quoteMarker.exec(content)
    ) {
      quotes++
      content = content.slice(marker[0].length)
    }
    const marker = /^(`{3,}|~{3,})/.exec(content)?.[1]
    if (marker) {
      fence = { marker, quotes, indent: list }
      previous = null
      table = null
      continue
    }
    if (!content.trim()) {
      previous = null
      table = null
      continue
    }
    // A new list item, a heading or another container ends a table, and
    // its rows head no table there.
    const container = `${quotes}:${list}`
    if (
      table !== null &&
      (item || heading.test(content) || container !== table)
    ) {
      table = null
      previous = null
    }
    if (table !== null) continue
    if (heading.test(content)) {
      previous = null
      continue
    }
    if (
      previous !== null &&
      !item &&
      delimiterRow.test(content.trimEnd()) &&
      parseRow(previous).cells.length === parseRow(content).cells.length &&
      parseRow(previous).pipes.length > 0
    ) {
      count++
      table = container
    }
    previous = content
  }
  return count
}
