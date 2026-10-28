import assert from 'node:assert/strict'
import test from 'node:test'
import { formattedTextEffects } from '../src/shared/formatted-text-effects.ts'
import { textFeatures } from '../src/shared/formatted-text-rules.ts'
import {
  FormattedTextMask,
  formattedTextRuns,
} from '../src/shared/formatted-text-runs.ts'
import {
  boundaryInlineParser,
  boundaryParser,
} from '../src/shared/markdown-boundary-syntax.ts'
import {
  renderedBoundary,
  renderedRange,
} from '../src/shared/rendered-range.ts'
import { RenderedTextIndex } from '../src/shared/rendered-text.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'
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
const parser = boundaryParser(config),
  inline = boundaryInlineParser(config)
function inputFor(text) {
  return {
    length: text.length,
    read: (from, to) => text.slice(from, to),
    lineAt(at) {
      const from = text.lastIndexOf('\n', at - 1) + 1,
        next = text.indexOf('\n', at)
      return { from, to: next < 0 ? text.length : next }
    },
  }
}
function effectsFor(tree, input, range) {
  const definitions = new Set()
  const effects = [
    ...formattedTextEffects(
      tree,
      0,
      input,
      range,
      config,
      inline,
      definitions,
      false,
    ),
  ]
  if (definitions.size)
    effects.push(
      ...formattedTextEffects(
        tree,
        0,
        input,
        range,
        config,
        inline,
        definitions,
        true,
      ),
    )
  return effects
}
function indexFor(text) {
  const source = new SourceStore(text, { tabId: 'run-assembly', revision: 0 }),
    index = new RenderedTextIndex(source.snapshot(), 0, config)
  for (const _ of index.build()) {
  }
  return index
}
function textFor(runs, input, range, options) {
  return [...renderedRange(runs, range.from, range.to, input, options)]
    .map((chunk) => chunk.text)
    .join('')
}
function ordered(runs) {
  let end = -1
  for (const run of runs) {
    assert.ok(run.from >= end && run.to > run.from, JSON.stringify(runs))
    end = run.to
  }
}

test('shared effects assemble exactly the existing find chunks and provenance for every small source range', () => {
  let compared = 0
  for (const text of [
    'hello **world**',
    'a &NotEqualTilde; b 😀',
    'a \\*b\\* and `c*d`',
    '[label](url) and [[Page|Alias]]',
    '> - a\n>   **b**\n\nend',
    '# first\n\nnext\nline',
    '| a | **b** |\n|---|---|\n| c | d |',
    'a ![alt](pic) b\n\n---\n\nc $x$',
    'ref [^1]\n\n[^1]: note',
    '<div>\n*a*\n</div>',
  ]) {
    const input = inputFor(text),
      range = { from: 0, to: text.length },
      effects = effectsFor(parser.parse(text), input, range),
      index = indexFor(text)
    for (let from = 0; from <= text.length; from++) {
      if (!renderedBoundary(input, from)) continue
      for (let to = from; to <= text.length; to++) {
        if (!renderedBoundary(input, to)) continue
        const selection = { from, to },
          runs = formattedTextRuns(effects, input, selection)
        ordered(runs)
        assert.deepEqual(
          [...renderedRange(runs, from, to, input)],
          [...index.range(from, to)],
          JSON.stringify({ text, from, to }),
        )
        compared++
      }
    }
  }
  assert.ok(compared > 2000, String(compared))
})

test('effect order retains mask precedence and unchanged atoms remain literal', () => {
  const input = inputFor('&amp; x'),
    range = { from: 0, to: input.length }
  const atom = { kind: 'atom', from: 0, to: 5 }
  for (const kind of ['hide', 'barrier']) {
    const hidden = { kind, from: 0, to: 5 }
    const visible = formattedTextRuns([hidden, null, atom], input, range),
      erased = formattedTextRuns([atom, hidden], input, range)
    ordered(visible)
    ordered(erased)
    assert.equal(textFor(visible, input, range), '& x')
    assert.equal(textFor(erased, input, range), ' x')
    assert.equal(erased[0].barrier === true, kind === 'barrier')
  }
  assert.deepEqual(
    formattedTextRuns(
      [{ kind: 'atom', from: 0, to: 7 }],
      inputFor('literal'),
      range,
    ),
    [{ from: 0, to: 7 }],
  )
  const newline = inputFor('\n'),
    unit = { from: 0, to: 1 }
  const block = { kind: 'block', ...unit },
    space = { kind: 'atom', ...unit }
  assert.deepEqual(formattedTextRuns([space, block], newline, unit), [
    { ...unit, text: '\n', block: true },
  ])
  assert.deepEqual(formattedTextRuns([block, space], newline, unit), [
    { ...unit, text: ' ' },
  ])
})

test('bounded atom ranges retain complete envelopes and mark partial assembly imprecise', () => {
  const text = 'pre &NotEqualTilde; tail',
    input = inputFor(text),
    atom = { kind: 'atom', from: text.indexOf('&'), to: text.indexOf(';') + 1 },
    range = { from: atom.from + 2, to: atom.to - 1 },
    runs = formattedTextRuns([atom], input, range)
  assert.deepEqual(runs, [{ from: atom.from, to: atom.to, text: '≂̸' }])
  assert.deepEqual(
    [...renderedRange(runs, range.from, range.to, input)],
    [{ ...range, text: '≂̸', precise: false }],
  )
})

