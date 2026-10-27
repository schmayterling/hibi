import assert from 'node:assert/strict'
import test from 'node:test'
import {
  Annotation,
  Compartment,
  EditorSelection,
  EditorState,
  Prec,
  StateEffect,
  StateField,
  Transaction,
} from '@codemirror/state'
import {
  createSourceSession,
  failedEditGuard,
  failingParts,
  firstStateRead,
  reconfiguration,
  sourceEditTransaction,
  transactionState,
} from '../src/renderer/src/source-session.ts'
import { DocumentSession } from '../src/shared/document-session.ts'
import { runSourceHistory } from '../src/shared/source-history.ts'
import { sourceEditorText } from './source-editor-text.mjs'

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
  const attach = (viewId, reject) => {
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
    const dispose = bridge.attach(view, reject)
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
test('unmounted panes keep independent places mapped through edits without full-source reads', () => {
  const f = fixture('a\r\n😀b\r\n'.repeat(60000), {}, [
    EditorState.allowMultipleSelections.of(true),
  ])
  const source = f.attach('source'),
    other = f.attach('other')
  source.dispatch({
    selection: EditorSelection.create([
      EditorSelection.range(102, 106),
      EditorSelection.cursor(120),
    ]),
  })
  other.dispatch({ selection: { anchor: 202, head: 198 } })
  source.bridge.keepPlace(source.view, 90, -7)
  other.bridge.keepPlace(other.view, 180, -3)
  source.dispose()
  other.dispose()
  f.session.releaseView('source')
  f.session.releaseView('other')
  f.session.counters(true)
  f.session.edit([{ from: 0, to: 0, insert: 'é\r\n' }], 'visual', 'prefix')
  f.session.undo()
  f.session.redo()
  const bridge = createSourceSession(f.session, 'source'),
    place = bridge.place(),
    second = createSourceSession(f.session, 'other').place()
  assert.deepEqual(
    place.selection.ranges.map(({ anchor, head }) => ({ anchor, head })),
    [
      { anchor: 104, head: 108 },
      { anchor: 122, head: 122 },
    ],
  )
  assert.equal(place.top, 92)
  assert.equal(place.margin, -7)
  assert.equal(second.selection.main.anchor, 204)
  assert.equal(second.selection.main.head, 200)
  assert.equal(second.top, 182)
  assert.equal(second.margin, -3)
  assert.equal(bridge.place(), null)
  assert.equal(f.session.counters().materializations, 0)
  assert.ok(f.session.counters().sourceUnitsRead < 1000)
  assert.deepEqual(f.errors, [])
  f.session.dispose()
})

test('addon admission uses exact ranges and rejects native vetoes without flattening', () => {
  for (const extensions of [
    [],
    [EditorState.changeFilter.of(() => false)],
    [
      EditorState.transactionFilter.of((tr) => [
        tr,
        { changes: { from: tr.newDoc.length, insert: '!' }, sequential: true },
      ]),
    ],
  ]) {
    const f = fixture('a\r\n😀b'.repeat(30000), {}, extensions)
    const view = f.attach()
    f.session.counters(true)
    const snapshot = f.session.snapshot()
    const changes = [{ from: 5, to: 6, insert: 'B', expectedText: 'b' }]
    if (extensions.length)
      assert.throws(
        () =>
          sourceEditTransaction(view.view.state, snapshot, changes, 1000000),
        /extension changed/,
      )
    else {
      const transaction = sourceEditTransaction(
        view.view.state,
        snapshot,
        changes,
        1000000,
      )
      assert.ok(transaction)
      view.bridge.dispatch([transaction], view.view, changes)
      assert.equal(f.session.snapshot().sliceRaw(0, 6), 'a\r\n😀B')
      view.bridge.undo()
      assert.equal(f.session.snapshot().sliceRaw(0, 6), 'a\r\n😀b')
    }
    assert.equal(f.session.counters().materializations, 0)
    assert.ok(f.session.counters().sourceUnitsRead < 1000)
    view.dispose()
    f.session.dispose()
  }
})

test('addon admission rejects mismatched native lengths before reading source', () => {
  const f = fixture('a\r\n😀b')
  const snapshot = f.session.snapshot()
  f.session.counters(true)
  for (const doc of ['a', 'a longer native replica'])
    for (const insert of ['A', 'a'])
      assert.throws(
        () =>
          sourceEditTransaction(
            EditorState.create({ doc }),
            snapshot,
            [{ from: 0, to: 1, insert, expectedText: 'a' }],
            100,
          ),
        /The source editor is synchronizing/,
      )
  assert.equal(f.session.counters().sourceUnitsRead, 0)
  assert.equal(f.session.counters().materializations, 0)
  assert.equal(f.operations.length, 0)
  f.session.dispose()
})

test('addon admission preserves exact byte limits and line-ending-only refusal', () => {
  for (const [source, changes, maximum, error] of [
    [
      'é',
      [{ from: 0, to: 1, insert: '😀', expectedText: 'é' }],
      3,
      /size limit/,
    ],
    [
      'a\r\nb',
      [{ from: 1, to: 3, insert: '\n', expectedText: '\r\n' }],
      100,
      /line-ending pairs/,
    ],
    [
      'a\r\nb',
      [{ from: 2, to: 2, insert: 'x', expectedText: '' }],
      100,
      /split/,
    ],
    [
      'abc',
      [{ from: 1, to: 2, insert: 'x', expectedText: 'wrong' }],
      100,
      /text at/,
    ],
  ]) {
    const f = fixture(source)
    const view = f.attach()
    assert.throws(
      () =>
        sourceEditTransaction(
          view.view.state,
          f.session.snapshot(),
          changes,
          maximum,
        ),
      error,
    )
    assert.equal(f.session.snapshot().version, 0)
    view.dispose()
    f.session.dispose()
  }
})

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
for (const hidden of [false, true]) {
  for (const failure of ['before update', 'after update', 'state update']) {
    test(`a ${hidden ? 'hidden' : 'shown'} view failing ${failure} rejects edits and history until rebuilt`, (t) => {
      const f = fixture('start')
      t.after(() => f.session.dispose())
      const source = f.attach('source')
      const formatted = createSourceSession(f.session, 'formatted')
      let fail = true
      const rejected = []
      const shown = {
        state: EditorState.create({
          doc: sourceEditorText(f.session.snapshot()),
          extensions:
            failure === 'state update'
              ? StateField.define({
                  create: () => null,
                  update(value, transaction) {
                    if (fail && transaction.docChanged) {
                      fail = false
                      throw new Error('Fixture rejected the echo.')
                    }
                    return value
                  },
                })
              : [],
        }),
        update(transactions) {
          const reject = fail && transactions.some((tr) => tr.docChanged)
          if (reject) fail = false
          if (reject && failure === 'before update')
            throw new Error('Fixture rejected the echo.')
          for (const transaction of transactions) this.state = transaction.state
          if (reject && failure === 'after update')
            throw new Error('Fixture rejected the echo.')
        },
        setState(state) {
          this.state = state
        },
      }
      const detach = formatted.attach(shown, (error) =>
        rejected.push(error.message),
      )
      formatted.setVisible(!hidden)
      const type = (insert) =>
        source.dispatch({
          changes: { from: source.view.state.doc.length, insert },
          userEvent: 'input.type',
        })
      type('!')
      // Showing a hidden view must isolate the same failure as an immediate echo.
      formatted.setVisible(true)
      assert.deepEqual(rejected, ['Fixture rejected the echo.'])
      assert.equal(formatted.isCurrent(), false)
      type('?')
      // A failed draw is redrawn at the accepted echo; a failed state update
      // never reaches the view.
      assert.equal(
        shown.state.doc.toString(),
        failure === 'state update' ? 'start' : 'start!',
      )
      assert.equal(f.session.snapshot().materialize(), 'start!?')
      assert.throws(
        () =>
          formatted.dispatch(
            [shown.state.update({ changes: { from: 0, insert: 'x' } })],
            shown,
          ),
        /synchronizing/,
      )
      // Local selection and effects must not publish positions from stale text.
      const selection = f.session.selection('formatted')
      formatted.dispatch(
        [shown.state.update({ selection: { anchor: 1 } })],
        shown,
      )
      assert.equal(shown.state.selection.main.head, 1)
      assert.deepEqual(f.session.selection('formatted'), selection)
      assert.equal(formatted.undo(), false)
      assert.equal(runSourceHistory(shown, 'undo'), false)
      assert.equal(f.session.snapshot().materialize(), 'start!?')
      assert.equal(source.bridge.undo(), true)
      const undone = f.session.snapshot().materialize()
      assert.equal(formatted.redo(), false)
      assert.equal(runSourceHistory(shown, 'redo'), false)
      assert.equal(f.session.snapshot().materialize(), undone)
      assert.equal(source.bridge.redo(), true)
      assert.equal(f.session.snapshot().materialize(), 'start!?')
      formatted.keepPlace(shown, 0, -7)
      detach()
      const retry = createSourceSession(f.session, 'formatted')
      assert.equal(retry.place(), null)
      assert.equal(retry.snapshot(), f.session.snapshot())
      assert.deepEqual(rejected, ['Fixture rejected the echo.'])
      assert.deepEqual(f.errors, [])
    })
  }
}

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
  assert.equal(surface.bridge.isCurrent(), false)
  const selection = f.session.selection()
  surface.dispatch({ selection: { anchor: 1 } })
  assert.equal(f.session.selection(), selection)
  assert.throws(() => surface.dispatch(type(0, 'x', 0)), /synchronizing/)
  assert.equal(f.session.snapshot().materialize(), '# alpha\r\nbeta')
  assert.equal(surface.view.state.doc.toString(), '# alpha\nbeta')
  assert.equal(surface.bridge.isCurrent(), true)
  assert.equal(f.observations.length, 3)
  f.session.edit([{ from: 2, to: 7, insert: 'ALPHA' }], 'visual', 'caps')
  assert.equal(surface.bridge.isCurrent(), false)
  assert.equal(surface.bridge.snapshot(), f.session.snapshot())
  assert.equal(surface.bridge.isCurrent(), true)
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

test('a view update that throws while drawing is redrawn at the accepted state', () => {
  const f = fixture('one\r\ntwo\r\n')
  const rejected = []
  const surface = f.attach(undefined, (error) => rejected.push(error.message))
  const other = f.attach('other')
  const resets = []
  const draw = surface.view.update
  // CodeMirror sets its new state before drawing, so a draw can fail after it.
  let failure = 'after'
  surface.view.update = function (transactions) {
    const mode = failure
    failure = ''
    if (mode !== 'before') draw.call(this, transactions)
    if (mode) throw new Error(`draw failed ${mode}`)
  }
  surface.view.setState = function (state) {
    resets.push(state)
    this.state = state
  }
  surface.dispatch(type(3, 'X', 1))
  assert.equal(f.session.snapshot().materialize(), 'oneX\r\ntwo\r\n')
  assert.equal(surface.view.state.doc.toString(), 'oneX\ntwo\n')
  assert.equal(resets.at(-1), surface.view.state)
  surface.dispatch(type(4, 'Y', 2))
  failure = 'before'
  surface.dispatch(type(5, 'Z', 3))
  assert.equal(f.session.snapshot().materialize(), 'oneXYZ\r\ntwo\r\n')
  assert.equal(surface.view.state.doc.toString(), 'oneXYZ\ntwo\n')
  assert.equal(resets.at(-1), surface.view.state)
  // Canonical edits from another view reach a failing view the same way,
  // which then takes no edits or history until it is rebuilt.
  failure = 'after'
  other.dispatch(type(10, '!', 600))
  assert.equal(f.session.snapshot().materialize(), 'oneXYZ\r\ntwo!\r\n')
  assert.equal(surface.view.state.doc.toString(), 'oneXYZ\ntwo!\n')
  assert.equal(resets.length, 3)
  assert.deepEqual(
    f.errors.map((error) => error.message),
    ['draw failed after', 'draw failed before'],
  )
  assert.deepEqual(rejected, ['draw failed after'])
  assert.throws(() => surface.dispatch(type(0, '?', 700)), /synchronizing/)
  assert.equal(surface.bridge.undo(), false)
  // Its selection still moves, and a failed draw of it is redrawn too.
  failure = 'before'
  assert.throws(
    () => surface.dispatch({ selection: { anchor: 0 } }),
    /draw failed before/,
  )
  assert.equal(resets.length, 4)
  assert.equal(surface.view.state.selection.main.head, 0)
  surface.dispose()
  const rebuilt = f.attach()
  rebuilt.bridge.undo()
  rebuilt.bridge.undo()
  assert.equal(f.session.snapshot().materialize(), 'one\r\ntwo\r\n')
  assert.equal(rebuilt.view.state.doc.toString(), 'one\ntwo\n')
  assert.equal(other.view.state.doc.toString(), 'one\ntwo\n')
  rebuilt.bridge.redo()
  assert.equal(rebuilt.view.state.doc.toString(), 'oneXYZ\ntwo\n')
  assert.equal(resets.length, 4)
  assert.deepEqual(rejected, ['draw failed after'])
  rebuilt.dispose()
  other.dispose()
  f.session.dispose()
})

test('an edit the session rejects leaves the view at the canonical text', () => {
  let reject = false
  const f = fixture('ab\r\n', {
    admit: () => {
      if (reject) throw new Error('rejected')
    },
  })
  const surface = f.attach()
  const resets = []
  surface.view.setState = (state) => resets.push(state)
  reject = true
  assert.throws(() => surface.dispatch(type(2, 'X', 1)), /rejected/)
  assert.equal(f.session.snapshot().materialize(), 'ab\r\n')
  assert.equal(surface.view.state.doc.toString(), 'ab\n')
  reject = false
  surface.dispatch(type(2, 'Y', 2))
  assert.equal(f.session.snapshot().materialize(), 'abY\r\n')
  assert.equal(surface.view.state.doc.toString(), 'abY\n')
  assert.deepEqual(resets, [])
  assert.deepEqual(f.errors, [])
  surface.dispose()
  f.session.dispose()
})

test('an edit an extension fails on names that extension and keeps the others', () => {
  const failsOn = (name, fails) =>
    StateField.define({
      create: () => 0,
      update(value, transaction) {
        if (fails(transaction)) throw new Error(`${name} failed`)
        return value + 1
      },
    })
  const typedQ = (transaction) => transaction.newDoc.toString().includes('Q')
  const parts = [
    { name: 'healthy', extension: failsOn('healthy', () => false) },
    { name: 'q', extension: failsOn('q', typedQ) },
    {
      name: 'typing',
      extension: failsOn('typing', (transaction) =>
        transaction.isUserEvent('input.type'),
      ),
    },
    { name: 'later', extension: failsOn('later', () => false) },
  ]
  const compartment = new Compartment()
  const install = (kept) =>
    compartment.reconfigure(kept.map(({ extension }) => extension))
  // Like the editor's completion extender, which reads each new state first.
  const extender = EditorState.transactionExtender.of((transaction) => {
    transactionState(transaction)
    return null
  })
  const start = EditorState.create({
    doc: 'end',
    extensions: [
      extender,
      compartment.of(parts.map(({ extension }) => extension)),
    ],
  })
  const names = (failing) =>
    failing.map(({ part, error }) => `${part.name}: ${error.message}`)
  const typed = start.update({
    changes: { from: 3, insert: 'Q' },
    userEvent: 'input.type',
  })
  assert.equal(transactionState(typed), null)
  // Read later, it is the state the edit started from, not the part CodeMirror reached.
  assert.equal(typed.state, start)
  const moved = start.update({ selection: { anchor: 0 } })
  assert.equal(transactionState(moved), moved.state)
  assert.deepEqual(names(failingParts(start, [moved], parts, install)), [])
  // Each failing extension is named with its own error, also in a batch.
  assert.deepEqual(names(failingParts(start, [typed], parts, install)), [
    'q: q failed',
    'typing: typing failed',
  ])
  const batch = [
    moved,
    moved.state.update({
      changes: { from: 0, insert: 'Q' },
      userEvent: 'input.type',
    }),
  ]
  assert.deepEqual(names(failingParts(start, batch, parts, install)), [
    'q: q failed',
    'typing: typing failed',
  ])
  const pasted = start.update({
    changes: { from: 3, insert: 'Q' },
    userEvent: 'input.paste',
  })
  assert.deepEqual(names(failingParts(start, [pasted], parts, install)), [
    'q: q failed',
  ])
  // An extension's own annotation is replayed with the edit.
  const own = Annotation.define()
  const annotated = {
    name: 'annotated',
    extension: failsOn('annotated', (transaction) =>
      transaction.annotation(own),
    ),
  }
  const command = start.update({
    changes: { from: 3, insert: 'x' },
    annotations: own.of(true),
  })
  assert.deepEqual(
    names(failingParts(start, [command], [...parts, annotated], install)),
    ['annotated: annotated failed'],
  )
  // Installing alone: a value that is no extension is named.
  const invalid = { name: 'invalid', extension: { not: 'an extension' } }
  const empty = EditorState.create({
    doc: 'end',
    extensions: [extender, compartment.of([])],
  })
  assert.deepEqual(
    failingParts(empty, [], [parts[0], invalid, parts[3]], install).map(
      ({ part }) => part.name,
    ),
    ['invalid'],
  )
  // An edit that fails without any of them names none.
  const base = EditorState.create({
    doc: 'end',
    extensions: [extender, failsOn('base', typedQ), compartment.of([])],
  })
  const baseTyped = base.update({ changes: { from: 3, insert: 'Q' } })
  assert.deepEqual(failingParts(base, [baseTyped], parts, install), [])
})

test('filters and extenders that read a state never see one an extension failed on', () => {
  const failing = StateField.define({
    create: () => 0,
    update(value, transaction) {
      if (transaction.newDoc.toString().includes('Q'))
        throw new Error('field failed')
      return value
    },
  })
  // An addon's filter and extender that read its own field.
  const reading = (required) => [
    failing,
    EditorState.transactionFilter.of((transaction) => {
      transaction.state.field(failing, required)
      return transaction
    }),
    EditorState.transactionExtender.of((transaction) => {
      transaction.state.field(failing, required)
      return null
    }),
  ]
  const feature = reading(true)
  const typedQ = { changes: { from: 3, insert: 'Q' }, userEvent: 'input.type' }
  // Without the guard, the failure escapes while the edit is made: first from
  // the filter, then, once a raw read has swallowed it, from the half-built state.
  const swallowing = EditorState.transactionExtender.of((transaction) => {
    try {
      transaction.state
    } catch {}
    return null
  })
  for (const extensions of [feature, [failing, feature[2], swallowing]])
    assert.throws(
      () => EditorState.create({ doc: 'end', extensions }).update(typedQ),
      extensions === feature ? /field failed/ : /Cyclic dependency/,
    )
  const compartment = new Compartment()
  const install = (kept) =>
    compartment.reconfigure(kept.map(({ extension }) => extension))
  const names = (start, edit, parts) =>
    failingParts(start, edit, parts, install).map(
      ({ part, error }) => `${part.name}: ${error.message}`,
    )
  // A filter may rebuild the transaction that stands in for the edit.
  const rebuilding = [
    failing,
    EditorState.transactionFilter.of((transaction) => ({
      changes: transaction.changes,
      selection: transaction.selection,
      effects: transaction.effects,
      scrollIntoView: transaction.scrollIntoView,
    })),
  ]
  for (const extension of [reading(true), reading(false), rebuilding]) {
    const start = EditorState.create({
      doc: 'end',
      extensions: [compartment.of(extension), failedEditGuard],
    })
    const typed = start.update(typedQ)
    assert.equal(transactionState(typed), null)
    // Read later, it is the state the edit started from, not a half-built one.
    assert.equal(typed.state, start)
    // Leaving it out does not run its extender, which may require its field.
    assert.deepEqual(names(start, [typed], [{ name: 'feature', extension }]), [
      'feature: field failed',
    ])
    // In a batch, the edits before it are replayed first.
    const first = start.update({ changes: { from: 3, insert: 'a' } })
    const second = first.state.update({ changes: { from: 4, insert: 'Q' } })
    assert.equal(transactionState(second), null)
    assert.deepEqual(
      names(start, [first, second], [{ name: 'feature', extension }]),
      ['feature: field failed'],
    )
    // An edit made from a failed one starts where that one did; the failed
    // one is named from its own start.
    const after = second.state.update({ changes: { from: 4, insert: 'b' } })
    assert.equal(transactionState(after)?.doc.toString(), 'endab')
    assert.deepEqual(
      names(second.startState, [second], [{ name: 'feature', extension }]),
      ['feature: field failed'],
    )
    const removed = reconfiguration(start, install([])).state
    assert.equal(removed.field(failing, false), undefined)
    const typedB = start.update({ changes: { from: 3, insert: 'b' } })
    assert.equal(transactionState(typedB)?.doc.toString(), 'endb')
  }
  // Of two edits made from one state, the one dispatched is named.
  const alternatives = ['A', 'B'].map((letter) => ({
    name: letter,
    extension: StateField.define({
      create: () => 0,
      update(value, transaction) {
        if (transaction.newDoc.toString().includes(letter))
          throw new Error(`${letter} failed`)
        return value
      },
    }),
  }))
  const both = EditorState.create({
    doc: 'end',
    extensions: [
      compartment.of(alternatives.map(({ extension }) => extension)),
      failedEditGuard,
    ],
  })
  const [chosen] = ['A', 'B'].map((insert) =>
    both.update({ changes: { from: 3, insert } }),
  )
  assert.deepEqual(names(both, [chosen], alternatives), ['A: A failed'])
  // A transaction an extender fails to make is replayed from its specs.
  const extending = [
    EditorState.transactionExtender.of((transaction) => {
      if (transaction.newDoc.toString().includes('Z'))
        throw new Error('extender failed')
      return null
    }),
  ]
  const typedZ = { changes: { from: 3, insert: 'Z' } }
  const made = EditorState.create({
    doc: 'end',
    extensions: [compartment.of(extending), failedEditGuard],
  })
  assert.throws(() => made.update(typedZ), /extender failed/)
  assert.deepEqual(
    names(made, [typedZ], [{ name: 'extending', extension: extending }]),
    ['extending: extender failed'],
  )
})

test('a failure an extension caught while reading the state is still rejected', () => {
  const failing = StateField.define({
    create: () => 0,
    update(value, transaction) {
      if (transaction.docChanged && transaction.newDoc.toString().includes('Q'))
        throw new Error('field failed')
      return value
    },
  })
  const swallowed = []
  const feature = [
    failing,
    // Reads the new state before any guard and hides the failure.
    EditorState.changeFilter.of((transaction) => {
      try {
        transaction.state.field(failing)
      } catch (error) {
        swallowed.push(error.message)
      }
      return true
    }),
  ]
  const f = fixture('end', {}, [firstStateRead, feature, failedEditGuard])
  const surface = f.attach()
  const typed = type(3, 'Q', 1)
  assert.throws(() => surface.dispatch(typed), /field failed/)
  // Read first, the failure is kept before the filter runs; it reads the start.
  assert.deepEqual(swallowed, [])
  assert.equal(f.session.snapshot().materialize(), 'end')
  assert.equal(surface.view.state.doc.toString(), 'end')
  surface.dispatch(type(3, 'b', 2))
  assert.equal(f.session.snapshot().materialize(), 'endb')
  assert.deepEqual(f.errors, [])
  surface.dispose()
  f.session.dispose()
  // An addon can append an extender after the guards. On an edit made
  // without filters it reads the state first and catches the failure; the
  // state CodeMirror left unfinished still fails.
  const appended = EditorState.create({
    doc: 'end',
    extensions: [firstStateRead, failing, failedEditGuard],
  }).update({
    effects: StateEffect.appendConfig.of(
      Prec.lowest(
        EditorState.transactionExtender.of((transaction) => {
          try {
            transaction.state
          } catch {}
          return null
        }),
      ),
    ),
  }).state
  const late = appended.update({
    changes: { from: 3, insert: 'Q' },
    filter: false,
  })
  assert.equal(transactionState(late), null)
  // Then it reads as the state the edit started from.
  assert.equal(late.state, appended)
})

test('an edit an extension fails on reaches neither the session nor the view', () => {
  const failing = StateField.define({
    create: () => 0,
    update(value, transaction) {
      if (transaction.newDoc.toString().includes('Q'))
        throw new Error('field failed')
      return value
    },
  })
  const f = fixture('end\r\n', {}, [
    EditorState.transactionExtender.of((transaction) => {
      transactionState(transaction)
      return null
    }),
    failing,
  ])
  const surface = f.attach()
  const resets = []
  surface.view.setState = (state) => resets.push(state)
  assert.throws(() => surface.dispatch(type(3, 'Q', 1)), /field failed/)
  assert.equal(f.session.snapshot().materialize(), 'end\r\n')
  assert.equal(surface.view.state.doc.toString(), 'end\n')
  surface.dispatch(type(3, 'b', 2))
  assert.equal(f.session.snapshot().materialize(), 'endb\r\n')
  assert.equal(surface.view.state.doc.toString(), 'endb\n')
  assert.deepEqual(resets, [])
  assert.deepEqual(f.errors, [])
  surface.dispose()
  f.session.dispose()
})
