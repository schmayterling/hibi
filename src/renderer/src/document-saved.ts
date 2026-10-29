import type {
  DocumentFocus,
  DocumentSaved,
  DocumentState,
} from '../../shared/desktop.ts'
import type { DocumentRuntime } from './document-runtime.ts'

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
 * retained editor takes the saved baseline and, after Save As, the new file.
 * A tab edited since the saved version stays unsaved and refreshes on focus.
 */
export function acceptSaved(runtime: DocumentRuntime, saved: DocumentSaved) {
  const retained = runtime.get(saved.tabId)
  if (
    retained?.revision !== saved.revision ||
    retained.contentVersion !== saved.contentVersion
  )
    return
  const token = runtime.beginSave(saved.tabId)
  if (!token) return
  try {
    // Inactive tabs take their names from the active tab's list, which the
    // acknowledgment below publishes.
    const active = runtime.get()
    if (
      active?.tabs.some(
        (tab) => tab.id === saved.tabId && tab.name !== saved.name,
      )
    )
      runtime.focus({
        ...focusOf(active),
        tabs: active.tabs.map((tab) =>
          tab.id === saved.tabId ? { ...tab, name: saved.name } : tab,
        ),
      })
    runtime.acknowledgeSave(
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

// The first document transfer loads this module, before any tab can be unsaved.
globalThis.window?.hibi.onDocumentSaved((saved) => {
  void import('./document-runtime.ts').then(({ documentRuntime }) =>
    acceptSaved(documentRuntime, saved),
  )
})
