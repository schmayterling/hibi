import assert from 'node:assert/strict'
import test from 'node:test'
import { EditorState, Transaction } from '@codemirror/state'
import {
  createSourceSession,
  sourceEditorText,
} from '../src/renderer/src/source-session.ts'
import { DocumentSession } from '../src/shared/document-session.ts'

function fixture(source, options = {}, extensions = []) {
  const operations = [],
    errors = [],
    observations = []
  const session = new DocumentSession(
    source,
    { tabId: 'cm-test', revision: 0 },
    0,
    {
      enqueue: (operation) => operations.push(operation),
      onError: (error) => errors.push(error),
      ...options,
    },
  )
  const attach = (viewId) => {
    const bridge = createSourceSession(session, viewId)
    const selection = bridge.selection()
    const view = {
      state: EditorState.create({
        doc: sourceEditorText(session.snapshot()),
        ...(selection ? { selection } : {}),
        extensions,
      }),
      update(transactions) {
        for (const transaction of transactions) {
          assert.equal(transaction.startState, this.state)
          this.state = transaction.state
        }
        observations.push({
          version: session.state().contentVersion,
          operationCount: operations.length,
        })
      },
    }
    const dispose = bridge.attach(view)
    return {
      bridge,
      view,
      dispose,
      dispatch: (...specs) =>
        bridge.dispatch([view.state.update(...specs)], view),
    }
  }
  return { session, operations, errors, observations, attach }
}
const type = (from, insert, time) => ({
  changes: { from, insert },
  selection: { anchor: from + insert.length },
  annotations: [
    Transaction.userEvent.of('input.type'),
    Transaction.time.of(time),
  ],
})

test('S01/S07: accepted filters and sequential changes commit before CM callbacks with no full-source work', () => {
  const f = fixture('a\r\nb\nc\r', {}, [
    EditorState.transactionFilter.of((transaction) =>
      transaction.docChanged
        ? [
            transaction,
            {
              changes: { from: transaction.newDoc.length, insert: '!' },
              sequential: true,
            },
          ]
        : transaction,
    ),
  ])
  const first = f.attach(),
    second = f.attach()
  f.session.counters(true)
  first.dispatch({
    changes: [
      { from: 0, to: 1, insert: 'A' },
      { from: 2, to: 3, insert: 'B\nnew' },
    ],
  })
  assert.equal(f.session.counters().materializations, 0)
  assert.equal(f.session.snapshot().materialize(), 'A\r\nB\r\nnew\nc\r!')
  assert.equal(
    first.view.state.doc.toString(),
    second.view.state.doc.toString(),
  )
  assert.deepEqual(f.observations, [
    { version: 1, operationCount: 1 },
    { version: 1, operationCount: 1 },
  ])
  assert.equal(f.operations.length, 1)
  assert.equal(f.operations[0].changes.length, 3)
  assert.deepEqual(f.errors, [])
  first.dispose()
  second.dispose()
  f.session.dispose()
})

test('two source views share text and history but keep separate selections', () => {
  const f = fixture('abcd')
  const left = f.attach('left')
  const right = f.attach('right')
  left.dispatch({ selection: { anchor: 1 } })
  right.dispatch({ selection: { anchor: 4 } })
  assert.equal(f.session.selection('left').ranges[0].head, 1)
  assert.equal(f.session.selection('right').ranges[0].head, 4)
  left.dispatch(type(1, 'X', 1))
  assert.equal(left.view.state.doc.toString(), 'aXbcd')
  assert.equal(right.view.state.doc.toString(), 'aXbcd')
  assert.equal(f.session.selection('right').ranges[0].head, 5)
  assert.deepEqual(f.session.historyDepth(), { undo: 1, redo: 0 })
  right.bridge.undo()
  assert.equal(left.view.state.doc.toString(), 'abcd')
  assert.equal(right.view.state.doc.toString(), 'abcd')
  assert.equal(f.session.selection('right').ranges[0].head, 4)
  left.dispose()
  right.dispose()
  f.session.dispose()
})

