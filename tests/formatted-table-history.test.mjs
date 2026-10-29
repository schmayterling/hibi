import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { isolateHistory } from '@codemirror/commands'
import {
  Compartment,
  EditorSelection,
  EditorState,
  Transaction,
} from '@codemirror/state'
import { GFM } from '@lezer/markdown'
import {
  formattedDocument,
  formattedTree,
} from '../src/renderer/src/formatted-contributions.ts'
import { sourceFormatting } from '../src/renderer/src/source-formatting.ts'
import { createSourceSession } from '../src/renderer/src/source-session.ts'
import { DocumentSession } from '../src/shared/document-session.ts'
import { formattedMarkdownParser } from '../src/shared/formatted-markdown.ts'

registerHooks({
  load: (url, context, next) =>
    url.endsWith('.css')
      ? { format: 'module', source: '', shortCircuit: true }
      : next(url, context),
})
const { contribution } = await import('../src/renderer/src/formatted/tables.ts')
const { cellInput } = await import(
  '../src/renderer/src/formatted/table-cells.ts'
)
const grammar = formattedMarkdownParser(GFM)
const source = 'plain\n\n| aa | bb |\n| -- | -- |\n| cell | tail |\n'

function fixture(t, anchor, head, { genuine = true, multiple = false } = {}) {
  const owner = new Compartment()
  const session = new DocumentSession(
    source,
    { tabId: 'table-history', revision: 1 },
    0,
    {
      enqueue() {},
      onError(error) {
        throw error
      },
    },
  )
  t.after(() => session.dispose())
  const attach = (id, formatted) => {
    const bridge = createSourceSession(session, id)
    const view = {
      state: EditorState.create({
        doc: source,
        extensions: formatted
          ? [
              contribution.extension,
              EditorState.allowMultipleSelections.of(multiple),
              owner.of(
                formattedDocument.of({ tabId: 'table-history', revision: 1 }),
              ),
              formattedTree.of((state) => grammar.parse(state.doc.toString())),
            ]
          : [],
      }),
      composing: false,
      focus() {},
      update(transactions) {
        for (const tr of transactions) this.state = tr.state
      },
      dispatch(...specs) {
        bridge.dispatch([this.state.update(...specs)], this)
      },
    }
    const detach = bridge.attach(view)
    t.after(detach)
    return { bridge, view }
  }
  const formatted = attach('formatted', true)
  const plain = attach('source', false)
  // The registered DOM pick supplies this same annotation. No browser input
  // is simulated here: these checks exercise the real source-history bridge.
  formatted.view.dispatch({
    selection: multiple
      ? EditorSelection.create(
          [EditorSelection.range(0, 1), EditorSelection.range(anchor, head)],
          1,
        )
      : { anchor, head },
    ...(genuine ? { annotations: cellInput.of(true) } : {}),
    userEvent: genuine ? 'select.pointer' : 'select',
  })
  return { ...formatted, plain, session, owner }
}

