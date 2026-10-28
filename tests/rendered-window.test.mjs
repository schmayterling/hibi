import assert from 'node:assert/strict'
import test from 'node:test'
import { MountedTree, NodeProp, Tree, TreeCursor } from '@lezer/common'
import { parser as javascriptParser } from '@lezer/javascript'
import {
  formattedTextEffects,
  formattedTextWindow,
} from '../src/shared/formatted-text-effects.ts'
import { textFeatures } from '../src/shared/formatted-text-rules.ts'
import {
  FormattedTextMask,
  formattedTextRuns,
} from '../src/shared/formatted-text-runs.ts'
import {
  boundaryInlineParser,
  boundaryParser,
} from '../src/shared/markdown-boundary-syntax.ts'
import { renderedRange } from '../src/shared/rendered-range.ts'
import {
  RenderedTextIndex,
  UnsupportedRenderedFind,
} from '../src/shared/rendered-text.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'
import { searchRenderedLiteral } from '../src/shared/source-rendered-search.ts'
import { renderedConfig } from './rendered-config.mjs'

const config = {
  ...renderedConfig,
  syntax: [
    ...renderedConfig.syntax,
    'obsidian@1',
    'subscript@1',
    'subtext@1',
    'math-inline@1',
    'math-block@1',
  ],
  flavors: [
    ...renderedConfig.flavors,
    'markdown.obsidian',
    'text-extras.text-extras',
    'math.latex',
  ],
  textFeatures: [...textFeatures],
}
function build(text) {
  const store = new SourceStore(text, { tabId: 'window', revision: 0 })
  const index = new RenderedTextIndex(store.snapshot(), 0, config)
  for (const _ of index.build()) {
  }
  return index
}
function inputFor(text) {
  return {
    length: text.length,
    read: (from, to) => text.slice(from, to),
    lineAt(at) {
      const from = text.lastIndexOf('\n', at - 1) + 1
      const next = text.indexOf('\n', at)
      return { from, to: next < 0 ? text.length : next }
    },
  }
}

function projectionWork(work) {
  const moves = Object.fromEntries(
      [
        'next',
        'enter',
        'childAfter',
        'childBefore',
        'prevSibling',
        'lastChild',
        'firstChild',
        'enterChild',
        'nextSibling',
        'sibling',
        'parent',
      ].map((method) => [method, 0]),
    ),
    originals = new Map(),
    masks = [],
    names = new Set(),
    runs = FormattedTextMask.prototype.runs
  try {
    for (const method of Object.keys(moves)) {
      const original = TreeCursor.prototype[method]
      assert.equal(typeof original, 'function', method)
      originals.set(method, original)
      TreeCursor.prototype[method] = function (...args) {
        moves[method]++
        const result = original.apply(this, args)
        names.add(this.name)
        return result
      }
    }
    FormattedTextMask.prototype.runs = function* (...args) {
      try {
        yield* runs.apply(this, args)
      } finally {
        masks.push(this.counters())
      }
    }
    const value = work()
    return {
      value,
      moves,
      masks,
      names: [...names],
      total: Object.values(moves).reduce((sum, count) => sum + count, 0),
    }
  } finally {
    FormattedTextMask.prototype.runs = runs
    for (const [method, original] of originals)
      TreeCursor.prototype[method] = original
  }
}

function selectedRuns(scope, input, window, selection) {
  const effects = formattedTextEffects(
    scope,
    0,
    input,
    { ...window, selection },
    config,
    boundaryInlineParser(config),
    new Set(),
    true,
  )
  return [
    ...renderedRange(
      formattedTextRuns(effects, input, { window, selection }),
      selection.from,
      selection.to,
      input,
    ),
  ]
    .map((chunk) => chunk.text)
    .join('')
}

test("reference definitions use the view's hidden source ranges", () => {
  for (const [source, expected] of [
    ['before\n\n[id]: https://example.test\n\nafter', 'before\nafter'],
    ['[id]: https://example.test', ''],
    ['- [id]: https://example.test\n\n  content', 'content'],
  ]) {
    const index = build(source)
    assert.equal(
      [...index.range(0, index.length)].map((chunk) => chunk.text).join(''),
      expected,
      source,
    )
    assert.equal(
      [...searchRenderedLiteral(index, 'example.test')].flatMap(
        (batch) => batch.matches,
      ).length,
      0,
    )
  }
})

