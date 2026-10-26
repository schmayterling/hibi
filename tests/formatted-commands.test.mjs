import assert from 'node:assert/strict'
import test from 'node:test'
import { EditorState } from '@codemirror/state'
import { Decoration, WidgetType } from '@codemirror/view'
import { GFM, parser } from '@lezer/markdown'
import {
  blockBreak,
  deleteBackward,
  deleteForward,
  exitBlock,
  gapInput,
  indent,
  lineBreak,
} from '../src/renderer/src/formatted-commands.ts'

const markdown = parser.configure(GFM)
const hide = Decoration.replace({})
const glyph = Decoration.replace({
  widget: new (class extends WidgetType {
    toDOM() {
      return null
    }
  })(),
})

/**
 * Run a structure command on `doc`, where `|` marks the caret, `⟦` `⟧`
 * enclose syntax the formatted view hides and `⟪` `⟫` text it shows as a
 * widget.
 */
function run(doc, command) {
  const hidden = []
  let text = '',
    caret = 0
  for (const char of doc) {
    if (char === '|') caret = text.length
    else if (char === '⟦' || char === '⟪')
      hidden.push({ from: text.length, value: char === '⟦' ? hide : glyph })
    else if (char === '⟧' || char === '⟫') hidden.at(-1).to = text.length
    else text += char
  }
  const state = EditorState.create({
    doc: text,
    selection: { anchor: caret },
  })
  const spec = command(
    state,
    markdown.parse(text),
    Decoration.set(hidden.map(({ from, to, value }) => value.range(from, to))),
  )
  if (!spec) return null
  const next = state.update(spec).state
  const head = next.selection.main.head
  return `${next.doc.sliceString(0, head)}|${next.doc.sliceString(head)}`
}

test('enter splits paragraphs and continues or leaves lists and quotes like the rich editor', () => {
  assert.equal(run('hello| world', blockBreak), 'hello\n\n| world')
  assert.equal(run('- one|', blockBreak), '- one\n- |')
  assert.equal(run('3. three|', blockBreak), '3. three\n4. |')
  assert.equal(run('- [x] done|', blockBreak), '- [x] done\n- [ ] |')
  // An empty item leaves the list; an empty quote line leaves the quote.
  assert.equal(run('- one\n- |', blockBreak), '- one\n\n|')
  assert.equal(run('> quote|', blockBreak), '> quote\n> |')
  assert.equal(run('> quote\n> |', blockBreak), '> quote\n\n|')
  assert.equal(run('```\n  code|\n```', blockBreak), '```\n  code\n  |\n```')
  assert.equal(run('- one|', lineBreak), '- one  \n  |')
  assert.equal(run('- one|', exitBlock), '- one\n\n|')
  assert.equal(run('para|', exitBlock), null)
})

test('backspace and delete edit visible text and remove block markers before joining blocks', () => {
  // The first Backspace at an item or heading turns it into plain text.
  assert.equal(run('⟦- ⟧|item', deleteBackward), '|item')
  assert.equal(run('⟦# ⟧|Title', deleteBackward), '|Title')
  assert.equal(run('⟦> ⟧|quoted', deleteBackward), '|quoted')
  // At the start of a paragraph it joins the previous one.
  assert.equal(run('one\n\n|two', deleteBackward), 'one|two')
  // Hidden syntax before the caret is skipped, never half deleted.
  assert.equal(run('⟦**⟧bold⟦**⟧|', deleteBackward), '**bol|**')
  assert.equal(run('one|\n\ntwo', deleteForward), 'one|two')
  assert.equal(run('|⟦**⟧bold⟦**⟧', deleteForward), '|**old**')
  // A widget shown for its text is deleted whole, like any character.
  assert.equal(run('ab ⟪&amp;⟫| cd', deleteBackward), 'ab | cd')
  assert.equal(run('ab |⟪&amp;⟫ cd', deleteForward), 'ab | cd')
  assert.equal(run('ab ⟪&amp;⟫⟦**⟧|', deleteBackward), 'ab |**')
})

test('tab nests and outdents list items, indents code and keeps paragraphs out of code', () => {
  assert.equal(
    run('- one\n- |two', (state, tree) => indent(state, tree, false)),
    '- one\n  - |two',
  )
  assert.equal(
    run('- one\n  - |two', (state, tree) => indent(state, tree, true)),
    '- one\n- |two',
  )
  assert.equal(
    run('```\n|code\n```', (state, tree) => indent(state, tree, false)),
    '```\n\t|code\n```',
  )
  // A tab at the start of a paragraph line would make it indented code.
  assert.equal(
    run('|para', (state, tree) => indent(state, tree, false)),
    '|para',
  )
})

test('typing on the blank line between two blocks starts its own paragraph', () => {
  const type = (doc, text) => {
    const at = doc.indexOf('|')
    const plain = doc.replace('|', '')
    const state = EditorState.create({ doc: plain })
    const spec = gapInput(state, at, at, text)
    if (!spec) return null
    const next = state.update(spec).state
    const head = next.selection.main.head
    return `${next.doc.sliceString(0, head)}|${next.doc.sliceString(head)}`
  }
  assert.equal(type('one\n|\ntwo', 'x'), 'one\n\nx|\n\ntwo')
  assert.equal(type('one\n\n|\n\ntwo', 'x'), null)
})
