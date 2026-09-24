import type { SidebarItem } from './Sidebar'

export type SidebarRow = {
  item: SidebarItem
  depth: number
  parent: string | null
  position: number
  size: number
  /** Section count through this row, including its own heading. */
  sections: number
  /** Divider count through this row. */
  dividers: number
}

/** Parent links let selection reveal ancestors without searching every item. */
export function sidebarParents(items: readonly SidebarItem[]) {
  const parents = new Map<string, string | null>()
  const stack = [{ items, index: 0, parent: null as string | null }]
  while (stack.length) {
    const frame = stack.at(-1)!
    const item = frame.items[frame.index++]
    if (!item) {
      stack.pop()
      continue
    }
    parents.set(item.id, frame.parent)
    if (item.children?.length)
      stack.push({ items: item.children, index: 0, parent: item.id })
  }
  return parents
}

export function sidebarRows(
  items: readonly SidebarItem[],
  expanded: ReadonlySet<string>,
  collapsible: boolean,
) {
  const rows: SidebarRow[] = []
  const indices = new Map<string, number>()
  const stack = [{ items, index: 0, parent: null as string | null }]
  let sections = 0
  let dividers = 0
  while (stack.length) {
    const frame = stack.at(-1)!
    const item = frame.items[frame.index++]
    if (!item) {
      stack.pop()
      continue
    }
    if (item.section) sections++
    if (item.divider) dividers++
    indices.set(item.id, rows.length)
    rows.push({
      item,
      parent: frame.parent,
      depth: stack.length - 1,
      position: frame.index,
      size: frame.items.length,
      sections,
      dividers,
    })
    if (item.children?.length && (!collapsible || expanded.has(item.id)))
      stack.push({ items: item.children, index: 0, parent: item.id })
  }
  return { rows, indices, sections }
}

export function sidebarRowTop(
  rows: readonly SidebarRow[],
  index: number,
  rowHeight: number,
  sectionHeight: number,
) {
  const row = rows[index]
  return row ? index * rowHeight + row.sections * sectionHeight : 0
}

/** Includes a row's optional section heading. */
export function sidebarBlockTop(
  rows: readonly SidebarRow[],
  index: number,
  rowHeight: number,
  sectionHeight: number,
) {
  return (
    sidebarRowTop(rows, index, rowHeight, sectionHeight) -
    (rows[index]?.item.section ? sectionHeight : 0)
  )
}

/** First block whose bottom is after the requested scroll offset. */
export function sidebarRowAt(
  rows: readonly SidebarRow[],
  offset: number,
  rowHeight: number,
  sectionHeight: number,
) {
  let from = 0,
    to = rows.length
  while (from < to) {
    const middle = Math.floor((from + to) / 2)
    if (
      sidebarRowTop(rows, middle, rowHeight, sectionHeight) + rowHeight <=
      offset
    )
      from = middle + 1
    else to = middle
  }
  return Math.min(from, Math.max(0, rows.length - 1))
}

export function sidebarWindow(
  rows: readonly SidebarRow[],
  top: number,
  height: number,
  rowHeight: number,
  sectionHeight: number,
  overscan = 8,
) {
  if (!rows.length || height <= 0) return { from: 0, to: 0 }
  return {
    from: Math.max(
      0,
      sidebarRowAt(rows, top, rowHeight, sectionHeight) - overscan,
    ),
    to: Math.min(
      rows.length,
      sidebarRowAt(rows, top + height, rowHeight, sectionHeight) + overscan + 1,
    ),
  }
}
