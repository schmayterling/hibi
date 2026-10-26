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

/** A document state read after its tab closed; its source is gone. */
export class StaleDocumentError extends Error {
  override name = 'StaleDocumentError'
}

type Source = {
  current: SourceSnapshot
  saved: SourceSnapshot
  text?: string
  savedText: { value?: string }
}
// Closures from old renders can hold a state long after its tab closes, so a
// state reaches its source only through this map, which closing the tab clears.
const sources = new WeakMap<DocumentState, Source>()
const tabStates = new Map<string, Set<WeakRef<DocumentState>>>()

const sourceOf = (document: DocumentState) => {
  const source = sources.get(document)
  if (!source) throw new StaleDocumentError('This tab is closed.')
  return source
}

/** The source of a state whose tab is still open. */
export const documentSnapshot = (document: DocumentState) =>
  sources.get(document)?.current

export function sourceDocument(
  metadata: DocumentFocus,
  current: SourceSnapshot,
  saved: SourceSnapshot,
  savedText: { value?: string } = {},
): DocumentState {
  const document: DocumentState = Object.freeze({
    ...metadata,
    get markdown() {
      const source = sourceOf(document)
      source.text ??= source.current.materialize()
      return source.text
    },
    get savedMarkdown() {
      const source = sourceOf(document)
      source.savedText.value ??= source.saved.materialize()
      return source.savedText.value
    },
  })
  sources.set(document, { current, saved, savedText })
  let states = tabStates.get(metadata.tabId)
  if (!states) {
    states = new Set()
    tabStates.set(metadata.tabId, states)
  }
  states.add(new WeakRef(document))
  // Forget collected states at each doubling; a long session makes many.
  if (states.size >= 64 && !(states.size & (states.size - 1)))
    for (const state of states) if (!state.deref()) states.delete(state)
  return document
}

/** Release a closed tab's sources: its states throw `StaleDocumentError` when read. */
export function releaseDocuments(tabId: string) {
  for (const state of tabStates.get(tabId) ?? []) {
    const document = state.deref()
    if (!document) continue
    sources.delete(document)
    loaded.delete(document)
  }
  tabStates.delete(tabId)
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
    // Start before other readers can consume preload's one startup stream.
    const startup = bootstrap()
    void startup.catch(() => {})
    api.bootstrap.document = () => startup
  }
  return api
}
