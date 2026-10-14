import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { build } from 'esbuild'

// CommonJS throughout, so the bundle and this test share one ProseMirror.
const require = createRequire(import.meta.url)
const { Schema } = require('@tiptap/pm/model')
const { EditorState, PluginKey } = require('@tiptap/pm/state')
const { closeHistory, history, redo, undo } = require('@tiptap/pm/history')
const { Decoration } = require('@tiptap/pm/view')
const { Fragment } = require('@tiptap/pm/model')
const { __insertCells, tableNodes } = require('@tiptap/pm/tables')

globalThis.tableLayoutEcho = new PluginKey('documentSourceEcho')
const bundle = await build({
  stdin: {
    contents:
      "export { tableLayout } from './src/renderer/src/table-layout.ts'; export { blockMove } from './src/addons/block-drag/move.ts'",
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
  write: false,
  plugins: [
    {
      name: 'source-echo',
      setup(build) {
        build.onResolve({ filter: /rich-source-session$/ }, () => ({
          path: 'echo',
          namespace: 'source-echo',
        }))
        build.onLoad({ filter: /.*/, namespace: 'source-echo' }, () => ({
          contents: 'export const richSourceEcho = globalThis.tableLayoutEcho',
        }))
      },
    },
  ],
})
const module = { exports: {} }
new Function('module', 'exports', 'require', bundle.outputFiles[0].text)(
  module,
  module.exports,
  require,
)
const { tableLayout, blockMove } = module.exports
const [plugin] = tableLayout.config.addProseMirrorPlugins.call({
  options: { tabId: 'test' },
})

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
  marks: { strong: {} },
})
const paragraph = (text) =>
  schema.nodes.paragraph.create(null, text ? schema.text(text) : null)
const row = (type, cells) =>
  schema.nodes.tableRow.create(
    null,
    cells.map((text) => schema.nodes[type].create(null, paragraph(text))),
  )
const table = (header, body) =>
  schema.nodes.table.create(null, [
    row('tableHeader', header),
    ...body.map((cells) => row('tableCell', cells)),
  ])
const create = (...blocks) =>
  EditorState.create({
    schema,
    plugins: [plugin],
    doc: schema.nodes.doc.create(null, blocks),
  })
const tables = (state) => {
  const found = []
  state.doc.descendants((node, pos) => {
    if (node.type.name !== 'table') return true
    found.push(pos)
    return false
  })
  return found
}
const size = (state, table, axis, index, value) =>
  state.apply(
    state.tr.setMeta(plugin, {
      size: { table, axis, index, value, commit: true },
    }),
  )
/** Inline styles by table, then by row or header cell. */
const styles = (state) => {
  const found = plugin.getState(state).decorations.find()
  return tables(state).map((pos) => {
    const node = state.doc.nodeAt(pos)
    const style = (from) =>
      found.find((decoration) => decoration.from === from)?.type.attrs.style ??
      ''
    const rows = []
    node.forEach((_, offset) => {
      rows.push(style(pos + 1 + offset))
    })
    const columns = []
    node.firstChild.forEach((_, offset) => {
      columns.push(style(pos + 2 + offset))
    })
    return { columns, rows }
  })
}

test('rich block moves carry only the retained table sizes through undo and redo', () => {
  const first = table(['same', 'header'], [['1', '2']])
  const second = table(['same', 'header'], [['3', '4']])
  let state = create(paragraph('before'), first, second)
  state = size(state, tables(state)[0], 'column', 0, 160)
  state = size(state, tables(state)[0], 'row', 1, 70)
  state = size(state, tables(state)[1], 'column', 1, 240)
  state = state.reconfigure({ plugins: [plugin, history()] })
  const check = () => {
    assert.deepEqual(
      styles(state),
      tables(state).map((pos) =>
        state.doc.nodeAt(pos) === first
          ? {
              columns: ['width: 160px', ''],
              rows: ['', '--table-row-height: 70px'],
            }
          : { columns: ['', 'width: 240px'], rows: ['', ''] },
      ),
    )
  }
  for (const direction of [-1, 1, 1, -1]) {
    const before = state.doc
    const pos = tables(state).find((pos) => state.doc.nodeAt(pos) === first)
    const tr = blockMove({ state, isEditable: true }, pos, direction)
    assert.ok(tr)
    state = state.apply(tr)
    check()
    assert.ok(
      undo(state, (tr) => {
        state = state.apply(tr)
      }),
    )
    assert.ok(state.doc.eq(before))
    check()
    assert.ok(
      redo(state, (tr) => {
        state = state.apply(tr)
      }),
    )
    check()
  }
})

