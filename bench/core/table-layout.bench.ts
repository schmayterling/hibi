import assert from 'node:assert/strict'
import { getExtensionField } from '@tiptap/core'
import { history, redo, undo } from '@tiptap/pm/history'
import { Schema } from '@tiptap/pm/model'
import { EditorState, type Plugin } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { bench, describe, vi } from 'vitest'
import { tableLayout } from '../../src/renderer/src/table-layout.ts'

// The transaction plugin needs only this key, not the renderer session graph.
vi.mock('../../src/renderer/src/rich-source-session', async () => {
  const { PluginKey } = await import('@tiptap/pm/state')
  return { richSourceEcho: new PluginKey('documentSourceEcho') }
})

const options = { time: 0, iterations: 32, warmupTime: 0, warmupIterations: 8 }
const [layout] = getExtensionField<
  (this: { options: { tabId: string } }) => [Plugin]
>(tableLayout, 'addProseMirrorPlugins', { options: { tabId: 'benchmark' } })()
assert.ok(layout)

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    text: { group: 'inline' },
    paragraph: { group: 'block', content: 'text*' },
    table: { group: 'block', content: 'tableRow+' },
    tableRow: { content: '(tableHeader | tableCell)+' },
    tableHeader: { content: 'paragraph' },
    tableCell: { content: 'paragraph' },
  },
})
const paragraph = (text: string) =>
  schema.node('paragraph', null, schema.text(text))
const row = (type: 'tableHeader' | 'tableCell', cells: string[]) =>
  schema.node(
    'tableRow',
    null,
    cells.map((text) => schema.node(type, null, paragraph(text))),
  )
const table = schema.node('table', null, [
  row('tableHeader', ['heading', 'value']),
  row('tableCell', ['one', 'two']),
])
let sized = EditorState.create({
  schema,
  plugins: [layout],
  doc: schema.node('doc', null, [
    table,
    ...Array.from({ length: 10000 }, (_, index) =>
      paragraph(`paragraph ${index}`),
    ),
  ]),
})
for (const [axis, index, value] of [
  ['column', 0, 160],
  ['row', 1, 64],
] as const)
  sized = sized.apply(
    sized.tr.setMeta(layout, {
      size: { table: 0, axis, index, value, commit: true },
    }),
  )

// Both bases have empty history. Each sample applies to its immutable base.
const first = sized.reconfigure({ plugins: [layout, history()] })
const warm = sized
  .apply(sized.tr.insertText('p', 4))
  .reconfigure({ plugins: [layout, history()] })
const typeInCell = (state: EditorState) =>
  state.apply(state.tr.insertText('x', 4))

function checkSizes(state: EditorState) {
  const current = state.doc.child(0)
  const header = current.child(0)
  const cell = header.child(0)
  const rowFrom = 1 + header.nodeSize
  assert.deepEqual(
    layout.getState(state).decorations.find(),
    DecorationSet.create(state.doc, [
      Decoration.node(0, current.nodeSize, { 'data-columns-sized': 'some' }),
      Decoration.node(2, 2 + cell.nodeSize, { style: 'width: 160px' }),
      Decoration.node(rowFrom, rowFrom + current.child(1).nodeSize, {
        style: '--table-row-height: 64px',
      }),
    ]).find(),
  )
}

// Preflight checks results and native undo/redo without timing their assertions.
for (const base of [first, warm]) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const changed = typeInCell(base)
    assert.equal(
      changed.doc.child(0).child(0).child(0).textContent,
      `x${base.doc.child(0).child(0).child(0).textContent}`,
    )
    assert.equal(changed.doc.nodeSize, base.doc.nodeSize + 1)
    assert.equal(changed.doc.childCount, 10001)
    assert.equal(changed.doc.child(10000).textContent, 'paragraph 9999')
    checkSizes(changed)
    let restored = changed
    assert.ok(
      undo(restored, (tr) => {
        restored = restored.apply(tr)
      }),
    )
    assert.ok(restored.doc.eq(base.doc))
    checkSizes(restored)
    assert.ok(
      redo(restored, (tr) => {
        restored = restored.apply(tr)
      }),
    )
    assert.ok(restored.doc.eq(changed.doc))
    checkSizes(restored)
  }
}
assert.equal(layout.getState(first).tables[0].versions, undefined)
assert.equal(layout.getState(warm).tables[0].unique, true)

describe('table layout transactions', () => {
  bench(
    'type in a sized table before first proof, 10000 surrounding paragraphs',
    () => {
      typeInCell(first)
    },
    options,
  )

  bench(
    'type in a sized table with warm proof, 10000 surrounding paragraphs',
    () => {
      typeInCell(warm)
    },
    options,
  )
})
