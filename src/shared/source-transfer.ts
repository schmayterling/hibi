import { type JournalHead, parseJournalHead } from './document-checkpoint.ts'

/** Trust bounds apply to each message, never to the complete document. */
export const SOURCE_TRANSFER_UNITS = 65536
export const SOURCE_TRANSFER_CHUNKS = 16
export type SourceTransferHead = JournalHead &
  Readonly<{
    streamId: string
    length: number
  }>
export type SourceTransferRequest = Readonly<{
  streamId: string
  sequence: number
}>
export type SourceTransferChunk = SourceTransferRequest &
  Readonly<{
    chunks: readonly string[]
    done: boolean
  }>

export function parseTransferRequest(value: unknown): SourceTransferRequest {
  const request = value as SourceTransferRequest
  if (
    !request ||
    typeof request.streamId !== 'string' ||
    !/^[\w.:-]{1,128}$/.test(request.streamId) ||
    !Number.isSafeInteger(request.sequence) ||
    request.sequence < 0
  )
    throw new Error('Invalid document transfer sequence.')
  return { streamId: request.streamId, sequence: request.sequence }
}
export function parseTransferHead(value: unknown): SourceTransferHead {
  const head = parseJournalHead(value),
    transfer = value as SourceTransferHead
  parseTransferRequest({ streamId: transfer.streamId, sequence: 0 })
  if (!Number.isSafeInteger(transfer.length) || transfer.length < 0)
    throw new Error('Invalid document transfer length.')
  return { ...head, streamId: transfer.streamId, length: transfer.length }
}
export function parseTransferChunk(value: unknown): SourceTransferChunk {
  const request = parseTransferRequest(value),
    chunk = value as SourceTransferChunk
  if (
    typeof chunk.done !== 'boolean' ||
    !Array.isArray(chunk.chunks) ||
    chunk.chunks.length > SOURCE_TRANSFER_CHUNKS ||
    chunk.chunks.some(
      (text) =>
        typeof text !== 'string' ||
        !text.length ||
        text.length > SOURCE_TRANSFER_UNITS,
    ) ||
    chunk.chunks.reduce((sum, text) => sum + text.length, 0) >
      SOURCE_TRANSFER_UNITS ||
    (!chunk.done && !chunk.chunks.length)
  )
    throw new Error('Invalid document transfer chunk.')
  return { ...request, chunks: chunk.chunks, done: chunk.done }
}

/** A next request acknowledges the preceding chunk. Final publication needs finish(). */
export class SourceTransferSender {
  readonly head: SourceTransferHead
  readonly #source: Iterator<string>
  #pending = ''
  #sequence = 0
  #offset = 0
  #done = false
  #closed = false
  constructor(head: SourceTransferHead, source: Iterable<string>) {
    this.head = parseTransferHead(head)
    this.#source = source[Symbol.iterator]()
  }
  read(value: unknown): SourceTransferChunk {
    const request = parseTransferRequest(value)
    if (
      this.#closed ||
      this.#done ||
      request.streamId !== this.head.streamId ||
      request.sequence !== this.#sequence
    )
      throw new Error('The document transfer is stale or out of order.')
    const chunks: string[] = []
    let units = 0
    while (
      units < SOURCE_TRANSFER_UNITS &&
      chunks.length < SOURCE_TRANSFER_CHUNKS
    ) {
      if (!this.#pending) {
        const next = this.#source.next()
        if (next.done) {
          this.#done = true
          break
        }
        this.#pending = next.value
      }
      const size = Math.min(this.#pending.length, SOURCE_TRANSFER_UNITS - units)
      if (size) chunks.push(this.#pending.slice(0, size))
      this.#pending = this.#pending.slice(size)
      units += size
      if (this.#offset + units === this.head.length) {
        this.#done = true
        break
      }
    }
    this.#offset += units
    if (
      this.#offset > this.head.length ||
      (this.#done && this.#offset !== this.head.length)
    )
      throw new Error('The document transfer length does not match.')
    return { ...request, chunks, done: this.#done, sequence: this.#sequence++ }
  }
  finish(value: unknown) {
    const request = parseTransferRequest(value)
    if (
      this.#closed ||
      !this.#done ||
      request.streamId !== this.head.streamId ||
      request.sequence !== this.#sequence
    )
      throw new Error('The document transfer is incomplete.')
    this.close()
    return this.head
  }
  close() {
    this.#closed = true
    this.#pending = ''
    this.#source.return?.()
  }
}

/** Partial data stays private to its consumer until exact length and final acknowledgment. */
export class SourceTransferReceiver {
  readonly head: SourceTransferHead
  readonly #consume: (text: string) => void
  #sequence = 0
  #offset = 0
  #done = false
  #failed = false
  constructor(head: SourceTransferHead, consume: (text: string) => void) {
    this.head = parseTransferHead(head)
    this.#consume = consume
  }
  get request(): SourceTransferRequest {
    return { streamId: this.head.streamId, sequence: this.#sequence }
  }
  receive(value: unknown) {
    try {
      const chunk = parseTransferChunk(value)
      if (
        this.#done ||
        this.#failed ||
        chunk.streamId !== this.head.streamId ||
        chunk.sequence !== this.#sequence
      )
        throw new Error('The document transfer is stale or out of order.')
      const size = chunk.chunks.reduce((sum, text) => sum + text.length, 0)
      if (
        this.#offset + size > this.head.length ||
        (chunk.done && this.#offset + size !== this.head.length)
      )
        throw new Error('The document transfer length does not match.')
      for (const text of chunk.chunks) this.#consume(text)
      this.#offset += size
      this.#sequence++
      this.#done = chunk.done
      return this.#done
    } catch (error) {
      this.#failed = true
      throw error
    }
  }
  finish() {
    if (!this.#done || this.#failed)
      throw new Error('The document transfer is incomplete.')
    return this.request
  }
}
