import assert from 'node:assert/strict'
import test from 'node:test'
import { parser, Table } from '@lezer/markdown'
import {
  alignments,
  cellContent,
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
