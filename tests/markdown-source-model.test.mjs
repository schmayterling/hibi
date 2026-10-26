import assert from 'node:assert/strict'
import test from 'node:test'
import { Parser, Tree } from '@lezer/common'
import { GFM, parser } from '@lezer/markdown'
import { MarkdownSourceModel } from '../src/shared/markdown-source-model.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'
import { normalizedSource } from '../src/shared/source-projection.ts'

const finish = (model) => {
  for (let count = 0; count < 1_000_000; count++) {
    const state = model.advance()
    if (state.complete) return state
  }
  throw new Error('Metadata did not converge.')
}
const edit = (store, model, changes) => {
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
  model.apply(prepared)
  assert.equal(model.state().source, store.snapshot())
  if (model.state().owners)
    assert.equal(model.state().owners.length, store.snapshot().utf16Length)
  return prepared
}
const rows = (owners) =>
  Array.from({ length: owners.count }, (_, index) => {
    const row = owners.get(index)
    return {
      kind: row.owner.kind,
      from: row.from,
      to: row.to,
      parsed: row.owner.parsed,
    }
  })

test('grammar dependency invalidation reparses earlier owners without changing source', () => {
  for (const eol of ['\n', '\r\n']) {
    let enabled = false
    const dialect = parser.configure({
      defineNodes: [{ name: 'DependentBlock', block: true }],
      parseBlock: [
        {
          name: 'DependentBlock',
          before: 'LinkReference',
          parse(cx, line) {
            if (!enabled || line.text !== 'candidate') return false
            cx.addElement(
              cx.elt(
                'DependentBlock',
                cx.lineStart,
                cx.lineStart + line.text.length,
              ),
            )
            cx.nextLine()
            return true
          },
        },
      ],
    })
    const source = `candidate${eol}${eol}${'unchanged paragraph'.concat(eol, eol).repeat(100)}last`
    const store = new SourceStore(source, {
      tabId: 'grammar-dependency',
      revision: 0,
    })
    const snapshot = store.snapshot()
    const model = new MarkdownSourceModel(snapshot, dialect, 'dependency')
    try {
      const initial = finish(model).owners
      const tail = initial.at(source.length - 1).owner
      assert.equal(initial.at(0).owner.kind, 'markdown:Paragraph')
      for (const next of [true, false, true]) {
        enabled = next
        model.invalidate(0, 1)
        assert.equal(model.state().complete, false)
        assert.equal(model.state().owners.at(0).owner.parsed, false)
        const state = finish(model)
        assert.equal(state.source, snapshot)
        assert.equal(store.snapshot(), snapshot)
        assert.equal(state.owners.at(source.length - 1).owner, tail)
        assert.deepEqual(rows(state.owners), oracle(snapshot, dialect))
      }
      for (const [from, to] of [
        [-1, 1],
        [0, 0],
        [1, 0],
        [0, source.length + 1],
        [0, NaN],
      ])
        assert.throws(() => model.invalidate(from, to), /outside/)
      if (eol === '\r\n')
        assert.throws(
          () =>
            model.invalidate('candidate'.length + 1, 'candidate'.length + 2),
          /outside/,
        )
      assert.equal(snapshot.sliceRaw(0, source.length), source)
    } finally {
      model.dispose()
    }
  }
})

test('fence pairing changes expand boundary coverage without quadratic interior walks', () => {
  const fences = 1024,
    fence = '`'.repeat(3)
  const text = Array.from(
    { length: fences },
    (_, n) => `${fence}\r\nbody ${n}\r\n`,
  ).join('')
  const store = new SourceStore(text, {
    tabId: 'fence-boundaries',
    revision: 0,
  })
  const model = new MarkdownSourceModel(store.snapshot(), parser, 'commonmark')
  finish(model)
  model.counters(true)
  store.counters(true)
  edit(store, model, [{ from: 0, to: 0, insert: `${fence}\r\n` }])
  const state = finish(model)
  const work = model.counters()
  assert.ok(work.nodesVisited < fences * 12, JSON.stringify(work))
  assert.ok(work.boundarySeeks <= fences * 2 + 4)
  assert.equal(store.counters().materializations, 0)
  assert.deepEqual(rows(state.owners), oracle(store.snapshot(), parser))
  model.dispose()
})

