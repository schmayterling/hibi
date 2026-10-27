import assert from 'node:assert/strict'
import test from 'node:test'
import { countText } from '../src/addons/word-count/count.ts'
import { FormattedCounter } from '../src/addons/word-count/formatted-counter.ts'
import { richText } from '../src/addons/word-count/formatted-text.ts'
import { defaultNoteSyntax } from '../src/shared/note-syntax.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'

const syntax = {
  ...defaultNoteSyntax,
  math: true,
  textExtras: true,
  alerts: true,
}
function read(counter) {
  const work = counter.read()
  for (;;) {
    const step = work.next()
    if (step.done) return step.value
  }
}
function edit(counter, from, to, insert) {
  const source = counter.store.snapshot()
  counter.apply({
    document: source.document,
    operationId: crypto.randomUUID(),
    baseVersion: source.version,
    contentVersion: source.version + 1,
    origin: 'source',
    historyGroup: 'local-count',
    changes: [{ from, to, insert }],
  })
}
for (const size of [16 * 1024, 64 * 1024])
  for (const marked of [false, true])
    test(`local paragraph edits at ${size} units, marked=${marked}, retain counts without full reads`, (t) => {
      let source = 'ordinary words '.repeat(Math.ceil(size / 15)).slice(0, size)
      if (marked) source = `**bold** ${source} **last**`
      const counter = new FormattedCounter(
        new SourceStore(source, { tabId: 'local', revision: 0 }),
        syntax,
      )
      t.after(() => counter.dispose())
      assert.deepEqual(
        read(counter),
        countText(richText(source, syntax).slice(1)),
      )
      const at = size / 2
      counter.counters(true)
      edit(counter, at, at, ' y ')
      source = `${source.slice(0, at)} y ${source.slice(at)}`
      assert.deepEqual(
        read(counter),
        countText(richText(source, syntax).slice(1)),
      )
      const work = counter.counters()
      console.log(JSON.stringify({ size, work }))
      assert.ok(work.countedUnits < 1024, JSON.stringify(work))
      assert.ok(work.referenceUnits < 1024, JSON.stringify(work))
      assert.ok(work.source.sourceUnitsRead < 4096, JSON.stringify(work))
      assert.equal(work.source.materializations, 0)
      assert.equal(work.source.materializedUnits, 0)
      assert.equal(work.parser.parser.readUnits, 0)
      edit(counter, at, at + 3, '')
      source = `${source.slice(0, at)}${source.slice(at + 3)}`
      assert.deepEqual(
        read(counter),
        countText(richText(source, syntax).slice(1)),
      )
      // a syntax edit must reconcile every previously skipped parser generation.
      edit(counter, at, at, '**bold**')
      source = `${source.slice(0, at)}**bold**${source.slice(at)}`
      assert.deepEqual(
        read(counter),
        countText(richText(source, syntax).slice(1)),
      )
    })

test('paragraph-prefix punctuation edits can create ordered list ownership', (t) => {
  for (const [initial, from, to, insert] of [
    ['1 words', 1, 1, '.'],
    ['1 words', 1, 1, ')'],
    ['12.3 words', 3, 4, ''],
    ['words more', 0, 0, ' '],
    ['words more', 0, 0, '    '],
    ['x1. a', 0, 1, ''],
    ['1234567890. a', 0, 1, ''],
    ['. a', 0, 0, '1'],
    ['1', 1, 1, ')'],
    ['x word', 0, 1, ''],
    ['x\u00a0word', 0, 1, ''],
    ['[a]: /url\nfoo"', 10, 10, '"'],
    ['[a]: /url\n"foo', 14, 14, '"'],
  ]) {
    const counter = new FormattedCounter(
      new SourceStore(initial, { tabId: 'ordered-prefix', revision: 0 }),
      syntax,
    )
    t.after(() => counter.dispose())
    assert.deepEqual(
      read(counter),
      countText(richText(initial, syntax).slice(1)),
    )
    edit(counter, from, to, insert)
    const changed = initial.slice(0, from) + insert + initial.slice(to)
    assert.deepEqual(
      read(counter),
      countText(richText(changed, syntax).slice(1)),
      changed,
    )
    edit(counter, from, from + insert.length, initial.slice(from, to))
    assert.deepEqual(
      read(counter),
      countText(richText(initial, syntax).slice(1)),
    )
  }
})

test('local summaries retain unicode boundaries, bursts, neighbors and syntax invalidation', (t) => {
  for (const phrase of [
    'café 👩🏽‍💻 ordinary words ',
    '中文 ordinary words ',
    'à  🇵🇭 ordinary words ',
  ]) {
    let source = `# heading\r\n\r\n${phrase.repeat(1000)}end\r\n\r\n[label][ref]\r\n\r\n[ref]: old`
    const counter = new FormattedCounter(
      new SourceStore(source, { tabId: 'unicode', revision: 0 }),
      syntax,
    )
    t.after(() => counter.dispose())
    const expected = () => countText(richText(source, syntax).slice(1))
    assert.deepEqual(read(counter), expected())
    for (const insert of [
      ' y ',
      'z',
      '.',
      'www.',
      '👩🏽‍💻',
      'é',
      '[ref]',
      '\r\n\r\n',
      '$$',
    ]) {
      const at = source.indexOf('ordinary', source.length / 2) + 2
      edit(counter, at, at + 2, insert)
      source = `${source.slice(0, at)}${insert}${source.slice(at + 2)}`
      // two edits before a read exercise pending summary accumulation.
      edit(counter, at + insert.length, at + insert.length, 'next ')
      source = `${source.slice(0, at + insert.length)}next ${source.slice(at + insert.length)}`
      assert.deepEqual(
        read(counter),
        expected(),
        JSON.stringify({ phrase, insert }),
      )
    }
  }
})

