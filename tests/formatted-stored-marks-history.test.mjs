import assert from 'node:assert/strict'
import test from 'node:test'
import { DocInput } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { GFM } from '@lezer/markdown'
import { Editor } from '@tiptap/core'
import { Markdown } from '@tiptap/markdown'
import { formattedTree } from '../src/renderer/src/formatted-contributions.ts'
import { markdownConfiguration } from '../src/renderer/src/markdown.ts'
import { sameRichSourceDocument } from '../src/renderer/src/rich-source-preservation.ts'
import {
  sourceFormatting,
  storedMarkInput,
} from '../src/renderer/src/source-formatting.ts'
import { createSourceSession } from '../src/renderer/src/source-session.ts'
import { DocumentSession } from '../src/shared/document-session.ts'
import { formattedMarkdownParser } from '../src/shared/formatted-markdown.ts'

const grammar = formattedMarkdownParser(GFM)

function fixture(t, source = 'a `b`', at = source.length) {
  const session = new DocumentSession(
    source,
    { tabId: 'marks', revision: 0 },
    0,
    {
      enqueue() {},
      onError(error) {
        throw error
      },
    },
  )
  const bridge = createSourceSession(session, 'formatted')
  const view = {
    composing: false,
    state: EditorState.create({
      doc: source,
      selection: { anchor: at },
      extensions: [
        storedMarkInput,
        formattedTree.of((state) => grammar.parse(new DocInput(state.doc))),
      ],
    }),
    update(transactions) {
      for (const transaction of transactions) this.state = transaction.state
    },
    dispatch(spec) {
      bridge.dispatch([this.state.update(spec)], this)
    },
    focus() {},
  }
  const detach = bridge.attach(view)
  t.after(() => {
    detach()
    session.dispose()
  })
  view.dispatch = view.dispatch.bind(view)
  const formatting = sourceFormatting(view)
  const type = (text) => {
    for (const character of text) {
      const { from, to } = view.state.selection.main
      if (
        !view.state
          .facet(EditorView.inputHandler)
          .some((input) => input(view, from, to, character, () => null))
      )
        view.dispatch({
          ...view.state.replaceSelection(character),
          userEvent: 'input.type',
        })
    }
    const actual = view.state.doc.toString()
    assert.equal(session.snapshot().materialize(), actual)
    return actual
  }
  return { session, bridge, view, formatting, type }
}

function nativeCode(source, text) {
  const config = markdownConfiguration([
    { id: 'github', markedOptions: { gfm: true } },
  ])
  const editor = new Editor({
    element: null,
    extensions: [
      ...config.core,
      Markdown.configure({
        marked: config.parser,
        markedOptions: config.options,
      }),
      ...config.addons,
    ],
    content: source,
    contentType: 'markdown',
  })
  editor.commands.setTextSelection(4)
  editor.commands.toggleCode()
  editor.commands.toggleCode()
  editor.view.dispatch(editor.state.tr.insertText(text))
  return editor
}

test('source history restores stored code before undo and after redo', (t) => {
  for (const redo of [false, true]) {
    const f = fixture(t)
    f.formatting.run('inline-code')
    f.formatting.run('inline-code')
    const typed = f.type('x`y')
    assert.equal(f.bridge.undo(), true)
    assert.equal(f.view.state.doc.toString(), 'a `b`')
    assert.equal(f.formatting.inspect().state('inline-code').pressed, true)
    if (redo) {
      assert.equal(f.bridge.redo(), true)
      assert.equal(f.view.state.doc.toString(), typed)
    }
    const actual = f.type('Z')
    const native = nativeCode('a `b`', redo ? 'x`yZ' : 'Z')
    try {
      const parsed = native.schema.nodeFromJSON(native.markdown.parse(actual))
      assert.ok(sameRichSourceDocument(parsed, native.state.doc, true), actual)
    } finally {
      native.destroy()
    }
  }
})

test('restored pending marks clear on movement, external edits and toggling off', (t) => {
  for (const change of ['selection', 'external', 'off']) {
    const f = fixture(t, 'plain end')
    f.formatting.run('bold')
    f.type('X')
    assert.equal(f.bridge.undo(), true)
    assert.equal(f.formatting.inspect().state('bold').pressed, true)
    if (change === 'selection') f.view.dispatch({ selection: { anchor: 0 } })
    else if (change === 'external')
      f.session.edit(
        [{ from: 0, to: 0, insert: 'other ' }],
        'addon',
        'external',
      )
    else f.formatting.run('bold')
    assert.equal(f.formatting.inspect().state('bold').pressed, false)
    assert.equal(f.type('Y').includes('**'), false)
  }
})

