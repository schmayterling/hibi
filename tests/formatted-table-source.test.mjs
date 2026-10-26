import assert from 'node:assert/strict'
import test from 'node:test'
import { TreeFragment } from '@lezer/common'
import { parser, Table } from '@lezer/markdown'
import { ChunkedMarkdownParser } from '../src/renderer/src/chunked-markdown.ts'
import {
  alignColumn,
  alignments,
  cellContent,
  deleteColumn,
  deleteRow,
  insertColumn,
  insertRow,
  moveColumn,
  moveRow,
  parseRow,
  rowStart,
} from '../src/renderer/src/formatted/table-source.ts'

const markdown = parser.configure(Table)
const cells = (text) =>
  parseRow(text).cells.map(({ from, to }) => text.slice(from, to))

test('rows split into cells at unescaped pipes, with or without outer pipes', () => {
  assert.deepEqual(cells('| a | b |'), ['a', 'b'])
  assert.deepEqual(cells('a | b'), ['a', 'b'])
  assert.deepEqual(cells('|a|b|'), ['a', 'b'])
  assert.deepEqual(cells('| a \\| b | c |'), ['a \\| b', 'c'])
  // An even run of backslashes escapes itself, so the pipe ends the cell.
  assert.deepEqual(cells('| a \\\\| b |'), ['a \\\\', 'b'])
  assert.deepEqual(cells('| `x | y` |'), ['`x', 'y`'])
  assert.deepEqual(cells('| `x \\| y` |'), ['`x \\| y`'])
  assert.deepEqual(cells('|\ta\t|  b  |'), ['a', 'b'])
  // Wide characters keep UTF-16 positions.
  assert.deepEqual(cells('| 表格 | 😀 x |'), ['表格', '😀 x'])
})

test('empty cells are the empty range where their text goes', () => {
  const text = '| a ||  | b |'
  const row = parseRow(text, 10)
  assert.deepEqual(row.pipes, [10, 14, 15, 18, 22])
  assert.deepEqual(
    row.cells.map(({ from, to }) => [from, to]),
    [
      [12, 13],
      [15, 15],
      [17, 17],
      [20, 21],
    ],
  )
})

test('cells match the formatted view parser on generated tables', () => {
  let seed = 7
  const random = (n) => {
    seed = (seed * 16807) % 2147483647
    return seed % n
  }
  const pieces = [
    'a',
    'bb',
    ' ',
    '\t',
    '|',
    '\\|',
    '\\\\',
    '`',
    '*',
    '表',
    '😀',
  ]
  const row = () =>
    Array.from(
      { length: 1 + random(12) },
      () => pieces[random(pieces.length)],
    ).join('')
  for (let round = 0; round < 400; round++) {
    const body = Array.from({ length: 1 + random(4) }, row)
    const doc = `| h1 | h2 |\n| --- | --- |\n${body.map((line) => `x${line}`).join('\n')}`
    const tree = markdown.parse(doc)
    let line = 2
    tree.iterate({
      enter(node) {
        if (node.name !== 'TableRow') return
        const text = doc.slice(node.from, node.to)
        const expected = node.node
          .getChildren('TableCell')
          .map((cell) => [cell.from - node.from, cell.to - node.from])
        const actual = parseRow(text)
          .cells.filter(({ from, to }) => to > from)
          .map(({ from, to }) => [from, to])
        assert.deepEqual(actual, expected, JSON.stringify(text))
        line++
        return false
      },
    })
    assert.ok(line > 2, doc)
  }
})

test('delimiter rows give column alignments', () => {
  assert.deepEqual(alignments('| --- | :-- | --: | :-: |'), [
    null,
    'left',
    'right',
    'center',
  ])
  assert.deepEqual(alignments(':--|--:'), ['left', 'right'])
  assert.deepEqual(alignments('| - |'), [null])
})

test('cell content reads escaped pipes as pipes and maps back to the source', () => {
  const { text, source } = cellContent('a \\| `b\\|c`')
  assert.equal(text, 'a | `b|c`')
  assert.equal(source[2], 3, 'the pipe is after its backslash')
  assert.equal(source[text.length], 11)
  assert.deepEqual(cellContent('plain').source, [0, 1, 2, 3, 4, 5])
})