test('table sizes survive a move and separate cell edit through undo and redo', () => {
  const original = table(['one', 'two'], [['1', '2']])
  let state = create(original, paragraph('after'))
  state = size(state, tables(state)[0], 'column', 0, 160)
  state = size(state, tables(state)[0], 'row', 1, 70)
  state = state.reconfigure({ plugins: [plugin, history()] })
  const check = () =>
    assert.deepEqual(styles(state)[0], {
      columns: ['width: 160px', ''],
      rows: ['', '--table-row-height: 70px'],
    })
  state = state.apply(
    blockMove({ state, isEditable: true }, tables(state)[0], 1),
  )
  state = state.apply(
    closeHistory(state.tr).insertText('z', tables(state)[0] + 4),
  )
  check()
  for (const command of [undo, undo, redo, redo]) {
    assert.ok(
      command(state, (tr) => {
        state = state.apply(tr)
      }),
    )
    check()
  }
})

test('local table edits reuse uniqueness without walking the document', (t) => {
  const original = table(['a', 'b'], [['1', '2']])
  let state = create(
    ...Array.from({ length: 100 }, () => paragraph('before')),
    original,
  )
  let pos = tables(state)[0]
  state = size(state, pos, 'column', 0, 160)
  const walk = t.mock.method(Object.getPrototypeOf(state.doc), 'descendants')
  state = state.apply(state.tr.insertText('x', pos + 4))
  assert.equal(walk.mock.callCount(), 2)
  walk.mock.resetCalls()
  for (let index = 0; index < 20; index++)
    state = state.apply(state.tr.insertText('x', pos + 4))
  assert.equal(walk.mock.callCount(), 0)
  state = size(state, pos, 'column', 1, 180)
  state = state.apply(state.tr.insertText('x', pos + 4))
  assert.equal(walk.mock.callCount(), 0)

  state = state.apply(state.tr.insertText('x', 1))
  pos++
  assert.equal(walk.mock.callCount(), 0)
  state = state.apply(state.tr.insertText('x', pos + 4))
  assert.equal(walk.mock.callCount(), 2)
  walk.mock.resetCalls()
  state = state.apply(state.tr.insertText('x', pos + 4))
  assert.equal(walk.mock.callCount(), 0)

  const tr = state.tr.insertText('x', 1)
  pos++
  state = state.apply(tr.insertText('x', pos + 4))
  assert.equal(walk.mock.callCount(), 2)
  walk.mock.resetCalls()
  const marked = state.tr.addMark(1, 2, schema.marks.strong.create())
  state = state.apply(marked.insertText('x', pos + 4))
  assert.equal(walk.mock.callCount(), 2)
})

test('duplicated tables cannot keep a stale local identity proof', () => {
  for (const scenario of ['initial', 'outside', 'mixed']) {
    const original = table(['a', 'b'], [['1', '2']])
    let state = create(
      ...(scenario === 'initial' ? [original] : []),
      paragraph('before'),
      original,
    )
    const at = () => tables(state).at(-1)
    state = size(state, at(), 'column', 0, 160)
    state = state.apply(state.tr.insertText('x', at() + 4))
    if (scenario === 'outside') {
      state = state.apply(state.tr.insert(0, original))
      state = state.apply(state.tr.insertText('y', at() + 4))
    } else if (scenario === 'mixed') {
      state = state.apply(
        state.tr.insertText('y', at() + 4).insert(0, original),
      )
    }
    state = state.apply(state.tr.delete(0, original.nodeSize))
    state = state.apply(
      state.tr.replaceWith(0, state.doc.content.size, original),
    )
    assert.deepEqual(plugin.getState(state).tables, [], scenario)
  }
})

test('lost mappings reject ambiguous historical table versions', () => {
  for (const duplicateBefore of [false, true]) {
    const original = table(['a', 'b'], [['1', '2']])
    let state = create(paragraph('before'), original)
    state = size(state, tables(state)[0], 'column', 0, 160)
    state = state.apply(state.tr.insertText('z', tables(state)[0] + 4))
    const edited = state.doc.nodeAt(tables(state)[0])
    if (duplicateBefore) state = state.apply(state.tr.insert(0, original))
    state = state.apply(
      state.tr.replaceWith(
        0,
        state.doc.content.size,
        duplicateBefore ? [original] : [original, edited],
      ),
    )
    assert.deepEqual(plugin.getState(state).tables, [])
    assert.ok(
      styles(state).every(({ columns }) => columns.every((size) => !size)),
    )
  }
})

