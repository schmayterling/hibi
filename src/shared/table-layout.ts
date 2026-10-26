export const TABLE_LAYOUT_CHANNELS = {
  read: 'table-layout:read',
  write: 'table-layout:write',
} as const

/** Sizes in CSS pixels; 0 keeps a column or row at its automatic size. */
export type TableLayout = {
  /** Table ordinal and a fingerprint of its header row. */
  key: string
  columns: number[] | null
  rows: number[] | null
  /** Heights of rows past the first 1,000 as index and size pairs, so a long table stores only its sized rows. */
  rowsAfter?: [number, number][]
}

/** How many rows a stored layout lists in order; later rows are stored by index. */
export const LISTED_ROWS = 1000

/** A table's sizes as stored: rows past the first 1,000 by index. */
export function storedTableLayout(table: TableLayout): TableLayout {
  const { key, columns, rows } = table
  if (!rows || rows.length <= LISTED_ROWS) return { key, columns, rows }
  const after: [number, number][] = []
  for (let index = LISTED_ROWS; index < rows.length; index++)
    if (rows[index]) after.push([index, rows[index] as number])
  const listed = rows.slice(0, LISTED_ROWS)
  return {
    key,
    columns,
    rows: listed.some(Boolean) ? listed : null,
    ...(after.length ? { rowsAfter: after } : {}),
  }
}

/** A stored table's sizes with every row in order. */
export function listedTableLayout(table: TableLayout): TableLayout {
  const { key, columns, rows, rowsAfter } = table
  if (!rowsAfter?.length) return { key, columns, rows }
  const listed = [...(rows ?? [])]
  for (const [index, size] of rowsAfter) listed[index] = size
  return { key, columns, rows: Array.from(listed, (size) => size ?? 0) }
}

/** Some of a note's tables: keys to drop and tables to store, applied to the sizes stored when it arrives. */
export type TableLayoutUpdate = { remove: string[]; put: TableLayout[] }

/** A note's tables after an update. */
export function updateTableLayout(
  tables: readonly TableLayout[],
  { remove, put }: TableLayoutUpdate,
): TableLayout[] {
  const replaced = new Set([...remove, ...put.map((table) => table.key)])
  return [...tables.filter((table) => !replaced.has(table.key)), ...put]
}
