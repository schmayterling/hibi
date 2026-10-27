import assert from 'node:assert/strict'
import test from 'node:test'
import { EditorState } from '@codemirror/state'
import { TreeCursor } from '@lezer/common'
import { GFM, parser } from '@lezer/markdown'
import { formattedLiteralEdits } from '../src/renderer/src/formatted-source-edits.ts'
import { formattedSyntax } from '../src/renderer/src/formatted-syntax.ts'
import { BoundaryTree } from '../src/shared/chunked-markdown.ts'
import { MarkdownBoundaryIndex } from '../src/shared/markdown-boundary-index.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'

const markdown = parser.configure(GFM)
function check(source, changes) {
  const state = EditorState.create({ doc: source })
  const transaction = state.update({ changes })
  return formattedLiteralEdits(transaction, markdown, markdown.parse(source))
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
    ['x *word', { from: 7, insert: '*' }],
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

test('neighbor flanking, code delimiters and reference destinations cannot change', () => {
  for (const [source, changes] of [
    ['_foo_ bar', { from: 5, to: 6, insert: 'x' }],
    ['a _foo_', { from: 1, to: 2, insert: 'x' }],
    ['*foo.*bar', { from: 6, to: 7, insert: ' ' }],
    ['`a` b', { from: 3, insert: '`' }],
    ['[foo] x\n\n[foo]: /a\n[bar]: /b', { from: 1, to: 4, insert: 'bar' }],
  ])
    assert.equal(check(source, changes), false, source)
})

test('literal insertions at paragraph, heading, strong and cell ends remain accepted', () => {
  for (const [source, at] of [
    ['teh', 3],
    ['word\n\nnext', 4],
    ['**teh**', 5],
    ['# teh\n', 5],
    ['| teh | other |\n| --- | --- |', 5],
  ])
    assert.equal(check(source, { from: at, insert: 's' }), true, source)
})

test('corrections outside the app viewport tree retain their literal proof', () => {
  const syntax = formattedSyntax({ slice: 1000 })
  const doc = 'some teh words here\n\n'.repeat(20000)
  const state = EditorState.create({ doc, extensions: syntax.extension })
  const source = new SourceStore(doc, {
    tabId: 'proof',
    revision: 0,
  }).snapshot()
  const index = new MarkdownBoundaryIndex(source, {
    schema: 1,
    syntax: [],
    flavors: [],
    literal: [],
    opaque: [],
    prefix: 0,
    chunkSize: 4096,
    groupSize: 64,
    giantBlock: 65536,
  })
  while (!index.advance()) {}
  const builder = new BoundaryTree(index.parser, index.length)
  for (const page of index.pages()) builder.append(page.records)
  const boundaries = builder.finish()
  for (const at of [50000, doc.length - 25]) {
    const from = doc.indexOf('teh', at)
    const transaction = state.update({
      changes: { from, to: from + 3, insert: 'the' },
    })
    assert.equal(
      formattedLiteralEdits(
        transaction,
        syntax.parser(state),
        syntax.tree(state),
      ),
      null,
    )
    let units = 0
    const read = state.sliceDoc.bind(state)
    state.sliceDoc = (from, to) => {
      units += to - from
      return read(from, to)
    }
    try {
      assert.equal(
        formattedLiteralEdits(transaction, syntax.parser(state), boundaries),
        true,
      )
    } finally {
      state.sliceDoc = read
    }
    assert.ok(units < 16384, String(units))
  }
})

test('worker-indexed fenced contents after blank lines remain opaque without a body read', () => {
  const doc = '```\n' + 'code\n\n'.repeat(20000) + 'teh\n```'
  const source = new SourceStore(doc, {
    tabId: 'opaque',
    revision: 0,
  }).snapshot()
  const index = new MarkdownBoundaryIndex(source, {
    schema: 1,
    syntax: [],
    flavors: [],
    literal: [],
    opaque: [],
    prefix: 0,
    chunkSize: 4096,
    groupSize: 64,
    giantBlock: 65536,
  })
  while (!index.advance()) {}
  const builder = new BoundaryTree(index.parser, index.length)
  for (const page of index.pages()) builder.append(page.records)
  const state = EditorState.create({ doc })
  const from = doc.lastIndexOf('teh')
  const transaction = state.update({
    changes: { from, to: from + 3, insert: 'the' },
  })
  let units = 0
  const read = state.sliceDoc.bind(state)
  state.sliceDoc = (from, to) => {
    units += to - from
    return read(from, to)
  }
  assert.equal(
    formattedLiteralEdits(transaction, markdown, builder.finish()),
    false,
  )
  assert.ok(units < 32, String(units))
})

test('deeply nested block proof stays linear in its enclosing context', () => {
  for (const depth of [10, 100, 1000]) {
    const source = '> '.repeat(depth) + 'a teh b'
    const from = source.indexOf('teh')
    const transaction = EditorState.create({ doc: source }).update({
      changes: { from, to: from + 3, insert: 'the' },
    })
    const tree = markdown.parse(source)
    let moves = 0
    const original = TreeCursor.prototype.next
    TreeCursor.prototype.next = function (...args) {
      moves++
      return original.apply(this, args)
    }
    try {
      assert.equal(formattedLiteralEdits(transaction, markdown, tree), true)
    } finally {
      TreeCursor.prototype.next = original
    }
    assert.ok(moves <= depth * 4 + 32, `${depth}: ${moves}`)
  }
})

test('proving a local correction in 20k paragraphs visits only the affected syntax', () => {
  const source = 'paragraph\n\n'.repeat(20000)
  const state = EditorState.create({ doc: source })
  const from = source.length / 2
  const transaction = state.update({
    changes: { from, to: from + 9, insert: 'corrected' },
  })
  const before = markdown.parse(source)
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
    assert.equal(formattedLiteralEdits(transaction, markdown, before), true)
  } finally {
    for (const [method, original] of originals)
      TreeCursor.prototype[method] = original
  }
  assert.ok(moves < 16, String(moves))
})
