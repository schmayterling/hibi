import assert from 'node:assert/strict'
import test from 'node:test'
import {
  journalHead,
  parseJournalCheckpoint,
  verifyJournalCheckpoint,
} from '../src/shared/document-checkpoint.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'

test('J09: recovery checkpoint verification is exact, read-only and version-bound', async () => {
  const source = 'a\r\n😀b'.repeat(10_000),
    store = new SourceStore(source, { tabId: 'a', revision: 4 }, 9),
    snapshot = store.snapshot(),
    checkpoint = { ...journalHead(store), source }
  store.counters(true)
  assert.deepEqual(
    await verifyJournalCheckpoint(() => store, checkpoint, source.length),
    journalHead(store),
  )
  for (const change of [
    { source: `b${source.slice(1)}` },
    { source: source.slice(1) },
    { tabId: 'b' },
    { revision: 5 },
    { contentVersion: 8 },
  ])
    await assert.rejects(
      verifyJournalCheckpoint(
        () => store,
        { ...checkpoint, ...change },
        source.length,
      ),
    )
  assert.equal(store.snapshot(), snapshot)
  assert.equal(store.counters().materializations, 0)
})

test('recovery checkpoint rejects malformed and oversized payloads before reading source', async () => {
  let reads = 0
  for (const value of [
    null,
    {},
    { tabId: 'a', revision: -1, contentVersion: 0, source: '' },
    { tabId: 'a', revision: 0, contentVersion: 0, source: '12345' },
    { tabId: 'a', revision: 0, contentVersion: 0, source: [] },
  ]) {
    assert.throws(() => parseJournalCheckpoint(value, 4))
    await assert.rejects(
      verifyJournalCheckpoint(
        () => {
          reads++
        },
        value,
        4,
      ),
    )
  }
  assert.equal(reads, 0)
})

test('checkpoint comparison cannot acknowledge a replaced source root', async () => {
  const store = new SourceStore('same', { tabId: 'a', revision: 0 }),
    other = new SourceStore('same', { tabId: 'a', revision: 0 })
  let reads = 0
  await assert.rejects(
    verifyJournalCheckpoint(
      () => (++reads === 1 ? store : other),
      { ...journalHead(store), source: 'same' },
      10,
    ),
    /changed during recovery/,
  )
})

test('checkpoint comparison accepts an owned storage swap without accepting another source generation', async () => {
  const store = new SourceStore('same', { tabId: 'a', revision: 0 })
  let reads = 0
  const checkpoint = { ...journalHead(store), source: 'same' }
  assert.deepEqual(
    await verifyJournalCheckpoint(
      () => {
        if (++reads === 2) store.compact()
        return store
      },
      checkpoint,
      10,
    ),
    journalHead(store),
  )
  // Verification may yield and recheck ownership before its final read.
  assert.ok(reads >= 2)
})
