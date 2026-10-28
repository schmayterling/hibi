import assert from 'node:assert/strict'
import test from 'node:test'
import { EditorState, Text } from '@codemirror/state'
import { TreeCursor, TreeFragment } from '@lezer/common'
import { GFM, parser } from '@lezer/markdown'
import { formattedLiteralEdits } from '../src/renderer/src/formatted-source-edits.ts'
import { formattedSyntax } from '../src/renderer/src/formatted-syntax.ts'
import { BoundaryTree } from '../src/shared/chunked-markdown.ts'
import { MarkdownBoundaryIndex } from '../src/shared/markdown-boundary-index.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'
import { sourceParserInput } from '../src/shared/source-parser.ts'

const markdown = parser.configure(GFM)

/** Count native text reads independently of the guard's chosen accessors. */
function textReadUnits(run) {
  let units = 0,
    depth = 0
  const restores = []
  const prototypes = [
    Text.prototype,
    Object.getPrototypeOf(Text.of(['x'])),
    Object.getPrototypeOf(Text.of(Array(128).fill('x'))),
  ]
  for (const prototype of prototypes)
    for (const method of [
      'sliceString',
      'iterRange',
      'iter',
      'toString',
      'toJSON',
    ]) {
      if (!Object.hasOwn(prototype, method)) continue
      const original = prototype[method]
      prototype[method] = function (...args) {
        const outer = depth++ === 0
        let result
        try {
          result = original.apply(this, args)
        } finally {
          depth--
        }
        if (method === 'iterRange' || method === 'iter') {
          const next = result.next
          result.next = function (...args) {
            const value = next.apply(this, args)
            if (!depth) units += this.value.length
            return value
          }
        } else if (outer)
          units += Array.isArray(result)
            ? result.reduce(
                (size, line) => size + line.length,
                result.length - 1,
              )
            : result.length
        return result
      }
      restores.push(() => {
        prototype[method] = original
      })
    }
  try {
    run()
    assert.ok(units > 0, 'native text counter must observe the proof')
    return units
  } finally {
    for (const restore of restores) restore()
  }
}

test('native text counters cover leaf and node accessors without double counting', () => {
  for (const doc of [Text.of(['abc']), Text.of(Array(128).fill('abc'))])
    for (const method of [
      'sliceString',
      'iterRange',
      'iter',
      'iterLines',
      'toString',
      'toJSON',
    ]) {
      const units = textReadUnits(() => {
        if (method.startsWith('iter')) {
          const cursor =
            method === 'iterRange'
              ? doc.iterRange(0, doc.length)
              : doc[method]()
          while (!cursor.next().done) {}
        } else if (method === 'sliceString') doc.sliceString(0, doc.length)
        else doc[method]()
      })
      assert.equal(units, doc.length, method)
    }
})

test('a correction reads one list item regardless of the container length', (t) => {
  const work = []
  for (const count of [10, 2000]) {
    const doc = '- some teh words\n'.repeat(count)
    const from = doc.indexOf('teh', Math.floor(count / 2) * 17)
    const state = EditorState.create({ doc })
    const transaction = state.update({
      changes: { from, to: from + 3, insert: 'the' },
    })
    const tree = markdown.parse(doc)
    const units = textReadUnits(() =>
      assert.equal(formattedLiteralEdits(transaction, markdown, tree), true),
    )
    work.push(units)
  }
  t.diagnostic(JSON.stringify({ units: work }))
  assert.deepEqual(work, [work[0], work[0]])
  assert.ok(work[1] < 128, String(work))
})
test('batched corrections do not revisit every edit for every leaf', () => {
  const count = 100
  const doc = 'teh\n\n'.repeat(count)
  const state = EditorState.create({ doc })
  const transaction = state.update({
    changes: Array.from({ length: count }, (_, index) => ({
      from: index * 5,
      to: index * 5 + 3,
      insert: 'the',
    })),
  })
  const tree = markdown.parse(doc)
  let visits = 0
  const iterate = transaction.changes.iterChangedRanges.bind(
    transaction.changes,
  )
  transaction.changes.iterChangedRanges = (visit, ...args) =>
    iterate(
      (...range) => {
        visits++
        visit(...range)
      },
      ...args,
    )
  assert.equal(formattedLiteralEdits(transaction, markdown, tree), true)
  assert.ok(visits <= count * 4, String(visits))
})

