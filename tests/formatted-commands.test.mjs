import assert from 'node:assert/strict'
import test from 'node:test'
import { EditorState } from '@codemirror/state'
import { Decoration } from '@codemirror/view'
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

/**
 * Run a structure command on `doc`, where `|` marks the caret and `⟦` `⟧`
 * enclose syntax the formatted view hides.
 */
function run(doc, command) {
  const hidden = []
  let text = '',
    caret = 0,
    anchor = null
  for (const char of doc) {
    if (char === '|') caret = text.length
    else if (char === '^') anchor = text.length
    else if (char === '⟦') hidden.push({ from: text.length })
    else if (char === '⟧') hidden.at(-1).to = text.length
    else text += char
  }
  const state = EditorState.create({
    doc: text,
    selection: { anchor: anchor ?? caret, head: caret },
  })
  const spec = command(
    state,
    markdown.parse(text),
    Decoration.set(hidden.map(({ from, to }) => hide.range(from, to))),
  )
  if (!spec) return null
  const next = state.update(spec).state
  const { anchor: start, head } = next.selection.main
  if (start === head)
    return `${next.doc.sliceString(0, head)}|${next.doc.sliceString(head)}`
  const marks = [
    [start, '^'],
    [head, '|'],
  ].sort((a, b) => a[0] - b[0])
  return `${next.doc.sliceString(0, marks[0][0])}${marks[0][1]}${next.doc.sliceString(marks[0][0], marks[1][0])}${marks[1][1]}${next.doc.sliceString(marks[1][0])}`
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
})

test('tab nests and outdents list items, indents code and keeps paragraphs out of code', () => {
  assert.equal(
    run('- one\n- |two', (state, tree, hidden) =>
      indent(state, tree, false, hidden),
    ),
    '- one\n  - |two',
  )
  assert.equal(
    run('- one\n  - |two', (state, tree, hidden) =>
      indent(state, tree, true, hidden),
    ),
    '- one\n- |two',
  )
  assert.equal(
    run('```\n|code\n```', (state, tree, hidden) =>
      indent(state, tree, false, hidden),
    ),
    '```\n\t|code\n```',
  )
  // A tab at the start of a paragraph line would make it indented code.
  assert.equal(
    run('|para', (state, tree, hidden) => indent(state, tree, false, hidden)),
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

test('tab on selected code lines indents each line, and delete never joins a fence line', () => {
  const tab = (state, tree, hidden) => indent(state, tree, false, hidden)
  const untab = (state, tree, hidden) => indent(state, tree, true, hidden)
  // Before, the selected lines became one tab.
  assert.equal(run('```\n^x\ny|\n```', tab), '```\n\t^x\n\ty|\n```')
  assert.equal(run('```\n\t^x\n\ty|\n```', untab), '```\n^x\ny|\n```')
  // Inside a quote the tab goes after the hidden quote markers.
  assert.equal(
    run('> ```\n⟦> ⟧^x\n⟦> ⟧y|\n> ```', tab),
    '> ```\n> \t^x\n> \ty|\n> ```',
  )
  // A selection reaching a fence line leaves the fence alone.
  assert.equal(run('^```\nx|\n```', tab), '^```\n\tx|\n```')
  // Before, Delete joined `code~~~` and the prose after became code.
  assert.equal(
    run('~~~\ncode|\n~~~\n\nafter', deleteForward),
    '~~~\ncode|\n~~~\n\nafter',
  )
  assert.equal(
    run('para|\n~~~\ncode\n~~~', deleteForward),
    'para|\n~~~\ncode\n~~~',
  )
  // A heading's underline is never joined to its text or the paragraph after it.
  assert.equal(run('Title|\n===\n\nnext', deleteForward), 'Title|\n===\n\nnext')
  assert.equal(run('Title\n===\n|next', deleteBackward), 'Title\n===\n|next')
})

test('enter inside formatting closes it before the break and opens it again after', () => {
  // Before, `**bo|ld**` became `**bo` and `ld**`, and the bold was lost.
  assert.equal(run('**bo|ld**', blockBreak), '**bo**\n\n**|ld**')
  assert.equal(run('a *b **c|d** e*', blockBreak), 'a *b **c***\n\n***|d** e*')
  assert.equal(run('`co|de`', blockBreak), '`co`\n\n`|de`')
  assert.equal(run('[la|bel](/u)', blockBreak), '[la](/u)\n\n[|bel](/u)')
  assert.equal(run('- ~~st|ruck~~', blockBreak), '- ~~st~~\n- ~~|ruck~~')
  // At the edge of formatting the break stays outside it.
  assert.equal(run('**bold**|', blockBreak), '**bold**\n\n|')
})
