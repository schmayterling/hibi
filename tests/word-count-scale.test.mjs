import assert from 'node:assert/strict'
import test from 'node:test'
import { FormattedCounter } from '../src/addons/word-count/formatted-counter.ts'
import { defaultNoteSyntax } from '../src/shared/note-syntax.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'

test('a local edit in 50 MiB recounts bounded regions without flattening the document', {
  timeout: 180000,
}, () => {
  const unit = 'x'.repeat(1022) + '\n\n'
  const paragraphs = 50 * 1024
  const store = new SourceStore(unit.repeat(paragraphs), {
    tabId: 'large-counts',
    revision: 0,
  })
  const counter = new FormattedCounter(store, defaultNoteSyntax)
  const read = () => {
    const work = counter.read()
    for (;;) {
      const step = work.next()
      if (step.done) return step.value
    }
  }
  try {
    const initial = read()
    assert.equal(initial.words, paragraphs)
    counter.counters(true)
    const before = store.snapshot()
    const at = unit.length * (paragraphs / 2) + 512
    counter.apply({
      document: before.document,
      operationId: 'scale-edit',
      baseVersion: 0,
      contentVersion: 1,
      origin: 'source',
      historyGroup: 'scale-edit',
      changes: [{ from: at, to: at, insert: ' y ' }],
    })
    const changed = read()
    assert.equal(changed.words, initial.words + 2)
    assert.equal(changed.characters, initial.characters + 3)
    const work = counter.counters()
    console.log(
      JSON.stringify({
        countedRegions: work.countedRegions,
        countedUnits: work.countedUnits,
        referenceUnits: work.referenceUnits,
        source: work.source,
        parser: work.parser,
      }),
    )
    assert.ok(work.countedRegions <= 5)
    assert.ok(work.countedUnits < 8192)
    assert.ok(work.referenceUnits < 8192)
    assert.equal(work.source.materializations, 0)
    assert.equal(work.source.materializedUnits, 0)
    assert.ok(work.source.sourceUnitsRead < 16384)
    assert.ok(work.parser.nodesVisited < 32)
  } finally {
    counter.dispose()
  }
})