test('leaf projection retains literal ancestor settings', () => {
  const text = '> **word**',
    input = inputFor(text)
  const tree = boundaryParser(config).parse(text)
  const leaf = tree.resolveInner(text.indexOf('word'), 1).parent
  assert.equal(leaf.name, 'Paragraph')
  const effects = [
    ...formattedTextEffects(
      leaf,
      0,
      input,
      { from: leaf.from, to: leaf.to },
      { ...config, literal: ['Blockquote'] },
      boundaryInlineParser(config),
      new Set(),
      false,
    ),
  ].filter(Boolean)
  assert.ok(
    !effects.some((effect) => effect.kind === 'hide' || effect.kind === 'atom'),
  )
})

test('reference link syntax fails closed until shared resolution is available', () => {
  for (const text of [
    'hello [label][hidden]',
    'hello [hidden][]',
    'hello [hidden]',
    '| a | b |\n| - | - |\n| [label][hidden] | word |',
  ]) {
    assert.throws(
      () => build(text + '\n\n[hidden]: /url'),
      UnsupportedRenderedFind,
      text,
    )
  }
  assert.equal(
    [...build('hello [label](url)').range(0, 18)]
      .map((chunk) => chunk.text)
      .join(''),
    'hello label',
  )
})

test('quoted list continuations hide indentation after their quote markers', () => {
  for (const [source, expected] of [
    ['> - quoted *item*\n>   cont', 'quoted item cont'],
    ['> - a\n>   b', 'a b'],
    ['> 1. a\n>    b', 'a b'],
    ['>> - a\n>>   b', 'a b'],
  ]) {
    const index = build(source)
    assert.equal(
      [...index.range(0, index.length)].map((chunk) => chunk.text).join(''),
      expected,
      source,
    )
  }
})

test('retained projection cursor moves follow its window rather than preceding or trailing blocks', (t) => {
  const parser = boundaryParser(config),
    inline = boundaryInlineParser(config),
    measurements = []
  const measure = (scope, text, range, literal, label, blocks) => {
    const input = inputFor(text),
      read = input.read
    let readUnits = 0
    input.read = (from, to) => {
      readUnits += to - from
      return read(from, to)
    }
    const {
      value: effects,
      moves,
      total,
    } = projectionWork(() => [
      ...formattedTextEffects(
        scope,
        0,
        input,
        range,
        { ...config, literal },
        inline,
        new Set(),
        false,
      ),
    ])
    const result = {
      label,
      blocks,
      moves,
      readUnits,
      total,
      leaves: effects.filter((effect) => effect?.kind === 'leaf').length,
    }
    measurements.push(result)
    t.diagnostic(JSON.stringify(result))
  }
  for (const blocks of [20000, 40000]) {
    const text = 'block\n\n'.repeat(blocks),
      tree = parser.parse(text)
    for (const [label, at] of [
      ['start', 0],
      ['middle', 19000],
      ['end', blocks - 1],
    ]) {
      const from = at * 7,
        leaf = tree.resolveInner(from + 1, 1),
        range = { from, to: from + 5 }
      assert.equal(leaf.name, 'Paragraph')
      measure(leaf, text, range, [], label, blocks)
      measure(leaf, text, range, ['Paragraph'], label + '-literal', blocks)
    }
    measure(tree, text, { from: 0, to: 5 }, [], 'root-prefix', blocks)
  }
  const text = 'block\n\n'.repeat(Math.ceil((4 * 1024 * 1024) / 7)),
    tree = parser.parse(text),
    from = Math.floor(text.length / 14) * 7
  measure(
    tree,
    text,
    { from, to: from + 12 },
    [],
    'two-blocks-4mib',
    text.length / 7,
  )
  for (const result of measurements) {
    assert.ok(result.total <= 64, JSON.stringify(result))
    assert.ok(result.readUnits <= 4096, JSON.stringify(result))
    assert.equal(result.leaves, result.label === 'two-blocks-4mib' ? 2 : 1)
  }
})

