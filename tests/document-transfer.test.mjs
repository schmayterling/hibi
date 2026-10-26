import assert from 'node:assert/strict'
import test from 'node:test'
import {
  journalHead,
  parseJournalCheckpoint,
} from '../src/shared/document-checkpoint.ts'
import { createCheckpointVerifier } from '../src/shared/document-checkpoint-stream.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'
import {
  SOURCE_TRANSFER_UNITS,
  SourceTransferReceiver,
  SourceTransferSender,
} from '../src/shared/source-transfer.ts'

const head = (length, streamId = 'stream') => ({
  tabId: 'a',
  revision: 3,
  contentVersion: 7,
  streamId,
  length,
})

test('stream checkpoint metadata has no whole-document content ceiling', () => {
  assert.deepEqual(
    parseJournalCheckpoint(head(50 * 1024 * 1024)),
    head(50 * 1024 * 1024),
  )
})

test('50 mib transfers keep every message bounded and ordered without materializing source', () => {
  const size = 50 * 1024 * 1024,
    text = 'x'.repeat(4096)
  const chunks = function* () {
    for (let offset = 0; offset < size; offset += text.length) yield text
  }
  const sender = new SourceTransferSender(head(size), chunks())
  let received = 0,
    messages = 0,
    maximumUnits = 0
  const receiver = new SourceTransferReceiver(head(size), (chunk) => {
    assert.equal(chunk, text)
    received += chunk.length
  })
  for (;;) {
    const chunk = sender.read(receiver.request)
    messages++
    maximumUnits = Math.max(
      maximumUnits,
      chunk.chunks.reduce((sum, value) => sum + value.length, 0),
    )
    if (receiver.receive(chunk)) break
  }
  sender.finish(receiver.finish())
  assert.equal(received, size)
  assert.equal(maximumUnits, SOURCE_TRANSFER_UNITS)
  assert.equal(messages, size / SOURCE_TRANSFER_UNITS)
})

test('transfers preserve raw bom, crlf and surrogate seams exactly', () => {
  const chunks = ['\uFEFFa\r', '\n\uD83D', '\uDE00b\uD800', '\uDC00c\r\n'],
    source = chunks.join('')
  const sender = new SourceTransferSender(head(source.length), chunks),
    received = []
  const receiver = new SourceTransferReceiver(head(source.length), (chunk) =>
    received.push(chunk),
  )
  while (!receiver.receive(sender.read(receiver.request))) {}
  sender.finish(receiver.finish())
  assert.equal(received.join(''), source)
})

test('partial, malformed, excessive, out-of-order and duplicate streams cannot finish', () => {
  const invalid = [
    { chunks: ['x'], sequence: 1, done: true },
    { chunks: ['x'], streamId: 'other', done: true },
    { chunks: ['x'], done: true },
    { chunks: ['x'.repeat(65537)], done: false },
    { chunks: Array(17).fill('x'), done: false },
    { chunks: ['x'.repeat(65536), 'x'], done: false },
    { chunks: [], done: false },
    { chunks: [null], done: true },
  ]
  for (const patch of invalid) {
    const receiver = new SourceTransferReceiver(head(2), () => {})
    assert.throws(() =>
      receiver.receive({
        streamId: 'stream',
        sequence: 0,
        chunks: ['xx'],
        done: true,
        ...patch,
      }),
    )
    assert.throws(() => receiver.finish())
  }
  const receiver = new SourceTransferReceiver(head(2), () => {})
  const chunk = { streamId: 'stream', sequence: 0, chunks: ['xx'], done: true }
  receiver.receive(chunk)
  assert.throws(() => receiver.receive(chunk))
  assert.throws(() => receiver.finish())
})

test('malformed checkpoint chunks abort even after the last valid chunk', () => {
  const store = new SourceStore('kept', { tabId: 'a', revision: 0 }, 0)
  const verifier = createCheckpointVerifier(() => store)
  const transfer = { ...journalHead(store), streamId: 'checkpoint', length: 4 }
  const invalid = [
    { chunks: [null] },
    { chunks: ['x'.repeat(65537)] },
    { chunks: Array(17).fill('x') },
    { chunks: [], done: false },
    { sequence: -1 },
    { done: 'true' },
  ]
  for (const patch of invalid) {
    verifier.begin(transfer)
    const chunk = {
      streamId: transfer.streamId,
      sequence: 0,
      chunks: ['kept'],
      done: true,
    }
    const ack = verifier.append(chunk)
    assert.throws(() => verifier.append({ ...chunk, ...patch }))
    assert.throws(() => verifier.finish(ack), /stale|incomplete/)
  }
  assert.equal(store.snapshot().materialize(), 'kept')
})

test('checkpoint verification is read-only, exact and aborted by a version change', () => {
  const text = '\uFEFFa\r\n😀b'.repeat(20000),
    store = new SourceStore(text, { tabId: 'a', revision: 3 }, 7)
  const verifier = createCheckpointVerifier(() => store),
    original = store.snapshot()
  const transfer = {
    ...journalHead(store),
    streamId: 'checkpoint',
    length: text.length,
  }
  const sender = new SourceTransferSender(transfer, original.chunks())
  verifier.begin(transfer)
  let senderSequence = 0
  for (;;) {
    const chunk = sender.read({
      streamId: transfer.streamId,
      sequence: senderSequence++,
    })
    const ack = verifier.append(chunk)
    if (chunk.done) {
      assert.deepEqual(verifier.finish(ack), journalHead(store))
      break
    }
  }
  assert.equal(store.snapshot(), original)
  assert.equal(store.counters().materializations, 0)
  verifier.begin(transfer)
  store.commit(
    store.prepare({
      document: original.document,
      operationId: 'edit',
      historyGroup: 'edit',
      origin: 'source',
      baseVersion: 7,
      contentVersion: 8,
      changes: [{ from: 0, to: 0, insert: 'changed' }],
    }),
  )
  assert.throws(
    () =>
      verifier.append({
        streamId: transfer.streamId,
        sequence: 0,
        chunks: ['x'],
        done: false,
      }),
    /changed during recovery/,
  )
  assert.equal(store.snapshot().version, 8)
  assert.throws(() =>
    verifier.finish({ streamId: transfer.streamId, sequence: 0 }),
  )
})