for (const sameRow of [false, true]) {
  for (const reverse of [false, true]) {
    test(`genuine table text pick history collapses the restored upper endpoint, row=${sameRow}, reverse=${reverse}`, (t) => {
      const from = sameRow ? source.indexOf('cell') + 1 : 1,
        to = source.indexOf(sameRow ? 'tail' : 'cell') + 2
      const { view, bridge, plain, session } = fixture(
        t,
        reverse ? to : from,
        reverse ? from : to,
      )
      const original = view.state.selection
      assert.equal(
        sourceFormatting(view).run(sameRow ? 'italic' : 'bold'),
        true,
      )
      const formatted = view.state.doc.toString(),
        selected = view.state.selection
      assert.equal(selected.main.empty, false)
      assert.equal(session.snapshot().version, 1)
      // A subsequent source edit clears the live pick; undo restores its
      // selection kind from the captured history effects, not stale DOM.
      view.dispatch({
        ...view.state.replaceSelection('Z'),
        annotations: isolateHistory.of('full'),
        userEvent: 'input.type',
      })
      const typed = view.state.doc.toString()
      assert.equal(session.snapshot().version, 2)
      assert.equal(bridge.undo(), true)
      assert.equal(view.state.doc.toString(), formatted)
      assert.deepEqual(
        view.state.selection.toJSON(),
        EditorSelection.single(selected.main.to).toJSON(),
      )
      assert.deepEqual(
        plain.view.state.selection.toJSON(),
        EditorSelection.single(0).toJSON(),
      )
      assert.equal(bridge.undo(), true)
      assert.equal(view.state.doc.toString(), source)
      assert.deepEqual(
        view.state.selection.toJSON(),
        EditorSelection.single(original.main.to).toJSON(),
      )
      assert.equal(bridge.redo(), true)
      assert.equal(view.state.doc.toString(), formatted)
      assert.deepEqual(
        view.state.selection.toJSON(),
        EditorSelection.single(selected.main.to).toJSON(),
      )
      assert.equal(bridge.redo(), true)
      assert.equal(view.state.doc.toString(), typed)
      assert.equal(session.snapshot().version, 6)
      assert.deepEqual(
        plain.view.state.selection.toJSON(),
        EditorSelection.single(0).toJSON(),
      )
    })
  }
}

for (const document of [
  { tabId: 'other', revision: 1 },
  { tabId: 'table-history', revision: 2 },
]) {
  test(`genuine pick history keeps generic restored selection for another owner ${JSON.stringify(document)}`, (t) => {
    const { view, bridge, owner } = fixture(t, 1, source.indexOf('cell') + 2)
    const original = view.state.selection
    assert.equal(sourceFormatting(view).run('bold'), true)
    view.dispatch({
      effects: owner.reconfigure(formattedDocument.of(document)),
    })
    assert.equal(bridge.undo(), true)
    assert.equal(view.state.doc.toString(), source)
    assert.deepEqual(view.state.selection.toJSON(), original.toJSON())
  })
}

for (const multiple of [false, true]) {
  test(`generic and multiple table ranges retain their source history selection, multiple=${multiple}`, (t) => {
    const { view, bridge } = fixture(
      t,
      source.indexOf('cell') + 1,
      source.indexOf('tail') + 2,
      {
        genuine: multiple,
        multiple,
      },
    )
    const original = view.state.selection
    view.dispatch({
      ...view.state.replaceSelection('Z'),
      annotations: isolateHistory.of('full'),
      userEvent: 'input.type',
    })
    assert.equal(bridge.undo(), true)
    assert.equal(view.state.doc.toString(), source)
    assert.deepEqual(view.state.selection.toJSON(), original.toJSON())
  })
}

test('genuine table pick redo collapses past a later group that took its typing back', (t) => {
  const { view, bridge, session } = fixture(t, 1, source.indexOf('cell') + 2)
  assert.equal(sourceFormatting(view).run('bold'), true)
  const formatted = view.state.doc.toString(),
    selected = view.state.selection
  assert.equal(selected.main.empty, false)
  // A caret outside the table, then typing that its deletion takes back.
  view.dispatch({ selection: { anchor: 0 } })
  const time = Date.now()
  view.dispatch({
    changes: { from: 0, insert: 'Q' },
    selection: { anchor: 1 },
    annotations: Transaction.time.of(time),
    userEvent: 'input.type',
  })
  view.dispatch({
    changes: { from: 0, to: 1 },
    selection: { anchor: 0 },
    annotations: Transaction.time.of(time + 100),
    userEvent: 'delete.backward',
  })
  assert.deepEqual(session.historyDepth(), { undo: 1, redo: 0 })
  assert.equal(bridge.undo(), true)
  assert.equal(view.state.doc.toString(), source)
  assert.equal(bridge.redo(), true)
  assert.equal(view.state.doc.toString(), formatted)
  assert.deepEqual(
    view.state.selection.toJSON(),
    EditorSelection.single(selected.main.to).toJSON(),
  )
})
