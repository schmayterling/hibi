/** Physical line ancestry across list dedenting and quote marker removal. */
export type BlockLines = {
  source: string
  starts: number[]
  parent: BlockLines | undefined
  from: number | ((row: number) => number)
  read?: (row: number) => string | undefined
}

export const sourceLines = (
  source: string,
  parent?: BlockLines,
  from: BlockLines['from'] = 0,
): BlockLines => ({ source, parent, from, starts: [0] })

/** Resolve a container offset only if physical provenance is requested. */
export function relativeLines(source: string, parent: BlockLines, at: number) {
  let row: number | undefined
  return sourceLines(source, parent, (line) => {
    row ??= blockRow(parent, at)
    return row + line
  })
}

function nextLine(lines: BlockLines) {
  const at = lines.starts.at(-1)!
  if (at > lines.source.length) return false
  const end = lines.source.indexOf('\n', at)
  lines.starts.push(end < 0 ? lines.source.length + 1 : end + 1)
  return true
}

/** Cache each newline once, including when native containers re-read a prefix. */
export function blockRow(lines: BlockLines, at: number) {
  const scanned = lines.starts.length
  while (lines.starts.at(-1)! <= at && nextLine(lines)) {
    /* Advance the index. */
  }
  if (lines.starts.length !== scanned) return lines.starts.length - 2
  let low = 0,
    high = lines.starts.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (lines.starts[middle]! <= at) low = middle + 1
    else high = middle
  }
  return low - 1
}

export function blockLine(lines: BlockLines, row: number) {
  if (lines.read) return lines.read(row)
  while (lines.starts.length <= row + 1 && nextLine(lines)) {
    /* Advance the index. */
  }
  const at = lines.starts[row]
  if (at === undefined || at > lines.source.length) return
  return lines.source.slice(
    at,
    (lines.starts[row + 1] ?? lines.source.length + 1) - 1,
  )
}

/** Outdented markers belong to the first ancestor that preserves their columns. */
export function blockOrigin(lines: BlockLines, row: number) {
  while (lines.parent) {
    const next =
      typeof lines.from === 'number' ? lines.from + row : lines.from(row)
    if (blockLine(lines, row) !== blockLine(lines.parent, next)) break
    row = next
    lines = lines.parent
  }
  return { lines, row }
}
