import type { DocumentSession } from '../../shared/document-session.ts'
import {
  keptHistory,
  parseUndoHistory,
  restoredHistory,
} from '../../shared/undo-history.ts'
import { documentRuntime } from './document-runtime.ts'

/** Tabs whose undo steps changed with a save and are not kept yet. */
const unsent = new Set<string>()
let idle: number | undefined
let keeping: Promise<boolean> | undefined
const keeps = () =>
  (keeping ??= window.hibi.getKeepUndoHistory().catch(() => false))

/** Undo steps kept for a saved note's file join the session that opened it. */
export async function restore(tabId: string, session: DocumentSession) {
  if (!(await keeps())) return
  try {
    const stored = await window.hibi.readUndoHistory(
      tabId,
      session.savedSnapshot().version,
    )
    if (!stored) return
    const history = parseUndoHistory(stored)
    documentRuntime.restoreHistory(
      tabId,
      session,
      history.units,
      restoredHistory(
        history,
        documentRuntime.primaryViewId(tabId) ?? undefined,
      ),
    )
  } catch (error) {
    console.error('Could not restore undo history:', error)
  }
}

/** After a save, the steps up to it are kept once input is idle. */
export function keep(tabId: string) {
  unsent.add(tabId)
  if (idle === undefined)
    idle = requestIdleCallback(() => void flush(), { timeout: 5000 })
}

export async function flush() {
  if (idle !== undefined) cancelIdleCallback(idle)
  idle = undefined
  const tabs = [...unsent]
  unsent.clear()
  if (!tabs.length || !(await keeps())) return
  await Promise.all(
    tabs.map(async (tabId) => {
      const session = documentRuntime.session(tabId)
      const history = session && keptHistory(session)
      if (history)
        await window.hibi
          .storeUndoHistory(tabId, history)
          .catch((error: unknown) =>
            console.error('Could not keep undo history:', error),
          )
    }),
  )
}

export async function setKeep(next: boolean) {
  await window.hibi.setKeepUndoHistory(next)
  keeping = Promise.resolve(next)
  if (!next) unsent.clear()
}

/** Forgets open notes' undo steps and every note's kept ones. */
export async function clear() {
  unsent.clear()
  documentRuntime.clearHistory()
  await window.hibi.clearUndoHistory()
}
