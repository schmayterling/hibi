import type {
  DocumentFocus,
  DocumentSaved,
  DocumentState,
} from '../../shared/desktop.ts'
import { workspaceSyntaxEvents } from '../../shared/workspace-syntax-events.ts'
import { type DocumentRuntime, documentRuntime } from './document-runtime.ts'

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
 * Later edits keep their baseline, but take the saved file identity immediately.
 */
export function acceptSaved(runtime: DocumentRuntime, value: unknown) {
  if (!value || typeof value !== 'object') return
  const saved = value as DocumentSaved
  if (
    ![saved.tabId, saved.id, saved.name].every(
      (field) => typeof field === 'string' && field.length > 0,
    ) ||
    ![saved.revision, saved.contentVersion].every(
      (field) => Number.isSafeInteger(field) && field >= 0,
    ) ||
    typeof saved.ephemeral !== 'boolean' ||
    typeof saved.canAutosave !== 'boolean'
  )
    return
  const retained = runtime.get(saved.tabId)
  if (
    retained?.revision !== saved.revision ||
    retained.contentVersion < saved.contentVersion
  )
    return
  const identity = {
    id: saved.id,
    name: saved.name,
    ephemeral: saved.ephemeral,
    canAutosave: saved.canAutosave,
  }
  const token = runtime.beginSave(saved.tabId)
  if (!token) return
  try {
    const metadata = { ...focusOf(retained), ...identity }
    runtime.acknowledgeSave(
      retained.contentVersion === saved.contentVersion
        ? {
            ...metadata,
            saveReceipt: true,
            savedVersion: saved.contentVersion,
          }
        : metadata,
      token,
      retained.id,
    )
  } finally {
    runtime.endSave(token)
  }
}

function carryFlavorChoice(from: string, to: string) {
  const choice = localStorage.getItem(`hibi:flavor:${from}`)
  if (!choice) return
  localStorage.setItem(`hibi:flavor:${to}`, choice)
  workspaceSyntaxEvents.publish()
}

// The first document transfer loads this module, before any tab can be unsaved.
if (globalThis.window) {
  const identities = new WeakMap<
    object,
    Pick<DocumentState, 'id' | 'revision'>
  >()
  documentRuntime.subscribeDocument((document) => {
    const target = documentRuntime.captureDocument(document.tabId)!
    const previous = identities.get(target)
    if (previous?.id === document.id && previous.revision === document.revision)
      return
    if (
      previous &&
      previous.id !== document.id &&
      previous.revision === document.revision
    )
      carryFlavorChoice(previous.id, document.id)
    identities.set(target, { id: document.id, revision: document.revision })
  })
  window.hibi.onDocumentSaved((saved) => acceptSaved(documentRuntime, saved))
}
