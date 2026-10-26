import assert from 'node:assert/strict'
import test from 'node:test'
import { TreeFragment } from '@lezer/common'
import { parser, Table } from '@lezer/markdown'
import { ChunkedMarkdownParser } from '../src/renderer/src/chunked-markdown.ts'
import {
  alignments,
  cellContent,
  cellFixes,
  cellSpan,
  deleteColumn,
  deleteRow,
  insertColumn,
  insertRow,
  parseRow,
  planInline,
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
  // A quote in a list item comes after the item's indentation.
  assert.equal(rowStart('    > | a |', 1), 6)
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

test('cell decorations nest as spans in one sweep, linear in their number', () => {
  const ops = planInline(
    12,
    [
      { from: 0, to: 12, attributes: { class: 'link' } },
      { from: 2, to: 6, attributes: { class: 'strong' } },
    ],
    [
      { from: 2, to: 4, widget: null },
      { from: 8, to: 9, widget: 'br' },
    ],
    [{ at: 6, widget: 'mark', side: 1 }],
  )
  assert.deepEqual(
    ops.map((op) =>
      op.type === 'open'
        ? `<${op.mark.attributes.class}>`
        : op.type === 'close'
          ? '</>'
          : op.type === 'text'
            ? `${op.from}-${op.to}`
            : `[${op.widget}]`,
    ),
    [
      '<link>',
      '0-2',
      '<strong>',
      '4-6',
      '</>',
      '[mark]',
      '6-8',
      '[br]',
      '9-12',
      '</>',
    ],
  )
  // Count property reads of `n` emphasis spans with hidden markers.
  const reads = (n) => {
    let count = 0
    const counted = (range) =>
      new Proxy(range, {
        get(target, key) {
          count++
          return target[key]
        },
      })
    const marks = [],
      hidden = []
    for (let i = 0; i < n; i++) {
      marks.push(counted({ from: i * 4, to: i * 4 + 3, attributes: {} }))
      hidden.push(counted({ from: i * 4, to: i * 4 + 1, widget: null }))
      hidden.push(counted({ from: i * 4 + 2, to: i * 4 + 3, widget: null }))
    }
    planInline(n * 4, marks, hidden, [])
    return count
  }
  const small = reads(128),
    large = reads(1024)
  // Quadratic scans read 64 times as much for 8 times the spans.
  assert.ok(large < small * 12, `${small} → ${large}`)
})

/** A table in `doc` as transforms read it, from its first line to its last. */
function table(doc, quotes = 0, start = 0) {
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
    start,
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

test('rows insert and delete as single lines', () => {
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
  // A promoted row takes the delimiter row's width, or it is no header.
  const short = '| a | b |\n| --- | :-: |\n| 1 |\n| 3 | 4 |'
  assert.equal(
    apply(short, deleteRow(table(short), 0)),
    '| 1 |  |\n| --- | :-: |\n| 3 | 4 |',
  )
  const long = '| a | b |\n| - | - |\n| 1 | 2 | 3 |'
  assert.equal(
    apply(long, deleteRow(table(long), 0)),
    '| 1 | 2 | 3 |\n| - | - | --- |',
  )
  // New rows take the continuation prefix of quotes and list items.
  const quoted = '> | a | b |\n> | - | - |\n> | 1 | 2 |'
  assert.equal(
    apply(quoted, insertRow(table(quoted, 1, 2), 2, true)),
    '> | a | b |\n> | - | - |\n> | 1 | 2 |\n> |  |  |',
  )
  const item = '- | a |\n  | - |\n  | 1 |'
  assert.equal(
    apply(item, insertRow(table(item, 0, 2), 0, false)),
    '- |  |\n  | - |\n  | a |\n  | 1 |',
  )
  assert.equal(
    apply(item, insertRow(table(item, 0, 2), 2, false)),
    '- | a |\n  | - |\n  |  |\n  | 1 |',
  )
})

test('columns insert and delete in every row, ragged and bare rows included', () => {
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
  assert.equal(deleteColumn(table('| a |\n| - |'), 0), null)
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
  // One column keeps outer pipes, or its header and delimiter read as a heading.
  assert.equal(
    apply(bare, deleteColumn(table(bare), 1)),
    '| a |\n| --- |\n| 1 |',
  )
  assert.equal(
    apply(bare, deleteColumn(table(bare), 0)),
    '| b |\n| --- |\n| 2 |',
  )
  // Deleting a row's only cell keeps the row in the table.
  const lone = '| a | b |\n| - | - |\nonly'
  assert.equal(apply(lone, deleteColumn(table(lone), 0)), '| b |\n| - |\n|')
  // A list item's table keeps its marker.
  const item = '- | a | b |\n  | - | - |'
  assert.equal(
    apply(item, insertColumn(table(item, 0, 2), 0, false)),
    '- |  | a | b |\n  | --- | - | - |',
  )
})

test('row and column edits keep generated tables parsing as tables', () => {
  let seed = 11
  const random = (n) => {
    seed = (seed * 16807) % 2147483647
    return seed % n
  }
  const cell = () => ['x', '', 'a \\| b', '`c`', '**d**'][random(5)]
  for (let round = 0; round < 300; round++) {
    const columns = 1 + random(4)
    const row = () =>
      `| ${Array.from({ length: random(columns + 2) }, cell).join(' | ')} |`
    // Header and delimiter rows with or without outer pipes.
    const outer = columns < 2 || random(2) === 0
    const head = (cells) =>
      outer ? `| ${cells.join(' | ')} |` : cells.join(' | ')
    const doc = [
      head(Array.from({ length: columns }, (_, i) => `h${i}`)),
      head(Array.from({ length: columns }, () => '---')),
      ...Array.from({ length: 1 + random(4) }, row),
    ].join('\n')
    const source = table(doc)
    const at = random(source.lines)
    const edits = [
      insertRow(source, at === 1 ? 0 : at, random(2) === 0),
      at !== 1 ? deleteRow(source, at) : null,
      insertColumn(source, random(columns), random(2) === 0),
      deleteColumn(source, random(columns)),
    ]
    for (const edit of edits) {
      if (!edit) continue
      const next = apply(doc, edit)
      const tree = markdown.parse(next)
      const lines = []
      tree.iterate({
        enter(node) {
          if (node.name === 'Table')
            lines.push(next.slice(node.from, node.to).split('\n').length)
        },
      })
      assert.deepEqual(lines, [next.split('\n').length], `${doc}\n→\n${next}`)
    }
  }
})

test('cell spans run between delimiters, padding included', () => {
  const text = '| a ||  x | b'
  const row = parseRow(text)
  const spans = [0, 1, 2, 3, 4].map((index) => {
    const span = cellSpan(row, index, text.length)
    return span && [text.slice(span.from, span.to), span.closed]
  })
  assert.deepEqual(spans, [
    [' a ', true],
    ['', true],
    ['  x ', true],
    [' b', false],
    null,
  ])
  const bare = 'a | b'
  assert.deepEqual(cellSpan(parseRow(bare), 0, bare.length), {
    from: 0,
    to: 2,
    closed: true,
  })
})

test('typed cell text stays in its cell', () => {
  const fixed = (text, closed = true) =>
    apply(text, { changes: cellFixes(text, closed) })
  assert.equal(fixed('a|b'), 'a\\|b')
  assert.equal(fixed('a\\|b'), 'a\\|b', 'an escaped pipe stays')
  assert.equal(
    fixed('a\\\\|b'),
    'a\\\\\\|b',
    'an escaped backslash does not escape the pipe',
  )
  assert.equal(fixed('`x|y`'), '`x\\|y`', 'pipes in code are escaped too')
  assert.equal(fixed('one\ntwo\r\n'), 'one<br>two<br>')
  assert.equal(
    fixed('end\\'),
    'end\\ ',
    'a last backslash would escape the delimiter',
  )
  assert.equal(fixed('end\\', false), 'end\\')
  assert.equal(fixed('end\\\\'), 'end\\\\')
})
