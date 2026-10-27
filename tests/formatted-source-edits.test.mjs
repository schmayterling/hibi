import assert from 'node:assert/strict'
import test from 'node:test'
import { EditorState } from '@codemirror/state'
import { TreeCursor } from '@lezer/common'
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
  assert.equal(
    check('| teh | other |\n| --- | --- |', {
      from: 2,
      to: 5,
      insert: 'the',
    }),
    true,
  )
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
    ['| teh | other |\n| --- | --- |', { from: 2, to: 5, insert: 'the | new' }],
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
  const before = markdown.parse(source)
  const after = markdown.parse(transaction.newDoc.toString())
  let moves = 0
  const originals = new Map()
  for (const method of ['next', 'prev', 'nextSibling', 'prevSibling']) {
    const original = TreeCursor.prototype[method]
    originals.set(method, original)
    TreeCursor.prototype[method] = function (...args) {
      moves++
      return original.apply(this, args)
    }
  }
  try {
    assert.equal(formattedLiteralEdits(transaction, before, after), true)
  } finally {
    for (const [method, original] of originals)
      TreeCursor.prototype[method] = original
  }
  assert.ok(moves < 16, String(moves))
})