test('retained neighbour context stops safely across long hidden definition runs', (t) => {
  const sample = boundaryParser(config).parse(
      'before\n\n[id]: /hidden\n\nafter\n',
    ),
    first = sample.topNode.getChild('Paragraph').toTree(),
    reference = sample.topNode.getChild('LinkReference').toTree(),
    last = sample.topNode.lastChild.toTree(),
    results = []
  for (const blocks of [20000, 40000]) {
    const end = 8 + blocks * (reference.length + 1) + 1,
      tree = new Tree(
        sample.type,
        [first, ...Array(blocks).fill(reference), last],
        [
          0,
          ...Array.from(
            { length: blocks },
            (_, at) => 8 + at * (reference.length + 1),
          ),
          end,
        ],
        end + last.length,
      )
    for (const [label, selection] of [
      ['before', { from: 0, to: 1 }],
      ['after', { from: end, to: end + 1 }],
    ]) {
      const result = projectionWork(() =>
        formattedTextWindow(tree, selection, new Set()),
      )
      assert.equal(result.value, null)
      assert.ok(result.total <= 256, JSON.stringify(result))
      results.push({ blocks, label, moves: result.total })
      t.diagnostic(JSON.stringify(results.at(-1)))
    }
  }
  assert.equal(results[0].moves, results[2].moves)
  assert.equal(results[1].moves, results[3].moves)
})

test('50 mib fenced context projects only a deep selection and its boundary evidence', (t) => {
  const bodyLine = 'code line\n',
    bodyLength = 50 * 1024 * 1024,
    bodyStart = 4,
    suffixStart = bodyStart + bodyLength,
    fenceEnd = suffixStart + 3,
    length = suffixStart + 9,
    deepFrom =
      bodyStart +
      Math.floor((49 * 1024 * 1024) / bodyLine.length) * bodyLine.length +
      5,
    sample = boundaryParser(config).parse(
      '\x60\x60\x60\ncode line\n\x60\x60\x60\n\nnext',
    ),
    sampleFence = sample.topNode.firstChild,
    language = javascriptParser.parse('const value = 1;')
  // Stretch the retained grammar's one CodeText node; no 50 mib test string or cold parse.
  const mountedProps = (length) => [
    [
      NodeProp.mounted,
      new MountedTree(
        new Tree(language.type, [language], [length - language.length], length),
        null,
        javascriptParser,
      ),
    ],
  ]
  for (const mounted of ['none', 'CodeText', 'FencedCode']) {
    const fence = new Tree(
        sampleFence.type,
        [
          new Tree(sampleFence.firstChild.type, [], [], 3),
          new Tree(
            sampleFence.getChild('CodeText').type,
            [],
            [],
            bodyLength - 1,
            mounted === 'CodeText' ? mountedProps(bodyLength - 1) : undefined,
          ),
          new Tree(sampleFence.lastChild.type, [], [], 3),
        ],
        [0, bodyStart, suffixStart],
        fenceEnd,
        mounted === 'FencedCode' ? mountedProps(fenceEnd) : undefined,
      ),
      tree = new Tree(
        sample.type,
        [fence, new Tree(sample.topNode.lastChild.type, [], [], 4)],
        [0, fenceEnd + 2],
        length,
      )
    for (const [label, selection, expected] of [
      ['deep', { from: deepFrom, to: deepFrom + 10 }, 'line\ncode '],
      [
        'last-line-and-next-block',
        { from: suffixStart - 6, to: length },
        ' line\nnext',
      ],
    ]) {
      let readUnits = 0,
        lineCalls = 0,
        maximumRead = 0
      const input = {
        length,
        read(from, to) {
          readUnits += to - from
          maximumRead = Math.max(maximumRead, to - from)
          assert.ok(to - from <= 4096, JSON.stringify({ from, to }))
          let text = ''
          for (let at = from; at < to; at++)
            text +=
              at < bodyStart
                ? '\x60\x60\x60\n'[at]
                : at < suffixStart
                  ? bodyLine[(at - bodyStart) % bodyLine.length]
                  : '\x60\x60\x60\n\nnext'[at - suffixStart]
          return text
        },
        lineAt(at) {
          assert.ok(
            ++lineCalls <= 32,
            'selection crossed the bounded line budget',
          )
          if (at < bodyStart) return { from: 0, to: 3 }
          if (at < suffixStart) {
            const from =
              bodyStart +
              Math.floor((at - bodyStart) / bodyLine.length) * bodyLine.length
            return { from, to: from + bodyLine.length - 1 }
          }
          if (at <= fenceEnd) return { from: suffixStart, to: fenceEnd }
          if (at === fenceEnd + 1) return { from: at, to: at }
          return { from: fenceEnd + 2, to: length }
        },
      }
      const work = projectionWork(() => {
          const window = formattedTextWindow(tree, selection, new Set())
          assert.ok(window)
          return selectedRuns(tree, input, window, selection)
        }),
        mask = work.masks[0]
      assert.equal(work.value, expected)
      assert.deepEqual(
        work.names.filter(
          (name) =>
            ![
              'Document',
              'FencedCode',
              'CodeMark',
              'CodeText',
              'Paragraph',
            ].includes(name),
        ),
        [],
        JSON.stringify(work),
      )
      assert.ok(work.total <= 64, JSON.stringify(work))
      assert.ok(mask.effectWork + mask.runWork <= 64, JSON.stringify(mask))
      assert.ok(mask.maskBytes <= 2048, JSON.stringify(mask))
      assert.ok(readUnits <= 128, String(readUnits))
      t.diagnostic(
        JSON.stringify({
          label,
          mounted,
          length,
          lineCalls,
          readUnits,
          maximumRead,
          moves: work.total,
          mask,
        }),
      )
    }
  }
})

