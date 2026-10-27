import assert from 'node:assert/strict'
import test from 'node:test'
import { EditorSelection, EditorState, Transaction } from '@codemirror/state'
import { formattedProjection } from '../src/renderer/src/formatted-projection.ts'
import { createSourceSession } from '../src/renderer/src/source-session.ts'
import { DocumentSession } from '../src/shared/document-session.ts'
import { normalizedSource } from '../src/shared/source-projection.ts'

function fixture(text, adapter) {
  const session = new DocumentSession(
    text,
    { tabId: 'projection', revision: 0 },
    0,
    {
      enqueue() {},
      onError(error) {
        throw error
      },
    },
  )
  const bridge = createSourceSession(session)
  const view = {
    state: EditorState.create({
      doc: normalizedSource(text),
      extensions: formattedProjection([adapter], session.snapshot),
    }),
    update(transactions) {
      for (const transaction of transactions) this.state = transaction.state
    },
  }
  bridge.attach(view)
  const dispatch = (...specs) =>
    bridge.dispatch([view.state.update(...specs)], view)
  return { session, bridge, view, dispatch }
}
const prefix = '\uFEFF[@sources: é 😀 exact  ]\r\n\r\n'
const suffix = '\r\n[@end]'
let parses = 0
const adapter = {
  id: 'citations',
  preservation: { level: 'verbatim', version: '1' },
  parse(source) {
    parses++
    if (!source.startsWith(prefix) || !source.endsWith(suffix)) return null
    return {
      sourceOffset: prefix.length,
      content: source.slice(prefix.length, -suffix.length),
      serialize() {
        throw new Error('The host owns untouched source')
      },
    }
  },
}

test('verbatim bodies hide and protect prefix and suffix through selection, replacement and undo', () => {
  const f = fixture(prefix + 'body 😀' + suffix, adapter)
  const from = normalizedSource(prefix).length
  f.dispatch({ selection: EditorSelection.range(f.view.state.doc.length, 0) })
  assert.equal(f.view.state.selection.main.anchor, from + 'body 😀'.length)
  assert.equal(f.view.state.selection.main.head, from)
  f.dispatch(f.view.state.replaceSelection('changed\nbody'), {
    annotations: Transaction.userEvent.of('input.type'),
  })
  assert.equal(
    f.session.snapshot().materialize(),
    prefix + 'changed\r\nbody' + suffix,
  )
  const before = f.view.state.doc
  for (const change of [
    { from: 0, to: from, insert: '' },
    { from: f.view.state.doc.length, insert: 'lost' },
  ])
    f.dispatch({ changes: change })
  assert.equal(f.view.state.doc, before)
  f.bridge.undo()
  assert.equal(f.session.snapshot().materialize(), prefix + 'body 😀' + suffix)
  f.bridge.redo()
  assert.equal(
    f.session.snapshot().materialize(),
    prefix + 'changed\r\nbody' + suffix,
  )
})

test('canonical source-prefix changes refresh projection bounds without running input filters', () => {
  const f = fixture(prefix + 'body' + suffix, adapter)
  f.session.edit(
    [{ from: 0, to: prefix.length, insert: '' }],
    'source',
    'header',
  )
  assert.equal(f.view.state.doc.toString(), normalizedSource('body' + suffix))
  f.dispatch({ selection: { anchor: 0 } })
  assert.equal(f.view.state.selection.main.head, 0)
  f.bridge.undo()
  f.dispatch({ selection: { anchor: 0 } })
  assert.equal(
    f.view.state.selection.main.head,
    normalizedSource(prefix).length,
  )
})

test('unprovable verbatim adapters cannot accept changes', () => {
  const f = fixture('source', {
    ...adapter,
    parse: () => ({
      sourceOffset: 0,
      content: 'generated',
      serialize: (value) => value,
    }),
  })
  assert.equal(f.view.state.readOnly, true)
  f.dispatch({ changes: { from: 0, to: 6, insert: 'lost' } })
  assert.equal(f.session.snapshot().materialize(), 'source')
})

test('50 mib projected body edits map bounds without parser calls or whole-source reads', () => {
  const f = fixture(prefix + 'x'.repeat(50 * 1024 * 1024) + suffix, adapter)
  const count = parses
  f.session.counters(true)
  for (let i = 0; i < 20; i++) {
    const at = f.view.state.doc.length - normalizedSource(suffix).length
    f.dispatch({
      changes: { from: at, insert: 'y' },
      selection: { anchor: at + 1 },
    })
  }
  assert.equal(parses, count)
  const counters = f.session.counters()
  assert.equal(counters.materializations, 0)
  assert.ok(counters.sourceUnitsRead < 4096, JSON.stringify(counters))
})
