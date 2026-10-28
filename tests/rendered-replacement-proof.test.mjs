import assert from 'node:assert/strict'
import test from 'node:test'
import { boundaryParser } from '../src/shared/markdown-boundary-syntax.ts'
import { renderedReplaceEdits } from '../src/shared/rendered-replace.ts'
import { RenderedTextIndex } from '../src/shared/rendered-text.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'
import { searchRenderedLiteral } from '../src/shared/source-rendered-search.ts'
import { renderedConfig } from './rendered-config.mjs'

const finish = (work) => {
  for (;;) {
    const next = work.next()
    if (next.done) return next.value
  }
}
function build(text) {
  const store = new SourceStore(text, { tabId: 'proof', revision: 0 })
  const index = new RenderedTextIndex(store.snapshot(), 0, renderedConfig)
  finish(index.build())
  return index
}
const render = (index, from = 0, to = index.length) =>
  [...index.range(from, to)].map((chunk) => chunk.text).join('')
function replace(index, match, value) {
  const plan = finish(index.prepareReplacement(match, value))
  assert.equal(
    renderedReplaceEdits(match, value),
    null,
    'unverified plans cannot be applied',
  )
  const edits = renderedReplaceEdits(match, value, plan)
  if (!edits) return null
  let text = index.text(0, index.length)
  for (const edit of [...edits].reverse())
    text = text.slice(0, edit.from) + edit.insert + text.slice(edit.to)
  assert.equal(
    render(build(text)),
    render(index, 0, match.from) + value + render(index, match.to),
    JSON.stringify({
      source: index.text(0, index.length),
      query: match,
      value,
      text,
    }),
  )
  return text
}
test('replacement reparse rejects changed structure and preserves literal spellings when safe', () => {
  for (const [source, query, value] of [
    ['- a\n- b', 'a\nb', 'X'],
    ['> quoted\n> more', 'quoted more', 'one'],
    ['foo end\n# Heading', 'end\n', ''],
    ['2 * 3 * 4', ' 3 ', '3'],
    ['**Hello**world', 'Hello', 'Hi.'],
    ['first line\nsecond', 'first', '    code'],
    ['say **hello** now', 'hello', ' hi'],
    ['say **hello** now', 'hello', 'hello '],
  ]) {
    const index = build(source)
    const [match] = [...searchRenderedLiteral(index, query)].flatMap(
      (batch) => batch.matches,
    )
    assert.ok(match, JSON.stringify([source, query]))
    replace(index, match, value)
  }
  for (const source of [
    'TARGET tail',
    'midTARGETword',
    '[TARGET tail](url)',
    '\x60TARGET tail\x60',
  ]) {
    for (const value of [
      'snake_case',
      '#tag',
      '-1',
      '+1',
      '1.5 kg',
      '2 * 3',
      '$5',
    ]) {
      const index = build(source),
        [match] = [...searchRenderedLiteral(index, 'TARGET')].flatMap(
          (batch) => batch.matches,
        )
      const result = replace(index, match, value)
      assert.equal(
        result,
        source.replace('TARGET', value),
        source + ':' + value,
      )
    }
  }
})
test('replacement proof preserves the leaf block kind of surrounding text', () => {
  const parser = boundaryParser(renderedConfig)
  const leafAt = (source, position) => {
    let node = parser.parse(source).resolveInner(position, 1)
    while (node && !node.type.is('LeafBlock')) node = node.parent
    return node?.name
  }
  for (const source of ['before TARGET after', 'TARGET tail']) {
    const tail = source.endsWith('after') ? 'after' : 'tail'
    for (const value of ['\n<div>\n', '\n<section>\n']) {
      const index = build(source)
      const [match] = [...searchRenderedLiteral(index, 'TARGET')].flatMap(
        (batch) => batch.matches,
      )
      const plan = finish(index.prepareReplacement(match, value))
      if (!plan.edits) continue
      let result = source
      for (const edit of [...plan.edits].reverse())
        result =
          result.slice(0, edit.from) + edit.insert + result.slice(edit.to)
      assert.equal(
        leafAt(result, result.lastIndexOf(tail)),
        leafAt(source, source.lastIndexOf(tail)),
        JSON.stringify({ source, value, result }),
      )
    }
  }
})

test('seeded replacement corpus either proves intended rendered text or refuses', (t) => {
  let seed = 1,
    checked = 0,
    refused = 0
  const random = (n) => {
    seed ^= seed << 13
    seed >>>= 0
    seed ^= seed >>> 17
    seed ^= seed << 5
    seed >>>= 0
    return Math.floor((seed / 4294967296) * n)
  }
  const pick = (values) => values[random(values.length)]
  const tokens = [
    'a',
    'b',
    'c',
    'word',
    ' ',
    ' ',
    ' ',
    '*',
    '**',
    '_',
    '__',
    '~~',
    '\x60',
    '[',
    '](u)',
    '&amp;',
    '\\*',
    '\n',
    '\n\n',
    '- ',
    '# ',
    '> ',
    '1. ',
    '!',
    '<',
    '>',
    'x_y',
    '***',
  ]
  const values = [
    '',
    'X',
    'a b',
    '*',
    '_',
    '**',
    'x_y',
    '\x60',
    '\x60\x60',
    '#',
    '- ',
    '1.',
    '[',
    ']',
    '<',
    '&amp;',
    '\\',
    '!',
    'a*b',
    ' ',
    '~~',
    '$',
    '==',
    'snake_case',
  ]
  for (
    let iter = 0;
    iter < Number(process.env.HIBI_REPLACE_CASES ?? 20000);
    iter++
  ) {
    let source = ''
    const count = 2 + random(10)
    for (let at = 0; at < count; at++) source += pick(tokens)
    const index = build(source)
    const parts = [...index.runs()]
      .map((run) =>
        run.barrier ? '\u0000' : (run.text ?? index.text(run.from, run.to)),
      )
      .join('')
      .split('\u0000')
      .filter(Boolean)
    if (!parts.length) continue
    const text = pick(parts)
    const from = random(text.length),
      to = from + 1 + random(Math.min(6, text.length - from))
    const query = text.slice(from, to)
    if (!query.trim()) continue
    const matches = [
      ...searchRenderedLiteral(index, query, { caseSensitive: true }),
    ].flatMap((batch) => batch.matches)
    assert.ok(matches.length, JSON.stringify({ source, query, text }))
    const match = pick(matches),
      value = pick(values)
    const output = replace(index, match, value)
    if (output === null) refused++
    else checked++
  }
  assert.ok(checked)
  assert.ok(refused)
  t.diagnostic(JSON.stringify({ seed: 1, checked, refused, mismatches: 0 }))
})