test('selection documents the current whole-title, task-padding and table-cell read costs', (t) => {
  const parser = boundaryParser(config)
  for (const [label, note, select, factor] of [
    [
      'alert-title',
      (size) => '> [!NOTE] ' + 'x'.repeat(size),
      (text) => ({ from: text.length - 10, to: text.length }),
      1,
    ],
    [
      'task-padding',
      (size) => '- [ ]' + ' '.repeat(size) + 'word',
      (text) => ({ from: text.length - 24, to: text.length - 14 }),
      1,
    ],
    [
      'table-cell',
      (size) => '| title |\n| --- |\n| ' + 'x'.repeat(size) + ' |',
      (text) => ({ from: text.length - 12, to: text.length - 2 }),
      2,
    ],
  ]) {
    const reads = []
    for (const size of [16384, 32768]) {
      const text = note(size),
        tree = parser.parse(text),
        selection = select(text),
        window = { from: 0, to: text.length },
        input = inputFor(text),
        read = input.read
      let readUnits = 0
      input.read = (from, to) => {
        readUnits += to - from
        return read(from, to)
      }
      const work = projectionWork(() =>
        selectedRuns(tree, input, window, selection),
      )
      assert.equal(work.value, label === 'task-padding' ? '' : 'x'.repeat(10))
      assert.ok(
        readUnits >= factor * size,
        JSON.stringify({ label, size, readUnits }),
      )
      assert.ok(
        readUnits <= factor * size + 512,
        JSON.stringify({ label, size, readUnits }),
      )
      reads.push(readUnits)
      t.diagnostic(
        JSON.stringify({
          label,
          size,
          readUnits,
          moves: work.total,
          mask: work.masks[0],
        }),
      )
    }
    assert.equal(reads[1] - reads[0], factor * 16384, label)
  }
})

test('leaf projection retains quoted-list ancestor context', () => {
  const text = '> - first\n>   **word**',
    input = inputFor(text)
  const parser = boundaryParser(config),
    inline = boundaryInlineParser(config),
    tree = parser.parse(text)
  let leaf = tree.resolveInner(text.indexOf('word'), 1)
  while (leaf.name !== 'Paragraph') leaf = leaf.parent
  const range = { from: text.indexOf('\n') + 1, to: text.length }
  const effects = (node) =>
    [
      ...formattedTextEffects(
        node,
        0,
        input,
        range,
        config,
        inline,
        new Set(),
        false,
      ),
    ]
      .filter(
        (effect) => effect && effect.to > range.from && effect.from < range.to,
      )
      .map((effect) => ({
        ...effect,
        from: Math.max(range.from, effect.from),
        to: Math.min(range.to, effect.to),
      }))
  assert.deepEqual(effects(leaf), effects(tree))
})