test('local count windows preserve word and grapheme context across inline syntax', (t) => {
  for (const [initial, marker, offset] of [
    ['**word**\u0301x', '\u0301', 1],
    ['x\u0301**word**', '\u0301', 0],
    ['`word`\u0301x', '\u0301', 1],
    ['**👩**\u200d💻x', '\u200d', 1],
  ]) {
    const counter = new FormattedCounter(
      new SourceStore(initial, { tabId: 'inline-boundary', revision: 0 }),
      syntax,
    )
    t.after(() => counter.dispose())
    assert.deepEqual(
      read(counter),
      countText(richText(initial, syntax).slice(1)),
    )
    const from = initial.indexOf(marker) + offset
    edit(counter, from, from, ' ')
    const changed = `${initial.slice(0, from)} ${initial.slice(from)}`
    assert.deepEqual(
      read(counter),
      countText(richText(changed, syntax).slice(1)),
      changed,
    )
    edit(counter, from, from + 1, '')
    assert.deepEqual(
      read(counter),
      countText(richText(initial, syntax).slice(1)),
    )
  }
})

for (const size of [16 * 1024, 64 * 1024])
  for (const edge of [
    'start',
    'end',
    'marked-end',
    'end-newline',
    'end-neighbor',
  ])
    test(`ordinary paragraph ${edge} edits stay local at ${size} units`, (t) => {
      const body = 'ordinary words '.repeat(Math.ceil(size / 15)).slice(0, size)
      const initial =
        edge === 'marked-end'
          ? `**bold** ${body}`
          : edge === 'end-newline'
            ? `${body}\n`
            : edge === 'end-neighbor'
              ? `${body}\n\nnext`
              : body
      const at =
        edge === 'start'
          ? 0
          : edge.startsWith('end-')
            ? body.length
            : initial.length
      const counter = new FormattedCounter(
        new SourceStore(initial, { tabId: 'endpoint', revision: 0 }),
        syntax,
      )
      t.after(() => counter.dispose())
      const expected = (source) => countText(richText(source, syntax).slice(1))
      const changed = `${initial.slice(0, at)}z${initial.slice(at)}`
      assert.deepEqual(read(counter), expected(initial))
      const burst = `${initial.slice(0, at)}zq${initial.slice(at)}`
      for (const [from, to, insert, source] of [
        [at, at, 'z', changed],
        [at + 1, at + 1, 'q', burst],
        [at, at + 2, '', initial],
      ]) {
        counter.counters(true)
        edit(counter, from, to, insert)
        const result = read(counter)
        const work = counter.counters()
        assert.deepEqual(result, expected(source))
        assert.ok(work.countedUnits < 1024, JSON.stringify(work))
        assert.ok(work.source.sourceUnitsRead < 4096, JSON.stringify(work))
        assert.equal(work.referenceUnits, 0)
        assert.equal(work.source.materializations, 0)
        assert.equal(work.parser.parser.readUnits, 0)
      }
      const insert = edge === 'start' ? '# ' : '**bold**'
      edit(counter, at, at, insert)
      assert.deepEqual(
        read(counter),
        expected(`${initial.slice(0, at)}${insert}${initial.slice(at)}`),
      )
    })

test('endpoint summaries reconcile cancelled parsing and syntax undo', (t) => {
  const initial = `# head\n\n${'ordinary words '.repeat(1100)}\n\nlast`
  const at = initial.lastIndexOf('\n\nlast')
  const counter = new FormattedCounter(
    new SourceStore(initial, { tabId: 'endpoint-cancel', revision: 0 }),
    syntax,
  )
  t.after(() => counter.dispose())
  read(counter)
  edit(counter, at, at, 'z')
  const changed = `${initial.slice(0, at)}z${initial.slice(at)}`
  edit(counter, at + 1, at + 1, '**bold**')
  const work = counter.read()
  assert.equal(work.next().done, false)
  work.return()
  edit(counter, at + 1, at + 9, '')
  assert.deepEqual(read(counter), countText(richText(changed, syntax).slice(1)))
  edit(counter, at, at + 1, '')
  assert.deepEqual(read(counter), countText(richText(initial, syntax).slice(1)))
})

test('endpoint ownership and pending totals stay independent across streams', (t) => {
  const initial = 'ordinary words '.repeat(1100)
  const counters = ['first', 'second'].map((tabId) => {
    const counter = new FormattedCounter(
      new SourceStore(initial, { tabId, revision: 0 }),
      syntax,
    )
    t.after(() => counter.dispose())
    read(counter)
    return counter
  })
  edit(counters[0], initial.length, initial.length, 'one')
  edit(counters[1], 0, 0, 'two ')
  edit(counters[0], initial.length + 3, initial.length + 3, ' more')
  assert.deepEqual(
    read(counters[0]),
    countText(richText(`${initial}one more`, syntax).slice(1)),
  )
  assert.deepEqual(
    read(counters[1]),
    countText(richText(`two ${initial}`, syntax).slice(1)),
  )
})