test('rows in quotes start after their quote markers', () => {
  assert.equal(rowStart('> | a |', 1), 2)
  assert.equal(rowStart('> > | a |', 2), 4)
  assert.equal(rowStart('  >| a |', 1), 3)
  assert.equal(rowStart('| a |', 0), 0)
})

test('ragged and malformed giant tables parse in linear time and bounded edits', () => {
  const probe = {
    parsedChunks: 0,
    parsedUnits: 0,
    scannedUnits: 0,
    reusedNodes: 0,
    builtGroups: 0,
  }
  const chunked = new ChunkedMarkdownParser(markdown, markdown, {
    probe,
    opaque: new Set(['Table']),
  })
  const shapes = [
    (i) => `| ${i} | b |`,
    (i) => `| ${i} | b | c | d | e |`,
    (i) => `${i} \\| no | pipes \\\\|`,
    (i) => `| ${'\\'.repeat(i % 7)}| ${'`|'.repeat(i % 5)} |`,
    (i) => `plain row ${i} without pipes`,
  ]
  const rows = Array.from({ length: 20000 }, (_, i) => shapes[i % 5](i))
  let text = `# T\n\n| a | b |\n| - | - |\n${rows.join('\n')}\n\nafter\n`
  const parse = (fragments, demand) => {
    const run = chunked.startChunkedParse(
      {
        length: text.length,
        read: (from, to) => text.slice(from, to),
        chunk: (from) => text.slice(from),
        lineChunks: false,
      },
      fragments,
      demand,
    )
    for (;;) {
      const tree = run.advance()
      if (tree) return tree
    }
  }
  // A table widget on screen makes the whole table the visible range.
  const demand = { from: 0, to: text.length }
  let tree = parse([], demand)
  // Finding the table's end reads it once.
  assert.ok(probe.scannedUnits < 2 * text.length, JSON.stringify(probe))
  for (const at of [text.length >> 1, (text.length * 3) >> 2]) {
    for (const key of Object.keys(probe)) probe[key] = 0
    const line = text.lastIndexOf('\n', at) + 1
    text = `${text.slice(0, line)}x${text.slice(line)}`
    tree = parse(
      TreeFragment.applyChanges(TreeFragment.addTree(tree), [
        { fromA: line, toA: line, fromB: line, toB: line + 1 },
      ]),
      demand,
    )
    assert.ok(probe.parsedUnits < 4096, JSON.stringify(probe))
    assert.ok(probe.scannedUnits <= 16384, JSON.stringify(probe))
  }
  let tables = 0
  tree.iterate({
    enter(node) {
      if (node.name === 'Table') tables++
    },
  })
  assert.equal(tables, 1)
})

/** A table in `doc` as transforms read it, from its first line to its last. */
function table(doc, quotes = 0) {
  const lines = doc.split('\n')
  const starts = []
  let at = 0
  for (const text of lines) {
    starts.push(at)
    at += text.length + 1
  }
  return {
    lines: lines.length,
    line: (index) => ({ from: starts[index], text: lines[index] }),
    quotes,
  }
}
const apply = (doc, edit) => {
  assert.ok(edit, 'an edit')
  let text = doc
  for (const { from, to, insert } of [...edit.changes].sort(
    (a, b) => b.from - a.from,
  ))
    text = text.slice(0, from) + insert + text.slice(to)
  return text
}
const grid = (doc) =>
  doc
    .split('\n')
    .map((text) =>
      parseRow(text).cells.map(({ from, to }) => text.slice(from, to)),
    )

const base = '| a | b |\n| --- | :-: |\n| 1 | 2 |\n| 3 | 4 |'

