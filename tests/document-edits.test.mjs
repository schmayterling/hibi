import assert from 'node:assert/strict'
import test from 'node:test'
import * as sourceEdits from '../src/shared/document-edits.ts'
import {
  editedSource,
  parseSourceEditRequest,
  sourceEditMatches,
  validateSourceEdits,
} from '../src/shared/document-edits.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'

test('snapshot admission distinguishes conflicts and reads only edited ranges', () => {
  const store = new SourceStore('a\r\n😀b'.repeat(30000), {
    tabId: 'test',
    revision: 0,
  })
  const snapshot = store.snapshot()
  store.counters(true)
  assert.deepEqual(
    sourceEdits.validateSourceEdits(snapshot, [edit(5, 6, 'B', 'b')]),
    { status: 'valid', changed: true },
  )
  assert.equal(store.counters().materializations, 0)
  assert.ok(store.counters().sourceUnitsRead < 100)
  for (const [from, to] of [
    [2, 2],
    [4, 4],
    [-1, 0],
    [5, 4],
    [0, Infinity],
  ])
    assert.equal(
      sourceEdits.validateSourceEdits(snapshot, [edit(from, to, 'x')]).status,
      'invalid',
    )
  assert.equal(
    sourceEdits.validateSourceEdits(snapshot, [edit(5, 6, 'x', 'wrong')])
      .status,
    'conflict',
  )
  assert.deepEqual(
    sourceEdits.validateSourceEdits(snapshot, [edit(5, 6, 'b', 'b')]),
    { status: 'valid', changed: false },
  )
})

test('snapshot byte admission accounts for newly joined surrogate seams', () => {
  const source = new SourceStore('\ud800x\udc00', {
    tabId: 'test',
    revision: 0,
  }).snapshot()
  const changes = [edit(1, 2, '', 'x')]
  assert.equal(
    sourceEdits.validateSourceEdits(source, changes, 4).status,
    'valid',
  )
  assert.equal(
    sourceEdits.validateSourceEdits(source, changes, 3).status,
    'invalid',
  )
  assert.equal(editedSource(source, changes, 4), '\ud800\udc00')
})

const snapshot = (text) =>
  new SourceStore(text, { tabId: 'test', revision: 0 }).snapshot()
const request = (changes) => ({
  requestId: 'review:1',
  tabId: 'tab',
  revision: 1,
  contentVersion: 2,
  changes,
})
const edit = (from, to, insert, expectedText = '') => ({
  from,
  to,
  insert,
  expectedText,
})
test('source edits validate exact ranges, order, Unicode boundaries, and UTF-8 limits', () => {
  const normalized = parseSourceEditRequest(
    request([edit(6, 11, 'there', 'world'), edit(0, 5, 'hi', 'hello')]),
  )
  assert.equal(
    editedSource(snapshot('hello world'), normalized.changes, 100),
    'hi there',
  )
  assert.ok(
    sourceEditMatches(normalized, {
      tabId: 'tab',
      revision: 1,
      contentVersion: 2,
    }),
  )
  assert.equal(
    sourceEditMatches(normalized, {
      tabId: 'other',
      revision: 1,
      contentVersion: 2,
    }),
    false,
  )
  assert.equal(
    sourceEditMatches(normalized, {
      tabId: 'tab',
      revision: 1,
      contentVersion: 3,
    }),
    false,
  )
  for (const changes of [
    [edit(-1, 0, '')],
    [edit(0.5, 1, '')],
    [edit(0, Infinity, '')],
    [edit(0, 0, '\ud800')],
    Array.from({ length: 257 }, () => edit(0, 0, 'x')),
  ])
    assert.throws(() => parseSourceEditRequest(request(changes)))
  for (const changes of [
    [edit(1, 2, 'x', '\ude00')],
    [edit(0, 1, 'x', '\ud83d')],
    [edit(0, 3, '')],
    [edit(0, 2, 'x', 'different')],
    [edit(0, 2, 'a', '😀'), edit(1, 2, 'b', '\ude00')],
    [edit(0, 0, 'a'), edit(0, 0, 'b')],
    [edit(0, 2, 'a', '😀'), edit(2, 2, 'b')],
  ])
    assert.throws(() =>
      editedSource(
        snapshot('😀'),
        parseSourceEditRequest(request(changes)).changes,
        100,
      ),
    )
  assert.equal(editedSource(snapshot('😀'), [edit(0, 2, 'é', '😀')], 2), 'é')
  assert.throws(
    () => editedSource(snapshot(''), [edit(0, 0, '😀')], 3),
    /size limit/,
  )
  assert.equal(
    editedSource(
      snapshot('ab'),
      [edit(0, 1, 'x', 'a'), edit(1, 2, 'y', 'b')],
      2,
    ),
    'xy',
  )
})

test('whole source edits have no default content ceiling and retain explicit byte bounds', () => {
  const source = 'é'.repeat(2 * 1024 * 1024)
  const changes = [edit(0, 1, '中', 'é')]
  assert.equal(editedSource(snapshot(source), changes), '中' + source.slice(1))
  assert.throws(
    () => editedSource(snapshot(source), changes, 2 * 1024 * 1024),
    /size limit/,
  )
})

test('range validation on 50 mib reads only exact changed spans and unicode boundaries', () => {
  const store = new SourceStore('a'.repeat(50 * 1024 * 1024), {
    tabId: 'large',
    revision: 0,
  })
  const source = store.snapshot()
  store.counters(true)
  assert.deepEqual(
    validateSourceEdits(source, [
      edit(0, 1, 'b', 'a'),
      edit(source.utf16Length - 1, source.utf16Length, 'c', 'a'),
    ]),
    { status: 'valid', changed: true },
  )
  assert.deepEqual(validateSourceEdits(source, [edit(0, 1, 'a', 'a')]), {
    status: 'valid',
    changed: false,
  })
  assert.equal(
    validateSourceEdits(source, [edit(0, 1, 'b', 'wrong')]).status,
    'conflict',
  )
  assert.equal(
    validateSourceEdits(source, [edit(0, 1, 'b', 'a'), edit(0, 1, 'c', 'a')])
      .status,
    'invalid',
  )
  assert.ok(
    store.counters().sourceUnitsRead < 128,
    JSON.stringify(store.counters()),
  )
  assert.equal(store.counters().materializations, 0)
  const unicode = new SourceStore('😀\r\nend', {
    tabId: 'unicode',
    revision: 0,
  }).snapshot()
  for (const from of [1, 3])
    assert.equal(
      validateSourceEdits(unicode, [edit(from, from, 'x')]).status,
      'invalid',
    )
})
