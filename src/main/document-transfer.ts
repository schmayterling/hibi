import { randomUUID } from 'node:crypto'
import type { DocumentState } from '../shared/desktop'
import type { DocumentTransfer } from '../shared/document-transfer'
import {
  parseTransferRequest,
  SourceTransferSender,
} from '../shared/source-transfer'
import { documentSources } from './document'

/** Native snapshots remain authoritative throughout an acknowledged read. */
export function createDocumentTransfers() {
  type Source = NonNullable<ReturnType<typeof documentSources.get>>
  type Stream = {
    owner: number
    source: Source
    wire: DocumentTransfer
    sender: SourceTransferSender
    metadata: string
    key: string
    current: () => boolean
  }
  const streams = new Map<string, Stream>()
  const known = new Map<number, WeakSet<Source['store']>>()
  const identities = new WeakMap<object, string>()
  const tabs = new Map<string, string>()
  const close = (id: string) => {
    const stream = streams.get(id)
    if (!stream) return
    const key = stream.key
    if (tabs.get(key) === id) tabs.delete(key)
    stream.sender.close()
    streams.delete(id)
  }
  const lookup = (owner: number, value: unknown) => {
    const request = parseTransferRequest(value),
      stream = streams.get(request.streamId)
    if (!stream || stream.owner !== owner)
      throw new Error('The document transfer is stale or out of order.')
    if (!stream.current()) {
      close(request.streamId)
      throw new Error('The document changed during transfer. Try again.')
    }
    return { request, stream }
  }
  const encode = (
    owner: number,
    value: unknown,
    immutable: boolean,
    force: boolean,
  ): unknown => {
    if (!value || typeof value !== 'object') return value
    const source = documentSources.get(value as DocumentState)
    if (source) {
      const state = value as DocumentState,
        key = `${owner}:${immutable ? `saved:${state.contentVersion}:` : 'load:'}${state.tabId}`
      const identity = source.store ?? source.current
      let sourceId = identities.get(identity)
      if (!sourceId) {
        sourceId = randomUUID()
        identities.set(identity, sourceId)
      }
      const metadata = {
        sourceId,
        tabId: state.tabId,
        tabs: state.tabs,
        tabsEnabled: state.tabsEnabled,
        id: state.id,
        ephemeral: state.ephemeral,
        name: state.name,
        dirty: state.dirty,
        revision: state.revision,
        contentVersion: state.contentVersion,
        canAutosave: state.canAutosave,
      }
      if (immutable)
        return {
          ...metadata,
          saveReceipt: true,
          savedVersion: source.saved.version,
        }
      if (!force && known.get(owner)?.has(source.store))
        return {
          ...metadata,
          documentMetadata: true,
          replaced: false,
          savedVersion: source.saved.version,
        }
      const signature = JSON.stringify(metadata)
      const previousId = tabs.get(key),
        previous = previousId ? streams.get(previousId) : undefined
      if (
        previous &&
        previous.source.current === source.current &&
        previous.source.saved === source.saved &&
        previous.metadata === signature &&
        previous.current()
      )
        return previous.wire
      if (previousId) close(previousId)
      const sameSource = source.current.sharesRoot(source.saved)
      const head = {
        tabId: state.tabId,
        revision: state.revision,
        contentVersion: state.contentVersion,
        streamId: randomUUID(),
        length:
          source.current.utf16Length +
          (sameSource ? 0 : source.saved.utf16Length),
      }
      const wire: DocumentTransfer = {
        ...metadata,
        replaced: true,
        documentTransfer: head,
        sourceLength: source.current.utf16Length,
        savedLength: source.saved.utf16Length,
        sameSource,
      }
      const chunks = function* () {
        yield* source.current.chunks()
        if (!sameSource) yield* source.saved.chunks()
      }
      streams.set(head.streamId, {
        owner,
        source,
        wire,
        sender: new SourceTransferSender(head, chunks()),
        metadata: signature,
        key,
        current: immutable ? source.live : source.owns,
      })
      tabs.set(key, head.streamId)
      return wire
    }
    if ('document' in value) {
      const result = value as { document: unknown }
      return {
        ...result,
        document: encode(owner, result.document, immutable, force),
      }
    }
    return value
  }
  return {
    encode(owner: number, value: unknown, immutable = false, force = false) {
      for (const [id, stream] of streams) if (!stream.current()) close(id)
      return encode(owner, value, immutable, force)
    },
    read(owner: number, value: unknown) {
      const { request, stream } = lookup(owner, value)
      try {
        return stream.sender.read(request)
      } catch (error) {
        close(request.streamId)
        throw error
      }
    },
    finish(owner: number, value: unknown) {
      const { request, stream } = lookup(owner, value)
      try {
        const head = stream.sender.finish(request)
        if (stream.source.store) {
          let owned = known.get(owner)
          if (!owned) {
            owned = new WeakSet()
            known.set(owner, owned)
          }
          owned.add(stream.source.store)
        }
        return {
          tabId: head.tabId,
          revision: head.revision,
          contentVersion: head.contentVersion,
        }
      } finally {
        close(request.streamId)
      }
    },
    abort(owner: number, value: unknown) {
      const request = parseTransferRequest(value),
        stream = streams.get(request.streamId)
      if (stream?.owner === owner) close(request.streamId)
    },
    clear() {
      for (const id of streams.keys()) close(id)
      known.clear()
    },
  }
}
