import type { DocumentState } from '../../shared/desktop.ts'
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
import { sourceDocument } from './document-transfer.ts'
// Every retained source arrives through here first, so save reports start with it.
import './document-saved.ts'

/** Stream validation and publication load only when a document transfer starts. */
export function loadDocumentTransfer(
  native: DocumentTransferApi,
  wire: DocumentTransfer,
  loaded: WeakMap<DocumentState, LoadedDocument>,
  pending: Map<string, Promise<DocumentState>>,
  retry = true,
): Promise<DocumentState> {
  const head = parseTransferHead(wire.documentTransfer),
    previous = pending.get(head.streamId)
  if (previous) return previous
  const work = readDocumentTransfer(native, wire, loaded)
    .catch(async (error) => {
      if (
        !retry ||
        !String(error).includes(
          'The document transfer is stale or out of order.',
        )
      )
        throw error
      // Another reply may have consumed this stream before this one arrived.
      const current = await native.openDocumentTransfer(wire.tabId)
      if (
        current.tabId !== wire.tabId ||
        current.sourceId !== wire.sourceId ||
        current.revision !== wire.revision ||
        current.contentVersion !== wire.contentVersion ||
        current.documentTransfer.streamId === head.streamId
      )
        throw error
      return loadDocumentTransfer(native, current, loaded, pending, false)
    })
    .finally(() => pending.delete(head.streamId))
  pending.set(head.streamId, work)
  return work
}

async function readDocumentTransfer(
  native: DocumentTransferApi,
  wire: DocumentTransfer,
  loaded: WeakMap<DocumentState, LoadedDocument>,
): Promise<DocumentState> {
  const head = parseTransferHead(wire.documentTransfer)
  if (
    head.tabId !== wire.tabId ||
    head.revision !== wire.revision ||
    head.contentVersion !== wire.contentVersion ||
    ![wire.sourceLength, wire.savedLength].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    ) ||
    typeof wire.sameSource !== 'boolean' ||
    (wire.sameSource && wire.sourceLength !== wire.savedLength) ||
    head.length !== wire.sourceLength + (wire.sameSource ? 0 : wire.savedLength)
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
    const document = sourceDocument(metadata, snapshot, baseline)
    loaded.set(document, {
      store: source,
      current: snapshot,
      saved: baseline,
    })
    return document
  } finally {
    await native.abortDocumentTransfer(receiver.request).catch(() => {})
  }
}
