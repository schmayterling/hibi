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
  while (listed.length && !listed.at(-1)) listed.pop()
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

/** One column width or row height of a table, 0 for automatic. */
export type TableSize = {
  key: string
  axis: 'column' | 'row'
  index: number
  size: number
}

/**
 * Some of a note's tables, applied to the sizes stored when it arrives:
 * keys to drop, tables to store whole (new or re-keyed ones), and single
 * sizes to set, which leave a table's other sizes as they are stored.
 */
export type TableLayoutUpdate = {
  remove: string[]
  put: TableLayout[]
  set?: TableSize[]
}

/** A note's tables after an update; tables with every row listed. */
export function updateTableLayout(
  tables: readonly TableLayout[],
  { remove, put, set = [] }: TableLayoutUpdate,
): TableLayout[] {
  const replaced = new Set([...remove, ...put.map((table) => table.key)])
  const next = [
    ...tables.filter((table) => !replaced.has(table.key)),
    ...put,
  ].map(listedTableLayout)
  for (const { key, axis, index, size } of set) {
    let at = next.findIndex((table) => table.key === key)
    if (at < 0) at = next.push({ key, columns: null, rows: null }) - 1
    const table = next[at] as TableLayout
    const sizes = [...((axis === 'column' ? table.columns : table.rows) ?? [])]
    while (sizes.length <= index) sizes.push(0)
    sizes[index] = size
    while (sizes.length && !sizes.at(-1)) sizes.pop()
    next[at] = {
      ...table,
      [axis === 'column' ? 'columns' : 'rows']: sizes.length ? sizes : null,
    }
  }
  // A table whose sizes are all automatic again has no entry.
  return next.filter(
    (table) => table.columns?.some(Boolean) || table.rows?.some(Boolean),
  )
}

/** The sizes that differ between two versions of a table, to set one by one. */
export function tableSizeChanges(
  before: TableLayout,
  after: TableLayout,
): TableSize[] {
  const changes: TableSize[] = []
  for (const axis of ['column', 'row'] as const) {
    const a = (axis === 'column' ? before.columns : before.rows) ?? [],
      b = (axis === 'column' ? after.columns : after.rows) ?? []
    for (let index = 0; index < Math.max(a.length, b.length); index++)
      if ((a[index] ?? 0) !== (b[index] ?? 0))
        changes.push({ key: after.key, axis, index, size: b[index] ?? 0 })
  }
  return changes
}
