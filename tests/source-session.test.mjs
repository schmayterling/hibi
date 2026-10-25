import assert from 'node:assert/strict'
import test from 'node:test'
import { EditorState, StateEffect, Transaction } from '@codemirror/state'
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

test('a hidden source view coalesces canonical edits and catches up exactly when shown', () => {
  const f = fixture('one\r\ntwo\rthree\n')
  const surface = f.attach()
  surface.dispatch({ selection: { anchor: 3 } })
  surface.bridge.setVisible(false)
  f.observations.length = 0
  const at = (text) => f.session.snapshot().materialize().indexOf(text)
  for (const letter of 'abc')
    f.session.edit(
      [{ from: at('\r\n'), to: at('\r\n'), insert: letter }],
      'visual',
      'typing',
    )
  // Joining "\r" with a new "\n" turns two editor lines into one CRLF.
  f.session.edit(
    [{ from: at('three'), to: at('three'), insert: '\n' }],
    'visual',
    'seam',
  )
  f.session.edit([{ from: 0, to: 3, insert: 'ONE' }], 'visual', 'replace')
  f.session.undo()
  f.session.edit(
    [{ from: at('two'), to: at('two') + 3, insert: '' }],
    'visual',
    'delete',
  )
  assert.equal(f.observations.length, 0)
  assert.equal(f.operations.length, 7)
  assert.equal(f.session.snapshot().materialize(), 'oneabc\r\n\r\nthree\n')
  assert.equal(f.session.state().canUndo, true)
  surface.bridge.setVisible(true)
  assert.deepEqual(f.observations, [{ version: 7, operationCount: 7 }])
  assert.equal(
    surface.view.state.doc.toString(),
    sourceEditorText(f.session.snapshot()).toString(),
  )
  assert.equal(
    surface.view.state.selection.main.head,
    f.session.snapshot().rawToEditor(f.session.selection().ranges[0].head),
  )
  surface.dispatch(type(6, '!', 0))
  assert.equal(f.session.snapshot().materialize(), 'oneabc!\r\n\r\nthree\n')
  assert.ok(f.session.undo())
  assert.equal(surface.view.state.doc.toString(), 'oneabc\n\nthree\n')
  assert.deepEqual(f.errors, [])
  surface.dispose()
  f.session.dispose()
})

test('a shown source view gets the caret immediate echoes would have left', () => {
  const scenarios = [
    {
      source: 'abc\r\ndef\r\nghi',
      caret: 5,
      // Without a session selection, each echo maps the view's own caret.
      steps: [
        [6, 6, 'X'],
        [7, 7, 'Y', true],
        [0, 0, 'Z\r\n'],
        [0, 1, ''],
      ],
      head: 7,
    },
    {
      // Undo restores the untracked selection from before the caret was placed.
      source: 'abcdef',
      prefix: 'ZZ',
      caret: 5,
      steps: ['undo', [0, 0, 'XY'], [1, 6, '']],
      head: 1,
    },
    {
      source: 'abcdef',
      caret: 3,
      steps: [
        [2, 4, '', true],
        [1, 3, 'Y'],
      ],
    },
    {
      source: 'abcdef',
      caret: 3,
      steps: [
        [1, 5, 'X', true],
        [0, 1, ''],
      ],
    },
    {
      source: 'abcdef',
      caret: 3,
      steps: [
        [0, 0, 'X'],
        [2, 5, '', true],
        [1, 3, 'Y'],
      ],
    },
  ]
  const run = ({ source, prefix, caret, steps }, hidden) => {
    const f = fixture(source)
    if (prefix)
      f.session.edit([{ from: 0, to: 0, insert: prefix }], 'visual', 'prefix')
    const surface = f.attach()
    surface.dispatch({ selection: { anchor: caret } })
    surface.bridge.setVisible(!hidden)
    for (const step of steps) {
      if (step === 'undo') {
        f.session.undo()
        assert.equal(f.session.selection(), null)
        continue
      }
      const [from, to, insert, clear] = step
      f.session.edit(
        [{ from, to, insert }],
        'visual',
        'step',
        undefined,
        clear ? () => null : undefined,
      )
    }
    surface.bridge.setVisible(true)
    const result = {
      doc: surface.view.state.doc.toString(),
      selection: surface.view.state.selection.toJSON(),
      source: f.session.snapshot().materialize(),
      errors: f.errors,
    }
    surface.dispose()
    f.session.dispose()
    return result
  }
  for (const scenario of scenarios) {
    const live = run(scenario, false)
    if (scenario.head !== undefined)
      assert.equal(live.selection.ranges[0].head, scenario.head)
    assert.deepEqual(run(scenario, true), live, JSON.stringify(scenario.steps))
  }
})

test('reads, internal effects and stale input keep a hidden source replica exact', () => {
  const f = fixture('alpha\r\nbeta')
  const surface = f.attach()
  surface.dispatch({ selection: { anchor: 5 } })
  surface.bridge.setVisible(false)
  f.session.edit([{ from: 0, to: 0, insert: '# ' }], 'visual', 'heading')
  f.observations.length = 0
  // Parser and configuration effects apply to the replica without catching up.
  const effect = StateEffect.define()
  surface.bridge.dispatch(
    [surface.view.state.update({ effects: effect.of(1) })],
    surface.view,
  )
  assert.equal(surface.view.state.doc.toString(), 'alpha\nbeta')
  const selection = f.session.selection()
  surface.dispatch({ selection: { anchor: 1 } })
  assert.equal(f.session.selection(), selection)
  assert.throws(() => surface.dispatch(type(0, 'x', 0)), /synchronizing/)
  assert.equal(f.session.snapshot().materialize(), '# alpha\r\nbeta')
  assert.equal(surface.view.state.doc.toString(), '# alpha\nbeta')
  assert.equal(f.observations.length, 3)
  f.session.edit([{ from: 2, to: 7, insert: 'ALPHA' }], 'visual', 'caps')
  assert.equal(surface.bridge.snapshot(), f.session.snapshot())
  assert.equal(surface.view.state.doc.toString(), '# ALPHA\nbeta')
  assert.equal(f.operations.length, 2)
  assert.deepEqual(f.errors, [])
  surface.dispose()
  f.session.dispose()
})

test('storage compaction while source is hidden keeps the pending replica', async () => {
  const chunk = 65536
  const f = fixture('keep\r\nthis', { chunkUnits: chunk })
  const surface = f.attach()
  surface.bridge.setVisible(false)
  // One retained character per arena chunk leaves reclaimable storage.
  f.session.edit(
    [{ from: 4, to: 4, insert: 'x'.repeat(5 * chunk) }],
    'visual',
    'paste',
  )
  f.session.edit(
    Array.from({ length: 5 }, (_, index) => ({
      from: 5 + index * chunk,
      to: 4 + (index + 1) * chunk,
      insert: '',
    })),
    'visual',
    'cut',
  )
  f.session.edit([{ from: 0, to: 0, insert: '> ' }], 'visual', 'quote')
  const before = f.session.snapshot()
  await f.session.maintainStorage()
  assert.notEqual(f.session.snapshot(), before)
  f.session.edit([{ from: 17, to: 17, insert: '!' }], 'visual', 'mark')
  surface.bridge.setVisible(true)
  assert.equal(surface.view.state.doc.toString(), '> keepxxxxx\nthis!')
  assert.equal(f.session.snapshot().materialize(), '> keepxxxxx\r\nthis!')
  assert.deepEqual(f.errors, [])
  surface.dispose()
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