test("replacement never loses the first character's marks beside closing delimiters", () => {
  const source = 'a==&amp;[[R]]__\x60=='
  const original = build(source)
  const [match] = [...searchRenderedLiteral(original, '\x60')].flatMap(
    (batch) => batch.matches,
  )
  const work = original.prepareReplacement(match, '==')
  let next = work.next()
  while (!next.done) next = work.next()
  // The view treats backslashes inside highlights literally; an unprovable repair is refused.
  if (!next.value.edits) return
  let changed = source
  for (const edit of [...next.value.edits].reverse())
    changed = changed.slice(0, edit.from) + edit.insert + changed.slice(edit.to)
  const index = build(changed),
    tree = boundaryParser(config).parse(changed)
  const [inserted] = [...searchRenderedLiteral(index, '==')].flatMap(
    (batch) => batch.matches,
  )
  assert.ok(inserted)
  for (const segment of inserted.segments) {
    let node = tree.resolveInner(segment.from, 1),
      marked = false
    while (node) {
      marked ||= node.name === 'Highlight'
      node = node.parent
    }
    assert.ok(marked, changed)
  }
})

test('partial replacement proof does not ignore a distant closing delimiter', () => {
  const source =
    'needle ' + 'plain words here and there\n'.repeat(5000) + 'end* tail'
  const original = build(source)
  const [match] = [...searchRenderedLiteral(original, 'needle')].flatMap(
    (batch) => batch.matches,
  )
  const work = original.prepareReplacement(match, '*needle')
  let next = work.next()
  while (!next.done) next = work.next()
  if (!next.value.edits) return
  let changed = source
  for (const edit of [...next.value.edits].reverse())
    changed = changed.slice(0, edit.from) + edit.insert + changed.slice(edit.to)
  const actual = build(changed)
  const visible = (index) =>
    [...index.range(0, index.length)].map((chunk) => chunk.text).join('')
  assert.ok(
    visible(actual) ===
      '*needle' +
        [...original.range(match.to, original.length)]
          .map((chunk) => chunk.text)
          .join(''),
    'partial proof missed a delimiter beyond its window',
  )
})

test('replacement in a certified ordinary tail uses a bounded local proof', (t) => {
  const source = 'plain words '.repeat(6000) + 'needle' + ' rest'.repeat(6000)
  const index = build(source)
  const [match] = [...searchRenderedLiteral(index, 'needle')].flatMap(
    (batch) => batch.matches,
  )
  assert.equal(index.counters().plainTailUnits, source.length)
  const work = index.prepareReplacement(match, 'X')
  let next = work.next(),
    yields = 0
  while (!next.done) {
    yields++
    next = work.next()
  }
  assert.ok(next.value.edits)
  assert.ok(yields < 128, JSON.stringify({ length: source.length, yields }))
  t.diagnostic(JSON.stringify({ length: source.length, yields }))
})

test('replacement proof includes the gap before an adjacent opaque block', () => {
  const source = '\x60\\*~~\n\n*** ***'
  const index = build(source)
  const query = [...index.range(0, 6)].map((chunk) => chunk.text).join('')
  const [match] = [...searchRenderedLiteral(index, query)].flatMap(
    (batch) => batch.matches,
  )
  const work = index.prepareReplacement(match, 'snake_case')
  let next = work.next()
  while (!next.done) next = work.next()
  if (!next.value.edits) return
  let changed = source
  for (const edit of [...next.value.edits].reverse())
    changed = changed.slice(0, edit.from) + edit.insert + changed.slice(edit.to)
  const actual = build(changed)
  assert.equal(
    [...actual.range(0, actual.length)]
      .filter((chunk) => !chunk.barrier)
      .map((chunk) => chunk.text)
      .join(''),
    'snake_case',
  )
})

