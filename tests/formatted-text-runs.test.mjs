import assert from 'node:assert/strict'
import test from 'node:test'
import {
  formattedTextEffects,
  formattedTextLeafVisible,
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
import {
  renderedBoundary,
  renderedRange,
} from '../src/shared/rendered-range.ts'
import {
  RenderedTextIndex,
  UnsupportedRenderedFind,
} from '../src/shared/rendered-text.ts'
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
function definitionsFor(scope, input) {
  // The caller retains note-wide metadata before measuring bounded selection work.
  let root = scope.topNode ?? scope
  while (root.parent) root = root.parent
  const definitions = new Set()
  for (const _ of formattedTextEffects(
    root,
    0,
    input,
    { from: 0, to: input.length },
    config,
    inline,
    definitions,
    false,
  )) {
  }
  return definitions
}
function effectsFor(
  scope,
  input,
  window,
  definitions = definitionsFor(scope, input),
  selection = window,
) {
  return [
    ...formattedTextEffects(
      scope,
      0,
      input,
      { ...window, selection },
      config,
      inline,
      definitions,
      true,
    ),
  ]
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
    'a\n\nb\n\n',
    '\n\nalpha\n\n\nbeta\n\n\n',
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
          runs = formattedTextRuns(effects, input, { window: range, selection })
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

test('a context window preserves blank-line boundaries before cutting the selection', () => {
  const text = 'outside\n\nfirst\n\nmiddle\n\nlast\n\noutside',
    input = inputFor(text),
    tree = parser.parse(text),
    window = { from: text.indexOf('first'), to: text.indexOf('last') + 4 },
    selection = { from: window.from + 5, to: text.indexOf('last') },
    effects = effectsFor(tree, input, window, undefined, selection),
    runs = formattedTextRuns(effects, input, { window, selection }),
    index = indexFor(text)
  assert.equal(textFor(runs, input, selection), '\nmiddle\n')
  assert.deepEqual(
    [...renderedRange(runs, selection.from, selection.to, input)],
    [...index.range(selection.from, selection.to)],
  )
})

test('a bounded context window resolves footnotes using note-wide definitions', () => {
  const text = 'prefix\n\nref [^1]\n\nnext\n\nunrelated\n\n[^1]: note',
    input = inputFor(text),
    tree = parser.parse(text),
    window = { from: 0, to: text.indexOf('next') + 4 },
    selection = {
      from: text.indexOf('ref [^1]'),
      to: text.indexOf('ref [^1]') + 8,
    },
    effects = effectsFor(tree, input, window, undefined, selection),
    runs = formattedTextRuns(effects, input, { window, selection }),
    index = indexFor(text)
  assert.ok(window.to < text.indexOf('[^1]:'))
  assert.equal(textFor(runs, input, selection), 'ref 1')
  assert.deepEqual(
    [...renderedRange(runs, selection.from, selection.to, input)],
    [...index.range(selection.from, selection.to)],
  )
})

test('hidden reference definitions keep adjoining gaps hidden outside the selection', () => {
  const text = 'before\n\n[id]: /hidden\n\nafter\n',
    input = inputFor(text),
    window = { from: 0, to: text.length },
    selection = { from: 21, to: 22 },
    effects = effectsFor(
      parser.parse(text),
      input,
      window,
      undefined,
      selection,
    ),
    runs = formattedTextRuns(effects, input, { window, selection }),
    index = indexFor(text)
  assert.equal(textFor(runs, input, selection), '')
  assert.deepEqual(
    [...renderedRange(runs, selection.from, selection.to, input)],
    [...index.range(selection.from, selection.to)],
  )
})

test('bounded selected effects retain context separators and note-wide definitions for every small range', (t) => {
  let compared = 0
  for (const text of [
    'a\n\nb\n\n',
    '\n\nalpha\n\n\nbeta\n\n\n',
    'hello **world**\n\nlast',
    '> - first\n>   **word**\n\nlast',
    '- [ ]    task\n\n- [x] next',
    '> [!NOTE] title\n> body\n\nlast',
    'ref [^1]\n\nother\n\n[^1]: note',
    'a &NotEqualTilde; b 😀\n\nlast',
    '==a &amp; b== and [[Page|Alias]]',
    '[label](url) and \x60code\x60',
    '    indented\n    code\n\nlast',
    '\x60\x60\x60\nline one\nline two\n\x60\x60\x60\n\nlast',
    '| a | **b** |\n|---|---|\n| c | d |',
    'a ![alt](pic) b\n\n---\n\nlast',
    'before\n\n[id]: /hidden\n\nafter\n',
    'before\n\n[a]: /one\n[b]: /two\n\nafter\n',
    'before\n\n[id]: /hidden\n[other]: /also-hidden\n\nafter\n',
    '# Title #\n\nnext',
    'before\n\n> [id]: /hidden\n>\n> after\n',
    'before\n\n[id]: /hidden\n\n\x60\x60\x60\ncode\n\x60\x60\x60\n',
    '[a]: /one\n\n[b]: /two\n\nlast\n',
    '> [id]: /hidden\n>\n> after\n',
    '- [id]: /hidden\n\n  after\n',
    'before\n\n[^1]: note\n\nafter',
    'before\n\n---\n\nafter\n',
    'before\n\n$$\nx\n$$\n\nafter\n',
    'before\n\n> [!NOTE]\n> body\n\nafter',
    '\x60\x60\x60\n[id]: /visible\n\x60\x60\x60\n\nlast',
  ]) {
    const input = inputFor(text),
      tree = parser.parse(text),
      definitions = definitionsFor(tree, input),
      index = indexFor(text)
    for (let from = 0; from <= text.length; from++) {
      if (!renderedBoundary(input, from)) continue
      for (let to = from; to <= text.length; to++) {
        if (!renderedBoundary(input, to)) continue
        const selection = { from, to },
          window = formattedTextWindow(tree, selection, new Set(config.literal))
        assert.ok(window, JSON.stringify({ text, selection }))
        const effects = effectsFor(tree, input, window, definitions, selection),
          runs = formattedTextRuns(effects, input, { window, selection })
        ordered(runs)
        assert.deepEqual(
          [...renderedRange(runs, from, to, input)],
          [...index.range(from, to)],
          JSON.stringify({ text, window, selection }),
        )
        compared++
      }
    }
  }
  assert.ok(compared > 2000, String(compared))
  t.diagnostic(JSON.stringify({ compared, mismatches: 0 }))
})

test('normalization refuses missing neighbour evidence and the leaf predicate retains literal definitions', () => {
  const text = 'before\n\n[id]: /hidden\n[other]: /also-hidden\n\nafter\n',
    input = inputFor(text),
    tree = parser.parse(text),
    selection = { from: 43, to: 45 }
  for (const window of [selection, { from: 8, to: text.length }])
    assert.throws(
      () =>
        formattedTextRuns(
          effectsFor(tree, input, window, undefined, selection),
          input,
          { window, selection },
        ),
      /missing neighbouring blocks/,
    )
  assert.deepEqual(formattedTextWindow(tree, selection, new Set()), {
    from: 0,
    to: text.length - 1,
  })
  const quoted = parser
    .parse('> [id]: /hidden')
    .topNode.getChild('Blockquote')
    .getChild('LinkReference')
  assert.ok(quoted)
  assert.equal(formattedTextLeafVisible(quoted, new Set()), false)
  assert.equal(
    formattedTextLeafVisible(quoted, new Set(['LinkReference'])),
    true,
  )
  assert.equal(formattedTextLeafVisible(quoted, new Set(['Blockquote'])), true)
})

test('hidden block edges keep selected chunks and provenance equal to the complete index', (t) => {
  const blocks = [
    'para **b** text\n',
    'plain\n',
    '\n',
    '\n\n',
    '[id]: /hidden\n',
    '[x]: <u> "t"\n',
    '<!-- c -->\n',
    '<!--\nmulti\n-->\n',
    '<div>\n*x*\n</div>\n',
    '[^1]: note\n',
    '\x60\x60\x60\ncode\n\x60\x60\x60\n',
    '~~~js\nc\n~~~\n',
    '$$\nx\n$$\n',
    '---\n',
    '***\n',
    '> [!NOTE] t\n> b\n',
    '| a | b |\n|---|---|\n| c | d |\n',
    '- [ ] t\n',
    '- a\n  - b\n',
    '# h #\n',
    'Title\n===\n',
    '    indented\n',
    '> q\n>\n> r\n',
    'ref [^1] x\n',
    '![i](p)\n',
    '-# small\n',
    'a %%c%% b\n',
    '<br>\n',
    '  \n',
    '\t\n',
  ]
  let seed = 1,
    compared = 0,
    refused = 0
  const random = (limit) => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return Math.floor(((seed >>> 0) / 4294967296) * limit)
  }
  for (let fixture = 0; fixture < 1500; fixture++) {
    let text = ''
    for (let at = 0, count = 2 + random(8); at < count; at++)
      text += blocks[random(blocks.length)]
    if (!random(3)) text = text.replace(/\n$/, '')
    const input = inputFor(text),
      tree = parser.parse(text),
      definitions = definitionsFor(tree, input)
    let index
    try {
      index = indexFor(text)
    } catch (error) {
      if (!(error instanceof UnsupportedRenderedFind)) throw error
      refused++
      continue
    }
    for (let range = 0; range < 8; range++) {
      const from = random(text.length + 1),
        to = Math.min(text.length, from + random(12)),
        selection = { from, to }
      if (!renderedBoundary(input, from) || !renderedBoundary(input, to))
        continue
      const window = formattedTextWindow(
        tree,
        selection,
        new Set(config.literal),
      )
      assert.ok(window, JSON.stringify({ text, selection }))
      for (const context of [window, { from: 0, to: text.length }]) {
        const effects = effectsFor(
            tree,
            input,
            context,
            definitions,
            selection,
          ),
          runs = formattedTextRuns(effects, input, {
            window: context,
            selection,
          })
        ordered(runs)
        assert.deepEqual(
          [...renderedRange(runs, from, to, input)],
          [...index.range(from, to)],
          JSON.stringify({ text, window: context, selection }),
        )
        compared++
      }
    }
  }
  assert.ok(compared > 10000, String(compared))
  t.diagnostic(JSON.stringify({ compared, refused, mismatches: 0 }))
})

test('effect order retains mask precedence and unchanged atoms remain literal', () => {
  const input = inputFor('&amp; x'),
    range = { from: 0, to: input.length }
  const atom = { kind: 'atom', from: 0, to: 5 }
  for (const kind of ['hide', 'barrier']) {
    const hidden = { kind, from: 0, to: 5 }
    const visible = formattedTextRuns([hidden, null, atom], input, {
        window: range,
        selection: range,
      }),
      erased = formattedTextRuns([atom, hidden], input, {
        window: range,
        selection: range,
      })
    ordered(visible)
    ordered(erased)
    assert.equal(textFor(visible, input, range), '& x')
    assert.equal(textFor(erased, input, range), ' x')
    assert.equal(erased[0].barrier === true, kind === 'barrier')
  }
  assert.deepEqual(
    formattedTextRuns([{ kind: 'atom', from: 0, to: 7 }], inputFor('literal'), {
      window: range,
      selection: range,
    }),
    [{ from: 0, to: 7 }],
  )
  const newline = inputFor('\n'),
    unit = { from: 0, to: 1 }
  const block = { kind: 'block', ...unit },
    space = { kind: 'atom', ...unit }
  assert.deepEqual(
    formattedTextRuns([space, block], newline, {
      window: unit,
      selection: unit,
    }),
    [{ ...unit, text: '\n', block: true }],
  )
  assert.deepEqual(
    formattedTextRuns([block, space], newline, {
      window: unit,
      selection: unit,
    }),
    [{ ...unit, text: ' ' }],
  )
})

test('bounded atom ranges retain complete envelopes and mark partial assembly imprecise', () => {
  const text = 'pre &NotEqualTilde; tail',
    input = inputFor(text),
    atom = { kind: 'atom', from: text.indexOf('&'), to: text.indexOf(';') + 1 },
    range = { from: atom.from + 2, to: atom.to - 1 },
    runs = formattedTextRuns([atom], input, {
      window: { from: 0, to: text.length },
      selection: range,
    })
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
      runs = formattedTextRuns(effects, input, {
        window: range,
        selection: range,
      })
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
  const window = { from: 0, to: text.length },
    effects = effectsFor(leaf, input, window, undefined, range),
    runs = formattedTextRuns(effects, input, {
      window,
      selection: range,
    }),
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
    tree = parser.parse(text),
    definitions = definitionsFor(tree, input)
  let readUnits = 0,
    effectCount = 0
  const read = input.read
  input.read = (from, to) => {
    readUnits += to - from
    return read(from, to)
  }
  const window = formattedTextWindow(tree, range, new Set(config.literal)),
    effects = effectsFor(tree, input, window, definitions, range),
    mask = new FormattedTextMask(input)
  for (const effect of effects)
    if (effect) {
      effectCount++
      for (const _ of mask.effect(effect, range)) {
      }
    }
  const runs = [...mask.runs(range.from, range.to)]
  assert.deepEqual(
    formattedTextRuns(effects, input, { window, selection: range }),
    runs,
  )
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
  assert.deepEqual(
    formattedTextRuns(effects, input, {
      window: { from: 0, to: length },
      selection: range,
    }),
    runs,
  )
  assert.deepEqual(runs, [{ ...range, text: '' }])
  const counters = mask.counters()
  assert.equal(counters.effectWork, 256)
  assert.ok(counters.runWork <= 320, JSON.stringify(counters))
  assert.equal(counters.maskBytes, 2048)
  assert.equal(readUnits, 2)
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
    assert.throws(
      () =>
        formattedTextRuns(effects(), input, {
          window: range,
          selection: range,
        }),
      /outside/,
    )
  for (const bounds of [
    { window: { from: 2, to: 6 }, selection: { from: 0, to: 4 } },
    { window: { from: 2, to: 4 }, selection: { from: 2, to: 6 } },
  ])
    assert.throws(() => formattedTextRuns(effects(), input, bounds), /outside/)
  assert.deepEqual(
    formattedTextRuns(effects(), input, {
      window: { from: 0, to: 6 },
      selection: { from: 2, to: 2 },
    }),
    [],
  )
  assert.equal(pulled, 0)
})
