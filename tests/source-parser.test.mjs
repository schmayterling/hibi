import assert from 'node:assert/strict'
import test from 'node:test'
import { GFM, parser } from '@lezer/markdown'
import { SourceStore } from '../src/shared/source-buffer.ts'
import {
  SourceParserSession,
  sourceParserInput,
} from '../src/shared/source-parser.ts'
import { normalizedSource } from '../src/shared/source-projection.ts'

const treeShape = (tree) => {
  const result = []
  tree.iterate({
    enter: (node) => {
      result.push([node.name, node.from, node.to])
    },
  })
  return result
}
const finish = (session) => {
  for (let count = 0; count < 1_000_000; count++) {
    const state = session.advance()
    if (state.complete) return state.tree
  }
  throw new Error('Parser did not converge.')
}
const edit = (store, changes) => {
  const before = store.snapshot()
  const prepared = store.prepare({
    document: before.document,
    operationId: crypto.randomUUID(),
    baseVersion: before.version,
    contentVersion: before.version + 1,
    origin: 'source',
    historyGroup: 'test',
    changes,
  })
  store.commit(prepared)
  return prepared
}

test('ENG13: normalized snapshot Input returns complete lines at every UTF-16 coordinate', () => {
  for (const source of [
    '',
    '\uFEFFa\r\nb😀\nc\rd\r\n',
    '\r\n\r\n',
    '😀\rlast',
  ]) {
    const normalized = normalizedSource(source)
    const store = new SourceStore(source, { tabId: 'input', revision: 0 }, 0, {
      chunkUnits: 4,
      leafCapacity: 4,
      fanout: 4,
    })
    const input = sourceParserInput(store.snapshot())
    assert.equal(input.lineChunks, true)
    assert.equal(input.length, normalized.length)
    for (let from = 0; from <= input.length; from++) {
      const end = normalized.indexOf('\n', from)
      assert.equal(
        input.chunk(from),
        from === end
          ? '\n'
          : normalized.slice(from, end < 0 ? input.length : end),
      )
      for (let to = from; to <= input.length; to++)
        assert.equal(input.read(from, to), normalized.slice(from, to))
    }
    for (const value of [-1, NaN, Infinity, 0.5, input.length + 1]) {
      assert.throws(() => input.chunk(value), /outside/)
      assert.throws(() => input.read(value, input.length), /outside/)
      assert.throws(() => input.read(0, value), /outside/)
    }
    if (input.length) assert.throws(() => input.read(1, 0), /outside/)
  }
})

test('long physical lines keep exact Markdown trees across source edits', () => {
  const long = 'word 😀 '.repeat(900)
  for (const ending of ['\n', '\r\n', '\r']) {
    for (const text of [
      '# ' + long,
      '```md\n' + long + '\n```\n\n# after',
      'first\n' + long + '\nlast\n\n# after',
    ]) {
      const source = text.replaceAll('\n', ending)
      for (const dialect of [parser, parser.configure(GFM)]) {
        const store = new SourceStore(source, {
          tabId: 'long-lines',
          revision: 0,
        })
        const session = new SourceParserSession(
          store.snapshot(),
          dialect,
          'test',
        )
        try {
          const compare = () =>
            assert.deepEqual(
              treeShape(finish(session)),
              treeShape(
                dialect.parse(normalizedSource(store.snapshot().materialize())),
              ),
              JSON.stringify({ ending, start: text.slice(0, 6) }),
            )
          compare()
          let at = 4096
          while (!store.snapshot().isEditBoundary(at)) at++
          const insert = ending + '# inserted' + ending
          session.apply(edit(store, [{ from: at, to: at, insert }]))
          compare()
          session.apply(
            edit(store, [{ from: at, to: at + insert.length, insert: '' }]),
          )
          compare()
        } finally {
          session.dispose()
        }
      }
    }
  }
})

test('line chunks report long reads without materializing a multiline document', () => {
  const source = ['# title', 'x'.repeat(8193), 'tail'].join('\r\n')
  const store = new SourceStore(source, { tabId: 'line-work', revision: 0 })
  const session = new SourceParserSession(
    store.snapshot(),
    parser,
    'commonmark',
  )
  store.counters(true)
  try {
    finish(session)
    assert.equal(session.counters().maximumRead, 8193)
    assert.ok(session.counters().readUnits <= source.length)
    assert.equal(store.counters().materializations, 0)
    assert.equal(store.counters().materializedUnits, 0)
  } finally {
    session.dispose()
  }
})

test('ENG14: incremental Markdown trees match full dialect parsers through adversarial source changes', () => {
  let seed = 90411
  const random = (max) => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return (seed >>> 0) % max
  }
  const fragments = [
    '# heading\r\n',
    '```js\n',
    '```\n',
    '<div>\n',
    '</div>\n',
    '- item\n  continuation\n',
    '[id]: /url\n',
    '[link][id]\n',
    '| a | b |\n|---|---|\n| c | d |\n',
    '$math$',
    '😀',
    '\r\n',
    '\n',
    ' ',
  ]
  for (const dialect of [parser, parser.configure(GFM)]) {
    const store = new SourceStore(fragments.join(''), {
      tabId: 'parser',
      revision: 0,
    })
    const session = new SourceParserSession(
      store.snapshot(),
      dialect,
      dialect === parser ? 'commonmark' : 'gfm',
    )
    for (let run = 0; run < 250; run++) {
      assert.deepEqual(
        treeShape(finish(session)),
        treeShape(
          dialect.parse(normalizedSource(store.snapshot().materialize())),
        ),
      )
      const before = store.snapshot()
      let from = random(before.utf16Length + 1),
        to = Math.min(before.utf16Length, from + random(8))
      while (!before.isEditBoundary(from)) from--
      while (!before.isEditBoundary(to)) to++
      const insert = fragments[random(fragments.length)]
      const prepared = edit(store, [{ from, to, insert }])
      session.apply(prepared)
      assert.equal(session.state().complete, false)
      assert.equal(session.state().tree, null)
      if (run % 3 === 0) session.advance()
    }
    assert.deepEqual(
      treeShape(finish(session)),
      treeShape(
        dialect.parse(normalizedSource(store.snapshot().materialize())),
      ),
    )
    session.dispose()
    assert.throws(() => session.advance(), /disposed/)
  }
})

test('parser cancellation retains ordered patches and rejects stale roots and dialect reuse', () => {
  const store = new SourceStore('# start\n\ntext\n'.repeat(1000), {
    tabId: 'parser',
    revision: 0,
  })
  const session = new SourceParserSession(
    store.snapshot(),
    parser,
    'commonmark',
    1,
  )
  finish(session)
  const old = session.state()
  const first = edit(store, [{ from: 0, to: 0, insert: '```\n' }])
  session.apply(first)
  session.advance()
  const second = edit(store, [{ from: 5000, to: 5000, insert: '\n```\n' }])
  session.apply(second)
  assert.throws(() => session.apply(first), /stale/)
  assert.equal(old.source.version, 0)
  assert.equal(old.complete, true)
  assert.ok(session.counters().fragments <= 1)
  const gfm = parser.configure(GFM)
  session.reconfigure(gfm, 'gfm')
  assert.equal(session.counters().fragments, 0)
  assert.deepEqual(
    treeShape(finish(session)),
    treeShape(gfm.parse(normalizedSource(store.snapshot().materialize()))),
  )
})