test('source sync clears historical table identity while retaining current sizes', () => {
  const original = table(['a', 'b'], [['1', '2']])
  let state = create(paragraph('before'), original)
  state = size(state, tables(state)[0], 'column', 0, 160)
  state = state.apply(state.tr.insertText('z', tables(state)[0] + 4))
  const replacement = schema.nodeFromJSON(
    state.doc.nodeAt(tables(state)[0]).toJSON(),
  )
  state = state.apply(
    state.tr
      .replaceWith(0, state.doc.content.size, [
        paragraph('before'),
        replacement,
      ])
      .setMeta(globalThis.tableLayoutEcho, true),
  )
  assert.equal(styles(state)[0].columns[0], 'width: 160px')
  state = state.apply(
    state.tr.replaceWith(0, state.doc.content.size, [
      original,
      paragraph('after'),
    ]),
  )
  assert.deepEqual(plugin.getState(state).tables, [])
})

test('lost mappings do not choose between duplicated retained table nodes', () => {
  const shared = table(['a', 'b'], [['1', '2']])
  const other = table(['c', 'd'], [['3', '4']])
  const text = paragraph('before')
  for (const [before, after] of [
    [
      [text, shared, other],
      [shared, shared, other],
    ],
    [
      [text, shared, shared],
      [shared, text],
    ],
  ]) {
    let state = create(...before)
    state = size(state, tables(state)[0], 'column', 0, 160)
    state = state.apply(state.tr.replaceWith(0, state.doc.content.size, after))
    assert.deepEqual(plugin.getState(state).tables, [])
    assert.ok(
      styles(state).every(({ columns }) => columns.every((size) => !size)),
    )
  }
})

test('lost mappings do not match a reconstructed table by content', () => {
  const original = table(['a', 'b'], [['1', '2']])
  let state = create(paragraph('before'), original)
  state = size(state, tables(state)[0], 'column', 0, 160)
  const replacement = schema.nodeFromJSON(original.toJSON())
  assert.ok(replacement.eq(original))
  assert.notEqual(replacement, original)
  state = state.apply(
    state.tr.replaceWith(0, state.doc.content.size, replacement),
  )
  assert.deepEqual(plugin.getState(state).tables, [])
})

test('source sync does not move sizes between tables', () => {
  const first = table(['a', 'b'], [['1', '2']])
  const second = table(['c', 'd'], [['3', '4']])
  let state = create(first, second)
  state = size(state, tables(state)[0], 'column', 0, 380)
  const swapped = state.tr.replaceWith(0, state.doc.content.size, [
    second,
    first,
  ])
  state = state.apply(swapped.setMeta(globalThis.tableLayoutEcho, true))
  assert.deepEqual(plugin.getState(state).tables, [])
  assert.deepEqual(
    styles(state).map(({ columns }) => columns),
    [
      ['', ''],
      ['', ''],
    ],
  )
})

test('row and column sizes follow inserted and deleted rows and columns', () => {
  let state = create(
    paragraph('before'),
    table(
      ['a', 'b'],
      [
        ['1', '2'],
        ['3', '4'],
      ],
    ),
  )
  const at = () => tables(state)[0]
  state = size(state, at(), 'row', 2, 131)
  state = size(state, at(), 'column', 1, 200)
  // Insert a body row above body row 1.
  const rowStart = (index) => {
    let start = at() + 1
    for (let i = 0; i < index; i++)
      start += state.doc.nodeAt(at()).child(i).nodeSize
    return start
  }
  state = state.apply(
    state.tr.insert(rowStart(1), row('tableCell', ['n', 'n'])),
  )
  assert.deepEqual(styles(state)[0].rows, [
    '',
    '',
    '',
    '--table-row-height: 131px',
  ])
  // Delete the new row again.
  state = state.apply(state.tr.delete(rowStart(1), rowStart(2)))
  assert.deepEqual(styles(state)[0].rows, ['', '', '--table-row-height: 131px'])
  // Insert a column before the first one, in every row.
  let tr = state.tr
  state.doc.nodeAt(at()).forEach((_, offset, index) => {
    tr.insert(
      tr.mapping.map(at() + 1 + offset + 1),
      schema.nodes[index ? 'tableCell' : 'tableHeader'].create(
        null,
        paragraph('x'),
      ),
    )
  })
  state = state.apply(tr)
  assert.deepEqual(styles(state)[0].columns, ['', '', 'width: 200px'])
  // Delete the sized column.
  tr = state.tr
  state.doc.nodeAt(at()).forEach((current, offset) => {
    const cell =
      at() +
      1 +
      offset +
      1 +
      current.child(0).nodeSize +
      current.child(1).nodeSize
    tr.delete(
      tr.mapping.map(cell),
      tr.mapping.map(cell + current.child(2).nodeSize),
    )
  })
  state = state.apply(tr)
  assert.deepEqual(styles(state)[0].columns, ['', ''])
  assert.deepEqual(plugin.getState(state).tables[0].columns, [])
})

