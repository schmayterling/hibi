import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { history, undoDepth } from '@codemirror/commands'
import { DocInput } from '@codemirror/language'
import { EditorState, Transaction } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { GFM } from '@lezer/markdown'
import {
  formattedLiteral,
  formattedTree,
} from '../src/renderer/src/formatted-contributions.ts'
import {
  sourceFormatting,
  storedMarkInput,
} from '../src/renderer/src/source-formatting.ts'
import * as actions from '../src/renderer/src/source-formatting-actions.ts'
import { formattedMarkdownParser } from '../src/shared/formatted-markdown.ts'

registerHooks({
  load: (url, context, next) =>
    url.endsWith('.css')
      ? { format: 'module', source: '', shortCircuit: true }
      : next(url, context),
})
const { CellEditor } = await import(
  '../src/renderer/src/formatted/table-cells.ts'
)
const { inlineInput } = actions
const grammar = formattedMarkdownParser(GFM)
// The open edges: no Markdown spelling keeps the typed text out of the italic.
const unsafe = [
  ['c _[ell](https://e.test)_', 0, 3, 'Z', ['Entity']],
  ['x _[ell](https://e.test)_', 1, 3, '', []],
  ['x _[ell](https://e.test)_', 1, 2, '', []],
]

const rejected = (error) =>
  error instanceof Error && error.cause === actions.formattedInputError

/** A view whose input handlers run as CodeMirror's DOM input runs them. */
function view(source, anchor, head, literal = []) {
  const dispatched = []
  const view = {
    composing: false,
    compositionStarted: false,
    dispatched,
    state: EditorState.create({
      doc: source,
      selection: { anchor, head },
      extensions: [
        history(),
        storedMarkInput,
        ...literal.map((name) => formattedLiteral.of(name)),
        formattedTree.of((state) => grammar.parse(new DocInput(state.doc))),
      ],
    }),
    dispatch(spec) {
      const transaction = this.state.update(spec)
      dispatched.push(transaction)
      this.state = transaction.state
    },
    focus() {},
    input(text) {
      const { from, to } = this.state.selection.main
      return this.state
        .facet(EditorView.inputHandler)
        .some((handler) => handler(this, from, to, text, () => null))
    },
  }
  view.dispatch = view.dispatch.bind(view)
  return view
}

test('inline input throws the tagged rejection only for the unsafe render', () => {
  for (const [source, from, to, text, literal] of unsafe) {
    const state = EditorState.create({
      doc: source,
      selection: { anchor: from, head: to },
      extensions: literal.map((name) => formattedLiteral.of(name)),
    })
    assert.throws(
      () => inlineInput(state, grammar.parse(source), from, to, text),
      (error) =>
        rejected(error) &&
        error.message ===
          'This edit would rewrite other Markdown. Use Source view for this document.',
    )
  }
  const state = EditorState.create({
    doc: 'plain text',
    selection: { anchor: 1, head: 2 },
  })
  assert.equal(inlineInput(state, grammar.parse('plain text'), 1, 2, 'Z'), null)
})

test('inline input leaves a reference definition destination to plain text input', () => {
  for (const definition of [
    '[ref]: /first',
    '[ref]: </first> "title"',
    '> [ref]: /first',
  ]) {
    const source = `${definition}\n\n# [label][ref]\n\nlast`
    const from = source.indexOf('/first'),
      to = from + '/first'.length
    const state = EditorState.create({
      doc: source,
      selection: { anchor: from, head: to },
    })
    // The destination is not linked text: typing over it must not wrap it as a link.
    assert.equal(
      inlineInput(state, grammar.parse(source), from, to, '/changed'),
      null,
    )
    assert.equal(view(source, from, to).input('/changed'), false)
  }
  const linked = view('[label](/first)', 1, 6)
  assert.equal(linked.input('changed'), true)
  assert.equal(linked.state.doc.toString(), '[changed](/first)')
})

test('stored-mark input rejects an unsafe edge with only the annotation', () => {
  for (const [source, from, to, text, literal] of unsafe) {
    const editor = view(source, from, to, literal)
    const before = editor.state
    assert.equal(editor.input(text), true)
    assert.equal(editor.dispatched.length, 1)
    const [transaction] = editor.dispatched
    assert.ok(rejected(transaction.annotation(actions.rejectedInput)))
    assert.equal(transaction.docChanged, false)
    assert.equal(transaction.selection, undefined)
    assert.equal(transaction.annotation(Transaction.userEvent), undefined)
    assert.equal(editor.state.doc.toString(), source)
    assert.ok(editor.state.selection.eq(before.selection))
    assert.equal(undoDepth(editor.state), 0)
  }
})

test('stored-mark input keeps safe edges, pending marks, and other failures', () => {
  // Without the literal entity, the typed letter is spelled as an entity.
  const safe = view('c _[ell](https://e.test)_', 0, 3)
  assert.equal(safe.input('Z'), true)
  assert.equal(safe.state.doc.toString(), '&#90;_[ell](https://e.test)_')
  assert.equal(safe.dispatched[0].annotation(actions.rejectedInput), undefined)

  const pending = view('a b', 1, 1)
  assert.equal(sourceFormatting(pending).run('italic'), true)
  pending.dispatched.length = 0
  assert.equal(pending.input('Z'), true)
  assert.equal(pending.state.doc.toString(), 'a*Z* b')
  assert.equal(pending.dispatched.length, 1)
  assert.equal(
    pending.dispatched[0].annotation(actions.rejectedInput),
    undefined,
  )

  const failing = view('x _[ell](https://e.test)_', 1, 2)
  const failure = new Error('unrelated')
  failing.state.sliceDoc = () => {
    throw failure
  }
  assert.throws(
    () => failing.input(''),
    (error) => error === failure,
  )
  assert.equal(failing.dispatched.length, 0)
})

test('a table cell forwards a rejection before updating its own state', () => {
  const error = new Error('rejected', { cause: actions.formattedInputError })
  const cell = EditorState.create({ doc: 'cell' })
  const transaction = cell.update({
    annotations: actions.rejectedInput.of(error),
  })
  const sent = []
  let updated = 0
  const editor = {
    remote: false,
    host: {
      main: { dispatch: (spec) => sent.push(spec) },
      current: () => true,
      span: () => ({ from: 0, to: 4 }),
    },
    refresh() {
      updated++
    },
  }
  CellEditor.prototype.dispatch.call(editor, [transaction], {
    update() {
      updated++
    },
    dom: { isConnected: true },
    composing: false,
  })
  assert.equal(updated, 0)
  assert.equal(sent.length, 1)
  assert.equal(
    EditorState.create({ doc: 'main' })
      .update(sent[0])
      .annotation(actions.rejectedInput),
    error,
  )
})
