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
      // A syntax edit must reconcile every previously skipped parser generation.
      edit(counter, at, at, '**bold**')
      source = `${source.slice(0, at)}**bold**${source.slice(at)}`
      assert.deepEqual(
        read(counter),
        countText(richText(source, syntax).slice(1)),
      )
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
      '👩🏽‍💻',
      'é',
      '[ref]',
      '\r\n\r\n',
      '$$',
    ]) {
      const at = source.indexOf('ordinary', source.length / 2) + 2
      edit(counter, at, at + 2, insert)
      source = `${source.slice(0, at)}${insert}${source.slice(at + 2)}`
      // Two edits before a read exercise pending summary accumulation.
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
