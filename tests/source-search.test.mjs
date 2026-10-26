import assert from 'node:assert/strict'
import test from 'node:test'
import { SearchCursor } from '@codemirror/search'
import { Text } from '@codemirror/state'
import { SourceStore } from '../src/shared/source-buffer.ts'
import { normalizedSource } from '../src/shared/source-projection.ts'
import { searchSourceLiteral } from '../src/shared/source-search.ts'

const collect = (cursor) => {
  const matches = []
  for (;;) {
    const next = cursor.next()
    if (next.done) return { matches, ...next.value }
    assert.ok(next.value.matches.length <= 128)
    matches.push(...next.value.matches)
  }
}
const oracle = (source, query, caseSensitive) => {
  if (!query) return []
  const text = Text.of(normalizedSource(source).split('\n'))
  const cursor = new SearchCursor(
    text,
    query,
    0,
    text.length,
    caseSensitive
      ? undefined
      : (text) => text.toLowerCase().replaceAll('ς', 'σ'),
  )
  const found = []
  while (!cursor.next().done) found.push({ ...cursor.value })
  return found
}

test('ENG25: chunked literal search agrees with native search across Unicode and line-ending seams', () => {
  let seed = 61374
  const random = (maximum) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0
    return (seed >>> 0) % maximum
  }
  const alphabet = [
    'a',
    'b',
    'A',
    ' ',
    '\n',
    '\r\n',
    '\r',
    'é',
    'e\u0301',
    'K',
    'ﬃ',
    '😀',
    'Å',
    'Σ',
    'Ο',
    'İ',
  ]
  for (let run = 0; run < 500; run++) {
    const source = Array.from(
      { length: 10 + random(90) },
      () => alphabet[random(alphabet.length)],
    ).join('')
    const store = new SourceStore(source, { tabId: 'find', revision: 0 }, 0, {
      chunkUnits: 16,
    })
    const queries = ['a', 'é', 'e', 'i', 'ff', '😀', '\n', '\r', 'σ', ' ']
    queries.push(
      Array.from(
        { length: 1 + random(4) },
        () => alphabet[random(alphabet.length)],
      ).join(''),
    )
    for (const query of queries)
      for (const caseSensitive of [false, true]) {
        const found = collect(
          searchSourceLiteral(store.snapshot(), query, { caseSensitive }),
        )
        assert.deepEqual(
          found.matches,
          oracle(source, query, caseSensitive),
          JSON.stringify({ source, query, caseSensitive }),
        )
        assert.equal(found.total, found.matches.length)
        assert.equal(found.scanned, normalizedSource(source).length)
      }
    assert.equal(store.counters().materializations, 0)
  }
})

test('source find matches Greek sigma forms at word ends, inside words and beside punctuation', () => {
  const text = '😀ΟΔΟΣ οδος οδοσ;ΟΔΟΣ! ΑΣΑ ΑςΑ ΑσΑ ΣΣΣΣ,ΣΣ.'
  for (const chunkUnits of [16, 17, 19, 32]) {
    const store = new SourceStore(text, { tabId: 'sigma', revision: 0 }, 0, {
      chunkUnits,
    })
    for (const query of ['ΟΔΟΣ', 'οδος', 'οδοσ'])
      assert.deepEqual(
        collect(searchSourceLiteral(store.snapshot(), query)).matches,
        [2, 7, 12, 17].map((from) => ({ from, to: from + 4, precise: true })),
        JSON.stringify({ query, chunkUnits }),
      )
    for (const query of ['Σ', 'σ', 'ς'])
      assert.deepEqual(
        collect(searchSourceLiteral(store.snapshot(), query)).matches,
        Array.from(text.matchAll(/[Σσς]/gu), ({ index: from }) => ({
          from,
          to: from + 1,
          precise: true,
        })),
        JSON.stringify({ query, chunkUnits }),
      )
    for (const query of ['ΑΣΑ', 'ΑςΑ', 'ΑσΑ'])
      assert.deepEqual(
        collect(searchSourceLiteral(store.snapshot(), query)).matches,
        [23, 27, 31].map((from) => ({ from, to: from + 3, precise: true })),
      )
    assert.equal(store.counters().materializations, 0)
  }
})

test('literal search batches stay bounded through dense matches, repeated prefixes and retained snapshots', () => {
  const source = 'a'.repeat(200000) + '\r\n😀' + 'b'.repeat(200000)
  const store = new SourceStore(source, { tabId: 'find', revision: 0 })
  const old = store.snapshot(),
    cursor = searchSourceLiteral(old, 'a'.repeat(4000) + 'x')
  assert.equal(cursor.next().value.scanned, 8192)
  store.commit(
    store.prepare({
      document: old.document,
      operationId: 'edit',
      baseVersion: 0,
      contentVersion: 1,
      origin: 'source',
      historyGroup: 'typing',
      changes: [{ from: 0, to: 1, insert: 'z' }],
    }),
  )
  assert.deepEqual(collect(cursor).matches, [])
  const dense = collect(searchSourceLiteral(old, 'a'))
  assert.equal(dense.total, 200000)
  assert.equal(dense.matches[0].from, 0)
  assert.equal(
    collect(searchSourceLiteral(store.snapshot(), 'a')).total,
    199999,
  )
  assert.equal(store.counters().materializations, 0)
  assert.deepEqual(collect(searchSourceLiteral(old, '')), {
    matches: [],
    scanned: 0,
    total: 0,
  })
  assert.throws(
    () => searchSourceLiteral(old, 'x'.repeat(65537)).next(),
    /limit/,
  )
})