test('edits rebuild decorations only for the tables they touch', (t) => {
  const body = Array.from({ length: 100 }, (_, index) => [`${index}`, 'x'])
  let state = create(
    paragraph('before'),
    ...Array.from({ length: 50 }, (_, index) =>
      table([`h${index}`, 'b'], body),
    ),
  )
  for (const pos of tables(state)) {
    state = size(state, pos, 'column', 0, 120)
    state = size(state, pos, 'row', 1, 40)
  }
  // Each table: the table itself, one header cell, and one row.
  const perTable = 3
  const node = t.mock.method(Decoration, 'node')
  for (let index = 0; index < 20; index++)
    state = state.apply(state.tr.insertText('x', 1))
  assert.equal(node.mock.callCount(), 0)
  assert.equal(plugin.getState(state).decorations.find().length, 50 * perTable)

  const [first] = tables(state)
  const hover = (table, index) =>
    state.apply(
      state.tr.setMeta(plugin, {
        handle: table === null ? null : { table, axis: 'column', index },
      }),
    )
  state = hover(first, 0)
  // The hovered column has one cell in each of the 101 rows.
  assert.equal(node.mock.callCount(), perTable + 101)
  node.mock.resetCalls()
  state = state.apply(state.tr.insertText('y', first + 4))
  assert.equal(node.mock.callCount(), perTable + 101)
  node.mock.resetCalls()
  state = state.apply(state.tr.insertText('z', tables(state)[1] + 4))
  assert.equal(node.mock.callCount(), perTable)
  node.mock.resetCalls()
  state = hover(null)
  assert.equal(node.mock.callCount(), perTable)
  assert.deepEqual(styles(state)[1], {
    columns: ['width: 120px', ''],
    rows: ['', '--table-row-height: 40px', ...Array(99).fill('')],
  })
})

test('a paste that adds columns keeps the widths of the cells it replaces', () => {
  // prosemirror-tables pastes by growing the table, then replacing cells.
  const pasting = new Schema({
    nodes: schema.spec.nodes
      .remove('table')
      .remove('tableRow')
      .remove('tableHeader')
      .remove('tableCell')
      .append(tableNodes({ tableGroup: 'block', cellContent: 'paragraph' })),
  })
  const cell = (type, text) =>
    pasting.nodes[type].create(
      null,
      pasting.nodes.paragraph.create(null, pasting.text(text)),
    )
  const line = (type, cells) =>
    pasting.nodes.table_row.create(
      null,
      cells.map((text) => cell(type, text)),
    )
  let state = EditorState.create({
    schema: pasting,
    plugins: [plugin],
    doc: pasting.nodes.doc.create(null, [
      pasting.nodes.table.create(null, [
        line('table_header', ['a', 'b', 'c']),
        line('table_cell', ['1', '2', '3']),
      ]),
    ]),
  })
  state = size(state, 0, 'column', 0, 110)
  state = size(state, 0, 'column', 1, 220)
  state = size(state, 0, 'column', 2, 330)
  __insertCells(
    state,
    (tr) => {
      state = state.apply(tr)
    },
    1,
    { top: 0, left: 0 },
    {
      width: 4,
      height: 1,
      rows: [
        Fragment.from(
          ['w', 'x', 'y', 'z'].map((text) => cell('table_header', text)),
        ),
      ],
    },
  )
  assert.equal(state.doc.firstChild.firstChild.textContent, 'wxyz')
  assert.deepEqual(plugin.getState(state).tables[0].columns, [110, 220, 330])
  assert.deepEqual(styles(state)[0].columns, [
    'width: 110px',
    'width: 220px',
    'width: 330px',
    '',
  ])
})

test('moving a block around an unchanged table keeps its decorations', () => {
  let state = create(
    table(['a', 'b'], [['1', '2']]),
    paragraph('one'),
    paragraph('two'),
  )
  state = size(state, 0, 'column', 0, 150)
  state = size(state, 0, 'row', 1, 60)
  const before = styles(state)
  // The block-drag addon swaps siblings by replacing the parent's content.
  const [first, one, two] = state.doc.content.content
  state = state.apply(
    state.tr.replaceWith(
      0,
      state.doc.content.size,
      Fragment.fromArray([first, two, one]),
    ),
  )
  assert.equal(state.doc.child(1).textContent, 'two')
  assert.deepEqual(plugin.getState(state).tables[0].columns, [150])
  assert.deepEqual(styles(state), before)
})