test('bounded owner pages preserve raw positions, coverage, epochs and continuation across edits', () => {
  const store = new SourceStore(
    '# heading\r\n\r\nparagraph\r\n\r\n'.repeat(10000),
    { tabId: 'pages', revision: 0 },
  )
  const model = new MarkdownSourceModel(store.snapshot(), parser, 'commonmark')
  assert.deepEqual(model.page(0, 50).rows, [])
  assert.equal(model.page(0, 50).complete, false)
  finish(model)
  model.counters(true)
  const first = model.page(180000, store.snapshot().utf16Length, 3)
  assert.equal(first.rows.length, 3)
  assert.equal(first.complete, true)
  assert.equal(first.version, store.snapshot().version)
  assert.equal(first.epoch, model.state().owners.epoch)
  assert.equal(first.next, first.rows.at(-1).to)
  assert.ok(model.counters().owners.lookupSlotsRead < 1024)
  const next = model.page(first.next, store.snapshot().utf16Length, 3)
  assert.equal(next.rows[0].index, first.rows.at(-1).index + 1)
  assert.equal(next.rows[0].from, first.next)
  const caret = model.page(first.rows[0].from, first.rows[0].from, 1)
  assert.equal(caret.rows[0].owner.slot, first.rows[0].owner.slot)
  assert.equal(caret.next, null)
  assert.throws(() => {
    first.rows[0].owner.length = 0
  }, TypeError)
  assert.throws(() => first.rows.push(first.rows[0]), TypeError)
  const tail = model.page(
    store.snapshot().utf16Length,
    store.snapshot().utf16Length,
  )
  assert.equal(tail.next, null)
  assert.equal(tail.rows.length, 1)
  edit(store, model, [{ from: 0, to: 0, insert: 'prefix\n\n' }])
  assert.equal(model.page(180008, 180020).complete, false)
  assert.equal(model.page(180008, 180020).version, 1)
  assert.equal(model.page(180008, 180020).epoch, first.epoch)
  for (const args of [
    [-1, 0],
    [1, 0],
    [0, Infinity],
    [0, 1, 0],
    [0, 1, 257],
  ])
    assert.throws(() => model.page(...args), /Invalid/)
  model.dispose()
})
function oracle(source, dialect) {
  const tree = dialect.parse(normalizedSource(source.materialize())),
    result = []
  let position = 0
  tree.iterate({
    enter(node) {
      if (node.name === 'Document' || node.type.isAnonymous) return
      const from = source.editorToRaw(node.from),
        to = source.editorToRaw(node.to)
      if (from > position)
        result.push({ kind: 'trivia', from: position, to: from, parsed: true })
      if (from < to)
        result.push({ kind: `markdown:${node.name}`, from, to, parsed: true })
      position = to
      return false
    },
  })
  if (position < source.utf16Length)
    result.push({
      kind: 'trivia',
      from: position,
      to: source.utf16Length,
      parsed: true,
    })
  return result
}

