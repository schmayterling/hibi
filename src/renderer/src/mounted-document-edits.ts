import type { DocumentState } from '../../shared/desktop.ts'
import type {
  SourceEditRequest,
  SourceEditResult,
} from '../../shared/document-edits.ts'
import type { ViewId, ViewTarget } from '../../shared/foundation-contracts.ts'
import { matchesProjectionIdentity } from './document-projection-identity.ts'

type EditorKind = 'source' | 'rich'
type MountedHandler = {
  tabId: string
  view: ViewTarget
  apply: (view: ViewTarget, request: SourceEditRequest) => SourceEditResult
}
const handlers = new Map<ViewId, Partial<Record<EditorKind, MountedHandler>>>()
let applying = false

export const mountedDocumentEdits = {
  register(
    tabId: string,
    view: ViewTarget,
    kind: EditorKind,
    apply: MountedHandler['apply'],
  ) {
    const adapters = handlers.get(view.viewId) ?? {}
    const entry = { tabId, view, apply }
    adapters[kind] = entry
    handlers.set(view.viewId, adapters)
    return () => {
      if (adapters[kind] !== entry) return
      delete adapters[kind]
      if (!adapters.source && !adapters.rich) handlers.delete(view.viewId)
    }
  },
  apply(
    document: DocumentState,
    views: readonly ViewTarget[],
    request: SourceEditRequest,
  ): SourceEditResult {
    if (applying)
      return { status: 'busy', message: 'An edit is already being applied.' }
    const kinds: readonly EditorKind[] = ['source', 'rich']
    const projectionId = request.projectionId
    const allowed =
      projectionId === undefined
        ? kinds
        : kinds.filter((kind) =>
            matchesProjectionIdentity(kind, document, projectionId),
          )
    if (!allowed.length)
      return {
        status: 'stale',
        message: 'The editor projection changed. Review the edits again.',
      }
    applying = true
    try {
      for (const view of views)
        for (const kind of allowed) {
          const adapter = handlers.get(view.viewId)?.[kind]
          if (
            adapter?.tabId !== document.tabId ||
            adapter.view.viewGeneration !== view.viewGeneration ||
            adapter.view.documentId !== view.documentId ||
            adapter.view.documentGeneration !== view.documentGeneration
          )
            continue
          const result = adapter.apply(view, request)
          if (result.status !== 'unsupported-view') return result
        }
      return {
        status: 'unsupported-view',
        message: 'This mounted editor cannot apply these source edits.',
      }
    } finally {
      applying = false
    }
  },
}