test('rows insert, delete and move as single lines', () => {
  assert.equal(
    apply(base, insertRow(table(base), 2, true)),
    '| a | b |\n| --- | :-: |\n| 1 | 2 |\n|  |  |\n| 3 | 4 |',
  )
  assert.equal(
    apply(base, insertRow(table(base), 2, false)),
    '| a | b |\n| --- | :-: |\n|  |  |\n| 1 | 2 |\n| 3 | 4 |',
  )
  // Below the header is the first row; above it, a new header.
  assert.equal(
    apply(base, insertRow(table(base), 0, true)),
    '| a | b |\n| --- | :-: |\n|  |  |\n| 1 | 2 |\n| 3 | 4 |',
  )
  assert.equal(
    apply(base, insertRow(table(base), 0, false)),
    '|  |  |\n| --- | :-: |\n| a | b |\n| 1 | 2 |\n| 3 | 4 |',
  )
  assert.equal(
    apply(base, deleteRow(table(base), 3)),
    '| a | b |\n| --- | :-: |\n| 1 | 2 |',
  )
  assert.equal(
    apply(base, deleteRow(table(base), 0)),
    '| 1 | 2 |\n| --- | :-: |\n| 3 | 4 |',
  )
  assert.equal(deleteRow(table('| a |\n| - |'), 0), null)
  assert.equal(
    apply(base, moveRow(table(base), 3, -1)),
    '| a | b |\n| --- | :-: |\n| 3 | 4 |\n| 1 | 2 |',
  )
  assert.equal(moveRow(table(base), 2, -1), null, 'rows stay below the header')
  // Rows in quotes and lists keep their line prefix.
  const quoted = '> | a | b |\n> | - | - |\n> | 1 | 2 |'
  assert.equal(
    apply(quoted, insertRow(table(quoted, 1), 2, true)),
    '> | a | b |\n> | - | - |\n> | 1 | 2 |\n> |  |  |',
  )
  const listed = '  | a |\n  | - |\n  | 1 |'
  assert.equal(
    apply(listed, insertRow(table(listed), 2, false)),
    '  | a |\n  | - |\n  |  |\n  | 1 |',
  )
})

test('columns insert, delete and move in every row, ragged rows included', () => {
  const ragged = '| a | b |\n| --- | :-: |\n| 1 |\n| 3 | 4 | 5 |\nx \\| y'
  assert.deepEqual(grid(apply(ragged, insertColumn(table(ragged), 0, false))), [
    ['', 'a', 'b'],
    ['---', '---', ':-:'],
    ['', '1'],
    ['', '3', '4', '5'],
    ['', 'x \\| y'],
  ])
  assert.deepEqual(grid(apply(ragged, insertColumn(table(ragged), 1, true))), [
    ['a', 'b', ''],
    ['---', ':-:', '---'],
    ['1'],
    ['3', '4', '', '5'],
    ['x \\| y'],
  ])
  assert.deepEqual(grid(apply(ragged, deleteColumn(table(ragged), 0))), [
    ['b'],
    [':-:'],
    [],
    ['4', '5'],
    [],
  ])
  assert.deepEqual(grid(apply(ragged, moveColumn(table(ragged), 0, 1))), [
    ['b', 'a'],
    [':-:', '---'],
    ['', '1'],
    ['4', '3', '5'],
    ['', 'x \\| y'],
  ])
  assert.equal(moveColumn(table(ragged), 1, 1), null)
  assert.equal(deleteColumn(table('| a |\n| - |'), 0), null)
  // Rows without outer pipes keep their cells.
  const bare = 'a | b\n--- | ---\n1 | 2'
  assert.deepEqual(grid(apply(bare, insertColumn(table(bare), 0, false))), [
    ['', 'a', 'b'],
    ['---', '---', '---'],
    ['', '1', '2'],
  ])
  assert.deepEqual(grid(apply(bare, insertColumn(table(bare), 1, true))), [
    ['a', 'b', ''],
    ['---', '---', '---'],
    ['1', '2', ''],
  ])
  assert.deepEqual(grid(apply(bare, deleteColumn(table(bare), 1))), [
    ['a'],
    ['---'],
    ['1'],
  ])
  // Deleting a row's only cell keeps the row in the table.
  const lone = '| a | b |\n| - | - |\nonly'
  assert.equal(apply(lone, deleteColumn(table(lone), 0)), '| b |\n| - |\n|')
})

test('alignment rewrites the delimiter cell and keeps its length', () => {
  assert.equal(
    apply(base, alignColumn(table(base), 0, 'left')),
    '| a | b |\n| :--- | :-: |\n| 1 | 2 |\n| 3 | 4 |',
  )
  assert.equal(
    apply(base, alignColumn(table(base), 1, 'right')),
    '| a | b |\n| --- | ---: |\n| 1 | 2 |\n| 3 | 4 |',
  )
  assert.equal(
    apply(base, alignColumn(table(base), 1, null)),
    '| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |',
  )
  assert.deepEqual(alignColumn(table(base), 1, 'center').changes, [])
})
