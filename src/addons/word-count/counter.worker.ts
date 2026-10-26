import { SourceStore } from '../../shared/source-buffer.ts'
import type { SourceOperation } from '../../shared/source-operations.ts'
import {
  type SourceTransferChunk,
  type SourceTransferHead,
  SourceTransferReceiver,
  type SourceTransferRequest,
} from '../../shared/source-transfer.ts'
import { countText } from './count.ts'
import { FormattedCounter } from './formatted-counter.ts'
import type { CountSyntax } from './formatted-text.ts'

export type FormattedCountRequest = {
  kind: 'count'
  streamId: string
  version: number
  syntax: CountSyntax
}
export type CounterRequest =
  | string
  | FormattedCountRequest
  | { kind: 'open'; head: SourceTransferHead }
  | { kind: 'chunk'; chunk: SourceTransferChunk }
  | { kind: 'edit'; streamId: string; operation: SourceOperation }
  | { kind: 'close'; streamId: string }
export type CounterReply =
  | { kind: 'chunk'; request: SourceTransferRequest }
  | { kind: 'ready'; request: SourceTransferRequest }
  | { kind: 'count'; result: ReturnType<typeof countText> | null }

type Document = {
  loader: ReturnType<typeof SourceStore.loader>
  receiver: SourceTransferReceiver
  store?: SourceStore
  model?: FormattedCounter
  syntax?: string
}
const documents = new Map<string, Document>()
let job: {
  streamId: string
  work: Generator<void, ReturnType<typeof countText>>
} | null = null
const reply = (message: CounterReply) => self.postMessage(message)
function cancel(streamId?: string) {
  if (!job || (streamId && streamId !== job.streamId)) return
  job.work.return(null as never)
  job = null
  reply({ kind: 'count', result: null })
}
function advance(current: NonNullable<typeof job>) {
  if (job !== current) return
  const until = performance.now() + 5
  do {
    const step = current.work.next()
    if (step.done) {
      job = null
      reply({ kind: 'count', result: step.value })
      return
    }
  } while (performance.now() < until)
  setTimeout(() => advance(current), 0)
}
self.onmessage = (event: MessageEvent<CounterRequest>) => {
  const message = event.data
  if (typeof message === 'string') {
    self.postMessage(countText(message))
    return
  }
  switch (message.kind) {
    case 'open': {
      const { head } = message
      const loader = SourceStore.loader(
        { tabId: head.tabId, revision: head.revision },
        head.contentVersion,
      )
      const receiver = new SourceTransferReceiver(head, loader.append)
      documents.set(head.streamId, { loader, receiver })
      reply({ kind: 'chunk', request: receiver.request })
      break
    }
    case 'chunk': {
      const entry = documents.get(message.chunk.streamId)
      if (!entry) return
      if (entry.receiver.receive(message.chunk)) {
        entry.store = entry.loader.finish()
        reply({ kind: 'ready', request: entry.receiver.finish() })
      } else reply({ kind: 'chunk', request: entry.receiver.request })
      break
    }
    case 'edit': {
      const entry = documents.get(message.streamId)
      if (!entry?.store) return
      cancel(message.streamId)
      if (entry.model) entry.model.apply(message.operation)
      else {
        const prepared = entry.store.prepare(message.operation)
        entry.store.commit(prepared)
      }
      break
    }
    case 'close':
      cancel(message.streamId)
      documents.get(message.streamId)?.model?.dispose()
      documents.delete(message.streamId)
      break
    case 'count': {
      const entry = documents.get(message.streamId)
      if (!entry?.store || entry.store.snapshot().version !== message.version) {
        reply({ kind: 'count', result: null })
        return
      }
      cancel()
      const syntax = JSON.stringify(message.syntax)
      if (!entry.model || entry.syntax !== syntax) {
        entry.model?.dispose()
        entry.model = new FormattedCounter(entry.store, message.syntax)
        entry.syntax = syntax
      }
      const current = { streamId: message.streamId, work: entry.model.read() }
      job = current
      setTimeout(() => advance(current), 0)
    }
  }
}