test('coarse source ownership stays exact through edits, cancellations, fences and mixed endings', () => {
  let seed = 89277
  const random = (max) => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return (seed >>> 0) % max
  }
  const parts = [
    '\n',
    '\r\n',
    '```\n',
    '<div>\n',
    '</div>\n',
    '- item\n',
    '[ref]: url\n',
    '# heading\n',
    '😀',
    'text',
    '  ',
  ]
  for (const dialect of [parser, parser.configure(GFM)]) {
    const store = new SourceStore(
      '# heading\r\n\r\none 😀\n\n- two\n- three\n\nlast',
      { tabId: 'model', revision: 0 },
    )
    const model = new MarkdownSourceModel(
      store.snapshot(),
      dialect,
      dialect === parser ? 'commonmark' : 'gfm',
    )
    const retained = finish(model),
      originalRows = rows(retained.owners)
    for (let at = 0; at < 300; at++) {
      const before = store.snapshot()
      let from = random(before.utf16Length + 1),
        to = Math.min(before.utf16Length, from + random(12))
      while (!before.isEditBoundary(from)) from--
      while (!before.isEditBoundary(to)) to++
      const insert = parts[random(parts.length)]
      if (before.sliceRaw(from, to) === insert) continue
      edit(store, model, [{ from, to, insert }])
      assert.equal(model.state().complete, false)
      if (at % 3 === 0) model.advance()
      if (at % 5 === 0)
        assert.deepEqual(
          rows(finish(model).owners),
          oracle(store.snapshot(), dialect),
          `edit ${at}`,
        )
    }
    assert.deepEqual(
      rows(finish(model).owners),
      oracle(store.snapshot(), dialect),
    )
    assert.deepEqual(rows(retained.owners), originalRows)
    edit(store, model, [
      { from: 0, to: store.snapshot().utf16Length, insert: '' },
    ])
    assert.equal(finish(model).owners.count, 0)
    edit(store, model, [{ from: 0, to: 0, insert: '\r\n\n' }])
    assert.deepEqual(
      rows(finish(model).owners),
      oracle(store.snapshot(), dialect),
    )
    model.dispose()
  }
})

test('100k-line prefix edits preserve later owners without a metadata tree walk', () => {
  const source = '# heading\n\nparagraph\n\n'.repeat(25_000).slice(0, -1)
  const store = new SourceStore(source, { tabId: 'large', revision: 0 })
  const model = new MarkdownSourceModel(store.snapshot(), parser, 'commonmark')
  const before = finish(model),
    last = before.owners.get(before.owners.count - 1).owner
  model.counters(true)
  store.counters(true)
  edit(store, model, [{ from: 0, to: 0, insert: '# new\n\n' }])
  assert.equal(store.counters().materializations, 0)
  assert.equal(
    model.state().owners.get(model.state().owners.count - 1).owner,
    last,
  )
  const after = finish(model),
    work = model.counters()
  assert.equal(after.owners.get(after.owners.count - 1).owner, last)
  assert.equal(after.owners.invalid(), 0)
  assert.ok(work.ownersReused > 99_000, JSON.stringify(work))
  assert.ok(work.nodesVisited < 2000, JSON.stringify(work))
  assert.ok(work.rowsWritten < 100, JSON.stringify(work))
  assert.equal(store.counters().materializations, 0)
  assert.deepEqual(rows(after.owners), oracle(store.snapshot(), parser))
})

test('shared parser tree payloads do not merge owner occurrences and dialect changes revoke coverage', () => {
  const ordinary = parser.parse('same\n\nsame'),
    shared = ordinary.children[0]
  const tree = new Tree(ordinary.type, [shared, shared], [0, 6], 10)
  class SharedParser extends Parser {
    createParse() {
      return {
        advance: () => tree,
        parsedPos: 10,
        stoppedAt: null,
        stopAt() {},
      }
    }
  }
  const store = new SourceStore('same\n\nsame', {
    tabId: 'shared',
    revision: 0,
  })
  const model = new MarkdownSourceModel(
    store.snapshot(),
    new SharedParser(),
    'shared-fixture',
  )
  const initial = finish(model),
    first = initial.owners.get(0).owner,
    last = initial.owners.get(2).owner
  assert.notEqual(first.slot, last.slot)
  const change = edit(store, model, [{ from: 0, to: 1, insert: 'S' }])
  const changed = finish(model)
  assert.equal(changed.owners.get(2).owner, last)
  assert.equal(initial.owners.get(0).owner, first)
  assert.throws(() => model.apply(change), /stale/)
  model.reconfigure(parser, 'commonmark')
  assert.equal(model.state().owners, null)
  assert.equal(model.state().complete, false)
  assert.deepEqual(rows(finish(model).owners), oracle(store.snapshot(), parser))
})
