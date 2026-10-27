import assert from 'node:assert/strict'
import test from 'node:test'
import { GFM, parser } from '@lezer/markdown'
import { decodeHTMLStrict } from 'entities'
import { RenderedTextIndex } from '../src/shared/rendered-text.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'
import { renderedConfig } from './rendered-config.mjs'

const project = (text) => {
  const source = new SourceStore(text, { tabId: 'projection', revision: 0 })
  const index = new RenderedTextIndex(source.snapshot(), 0, renderedConfig)
  for (const _step of index.build()) {
  }
  return [...index.range(0, index.length)]
    .map((run) => run.text ?? index.text(run.from, run.to))
    .join('')
}
function oracle(text) {
  const edits = []
  parser
    .configure(GFM)
    .parse(text)
    .iterate({
      enter(node) {
        if (/^(EmphasisMark|StrikethroughMark|CodeMark)$/.test(node.name))
          edits.push({ from: node.from, to: node.to, insert: '' })
        if (node.name === 'Escape')
          edits.push({
            from: node.from,
            to: node.to,
            insert: text.slice(node.to - 1, node.to),
          })
        if (node.name === 'Entity')
          edits.push({
            from: node.from,
            to: node.to,
            insert: decodeHTMLStrict(text.slice(node.from, node.to)),
          })
      },
    })
  let result = text
  for (const edit of edits.sort((a, b) => b.from - a.from))
    result = result.slice(0, edit.from) + edit.insert + result.slice(edit.to)
  return result
}

test('inline delimiter projection agrees with the commonmark and gfm baseline on a small exhaustive corpus', () => {
  const parts = [
    'a',
    ' ',
    '.',
    '*',
    '**',
    '***',
    '_',
    '__',
    '~',
    '~~',
    '`',
    '\\*',
    '&amp;',
  ]
  let checked = 0
  for (const left of parts)
    for (const right of parts)
      for (const content of ['word', 'a b', '*b*', 'a_b', 'b!']) {
        const text = 'prefix ' + left + content + right + ' suffix'
        assert.equal(project(text), oracle(text), JSON.stringify(text))
        checked++
      }
  assert.equal(checked, 845)
})

test('pure range assembly uses separators only at supplied semantic block boundaries', async () => {
  const { renderedRange } = await import('../src/shared/rendered-text.ts')
  const source = 'hello\n\n`world`'
  const runs = [
    { from: 0, to: 5 },
    { from: 5, to: 7, block: true },
    { from: 8, to: 13 },
  ]
  const read = {
    length: source.length,
    read: (from, to) => source.slice(from, to),
  }
  for (const [options, expected] of [
    [{}, 'hello\n\nworld'],
    [{ blockSeparator: '\n' }, 'hello\nworld'],
    [{ blockSeparator: '' }, 'helloworld'],
  ]) {
    const chunks = [...renderedRange(runs, 0, source.length, read, options)]
    assert.equal(chunks.map((chunk) => chunk.text).join(''), expected)
    assert.deepEqual(
      chunks.map(({ from, to }) => [from, to]),
      [
        [0, 5],
        [5, 7],
        [8, 13],
      ],
    )
  }
  assert.equal(
    [
      ...renderedRange(
        [{ from: 0, to: source.length }],
        0,
        source.length,
        read,
        { blockSeparator: '' },
      ),
    ]
      .map((chunk) => chunk.text)
      .join(''),
    source,
    'soft breaks are not semantic block boundaries',
  )
})

test('pure range rejects invalid bounds and partial unicode scalars', async () => {
  const { renderedRange } = await import('../src/shared/rendered-text.ts')
  const text = 'a😀b'
  const runs = [{ from: 0, to: text.length }]
  const input = {
    length: text.length,
    read: (from, to) => text.slice(from, to),
  }
  for (const [from, to] of [
    [3, 2],
    [NaN, 2],
    [0, Infinity],
    [-1, 2],
    [0, 5],
    [2, 3],
    [0, 2],
  ])
    assert.throws(
      () => [...renderedRange(runs, from, to, input)],
      `${from}:${to}`,
    )
})

