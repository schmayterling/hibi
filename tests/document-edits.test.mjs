import assert from 'node:assert/strict'
import test from 'node:test'
import {
  editedSource,
  parseSourceEditRequest,
  sourceEditMatches,
  validateSourceEdits,
} from '../src/shared/document-edits.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'

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
  assert.equal(editedSource('hello world', normalized.changes, 100), 'hi there')
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
      editedSource('😀', parseSourceEditRequest(request(changes)).changes, 100),
    )
  assert.equal(editedSource('😀', [edit(0, 2, 'é', '😀')], 2), 'é')
  assert.throws(() => editedSource('', [edit(0, 0, '😀')], 3), /size limit/)
  assert.equal(
    editedSource('ab', [edit(0, 1, 'x', 'a'), edit(1, 2, 'y', 'b')], 2),
    'xy',
  )
})

test('whole source edits have no default content ceiling and retain explicit byte bounds', () => {
  const source = 'é'.repeat(2 * 1024 * 1024)
  const changes = [edit(0, 1, '中', 'é')]
  assert.equal(editedSource(source, changes), '中' + source.slice(1))
  assert.throws(
    () => editedSource(source, changes, 2 * 1024 * 1024),
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
  assert.equal(
    validateSourceEdits(source, [
      edit(0, 1, 'b', 'a'),
      edit(source.utf16Length - 1, source.utf16Length, 'c', 'a'),
    ]),
    true,
  )
  assert.equal(validateSourceEdits(source, [edit(0, 1, 'a', 'a')]), false)
  assert.throws(
    () => validateSourceEdits(source, [edit(0, 1, 'b', 'wrong')]),
    /has changed/,
  )
  assert.throws(
    () =>
      validateSourceEdits(source, [edit(0, 1, 'b', 'a'), edit(0, 1, 'c', 'a')]),
    /overlap/,
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
    assert.throws(
      () => validateSourceEdits(unicode, [edit(from, from, 'x')]),
      /splits/,
    )
})
