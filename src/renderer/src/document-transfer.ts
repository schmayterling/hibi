import type {
  DesktopApi,
  DocumentFocus,
  DocumentState,
} from '../../shared/desktop.ts'
import type {
  DocumentMetadata,
  DocumentTransfer,
  DocumentTransferApi,
  LoadedDocument,
} from '../../shared/document-transfer.ts'
import type { SourceSnapshot } from '../../shared/source-buffer.ts'

const loaded = new WeakMap<DocumentState, LoadedDocument>()
export const loadedDocument = (document: DocumentState) => loaded.get(document)

export function sourceDocument(
  metadata: DocumentFocus,
  current: SourceSnapshot,
  saved: SourceSnapshot,
): DocumentState {
  let text: string | undefined, savedText: string | undefined
  return Object.freeze({
    ...metadata,
    get markdown() {
      text ??= current.materialize()
      return text
    },
    get savedMarkdown() {
      savedText ??= saved.materialize()
      return savedText
    },
  })
}

/** Hydrate inside the renderer: neither IPC nor contextBridge copies a complete note. */
export function documentTransferApi(
  native: DesktopApi & DocumentTransferApi,
  metadata?: (
    value: DocumentMetadata,
  ) => DocumentState | null | Promise<DocumentState | null>,
): DesktopApi {
  const pending = new Map<string, Promise<DocumentState>>()
  const load = async (wire: DocumentTransfer) => {
    const transfer = { ...wire, documentTransfer: { ...wire.documentTransfer } }
    const { loadDocumentTransfer, parseTransferHead } = await import(
      './document-transfer-load.ts'
    )
    const head = parseTransferHead(transfer.documentTransfer),
      previous = pending.get(head.streamId)
    if (previous) return previous
    const work = loadDocumentTransfer(native, transfer, loaded).finally(() =>
      pending.delete(head.streamId),
    )
    pending.set(head.streamId, work)
    return work
  }
  const hydrate = async (value: unknown): Promise<unknown> => {
    if (!value || typeof value !== 'object') return value
    if ('documentTransfer' in value) return load(value as DocumentTransfer)
    if ('documentMetadata' in value) {
      const wire = value as DocumentMetadata
      return (
        (await metadata?.(wire)) ??
        load(await native.openDocumentTransfer(wire.tabId))
      )
    }
    if ('document' in value) {
      const result = value as { document: unknown }
      return { ...result, document: await hydrate(result.document) }
    }
    return value
  }
  const wrap = (value: unknown, name?: string): unknown => {
    if (typeof value === 'function')
      return (...args: unknown[]) => {
        const result = value(...args)
        if (!(result instanceof Promise)) return result
        const response = result.then(hydrate)
        return name === 'getDocument'
          ? response.catch((error) => {
              if (
                !/The document (?:changed during transfer|transfer is stale or out of order)|local edits waiting to synchronize/.test(
                  String(error),
                )
              )
                throw error
              return value(...args).then(hydrate)
            })
          : response
      }
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => !key.endsWith('DocumentTransfer'))
          .map(([key, child]) => [key, wrap(child, key)]),
      )
    return value
  }
  const api = wrap(native) as DesktopApi
  const bootstrap = api.bootstrap?.document
  if (bootstrap) {
    // Preload retains one startup stream; every consumer shares its hydration.
    let startup: ReturnType<typeof bootstrap> | undefined
    api.bootstrap.document = () => (startup ??= bootstrap())
  }
  return api
}