test('bounded source ranges stream rendered text with source provenance', () => {
  const source = 'prefix **bold** &amp; tail' + 'x'.repeat(20000)
  const store = new SourceStore(source, { tabId: 'range', revision: 0 })
  const index = new RenderedTextIndex(store.snapshot(), 0, renderedConfig)
  for (const _step of index.build()) {
  }
  store.counters(true)
  assert.deepEqual(
    [...index.range(7, 20)],
    [
      { from: 9, to: 13, text: 'bold', precise: true },
      { from: 15, to: 16, text: ' ', precise: true },
      { from: 16, to: 20, text: '&', precise: false },
    ],
  )
  assert.deepEqual(
    [...index.range(17, 21)],
    [{ from: 17, to: 21, text: '&', precise: false }],
  )
  assert.deepEqual(
    [...index.range(16, 21)],
    [{ from: 16, to: 21, text: '&', precise: true }],
  )
  assert.deepEqual(
    [...index.range(10, 12)],
    [{ from: 10, to: 12, text: 'ol', precise: true }],
  )
  const chunks = [...index.range(21, source.length)]
  assert.equal(chunks.map((chunk) => chunk.text).join(''), source.slice(21))
  assert.ok(chunks.every((chunk) => chunk.to - chunk.from <= 4096))
  assert.equal(store.counters().materializations, 0)
  assert.throws(() => [...index.range(-1, 10)])
  assert.throws(() => [...index.range(10, source.length + 1)])
  assert.deepEqual([...index.range(10, 10)], [])
  store.counters(true)
  assert.deepEqual(
    [...index.range(source.length - 2, source.length)],
    [{ from: source.length - 2, to: source.length, text: 'xx', precise: true }],
  )
  // Two source units plus constant scalar/CRLF boundary checks.
  assert.ok(store.counters().sourceUnitsRead <= 4096)

  const unicode = new RenderedTextIndex(
    new SourceStore('x'.repeat(4095) + '😀z', {
      tabId: 'range-unicode',
      revision: 0,
    }).snapshot(),
    0,
    renderedConfig,
  )
  for (const _step of unicode.build()) {
  }
  assert.deepEqual(
    [...unicode.range(0, 4098)].map((chunk) => chunk.text.length),
    [4095, 3],
  )
  assert.throws(() => [...unicode.range(4096, 4098)])
})

test('links and code honor source-order precedence and quoted destinations', () => {
  for (const [source, expected] of [
    ['hello [world](url`x) `end', 'hello world `end'],
    ['hello `[world](url` end', 'hello [world](url end'],
    ['hello [a `]` world](url)', 'hello a ] world'],
    ['[outer [inner](url)](out`x) `end', '[outer inner](outx) end'],
    [
      '[outer `[inner](fake)` label](out`x) `end',
      'outer [inner](fake) label `end',
    ],
    ['hello [world](url "title ) here")', 'hello world'],
    ['hello [world](url "(")', 'hello world'],
    ['hello [world]( "a title")', 'hello world( "a title")'],
    ['hello [world](url (title here))', 'hello world'],
    ['hello [world](url "" junk)', 'hello world(url "" junk)'],
    ['hello [world](ur<l>)', 'hello world'],
  ])
    assert.equal(project(source), expected, source)
})

test('inline marks do not pair across block or list boundaries', () => {
  for (const [source, expected] of [
    ['*first\n- last*', '*first\nlast*'],
    ['*first\n# last*', '*first\nlast*'],
    ['*first\n\nlast*', '*first\nlast*'],
  ])
    assert.equal(project(source), expected, source)
})

test('rendered text leaves malformed syntax literal and decodes only prose atoms', () => {
  for (const [source, expected] of [
    ['a **word', 'a **word'],
    ['a [word](unfinished', 'a word(unfinished'],
    ['a [word](https://example.test "title") b', 'a word b'],
    ['a [word](https://example.test/a_(b)) b', 'a word b'],
    ['a `&amp; \\*` b', 'a &amp; \\* b'],
    ['a &#x1F600; b', 'a 😀 b'],
    ['a ![**image** `code` &amp;](url) b', 'a  b'],
  ])
    assert.equal(project(source), expected, source)
})
