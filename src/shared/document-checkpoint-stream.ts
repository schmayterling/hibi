import { type JournalHead, journalHead } from './document-checkpoint.ts'
import type { SourceStore } from './source-buffer.ts'
import {
  parseTransferHead,
  parseTransferRequest,
  SourceTransferReceiver,
} from './source-transfer.ts'

/** Verifies against an owned native snapshot; a partial checkpoint never writes text. */
export function createCheckpointVerifier(read: (tabId: string) => SourceStore) {
  const streams = new Map<
    string,
    {
      tabId: string
      receiver: SourceTransferReceiver
      current: () => boolean
    }
  >()
  const tabs = new Map<string, string>()
  const forget = (streamId: string) => {
    const stream = streams.get(streamId)
    if (stream && tabs.get(stream.tabId) === streamId) tabs.delete(stream.tabId)
    streams.delete(streamId)
  }
  return {
    begin(value: unknown): JournalHead {
      const head = parseTransferHead(value),
        store = read(head.tabId),
        snapshot = store.snapshot()
      if (
        snapshot.document.tabId !== head.tabId ||
        snapshot.document.revision !== head.revision ||
        snapshot.version !== head.contentVersion ||
        snapshot.utf16Length !== head.length
      )
        throw new Error('The document recovery checkpoint is stale.')
      const previous = tabs.get(head.tabId)
      if (previous) forget(previous)
      let offset = 0
      const current = () => read(head.tabId).ownsCurrentSnapshot(snapshot)
      const receiver = new SourceTransferReceiver(head, (text) => {
        if (!current())
          throw new Error('The document changed during recovery verification.')
        if (snapshot.sliceRaw(offset, offset + text.length) !== text)
          throw new Error('The document recovery checkpoint does not match.')
        offset += text.length
      })
      streams.set(head.streamId, { tabId: head.tabId, receiver, current })
      tabs.set(head.tabId, head.streamId)
      return journalHead(store)
    },
    append(value: unknown) {
      const streamId = (value as { streamId?: string } | null)?.streamId,
        stream = streamId ? streams.get(streamId) : undefined
      if (!stream) throw new Error('The document recovery checkpoint is stale.')
      try {
        if (!stream.current())
          throw new Error('The document changed during recovery verification.')
        stream.receiver.receive(value)
        return stream.receiver.request
      } catch (error) {
        forget(stream.receiver.head.streamId)
        throw error
      }
    },
    finish(value: unknown): JournalHead {
      const request = parseTransferRequest(value),
        stream = streams.get(request.streamId)
      if (!stream) throw new Error('The document recovery checkpoint is stale.')
      try {
        if (
          !stream.current() ||
          stream.receiver.finish().sequence !== request.sequence
        )
          throw new Error('The document changed during recovery verification.')
        return journalHead(read(stream.tabId))
      } finally {
        forget(request.streamId)
      }
    },
    abort(value: unknown) {
      forget(parseTransferRequest(value).streamId)
    },
    clear() {
      streams.clear()
      tabs.clear()
    },
  }
}