function check(source, changes) {
  const state = EditorState.create({ doc: source })
  const transaction = state.update({ changes })
  return formattedLiteralEdits(transaction, markdown, markdown.parse(source))
}

test('table cell proofs read the row and header independently of row count', (t) => {
  const work = []
  for (const count of [10, 2000]) {
    const doc = '| word |\n| --- |\n' + '| teh |\n'.repeat(count)
    const state = EditorState.create({ doc })
    const from = doc.indexOf('teh', doc.length / 2)
    const transaction = state.update({
      changes: { from, to: from + 3, insert: 'the' },
    })
    const tree = markdown.parse(doc)
    const units = textReadUnits(() =>
      assert.equal(formattedLiteralEdits(transaction, markdown, tree), true),
    )
    work.push(units)
  }
  t.diagnostic(JSON.stringify({ units: work }))
  assert.deepEqual(work, [work[0], work[0]])
  assert.ok(work[1] < 512, String(work))
})

test('leaf proofs retain multiline quote and list context', () => {
  for (const source of [
    '> *teh\n> words*',
    '> - teh\n>   words',
    '> _teh\n>_',
    '> > teh\n> > ---',
  ]) {
    const from = source.indexOf('teh')
    assert.equal(check(source, { from, to: from + 3, insert: 'the' }), true)
  }
  const source = '> *teh\n> words*'
  assert.equal(check(source, { from: source.length - 1, insert: '*' }), false)
  const marker = source.indexOf('\n>') + 1
  assert.equal(
    check(source, { from: marker, to: marker + 1, insert: '' }),
    false,
  )
})

test('nested container proofs preserve heading and table structure', () => {
  for (const source of [
    '- outer\n  - inner\n\n    teh title\n    -----\n',
    '-\n  teh title\n  -----\n',
    '-\n\tteh title\n\t-----\n',
    '-    outer\n\n     teh title\n     -----\n',
    '-     code\n\n  teh title\n  -----\n',
    '> - outer\n>   - inner\n>\n>     teh title\n>     -----\n',
  ]) {
    assert.match(markdown.parse(source).toString(), /SetextHeading2/)
    const from = source.indexOf('teh')
    assert.equal(check(source, { from, to: from + 3, insert: 'the' }), true)
    const underline = source.indexOf('-----')
    assert.equal(
      check(source, { from: underline, to: underline + 5, insert: 'words' }),
      false,
    )
  }
  const source = '- outer\n  - inner\n\n    title\n    `\n    -----\n'
  assert.match(markdown.parse(source).toString(), /SetextHeading2/)
  assert.equal(
    check(source, { from: source.indexOf('`\n') + 1, insert: '``' }),
    false,
  )
  const table =
    '- outer\n  - inner\n\n    | a | b |\n    | --- | --- |\n    | x | y |\n'
  const from = table.lastIndexOf('| y')
  assert.equal(check(table, { from, to: from + 1, insert: '' }), false)
})

test('task text remains literal while its checkbox is structural', () => {
  for (const source of [
    '- [ ] teh words',
    '> - [x] teh words',
    '- outer\n  - [ ] teh words',
  ]) {
    const from = source.indexOf('teh')
    assert.equal(check(source, { from, to: from + 3, insert: 'the' }), true)
  }
  const source = '- [ ] teh words'
  const from = source.indexOf('[ ]') + 1
  assert.equal(check(source, { from, to: from + 1, insert: 'x' }), false)
})

