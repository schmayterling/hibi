import type { TableLayout } from '../../shared/table-layout'

/*
 * Table column widths and row heights are view state, not Markdown: each tab
 * stores them by table key, and both formatted editors read and write the
 * same store.
 */

// Sizes survive tab switches in this window.
const session = new Map<string, TableLayout[]>()

/** A table's key: its ordinal in the note and a hash of its header cells' text, so edits elsewhere keep its sizes. */
export function tableKey(index: number, header: readonly string[]) {
  let text = String(header.length)
  for (const cell of header) text += `\t${cell}`
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++)
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193)
  return `${index}:${(hash >>> 0).toString(36)}`
}

/** A tab's table sizes this window has stored, if any. */
export const storedTableLayouts = (tabId: string) => session.get(tabId)

/** A tab's table sizes: stored in this window, or read from the workspace (null outside one). */
export function readTableLayouts(
  tabId: string,
): TableLayout[] | Promise<TableLayout[] | null> {
  return session.get(tabId) ?? window.hibi.readTableLayout(tabId)
}

/** Store a tab's table sizes and save them in the workspace. */
export function writeTableLayouts(tabId: string, tables: TableLayout[]) {
  session.set(tabId, tables)
  void window.hibi
    .writeTableLayout(tabId, tables)
    .catch((error: unknown) =>
      console.error('table sizes could not be saved:', error),
    )
}
