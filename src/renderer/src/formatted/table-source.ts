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