test('container replay never reads an unrelated huge opening paragraph', () => {
  const source = '- ' + 'outer'.repeat(100000) + '\n\n  teh title\n  -----'
  const state = EditorState.create({ doc: source })
  const from = source.indexOf('teh')
  const transaction = state.update({
    changes: { from, to: from + 3, insert: 'the' },
  })
  const tree = markdown.parse(source)
  const units = textReadUnits(() =>
    assert.equal(formattedLiteralEdits(transaction, markdown, tree), true),
  )
  assert.ok(units < 16384, String(units))
})

test('cold and released list proofs retain worker context without reading the container', (t) => {
  const list = '- some teh words\n'.repeat(2000)
  const doc = list + '\n' + 'paragraph words\n\n'.repeat(20000)
  const source = new SourceStore(doc, { tabId: 'list', revision: 0 }).snapshot()
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
  const trees = [builder.finish()]
  let revealed = trees[0]
  for (const demand of [
    { from: list.length / 2, to: list.length / 2 + 20 },
    { from: doc.length - 20, to: doc.length },
  ]) {
    const parse = index.parser.startChunkedParse(
      sourceParserInput(source),
      TreeFragment.addTree(revealed),
      demand,
    )
    let next = parse.advance()
    while (!next) next = parse.advance()
    revealed = next
  }
  trees.push(revealed)
  const state = EditorState.create({ doc })
  const from = doc.indexOf('teh', list.length / 2)
  const transaction = state.update({
    changes: { from, to: from + 3, insert: 'the' },
  })
  const work = []
  for (const tree of trees) {
    const units = textReadUnits(() =>
      assert.equal(formattedLiteralEdits(transaction, markdown, tree), true),
    )
    work.push(units)
    assert.ok(units < 16384, String(units))
  }
  t.diagnostic(JSON.stringify({ coldReleasedUnits: work }))
})

