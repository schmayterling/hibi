import assert from 'node:assert/strict'
import test from 'node:test'
import {
  EditorSelection,
  EditorState,
  StateEffect,
  Transaction,
} from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { parseFrontmatter } from '../src/addons/frontmatter/markdown.ts'
import {
  formattedProjection,
  formattedProjectionSource,
} from '../src/renderer/src/formatted-projection.ts'
import { createSourceSession } from '../src/renderer/src/source-session.ts'
import { DocumentSession } from '../src/shared/document-session.ts'
import { normalizedSource } from '../src/shared/source-projection.ts'

function fixture(text, adapter, prepare) {
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
  if (prepare) {
    prepare(session)
    text = session.snapshot().materialize()
  }
  const bridge = createSourceSession(session)
  const view = {
    state: EditorState.create({
      doc: normalizedSource(text),
      extensions: formattedProjection(
        Array.isArray(adapter) ? adapter : [adapter],
        session.snapshot,
      ),
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

test('frontmatter and custom projections protect the same ordered prefix', () => {
  const frontmatter = { id: 'frontmatter.metadata', parse: parseFrontmatter }
  const fm = '---\r\ntitle: exact\r\n---\r\n'
  const f = fixture(fm + prefix + 'body' + suffix, [frontmatter, adapter])
  f.dispatch({ selection: EditorSelection.range(0, f.view.state.doc.length) })
  assert.equal(
    f.view.state.selection.main.from,
    normalizedSource(fm + prefix).length,
  )
  f.dispatch(f.view.state.replaceSelection('changed'))
  assert.equal(
    f.session.snapshot().materialize(),
    fm + prefix + 'changed' + suffix,
  )
  const updated = fm.replace('exact', 'updated title')
  const next = updated + prefix + 'changed' + suffix
  f.dispatch({
    changes: {
      from: 0,
      to: normalizedSource(fm).length,
      insert: normalizedSource(updated),
    },
    annotations: formattedProjectionSource.of(next),
  })
  assert.equal(f.session.snapshot().materialize(), next)
  f.dispatch({ selection: { anchor: 0 } })
  assert.equal(
    f.view.state.selection.main.from,
    normalizedSource(updated + prefix).length,
  )
})

test('50 mib unmatched notes defer one proof to input and map interior echoes and history', () => {
  const f = fixture('x'.repeat(50 * 1024 * 1024), adapter)
  const count = parses
  f.session.counters(true)
  const background = StateEffect.define()
  for (let i = 0; i < 5; i++) {
    f.session.edit(
      [{ from: 10 + i, to: 10 + i, insert: 'y' }],
      'source',
      `s${i}`,
    )
    f.dispatch({ effects: background.of(i) })
  }
  assert.equal(parses, count, JSON.stringify(f.session.counters()))
  const afterEffects = f.session.counters()
  assert.equal(afterEffects.materializations, 0)
  assert.ok(afterEffects.sourceUnitsRead < 4096, JSON.stringify(afterEffects))
  for (let i = 0; i < 5; i++)
    f.dispatch({ changes: { from: 100, insert: 'z' } })
  assert.equal(parses, count + 1)
  assert.equal(f.session.counters().materializations, 1)
  f.session.counters(true)
  for (let i = 0; i < 5; i++) f.bridge.undo()
  for (let i = 0; i < 5; i++) f.bridge.redo()
  assert.equal(parses, count + 1)
  const counters = f.session.counters()
  assert.equal(counters.materializations, 0)
  assert.ok(counters.sourceUnitsRead < 4096, JSON.stringify(counters))
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

test('a fresh negative proof protects a header restored by undo without a focus event', () => {
  const f = fixture(prefix + 'body' + suffix, adapter, (session) =>
    session.edit(
      [{ from: 0, to: prefix.length, insert: '' }],
      'source',
      'header',
    ),
  )
  f.bridge.undo()
  f.dispatch({ selection: EditorSelection.range(0, f.view.state.doc.length) })
  f.dispatch(f.view.state.replaceSelection('typed'), {
    annotations: Transaction.userEvent.of('input.type'),
  })
  assert.equal(f.session.snapshot().materialize(), prefix + 'typed' + suffix)
})

test('a stale canonical echo rechecks before the next local selection and input', () => {
  const f = fixture('AB? body', {
    id: 'interior',
    preservation: { level: 'verbatim', version: '1' },
    parse(source) {
      if (!source.startsWith('AB! ')) return null
      return {
        sourceOffset: 4,
        content: source.slice(4),
        serialize: (text) => 'AB! ' + text,
      }
    },
  })
  f.session.edit([{ from: 2, to: 3, insert: '!' }], 'source', 'interior')
  f.dispatch({
    selection: { anchor: 0 },
    annotations: Transaction.userEvent.of('select'),
  })
  assert.equal(f.view.state.selection.main.head, 4)
  f.dispatch(f.view.state.replaceSelection('typed'))
  assert.equal(f.session.snapshot().materialize(), 'AB! typedbody')
})

test('local history-neutral edits are not canonical session echoes', () => {
  const f = fixture('plain text', adapter)
  f.dispatch({
    changes: { from: 0, insert: 'new ' },
    annotations: Transaction.addToHistory.of(false),
  })
  assert.equal(f.session.snapshot().materialize(), 'new plain text')
  assert.equal(f.view.state.readOnly, false)
})

test('stale local input cannot consume a newly protected prefix', () => {
  const f = fixture('AB? body', {
    id: 'interior-input',
    preservation: { level: 'verbatim', version: '1' },
    parse(source) {
      if (!source.startsWith('AB! ')) return null
      return {
        sourceOffset: 4,
        content: source.slice(4),
        serialize: (text) => 'AB! ' + text,
      }
    },
  })
  f.session.edit([{ from: 2, to: 3, insert: '!' }], 'source', 'interior')
  f.dispatch({ changes: { from: 0, insert: 'lost' } })
  assert.equal(f.session.snapshot().materialize(), 'AB! body')
  assert.equal(f.view.state.selection.main.head, 4)
  f.dispatch(f.view.state.replaceSelection('typed'))
  assert.equal(f.session.snapshot().materialize(), 'AB! typedbody')
})

test('50 mib local edits and refocuses do not re-read the source', () => {
  const original = EditorView.domEventHandlers
  let focus
  EditorView.domEventHandlers = (handlers) => {
    focus = handlers.focus
    return original.call(EditorView, handlers)
  }
  let f
  try {
    f = fixture(prefix + 'x'.repeat(50 * 1024 * 1024) + suffix, adapter)
  } finally {
    EditorView.domEventHandlers = original
  }
  const count = parses
  f.session.counters(true)
  f.view.dispatch = f.dispatch
  for (let i = 0; i < 5; i++) {
    f.dispatch({
      changes: { from: normalizedSource(prefix).length + 1, insert: 'y' },
    })
    focus({}, f.view)
  }
  assert.equal(parses, count)
  assert.equal(f.session.counters().materializations, 0)
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
