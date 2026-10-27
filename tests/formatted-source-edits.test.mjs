import assert from 'node:assert/strict'
import test from 'node:test'
import { EditorState } from '@codemirror/state'
import { GFM, parser } from '@lezer/markdown'
import { formattedLiteralEdits } from '../src/renderer/src/formatted-source-edits.ts'

const markdown = parser.configure(GFM)
function check(source, changes) {
  const state = EditorState.create({ doc: source })
  const transaction = state.update({ changes })
  return formattedLiteralEdits(
    transaction,
    markdown.parse(source),
    markdown.parse(transaction.newDoc.toString()),
  )
}

test('literal corrections preserve paragraph, heading, mark and link structure', () => {
  assert.equal(check('teh', { from: 0, to: 3, insert: 'the' }), true)
  assert.equal(
    check('very very **teh**', [
      { from: 0, to: 5, insert: '' },
      { from: 12, to: 15, insert: 'the' },
    ]),
    true,
  )
  assert.equal(check('# teh', { from: 2, to: 5, insert: 'the' }), true)
  assert.equal(check('[teh](url)', { from: 1, to: 4, insert: 'the' }), true)
  assert.equal(check('**teh**', { from: 2, to: 5, insert: 'the 😀' }), true)
})

test('source corrections cannot remove or introduce structure or edit opaque syntax', () => {
  for (const [source, changes] of [
    ['**the**', { from: 0, to: 2, insert: '' }],
    ['teh', { from: 0, to: 3, insert: '**the**' }],
    ['word', { from: 0, insert: '# ' }],
    ['x * word', { from: 8, insert: '*' }],
    ['[the](url)', { from: 6, to: 9, insert: 'new' }],
    ['`teh`', { from: 1, to: 4, insert: 'the' }],
    ['word', { from: 4, insert: '\nnext' }],
    ['word\nnext', { from: 4, to: 5, insert: ' ' }],
  ])
    assert.equal(
      check(source, changes),
      false,
      JSON.stringify({ source, changes }),
    )
})

test('proving a local correction in 20k paragraphs visits only the affected syntax', () => {
  const source = 'paragraph\n\n'.repeat(20000)
  const state = EditorState.create({ doc: source })
  const from = source.length / 2
  const transaction = state.update({
    changes: { from, to: from + 9, insert: 'corrected' },
  })
  let visited = 0
  const measured = (tree) => ({
    resolveInner: (...args) => tree.resolveInner(...args),
    iterate: (spec) =>
      tree.iterate({
        ...spec,
        enter(node) {
          visited++
          return spec.enter(node)
        },
      }),
  })
  assert.equal(
    formattedLiteralEdits(
      transaction,
      measured(markdown.parse(source)),
      measured(markdown.parse(transaction.newDoc.toString())),
    ),
    true,
  )
  assert.ok(visited < 16, String(visited))
})
