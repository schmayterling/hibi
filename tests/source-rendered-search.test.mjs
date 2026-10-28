import assert from 'node:assert/strict'
import test from 'node:test'
import { RenderedTextIndex } from '../src/shared/rendered-text.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'
import { searchRenderedLiteral } from '../src/shared/source-rendered-search.ts'
import { SourceSearchIndex } from '../src/shared/source-search-index.ts'
import { renderedConfig } from './rendered-config.mjs'

function finish(work) {
  for (;;) {
    const step = work.next()
    if (step.done) return step.value
  }
}
function fixture(text, query) {
  const source = new SourceStore(text, { tabId: 'rendered-index', revision: 0 })
  const projection = new RenderedTextIndex(source.snapshot(), 0, renderedConfig)
  const index = new SourceSearchIndex(source.snapshot(), query, {}, projection)
  finish(index.build())
  return { source, projection, index }
}

test('normalized query validation happens before projection work', () => {
  const source = new SourceStore('ordinary note', {
    tabId: 'find-limit',
    revision: 0,
  })
  const projection = new RenderedTextIndex(source.snapshot(), 0, renderedConfig)
  const index = new SourceSearchIndex(
    source.snapshot(),
    'ﬃ'.repeat(32768),
    {},
    projection,
  )
  assert.throws(() => finish(index.build()), /Normalized find text exceeds/)
  assert.equal(projection.counters().operations, 0)
})

test('rendered current index uses the exact source envelope', () => {
  const { index } = fixture('hello **world** hello world', 'hello world')
  const match = index.state().first.match
  assert.deepEqual(match.segments, [
    { from: 0, to: 6 },
    { from: 8, to: 13 },
  ])
  assert.equal(finish(index.locate(match.from, match.to)).current, 1)
  assert.equal(finish(index.locate(0, 6)).current, 0)
  assert.equal(finish(index.locate(0, 0)).next.rank, 1)
  assert.equal(finish(index.locate(14, 14)).next.rank, 2)
})

test('dense rendered highlights page through existing restart checkpoints', (t) => {
  const count = 20000
  const { index, projection, source } = fixture('x**y** '.repeat(count), 'xy')
  assert.equal(index.state().total, count)
  const before = projection.counters()
  let from = 7 * 11000,
    seen = 0,
    pages = 0
  source.counters(true)
  do {
    const page = finish(index.highlights({ from, to: 7 * 12000, limit: 128 }))
    assert.ok(page.matches.length <= 128)
    for (const match of page.matches) {
      assert.equal(match.from, 7 * (11000 + seen))
      assert.deepEqual(match.segments, [
        { from: match.from, to: match.from + 1 },
        { from: match.from + 3, to: match.from + 4 },
      ])
      seen++
    }
    pages++
    from = page.next
  } while (from !== null)
  assert.equal(seen, 1000)
  assert.equal(pages, 8)
  assert.equal(
    projection.counters().parses,
    before.parses,
    'paging reuses parsed projection',
  )
  assert.ok(
    source.counters().sourceUnitsRead < 512 * 1024,
    JSON.stringify(source.counters()),
  )
  assert.equal(source.counters().materializations, 0)
  t.diagnostic(
    JSON.stringify({
      pages,
      matches: seen,
      sourceUnitsRead: source.counters().sourceUnitsRead,
    }),
  )
})

test('rendered restart checkpoints retain phrases across long hidden link destinations', () => {
  const { index, projection } = fixture(
    'hello [world](https://example.test/' + 'a'.repeat(65536) + ') again',
    'world again',
  )
  const [match] = [...searchRenderedLiteral(projection, 'world again')].flatMap(
    (batch) => batch.matches,
  )
  assert.equal(index.state().total, 1)
  const page = finish(index.highlights({ from: match.to - 3, to: match.to }))
  assert.equal(page.matches.length, 1)
  const { containers, context, ...envelope } = match
  assert.deepEqual(page.matches[0], envelope)
})

test('50 mib rendered projection yields bounded reads and retains source ranges without flattening', (t) => {
  const length = 50 * 1024 * 1024
  const text = 'hello **world**\n\n' + 'a'.repeat(length)
  const store = new SourceStore(text, { tabId: 'rendered-scale', revision: 0 })
  store.counters(true)
  const projection = new RenderedTextIndex(store.snapshot(), 0, renderedConfig)
  let turns = 0
  for (const _step of projection.build()) {
    const counters = projection.counters()
    assert.ok(counters.maximumStep <= 2048)
    assert.ok(counters.maximumRead <= 4096)
    turns++
  }
  assert.ok(turns > length / 2048)
  const counters = projection.counters()
  assert.equal(counters.plainTailUnits, length)
  assert.ok(counters.maximumYieldRead <= 8192, JSON.stringify(counters))
  assert.ok(counters.maximumAdvanceRead <= 128 * 1024, JSON.stringify(counters))
  assert.ok(counters.maskBytes <= 4096)
  assert.equal(counters.retainedWindows, 0)
  assert.equal(counters.retainedNodes, 0)
  assert.ok(counters.parses <= 3)
  assert.ok(counters.sourceUnits < text.length * 8, JSON.stringify(counters))
  const index = new SourceSearchIndex(
    store.snapshot(),
    'hello world',
    {},
    projection,
  )
  finish(index.build())
  assert.equal(index.state().total, 1)
  const coldParses = projection.counters().parses
  finish(index.locate(0, 0))
  assert.equal(projection.counters().parses, coldParses + 1)
  const parseWork = projection.counters()
  finish(index.locate(0, 0))
  const nextQuery = new SourceSearchIndex(
    store.snapshot(),
    'world',
    {},
    projection,
  ).build()
  nextQuery.next()
  nextQuery.return()
  assert.equal(projection.counters().parses, parseWork.parses)
  assert.equal(store.counters().materializations, 0)
  t.diagnostic(JSON.stringify({ length: text.length, turns, ...counters }))
})

test('rendered find includes phrases split by hidden emphasis', () => {
  const text = 'hello **world**\n\nhello world\n\nHELLO world'
  const source = new SourceStore(text, { tabId: 'rendered-find', revision: 0 })
  const rendered = new SourceSearchIndex(
    source.snapshot(),
    'hello world',
    {},
    new RenderedTextIndex(source.snapshot(), 0, renderedConfig),
  )
  for (const _step of rendered.build()) {
  }
  assert.equal(rendered.state().total, 3)
  const raw = new SourceSearchIndex(source.snapshot(), 'hello world')
  for (const _step of raw.build()) {
  }
  assert.equal(raw.state().total, 2)
})