test('cold container context preserves nested prose and fences', () => {
  for (const [doc, allowed] of [
    ['> - some teh words\n'.repeat(2000), true],
    [
      '- intro\n\n  ```\n' + '  code\n\n'.repeat(1800) + '  teh\n  ```\n',
      false,
    ],
  ]) {
    const source = new SourceStore(doc, {
      tabId: 'context',
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
    const from = doc.indexOf('teh', doc.length / 2)
    const transaction = state.update({
      changes: { from, to: from + 3, insert: 'the' },
    })
    const units = textReadUnits(() =>
      assert.equal(
        formattedLiteralEdits(transaction, markdown, builder.finish()),
        allowed,
      ),
    )
    assert.ok(units < 20000, String(units))
  }
})

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
    const units = textReadUnits(() =>
      assert.equal(
        formattedLiteralEdits(transaction, syntax.parser(state), boundaries),
        true,
      ),
    )
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
  const units = textReadUnits(() =>
    assert.equal(
      formattedLiteralEdits(transaction, markdown, builder.finish()),
      false,
    ),
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

test('cold table headers after blank lines retain structural pipe protection', () => {
  for (const count of [400, 2400]) {
    const prefix = 'paragraph words\n\n'.repeat(3000)
    const table =
      '| a | b |\n| --- | --- |\n' +
      '| teh mid-dle word | one two |\n'.repeat(count)
    const doc = prefix + table + '\nafter\n'
    const source = new SourceStore(doc, {
      tabId: 'table',
      revision: 0,
    }).snapshot()
    const index = new MarkdownBoundaryIndex(source, {
      schema: 1,
      syntax: ['table@1'],
      flavors: ['markdown.github'],
      literal: [],
      opaque: ['Table'],
      prefix: 0,
      chunkSize: 4096,
      groupSize: 64,
      giantBlock: 65536,
    })
    while (!index.advance()) {}
    const builder = new BoundaryTree(index.parser, index.length)
    for (const page of index.pages()) builder.append(page.records)
    const tree = builder.finish()
    const state = EditorState.create({ doc })
    const header = prefix.length
    const row = doc.indexOf('teh', header + 2000)
    for (const changes of [
      { from: header + 4, to: header + 5, insert: '' },
      { from: header, to: header + 1, insert: 'x' },
      { from: header + 2, insert: '|' },
    ]) {
      const transaction = state.update({ changes })
      assert.equal(
        formattedLiteralEdits(transaction, index.parser.full, tree),
        false,
        JSON.stringify(changes),
      )
    }
    const literal = state.update({
      changes: { from: row, to: row + 3, insert: 'the' },
    })
    const units = textReadUnits(() =>
      assert.equal(
        formattedLiteralEdits(literal, index.parser.full, tree),
        true,
      ),
    )
    assert.ok(units < 16384, String(units))
  }
})

test('cold math-dense notes accept off-viewport corrections with bounded reads', (t) => {
  const work = []
  for (const count of [50, 210]) {
    const section =
      'para teh words here and more text\n\n'.repeat(30) + '$$\nx^2\n$$\n\n'
    const doc = section.repeat(count)
    const source = new SourceStore(doc, {
      tabId: 'math',
      revision: 0,
    }).snapshot()
    const index = new MarkdownBoundaryIndex(source, {
      schema: 1,
      syntax: ['math-block@1'],
      flavors: ['math.latex'],
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
    const tree = builder.finish()
    const state = EditorState.create({ doc })
    let maximum = 0
    for (let n = count - 1; n >= count - 30; n--) {
      const from = section.length * n + section.indexOf('teh', 500)
      const transaction = state.update({
        changes: { from, to: from + 3, insert: 'the' },
      })
      const units = textReadUnits(() =>
        assert.equal(
          formattedLiteralEdits(transaction, index.parser.full, tree),
          true,
          String(from),
        ),
      )
      maximum = Math.max(maximum, units)
    }
    work.push(maximum)
  }
  t.diagnostic(JSON.stringify({ coldMathUnits: work }))
  assert.ok(
    work.every((units) => units < 32768),
    String(work),
  )
})

test('a leaf correction cannot invalidate an earlier block read-ahead decision', () => {
  for (const prefix of ['', 'paragraph words\n\n'.repeat(3000)]) {
    const doc = prefix + '>1. $$\n>   x^2\n>   $$'
    const source = new SourceStore(doc, {
      tabId: 'lookahead',
      revision: 0,
    }).snapshot()
    const index = new MarkdownBoundaryIndex(source, {
      schema: 1,
      syntax: ['math-block@1'],
      flavors: ['math.latex'],
      literal: [],
      opaque: [],
      prefix: 0,
      chunkSize: 64,
      groupSize: 4,
      giantBlock: 1024,
    })
    while (!index.advance()) {}
    const builder = new BoundaryTree(index.parser, index.length)
    for (const page of index.pages()) builder.append(page.records)
    const parser = index.parser.full
    const from = doc.lastIndexOf('   ')
    const transaction = EditorState.create({ doc }).update({
      changes: { from, to: from + 3, insert: 'e' },
    })
    assert.match(parser.parse(doc).toString(), /BlockMath/)
    assert.doesNotMatch(
      parser.parse(transaction.newDoc.toString()).toString(),
      /BlockMath/,
    )
    for (const tree of [parser.parse(doc), builder.finish()])
      assert.equal(formattedLiteralEdits(transaction, parser, tree), false)
    for (const text of ['teh\n\n' + doc, '$$\nx^2\n$$\n\nteh']) {
      const at = text.indexOf('teh')
      const correction = EditorState.create({ doc: text }).update({
        changes: { from: at, to: at + 3, insert: 'the' },
      })
      assert.equal(
        formattedLiteralEdits(correction, parser, parser.parse(text)),
        true,
      )
    }
  }
})
