import assert from 'node:assert/strict'
import test from 'node:test'
import { formattedTextEffects } from '../src/shared/formatted-text-effects.ts'
import { textFeatures } from '../src/shared/formatted-text-rules.ts'
import {
  boundaryInlineParser,
  boundaryParser,
} from '../src/shared/markdown-boundary-syntax.ts'
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

test('an enclosing leaf projects a deep selection without walking other blocks', (t) => {
  const count = 20000,
    text = 'block\n\n'.repeat(count)
  const parser = boundaryParser(config),
    inline = boundaryInlineParser(config)
  const tree = parser.parse(text),
    from = 19000 * 7
  const leaf = tree.resolveInner(from + 1, 1)
  assert.equal(leaf.name, 'Paragraph')
  let visited = 0,
    readUnits = 0
  const counted = new Proxy(leaf, {
    get(target, key) {
      if (key === 'cursor')
        return () =>
          new Proxy(target.cursor(), {
            get(cursor, key) {
              if (key === 'node') visited++
              const value = Reflect.get(cursor, key, cursor)
              return typeof value === 'function' ? value.bind(cursor) : value
            },
          })
      return Reflect.get(target, key, target)
    },
  })
  const input = inputFor(text),
    read = input.read
  input.read = (from, to) => {
    readUnits += to - from
    return read(from, to)
  }
  const effects = [
    ...formattedTextEffects(
      counted,
      0,
      input,
      { from, to: from + 5 },
      config,
      inline,
      new Set(),
      false,
    ),
  ]
  assert.ok(effects.some((effect) => effect?.kind === 'leaf'))
  assert.ok(visited <= 8, JSON.stringify({ visited, readUnits }))
  assert.ok(readUnits <= 4096, JSON.stringify({ visited, readUnits }))
  t.diagnostic(JSON.stringify({ blocks: count, visited, readUnits }))
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