test('a changed prefix cannot reuse plain-tail proof across a new open fence', () => {
  const source = 'needle start\n\n' + 'ordinary '.repeat(12000)
  const index = build(source)
  assert.ok(index.counters().plainTailUnits > 65536)
  const [match] = [...searchRenderedLiteral(index, 'needle')].flatMap(
    (batch) => batch.matches,
  )
  const work = index.prepareReplacement(match, '\x60\x60\x60\n')
  let next = work.next()
  while (!next.done) next = work.next()
  if (!next.value.edits) return
  let changed = source
  for (const edit of [...next.value.edits].reverse())
    changed = changed.slice(0, edit.from) + edit.insert + changed.slice(edit.to)
  const actual = build(changed)
  assert.equal(
    [...actual.range(0, actual.length)].map((chunk) => chunk.text).join(''),
    '\x60\x60\x60\n' +
      [...index.range(match.to, index.length)]
        .map((chunk) => chunk.text)
        .join(''),
  )
})

test('candidate proofs cannot mutate the original footnote definitions', () => {
  const index = build('first\n\nsecond\n\n[^existing]: body')
  const match = (text) =>
    [...searchRenderedLiteral(index, text)].flatMap((batch) => batch.matches)[0]
  const finish = (work) => {
    for (;;) {
      const next = work.next()
      if (next.done) return next.value
    }
  }
  assert.ok(
    finish(index.prepareReplacement(match('first'), '[^new]: hello')).edits,
  )
  const plan = finish(index.prepareReplacement(match('second'), '[^new]'))
  assert.ok(plan.edits)
  assert.equal(plan.edits.find((edit) => edit.insert).insert, '[^new]')
})

test('local proof ignores artificial syntax-chunk document edges', () => {
  const index = build(
    'block\n\n'.repeat(600) + 'needle\n\n' + 'block\n\n'.repeat(600),
  )
  const [match] = [...searchRenderedLiteral(index, 'needle')].flatMap(
    (batch) => batch.matches,
  )
  const work = index.prepareReplacement(match, 'X')
  let next = work.next()
  while (!next.done) next = work.next()
  assert.ok(next.value.edits)
})

test('replacement inside a long wrapped paragraph remains local', (t) => {
  const unit = 'plain words here and there\n'
  const source = unit.repeat(8000) + 'needle ' + unit.repeat(8000)
  const index = build(source)
  const [match] = [...searchRenderedLiteral(index, 'needle')].flatMap(
    (batch) => batch.matches,
  )
  const work = index.prepareReplacement(match, 'X')
  let next = work.next(),
    yields = 0
  while (!next.done) {
    yields++
    next = work.next()
  }
  assert.ok(next.value.edits)
  assert.ok(yields < 256, JSON.stringify({ length: source.length, yields }))
  t.diagnostic(JSON.stringify({ length: source.length, yields }))
})

test('completed projection releases syntax windows before lazy match details', (t) => {
  const index = build('- item\n'.repeat(20000))
  assert.equal(index.counters().retainedWindows, 0)
  assert.equal(index.counters().retainedNodes, 0)
  let match
  for (const batch of searchRenderedLiteral(index, 'item')) {
    match = batch.matches[0]
    if (match) break
  }
  assert.ok(match)
  assert.ok(index.counters().retainedWindows <= 2)
  t.diagnostic(JSON.stringify(index.counters()))
})

test('replacement proof work is bounded by the edited block instead of the note', (t) => {
  const text =
    'needle start\n\n' +
    'plain words here and there\n'.repeat(Math.ceil((512 * 1024) / 26))
  const index = build(text)
  const [match] = [...searchRenderedLiteral(index, 'needle')].flatMap(
    (batch) => batch.matches,
  )
  const work = index.prepareReplacement(match, 'X')
  let yields = 0,
    result
  for (;;) {
    const next = work.next()
    if (next.done) {
      result = next.value
      break
    }
    yields++
  }
  assert.ok(result.edits)
  assert.ok(yields < 128, JSON.stringify({ length: text.length, yields }))
  t.diagnostic(JSON.stringify({ length: text.length, yields }))
})
