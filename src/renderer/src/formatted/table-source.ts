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
 * Where a table row's text starts on its line: after the markers of the
 * quotes around the table. List indentation is padding the row skips.
 */
export function rowStart(line: string, quotes: number) {
  let at = 0
  for (let depth = 0; depth < quotes; depth++) {
    const marker = /^[ \t]{0,3}>[ \t]?/.exec(line.slice(at))
    if (!marker) break
    at += marker[0].length
  }
  return at
}

/** A table's lines: 0 is the header, 1 the delimiter row, then the body rows. */
export type TableText = {
  lines: number
  line(index: number): { from: number; text: string }
  /** Quotes around the table, whose markers start its lines. */
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
  const at = rowStart(text, table.quotes)
  const start = from + at + /^[ \t]*/.exec(text.slice(at))![0].length
  return {
    ...parseRow(text.slice(at), from + at),
    from,
    start,
    end: from + text.length,
    text,
  }
}

/** Quote markers and indentation that start the table's lines. */
const prefix = (row: Line) => row.text.slice(0, row.start - row.from)

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
          insert: `\n${prefix(header)}${header.text.slice(header.start - header.from)}`,
        },
      ],
      cell: { line: 0, column: 0 },
    }
  }
  const reference = line(table, after ? Math.max(at, 1) : at)
  const text = `${prefix(reference)}${emptyRow(columns)}`
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
      first = line(table, 2)
    return {
      changes: [
        {
          from: header.start,
          to: header.end,
          insert: first.text.slice(first.start - first.from),
        },
        { from: line(table, 1).end, to: first.end, insert: '' },
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

/** Swap body row `at` with the row `by` lines away. */
export function moveRow(
  table: TableText,
  at: number,
  by: -1 | 1,
): TableEdit | null {
  const target = at + by
  if (at < 2 || target < 2 || target >= table.lines) return null
  const a = line(table, Math.min(at, target)),
    b = line(table, Math.max(at, target))
  return {
    changes: [
      { from: a.from, to: a.end, insert: b.text },
      { from: b.from, to: b.end, insert: a.text },
    ],
    cell: { line: target, column: 0 },
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
  if (line(table, 0).cells.length < 2) return null
  const changes: TableChange[] = []
  for (let index = 0; index < table.lines; index++) {
    const row = line(table, index)
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
      column: Math.max(0, Math.min(column, line(table, 0).cells.length - 2)),
    },
  }
}

/** Swap `column` with the column `by` away, alignment included. */
export function moveColumn(
  table: TableText,
  column: number,
  by: -1 | 1,
): TableEdit | null {
  const target = column + by
  const columns = line(table, 0).cells.length
  if (target < 0 || target >= columns) return null
  const [low, high] = column < target ? [column, target] : [target, column]
  const changes: TableChange[] = []
  for (let index = 0; index < table.lines; index++) {
    const row = line(table, index)
    const text = (cell: TableCell | undefined) =>
      cell ? row.text.slice(cell.from - row.from, cell.to - row.from) : ''
    const a = row.cells[low],
      b = row.cells[high]
    if (!a) continue
    if (b) {
      changes.push(
        { from: a.from, to: a.to, insert: text(b) },
        { from: b.from, to: b.to, insert: text(a) },
      )
      continue
    }
    // The row ends before `high`: it is written again with its cell moved out there.
    const cells = row.cells.map(text)
    while (cells.length <= high) cells.push('')
    ;[cells[low], cells[high]] = [cells[high]!, cells[low]!]
    changes.push({
      from: row.start,
      to: row.end,
      insert: `|${cells.map((cell) => (cell ? ` ${cell} |` : '  |')).join('')}`,
    })
  }
  return { changes, cell: { line: -1, column: target } }
}

/** Set a column's alignment in the delimiter row. */
export function alignColumn(
  table: TableText,
  column: number,
  align: TableAlignment,
): TableEdit | null {
  const delimiter = line(table, 1)
  const cell = delimiter.cells[column]
  if (!cell) return null
  const current = delimiter.text.slice(
    cell.from - delimiter.from,
    cell.to - delimiter.from,
  )
  const dashes = '-'.repeat(Math.max(3, current.replace(/[^-]/g, '').length))
  const insert =
    align === 'left'
      ? `:${dashes}`
      : align === 'right'
        ? `${dashes}:`
        : align === 'center'
          ? `:${dashes}:`
          : dashes
  return {
    changes:
      alignments(current)[0] === align
        ? []
        : [{ from: cell.from, to: cell.to, insert }],
    cell: { line: -1, column },
  }
}