test('undo and redo keep opposite caret states at a shared text boundary', (t) => {
  const f = fixture(t, 'plain end')
  f.formatting.run('bold')
  const first = f.type('X')
  f.view.dispatch({ selection: { anchor: f.view.state.selection.main.head } })
  f.formatting.run('bold')
  assert.equal(f.type('Y'), first + 'Y')
  assert.equal(f.bridge.undo(), true)
  assert.equal(f.formatting.inspect().state('bold').pressed, false)
  assert.equal(f.bridge.undo(), true)
  assert.equal(f.bridge.redo(), true)
  assert.equal(f.view.state.doc.toString(), first)
  assert.equal(f.formatting.inspect().state('bold').pressed, true)
  assert.equal(f.type('Z'), 'plain end**XZ**')
})

test('redo restores stored marks past a later group that took its typing back', (t) => {
  const f = fixture(t, 'plain end')
  f.formatting.run('bold')
  assert.equal(f.type('X '), 'plain end**X** ')
  f.view.dispatch({ selection: { anchor: 0 } })
  f.type('Q')
  f.view.dispatch({
    changes: { from: 0, to: 1 },
    selection: { anchor: 0 },
    userEvent: 'delete.backward',
  })
  assert.deepEqual(f.session.historyDepth(), { undo: 1, redo: 0 })
  assert.equal(f.bridge.undo(), true)
  assert.equal(f.bridge.redo(), true)
  assert.equal(f.view.state.doc.toString(), 'plain end**X** ')
  assert.equal(f.type('Z'), 'plain end**X Z**')
})

test('retained opaque input edges keep exact source history and one version per glyph', (t) => {
  for (const body of ['[ell](https://e.test)', '`ell`']) {
    for (const leading of [true, false]) {
      for (const reverse of [false, true]) {
        const source = leading ? 'c _' + body + '_' : '_' + body + '_ x'
        const from = leading ? 0 : source.length - 3,
          to = leading ? 3 : source.length
        const { view, session, bridge, type } = fixture(t, source, from)
        view.dispatch({
          selection: { anchor: reverse ? to : from, head: reverse ? from : to },
        })
        assert.equal(session.snapshot().version, 0)
        const typed = leading ? '&#90;_' + body + '_' : '_' + body + '_&#90;'
        assert.equal(type('Z'), typed)
        assert.equal(session.snapshot().version, 1)
        assert.equal(view.state.selection.main.head, leading ? 5 : typed.length)
        const next = leading ? '&#90;&#81;_' + body + '_' : typed + 'Q'
        assert.equal(type('Q'), next)
        assert.equal(session.snapshot().version, 2)
        assert.equal(view.state.selection.main.head, leading ? 10 : next.length)
        assert.equal(bridge.undo(), true)
        assert.equal(view.state.doc.toString(), source)
        assert.equal(session.snapshot().version, 3)
        assert.equal(bridge.redo(), true)
        assert.equal(view.state.doc.toString(), next)
        assert.equal(session.snapshot().version, 4)
        assert.equal(view.state.selection.main.head, leading ? 10 : next.length)
      }
    }
  }
})

test('retained code input grows fences and keeps whitespace inside them with an exact caret', (t) => {
  for (const [source, from, to, text, expected, head, nativeFrom, nativeTo] of [
    ['``ab``', 2, 4, ' x ', '``  x  ``', 6, 1, 3],
    ['`` ab ``', 3, 5, '   ', '``   ``', 5, 1, 3],
    ['``ab``', 2, 3, '``', '``` ``b ```', 6, 1, 2],
    ['``ab``', 2, 4, '`', '`` ` ``', 4, 1, 3],
  ]) {
    const config = markdownConfiguration([])
    const editor = new Editor({
      element: null,
      extensions: [
        ...config.core,
        Markdown.configure({
          marked: config.parser,
          markedOptions: config.options,
        }),
        ...config.addons,
      ],
      content: source,
      contentType: 'markdown',
    })
    try {
      editor.commands.setTextSelection({ from: nativeFrom, to: nativeTo })
      editor.view.dispatch(editor.state.tr.insertText(text))
      const { view, bridge } = fixture(t, source, from)
      view.dispatch({ selection: { anchor: from, head: to } })
      assert.equal(
        view.state
          .facet(EditorView.inputHandler)
          .some((input) => input(view, from, to, text, () => null)),
        true,
      )
      assert.equal(view.state.doc.toString(), expected)
      assert.equal(view.state.selection.main.head, head)
      assert.deepEqual(
        editor.schema.nodeFromJSON(editor.markdown.parse(expected)).toJSON(),
        editor.getJSON(),
      )
      assert.equal(bridge.undo(), true)
      assert.equal(view.state.doc.toString(), source)
      assert.equal(bridge.redo(), true)
      assert.equal(view.state.doc.toString(), expected)
      assert.equal(view.state.selection.main.head, head)
    } finally {
      editor.destroy()
    }
  }
})