test('S08/ENG20: source, visual and remounted source share history and raw selection', () => {
  const f = fixture('one\r\ntwo')
  const first = f.attach()
  first.dispatch(type(3, 'a', 10))
  first.dispatch(type(4, 'b', 20))
  assert.equal(f.session.historySize().groups, 1)
  assert.equal(f.session.selection().ranges[0].head, 5)
  f.session.edit([{ from: 7, to: 10, insert: '**two**' }], 'visual', 'bold')
  assert.equal(first.view.state.doc.toString(), 'oneab\n**two**')
  first.dispose()
  const second = f.attach()
  assert.equal(second.bridge.undo(), true)
  assert.equal(second.view.state.doc.toString(), 'oneab\ntwo')
  assert.equal(second.bridge.undo(), true)
  assert.equal(f.session.snapshot().materialize(), 'one\r\ntwo')
  assert.equal(second.view.state.selection.main.head, 0)
  assert.equal(f.session.state().dirty, false)
  second.bridge.redo()
  assert.equal(second.view.state.selection.main.head, 5)
  second.bridge.redo()
  assert.equal(second.view.state.doc.toString(), 'oneab\n**two**')
  assert.deepEqual(
    f.operations.map((op) => op.contentVersion),
    [1, 2, 3, 4, 5, 6, 7],
  )
  assert.deepEqual(f.errors, [])
  second.dispose()
  f.session.dispose()
})

test('source bridge rejects oversized, stale and invalid selection edits atomically', () => {
  const f = fixture('small', { maximumBytes: 8 })
  const surface = f.attach()
  const state = surface.view.state,
    snapshot = f.session.snapshot()
  assert.throws(() => surface.dispatch(type(5, 'huge', 0)), /size limit/)
  assert.equal(surface.view.state, state)
  assert.equal(f.session.snapshot(), snapshot)
  assert.equal(f.session.state().canUndo, false)
  assert.deepEqual(f.operations, [])
  assert.throws(
    () =>
      f.session.edit(
        [{ from: 0, to: 1, insert: 'S' }],
        'source',
        'bad',
        undefined,
        () => ({
          ranges: [{ anchor: 100, head: 100, association: 1 }],
          mainIndex: 0,
        }),
      ),
    /selection/,
  )
  assert.equal(f.session.snapshot(), snapshot)
  const stale = state.update(type(0, 'x', 1))
  surface.dispatch(type(0, 'y', 2))
  assert.throws(() => surface.bridge.dispatch([stale], surface.view), /stale/)
  assert.equal(f.session.snapshot().materialize(), 'ysmall')
  surface.dispose()
  f.session.dispose()
})

test('source selection survives reidentification and new CRLF seams without mutable aliases', () => {
  const f = fixture('\rX\n')
  const ranges = [{ anchor: 1, head: 1, association: 1 }]
  f.session.select({ ranges, mainIndex: 0 })
  ranges[0].head = 99
  f.session.edit([{ from: 1, to: 2, insert: '' }], 'source', 'delete')
  assert.equal(f.session.selection().ranges[0].head, 2)
  f.session.reidentify({ tabId: 'cm-test', revision: 4 })
  f.session.undo()
  assert.equal(f.session.snapshot().materialize(), '\rX\n')
  assert.equal(f.session.selection().ranges[0].head, 1)
  assert.equal(f.operations.at(-1).document.revision, 4)
  assert.deepEqual(f.errors, [])
  f.session.dispose()
})

test('source remount restores the host selection through mixed endings and tab reidentification', () => {
  const f = fixture('first\r\n😀second\nthird')
  const first = f.attach()
  first.dispatch({ selection: { anchor: 8, head: 14 } })
  const bookmark = f.session.selection()
  assert.deepEqual(bookmark.ranges[0], { anchor: 9, head: 15, association: -1 })
  first.dispose()
  f.session.reidentify({ tabId: 'cm-test', revision: 2 })
  const remounted = f.attach()
  assert.equal(remounted.view.state.selection.main.anchor, 8)
  assert.equal(remounted.view.state.selection.main.head, 14)
  assert.deepEqual(f.session.selection(), bookmark)
  assert.equal(f.operations.length, 0)
  remounted.dispatch(type(14, '!', 0))
  f.session.undo()
  assert.equal(remounted.view.state.selection.main.anchor, 8)
  assert.equal(remounted.view.state.selection.main.head, 14)
  assert.deepEqual(f.errors, [])
  remounted.dispose()
  f.session.dispose()
})

test('ENG24: 100k-line local input retains native CM Text and bounded source work', () => {
  const f = fixture('line\r\n'.repeat(100_000))
  const surface = f.attach()
  f.session.counters(true)
  for (let i = 0; i < 1000; i++) surface.dispatch(type(i, 'x', i))
  const counters = f.session.counters()
  assert.equal(counters.materializations, 0)
  assert.equal(f.operations.length, 1000)
  assert.equal(surface.view.state.doc.length, 501000)
  assert.equal(f.session.snapshot().utf16Length, 601000)
  assert.ok(counters.unitsScanned < 1_000_000, JSON.stringify(counters))
  assert.deepEqual(f.errors, [])
  surface.dispose()
  f.session.dispose()
})
