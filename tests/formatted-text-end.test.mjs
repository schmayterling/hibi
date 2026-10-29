import assert from 'node:assert/strict'
import test from 'node:test'
import { EditorState, Text } from '@codemirror/state'
import { GFM, parser } from '@lezer/markdown'
import { ChunkedMarkdownParser } from '../src/renderer/src/chunked-markdown.ts'
import {
  formattedOpenSelection,
  insertAfterBlock,
  removeBlock,
} from '../src/renderer/src/formatted-text-end.ts'

const markdown = parser.configure(GFM)
const text = (source) => Text.of(source.split('\n'))
const caret = (at) => ({ anchor: at, head: at })

test('a note opens with the caret at the end of its last text block', () => {
  // ‸ marks the caret.
  for (const marked of [
    '',
    'plain\n\nlast‸\n',
    'plain\n\n## Last‸ ##\n',
    'plain\n\nLast‸\n===\n',
    '> quoted\n> last‸\n>\n',
    '- one\n  - two\n    - last‸\n',
    '- one\n-‸\n',
    '```js\ncode\nlast‸\n```\n',
    '- item\n\n  > ```\n  > code\n  > last‸\n  > ```\n',
    '```\ncode\nlast‸\n',
    '    code\n    last‸\n',
    // The view draws no lines for an empty fence.
    '```\n```‸\n',
    '| a | b |\n| - | - |\n| c | d‸ |\n',
    '- item\n\n  > | a | b |\n  > | - | - |\n  > | c | d‸\n',
    '| a | b |\n| - | - |\n| c | d‸ | e |\n',
    '| a | b |\n| - | - |\n| c | ‸|\n',
    '| a | b‸ |\n| - | - |\n',
    // A row with fewer cells than columns ends in its last written cell.
    '| a | b |\n| - | - |\n| c‸ |\n',
    'plain‸\n\n[a]: https://example.test\n',
    // Blank lines after the last block that show an empty paragraph.
    'last‸\n',
    'last\n\n‸',
    'last\n\n‸\n',
    'last\n\n\n\n‸',
    '| a |\n| - |\n| c |\n\n‸\n',
  ]) {
    const source = marked.replace('‸', '')
    assert.deepEqual(
      formattedOpenSelection(text(source), markdown.parse(source)),
      caret(marked.includes('‸') ? marked.indexOf('‸') : 0),
      JSON.stringify(marked),
    )
  }
})

test('a note ending in a block the rich editor draws as one node opens with it selected', () => {
  // « and » mark the selection.
  for (const marked of [
    'plain\n\n«<div>\nlast\n</div>»\n',
    'plain\n\n«<!-- last -->»\n',
    'plain\n\n«***»\n',
    'plain\n\n«![last](missing.png)»\n',
    '> quoted\n>\n> «***»\n',
    '- item\n\n  «<!-- last -->»\n',
  ]) {
    const source = marked.replace(/[«»]/g, '')
    const anchor = marked.indexOf('«'),
      head = marked.indexOf('»') - 1
    assert.deepEqual(
      formattedOpenSelection(text(source), markdown.parse(source)),
      { anchor, head },
      JSON.stringify(marked),
    )
  }
  // An image beside text is text.
  const inline = 'plain\n\n![a](a.png) last\n'
  assert.deepEqual(
    formattedOpenSelection(text(inline), markdown.parse(inline)),
    caret(inline.length - 1),
  )
})

test('a fence a renderer draws is selected whole; a tree short of the end gives null', () => {
  const fence = 'plain\n\n```mermaid\ngraph TD\n```\n'
  const asked = []
  const replaced = (node) => asked.push(node.name) > 0
  assert.deepEqual(
    formattedOpenSelection(text(fence), markdown.parse(fence), replaced),
    { anchor: 7, head: fence.length - 1 },
  )
  assert.deepEqual(asked, ['FencedCode'])
  assert.deepEqual(
    formattedOpenSelection(text(fence), markdown.parse(fence)),
    caret(fence.indexOf('graph TD') + 'graph TD'.length),
  )
  // The open selection reads the tree it is given and never parses further.
  const source = `first\n\n${'old tail\n\n'.repeat(20000)}\`\`\`\ncode\n\`\`\`\n`
  const parse = new ChunkedMarkdownParser(markdown, markdown).startChunkedParse(
    {
      length: source.length,
      lineChunks: false,
      chunk: (from) => source.slice(from, from + 4096),
      read: (from, to) => source.slice(from, to),
    },
    [],
    { from: 0, to: 8192 },
  )
  let partial = parse.advance()
  while (!partial) partial = parse.advance()
  assert.equal(formattedOpenSelection(text(source), partial), null)
  assert.deepEqual(
    formattedOpenSelection(text(source), markdown.parse(source)),
    caret(source.length - 5),
  )
})

test('a selected block takes Backspace, Enter and a divider as the rich editor node selection does', () => {
  // « and » mark the selected block, ‸ the caret after the edit.
  const apply = (marked, edit) => {
    const source = marked.replace(/[«»]/g, '')
    const block = { from: marked.indexOf('«'), to: marked.indexOf('»') - 1 }
    const state = EditorState.create({ doc: source })
    const spec = edit(state, markdown.parse(source), block)
    const after = state.update(spec).state
    const at = after.selection.main.head
    return `${after.sliceDoc(0, at)}‸${after.sliceDoc(at)}`
  }
  const remove = (state, tree, block) => removeBlock(tree, block)
  const paragraph = (state, tree, block) =>
    insertAfterBlock(state, tree, block, false)
  const divider = (state, tree, block) =>
    insertAfterBlock(state, tree, block, true)
  for (const [marked, edit, expected] of [
    ['plain\n\n«$$\nx\n$$»\n', remove, 'plain‸\n'],
    ['plain\n\n«---»\n\nafter\n', remove, 'plain\n\n‸after\n'],
    ['«<!-- a -->»\n\nafter\n', remove, '‸after\n'],
    ['> plain\n>\n> «***»\n>\n> after\n', remove, '> plain\n>\n> ‸after\n'],
    ['plain\n\n«***»\n', paragraph, 'plain\n\n***\n\n‸'],
    ['plain\n\n«***»\n\nafter\n', paragraph, 'plain\n\n***\n\n‸\n\nafter\n'],
    ['> «***»\n>\n> after\n', paragraph, '> ***\n>\n> ‸\n>\n> after\n'],
    ['plain\n\n«***»\n', divider, 'plain\n\n***\n\n---\n\n‸\n'],
    ['plain\n\n«***»\n\nafter\n', divider, 'plain\n\n***\n\n---\n\n‸after\n'],
    ['> «***»\n', divider, '> ***\n>\n> ---\n>\n> ‸\n'],
  ])
    assert.equal(apply(marked, edit), expected, JSON.stringify(marked))
})
