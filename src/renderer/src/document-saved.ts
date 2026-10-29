import type {
  DocumentFocus,
  DocumentSaved,
  DocumentSaveReceipt,
  DocumentState,
} from '../../shared/desktop.ts'
import type { DocumentRuntime, DocumentSaveToken } from './document-runtime.ts'

// Reads only metadata, so the source is not materialized.
const focusOf = ({
  tabId,
  tabs,
  tabsEnabled,
  id,
  ephemeral,
  name,
  dirty,
  revision,
  contentVersion,
  canAutosave,
  sourceId,
}: DocumentState): DocumentFocus => ({
  tabId,
  tabs,
  tabsEnabled,
  id,
  ephemeral,
  name,
  dirty,
  revision,
  contentVersion,
  canAutosave,
  sourceId,
})

/**
 * A save prompt saved this tab, perhaps before a later prompt cancelled. Its
 * retained editor takes the saved baseline and, after Save As, the new file;
 * edits made since the saved version stay unsaved.
 */
export function acceptSaved(
  runtime: DocumentRuntime,
  saved: DocumentSaved,
  acknowledge: (
    document: DocumentSaveReceipt,
    token: DocumentSaveToken,
    expectedId: string,
  ) => void,
  accept: (document: DocumentState, focus: true) => void,
) {
  const retained = runtime.get(saved.tabId)
  if (retained?.revision !== saved.revision) return
  if (retained.contentVersion === saved.contentVersion) {
    const token = runtime.beginSave(saved.tabId)
    try {
      if (token)
        acknowledge(
          {
            ...focusOf(retained),
            ...saved,
            saveReceipt: true,
            savedVersion: saved.contentVersion,
          },
          token,
          retained.id,
        )
    } finally {
      runtime.endSave(token)
    }
  }
  // Inactive tabs show their names from the active tab's list.
  const active = runtime.get()
  if (
    !active?.tabs.some(
      (tab) => tab.id === saved.tabId && tab.name !== saved.name,
    )
  )
    return
  const renamed = runtime.focus({
    ...focusOf(active),
    tabs: active.tabs.map((tab) =>
      tab.id === saved.tabId ? { ...tab, name: saved.name } : tab,
    ),
  })
  if (renamed) accept(renamed, true)
}
