import {
  listedTableLayout,
  storedTableLayout,
  type TableLayout,
  type TableLayoutUpdate,
  updateTableLayout,
} from '../../shared/table-layout.ts'

/*
 * Table column widths and row heights are view state, not Markdown: each tab
 * stores them by table key, and both formatted editors read and write the
 * same store.
 */

// Sizes survive tab switches in this window.
const session = new Map<string, TableLayout[]>()
const listeners = new Map<string, Set<() => void>>()
/** Each tab's saves, one after another. */
const writing = new Map<string, Promise<void>>()

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
  return (
    session.get(tabId) ??
    window.hibi
      .readTableLayout(tabId)
      .then((tables) => tables?.map(listedTableLayout) ?? null)
  )
}

const changed = (tabId: string) => {
  for (const listener of listeners.get(tabId) ?? []) listener()
}

/**
 * Update some of a tab's tables on the sizes stored now, here and in the
 * workspace, so that views and windows of the tab never write back each
 * other's stale copies. `loaded` is what the caller read when this window
 * had stored nothing yet.
 */
export function updateTableLayouts(
  tabId: string,
  loaded: readonly TableLayout[],
  update: TableLayoutUpdate,
) {
  session.set(tabId, updateTableLayout(session.get(tabId) ?? loaded, update))
  save(tabId, update)
  changed(tabId)
}

/** Call `listener` after a tab's sizes change in this window; returns a function that stops. */
export function subscribeTableLayouts(tabId: string, listener: () => void) {
  const set = listeners.get(tabId) ?? new Set()
  listeners.set(tabId, set.add(listener))
  return () => {
    set.delete(listener)
    if (!set.size) listeners.delete(tabId)
  }
}

/**
 * Rows past the first 1,000 are stored by index, and size changes go in
 * batches of at most 1,000, so long tables stay within the workspace's
 * bounds. Sizes made automatic go first, so no batch holds more sizes than
 * the update ends with, and each batch waits for the one before it: a
 * rejected batch stops the rest.
 */
function save(tabId: string, update: TableLayoutUpdate) {
  const set = [...(update.set ?? [])].sort(
    (a, b) => Number(b.size === 0) - Number(a.size === 0),
  )
  const parts: TableLayoutUpdate[] = [
    {
      ...update,
      put: update.put.map(storedTableLayout),
      set: set.slice(0, 1000),
    },
  ]
  for (let at = 1000; at < set.length; at += 1000)
    parts.push({ remove: [], put: [], set: set.slice(at, at + 1000) })
  // After every batch of the tab's earlier saves, so that batches of two
  // saves never interleave; a rejected batch stops only its own save.
  const saved = (writing.get(tabId) ?? Promise.resolve())
    .then(async () => {
      for (const part of parts) await window.hibi.writeTableLayout(tabId, part)
    })
    .catch((error: unknown) =>
      console.error('table sizes could not be saved:', error),
    )
  writing.set(tabId, saved)
  void saved.then(() => {
    if (writing.get(tabId) === saved) writing.delete(tabId)
  })
}
