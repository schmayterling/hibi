import assert from 'node:assert/strict'
import test from 'node:test'
import { parseDocumentChange } from '../src/shared/document-journal.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'
import { SourceChunk } from '../src/shared/source-metrics.ts'
import { parseSourceOperation } from '../src/shared/source-operations.ts'
import { ownSourceText } from '../src/shared/source-text.ts'

test('owned strings preserve every UTF-16 unit across copy blocks, including lone surrogates', () => {
  const values = [
    '',
    '\0\r\n',
    '\ud800x\udc00',
    'x'.repeat(8191) + '😀\r\né',
    'e\u0301א😀\r\n'.repeat(30000),
  ]
  for (const value of values) {
    const copied = ownSourceText(value)
    assert.equal(copied, value)
    const chunk = new SourceChunk(value, () => {})
    assert.equal(chunk.text, value)
    assert.equal(
      chunk.metrics(0, value.length).utf8Bytes,
      Buffer.byteLength(value),
    )
  }
})

test('only text long enough to share a parent is copied', (t) => {
  // A Tab over 16384 code lines parses 16384 one-unit inserts in four layers.
  const parent = `${'x'.repeat(8192)}${Math.random()}`
  const changes = Array.from({ length: 16384 }, (_, line) => ({
    from: line * 64,
    to: line * 64,
    insert: '\t',
  }))
  changes.push(
    { from: 16384 * 64, to: 16384 * 64 + 1, insert: parent.slice(1, 13) },
    { from: 16384 * 64 + 2, to: 16384 * 64 + 3, insert: parent.slice(1, 14) },
  )
  const clone = t.mock.method(globalThis, 'structuredClone')
  const parsed = parseSourceOperation({
    document: { tabId: 'test', revision: 0 },
    operationId: 'tab',
    baseVersion: 0,
    contentVersion: 1,
    origin: 'source',
    historyGroup: 'indent',
    changes,
  })
  assert.deepEqual(
    clone.mock.calls.map(({ arguments: [text] }) => text),
    [parent.slice(1, 14)],
  )
  assert.deepEqual(parsed.changes, changes)
})

test('only privately validated immutable messages bypass repeated parsing', () => {
  const changes = [{ from: 0, to: 0, insert: 'before' }]
  const parsed = parseSourceOperation({
    document: { tabId: 'test', revision: 0 },
    operationId: 'one',
    baseVersion: 0,
    contentVersion: 1,
    origin: 'source',
    historyGroup: 'typing',
    changes,
  })
  changes[0].insert = 'changed'
  assert.equal(parsed.changes[0].insert, 'before')
  assert.equal(parseSourceOperation(parsed), parsed)
  assert.throws(() => {
    parsed.changes[0].insert = 'changed'
  })
  assert.throws(() =>
    parseSourceOperation(Object.freeze({ ...parsed, contentVersion: 99 })),
  )
  const legacy = parseDocumentChange({
    tabId: 'test',
    revision: 0,
    baseVersion: 0,
    contentVersion: 1,
    from: 0,
    to: 0,
    insert: 'kept',
  })
  assert.equal(parseDocumentChange(legacy), legacy)
  assert.throws(() => {
    legacy.insert = 'changed'
  })
  assert.throws(() =>
    parseDocumentChange(Object.freeze({ ...legacy, contentVersion: 99 })),
  )
})

test('source identity validation rejects coercible non-string IDs before constructing storage', () => {
  const store = new SourceStore('kept', { tabId: 'valid', revision: 0 })
  for (const document of [
    null,
    { revision: 0 },
    { tabId: 123, revision: 0 },
    { tabId: { toString: () => 'valid' }, revision: 0 },
  ]) {
    assert.throws(() => new SourceStore('invalid', document), /identity/)
    assert.throws(() => store.reidentify(document), /identity/)
  }
  assert.equal(store.snapshot().document.tabId, 'valid')
})
