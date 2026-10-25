import type { DesktopApi, DocumentState } from '../../shared/desktop.ts'
import type {
  DocumentTransfer,
  DocumentTransferApi,
  LoadedDocument,
} from '../../shared/document-transfer.ts'
import { SourceStore } from '../../shared/source-buffer.ts'
import {
  parseTransferHead,
  SourceTransferReceiver,
} from '../../shared/source-transfer.ts'

const loaded = new WeakMap<DocumentState, LoadedDocument>()
export const loadedDocument = (document: DocumentState) => loaded.get(document)

/** Hydrate inside the renderer: neither IPC nor contextBridge copies a complete note. */
export function documentTransferApi(
  native: DesktopApi & DocumentTransferApi,
): DesktopApi {
  const pending = new Map<string, Promise<DocumentState>>()
  const load = (wire: DocumentTransfer) => {
    const head = parseTransferHead(wire.documentTransfer),
      previous = pending.get(head.streamId)
    if (previous) return previous
    const work = (async () => {
      if (
        head.tabId !== wire.tabId ||
        head.revision !== wire.revision ||
        head.contentVersion !== wire.contentVersion ||
        ![wire.sourceLength, wire.savedLength].every(
          (value) => Number.isSafeInteger(value) && value >= 0,
        ) ||
        typeof wire.sameSource !== 'boolean' ||
        (wire.sameSource && wire.sourceLength !== wire.savedLength) ||
        head.length !==
          wire.sourceLength + (wire.sameSource ? 0 : wire.savedLength)
      )
        throw new Error('Invalid document transfer length.')
      const store = SourceStore.loader(wire, wire.contentVersion),
        saved = wire.sameSource ? null : SourceStore.loader(wire, 0)
      let offset = 0
      const receiver = new SourceTransferReceiver(head, (text) => {
        const current = Math.min(
          text.length,
          Math.max(0, wire.sourceLength - offset),
        )
        if (current) store.append(text.slice(0, current))
        if (current < text.length) saved!.append(text.slice(current))
        offset += text.length
      })
      try {
        while (
          !receiver.receive(await native.readDocumentTransfer(receiver.request))
        ) {}
        const ack = await native.finishDocumentTransfer(receiver.finish())
        if (
          ack.tabId !== wire.tabId ||
          ack.revision !== wire.revision ||
          ack.contentVersion !== wire.contentVersion
        )
          throw new Error('The document changed during transfer. Try again.')
        const source = store.finish(),
          snapshot = source.snapshot(),
          baseline = saved?.finish().snapshot() ?? snapshot
        const {
          documentTransfer: _transfer,
          sourceLength: _sourceLength,
          savedLength: _savedLength,
          sameSource: _same,
          ...metadata
        } = wire
        let text: string | undefined, savedText: string | undefined
        const document: DocumentState = Object.freeze({
          ...metadata,
          get markdown() {
            text ??= snapshot.materialize()
            return text
          },
          get savedMarkdown() {
            savedText ??= baseline.materialize()
            return savedText
          },
        })
        loaded.set(document, {
          store: source,
          current: snapshot,
          saved: baseline,
        })
        return document
      } finally {
        await native.abortDocumentTransfer(receiver.request).catch(() => {})
      }
    })().finally(() => pending.delete(head.streamId))
    pending.set(head.streamId, work)
    return work
  }
  const hydrate = async (value: unknown): Promise<unknown> => {
    if (!value || typeof value !== 'object') return value
    if ('documentTransfer' in value) return load(value as DocumentTransfer)
    if ('document' in value) {
      const result = value as { document: unknown }
      return { ...result, document: await hydrate(result.document) }
    }
    return value
  }
  const wrap = (value: unknown, name = ''): unknown => {
    if (typeof value === 'function')
      return (...args: unknown[]) => {
        const result = value(...args)
        if (!(result instanceof Promise)) return result
        const response = result.then(hydrate)
        return name === 'getDocument'
          ? response.catch((error) => {
              if (
                !/The document (?:changed during transfer|transfer is stale or out of order)/.test(
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
        Object.entries(value).map(([key, child]) => [key, wrap(child, key)]),
      )
    return value
  }
  return wrap(native) as DesktopApi
}
