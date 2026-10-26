import assert from 'node:assert/strict'
import test from 'node:test'
import {
  journalHead,
  parseJournalCheckpoint,
} from '../src/shared/document-checkpoint.ts'
import { createCheckpointVerifier } from '../src/shared/document-checkpoint-stream.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'
import { SOURCE_TRANSFER_UNITS } from '../src/shared/source-transfer.ts'
import { createCheckpointTransfer } from './checkpoint-transfer.mjs'

test('J09: recovery checkpoint verification is exact, read-only and version-bound', async () => {
  const source = '\uFEFFa\r\n😀b'.repeat(10_000),
    store = new SourceStore(source, { tabId: 'a', revision: 4 }, 9),
    snapshot = store.snapshot(),
    recovery = createCheckpointTransfer(() => store)
  store.counters(true)
  assert.deepEqual(
    await recovery.verify(recovery.checkpoint(journalHead(store), source)),
    journalHead(store),
  )
  for (const [text, change] of [
    [`b${source.slice(1)}`, {}],
    [source.slice(1), {}],
    [source, { tabId: 'b' }],
    [source, { revision: 5 }],
    [source, { contentVersion: 8 }],
  ])
    await assert.rejects(
      recovery.verify(
        recovery.checkpoint({ ...journalHead(store), ...change }, text),
      ),
    )
  assert.equal(store.snapshot(), snapshot)
  assert.equal(store.counters().materializations, 0)
})

test('recovery checkpoint rejects malformed metadata before reading source', () => {
  let reads = 0
  const verifier = createCheckpointVerifier(() => {
    reads++
    assert.fail('malformed checkpoint read source')
  })
  for (const value of [
    null,
    {},
    { tabId: 'a', revision: -1, contentVersion: 0, streamId: 's', length: 0 },
    { tabId: 'a', revision: 0, contentVersion: 0, streamId: '', length: 0 },
    { tabId: 'a', revision: 0, contentVersion: 0, streamId: 's', length: -1 },
    { tabId: 'a', revision: 0, contentVersion: 0, streamId: 's', length: [] },
    {
      tabId: 'a',
      revision: 0,
      contentVersion: 0,
      streamId: 's',
      length: Number.MAX_SAFE_INTEGER + 1,
    },
  ]) {
    assert.throws(() => parseJournalCheckpoint(value))
    assert.throws(() => verifier.begin(value))
  }
  assert.equal(reads, 0)
})

test('recovery checkpoint rejects obsolete string payloads', () => {
  assert.throws(() =>
    parseJournalCheckpoint({
      tabId: 'a',
      revision: 0,
      contentVersion: 0,
      source: 'kept',
    }),
  )
})

test('oversized checkpoint messages abort without writing or acknowledging source', () => {
  const source = 'x'.repeat(SOURCE_TRANSFER_UNITS + 1),
    store = new SourceStore(source, { tabId: 'a', revision: 0 }),
    snapshot = store.snapshot(),
    verifier = createCheckpointVerifier(() => store),
    head = {
      ...journalHead(store),
      streamId: 'oversized',
      length: source.length,
    }
  store.counters(true)
  verifier.begin(head)
  assert.throws(() =>
    verifier.append({
      streamId: head.streamId,
      sequence: 0,
      chunks: [source],
      done: true,
    }),
  )
  assert.throws(() => verifier.finish({ streamId: head.streamId, sequence: 1 }))
  assert.equal(store.snapshot(), snapshot)
  assert.equal(store.counters().materializations, 0)
})

test('checkpoint comparison cannot acknowledge a replaced source root', async () => {
  const store = new SourceStore('same', { tabId: 'a', revision: 0 }),
    other = new SourceStore('same', { tabId: 'a', revision: 0 })
  let reads = 0
  const recovery = createCheckpointTransfer(() =>
    ++reads === 1 ? store : other,
  )
  await assert.rejects(
    recovery.verify(recovery.checkpoint(journalHead(store), 'same')),
    /changed during recovery/,
  )
})

test('checkpoint comparison accepts an owned storage swap without accepting another source generation', async () => {
  const store = new SourceStore('same', { tabId: 'a', revision: 0 })
  let reads = 0
  const recovery = createCheckpointTransfer(() => {
    if (++reads === 2) store.compact()
    return store
  })
  assert.deepEqual(
    await recovery.verify(recovery.checkpoint(journalHead(store), 'same')),
    journalHead(store),
  )
  assert.ok(reads >= 2)
})
