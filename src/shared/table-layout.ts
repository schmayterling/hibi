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