test('semantic block separators differ from soft lines and keep source provenance', () => {
  for (const [text, expected] of [
    ['hello\n\n`world`', ['hello\nworld', 'helloworld']],
    ['hello\nworld', ['hello world', 'hello world']],
  ]) {
    const input = inputFor(text),
      range = { from: 0, to: text.length },
      effects = effectsFor(parser.parse(text), input, range),
      runs = formattedTextRuns(effects, input, range)
    ordered(runs)
    for (const [index, blockSeparator] of ['\n', ''].entries())
      assert.equal(
        textFor(runs, input, range, { blockSeparator }),
        expected[index],
      )
  }
})

test('an enclosing quoted-list leaf shares the same bounded run assembly as find', () => {
  const text = '> - first\n>   **word**',
    input = inputFor(text),
    tree = parser.parse(text),
    range = { from: text.indexOf('\n') + 1, to: text.length }
  let leaf = tree.resolveInner(text.indexOf('word'), 1)
  while (leaf.name !== 'Paragraph') leaf = leaf.parent
  const effects = effectsFor(leaf, input, range),
    runs = formattedTextRuns(effects, input, range),
    index = indexFor(text)
  assert.equal(textFor(runs, input, range), 'word')
  assert.deepEqual(
    [...renderedRange(runs, range.from, range.to, input)],
    [...index.range(range.from, range.to)],
  )
})

test('deep selection assembly work follows its range rather than preceding 20k blocks', (t) => {
  const text = 'block\n\n'.repeat(20000),
    input = inputFor(text),
    from = 19000 * 7,
    range = { from, to: from + 5 },
    leaf = parser.parse(text).resolveInner(from + 1, 1)
  let readUnits = 0,
    effectCount = 0
  const read = input.read
  input.read = (from, to) => {
    readUnits += to - from
    return read(from, to)
  }
  const effects = effectsFor(leaf, input, range),
    mask = new FormattedTextMask(input)
  for (const effect of effects)
    if (effect) {
      effectCount++
      for (const _ of mask.effect(effect, range)) {
      }
    }
  const runs = [...mask.runs(range.from, range.to)]
  assert.deepEqual(formattedTextRuns(effects, input, range), runs)
  assert.equal(textFor(runs, input, range), 'block')
  const counters = mask.counters()
  assert.ok(effectCount <= 8, JSON.stringify({ effectCount, ...counters }))
  assert.ok(
    counters.effectWork + counters.runWork <= 32,
    JSON.stringify(counters),
  )
  assert.ok(readUnits <= 64, String(readUnits))
  t.diagnostic(
    JSON.stringify({
      blocks: 20000,
      effectCount,
      sourceReadUnits: readUnits,
      ...counters,
    }),
  )
})

test('a small range in a 50 mib leaf never allocates or walks a whole-note mask', (t) => {
  const length = 50 * 1024 * 1024,
    from = 49 * 1024 * 1024 + 100,
    range = { from, to: from + 256 }
  let readUnits = 0
  const input = {
    length,
    read(from, to) {
      readUnits += to - from
      return 'x'.repeat(to - from)
    },
    lineAt: () => ({ from: 0, to: length }),
  }
  const effects = [
      { kind: 'hide', from: 0, to: length },
      { kind: 'leaf', from: 0, to: length },
    ],
    mask = new FormattedTextMask(input)
  for (const effect of effects)
    for (const _ of mask.effect(effect, range)) {
    }
  const runs = [...mask.runs(range.from, range.to)]
  assert.deepEqual(formattedTextRuns(effects, input, range), runs)
  assert.deepEqual(runs, [{ ...range, text: '' }])
  const counters = mask.counters()
  assert.equal(counters.effectWork, 256)
  assert.ok(counters.runWork <= 320, JSON.stringify(counters))
  assert.equal(counters.maskBytes, 2048)
  assert.ok(readUnits <= 4, String(readUnits))
  t.diagnostic(
    JSON.stringify({ length, sourceReadUnits: readUnits, ...counters }),
  )
})

test('worker yield callbacks retain work accounting and checkpoint frequency', () => {
  const input = inputFor('abc')
  let total = 0,
    pending = 0,
    checkpoints = 0
  const mask = new FormattedTextMask(input, (units = 1) => {
    total += units
    pending += units
    if (pending < 2) return false
    pending = 0
    return true
  })
  for (const _ of mask.effect(
    { kind: 'hide', from: 0, to: 3 },
    { from: 0, to: 3 },
  ))
    checkpoints++
  assert.equal(total, 3)
  assert.equal(mask.counters().effectWork, total)
  assert.equal(checkpoints, 1)
})

test('invalid and empty bounds do not consume syntax effects', () => {
  const input = inputFor('😀word')
  let pulled = 0
  function* effects() {
    pulled++
    yield { kind: 'hide', from: 0, to: 6 }
  }
  for (const range of [
    { from: 4, to: 3 },
    { from: NaN, to: 3 },
    { from: 0, to: Infinity },
    { from: 1, to: 3 },
    { from: 0, to: 1 },
  ])
    assert.throws(() => formattedTextRuns(effects(), input, range), /outside/)
  assert.deepEqual(formattedTextRuns(effects(), input, { from: 2, to: 2 }), [])
  assert.equal(pulled, 0)
})
