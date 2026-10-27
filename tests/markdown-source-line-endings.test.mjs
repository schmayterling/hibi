import assert from 'node:assert/strict'
import test from 'node:test'
import { GFM, parser } from '@lezer/markdown'
import { FormattedCounter } from '../src/addons/word-count/formatted-counter.ts'
import { MarkdownSourceModel } from '../src/shared/markdown-source-model.ts'
import { defaultNoteSyntax } from '../src/shared/note-syntax.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'

const dialect = parser.configure(GFM)
const syntax = { ...defaultNoteSyntax, alerts: true, textExtras: true }
const finish = (target) => {
  if (target instanceof FormattedCounter) {
    const work = target.read()
    for (;;) {
      const step = work.next()
      if (step.done) return step.value
    }
  }
  while (!target.advance().complete) {}
  return [...target.state().owners.records()].map(({ from, to, owner }) => ({
    from,
    to,
    kind: owner.kind,
    parsed: owner.parsed,
  }))
}
const apply = (store, target, changes) => {
  const source = store.snapshot()
  const operation = {
    document: source.document,
    operationId: `edit-${source.version}`,
    baseVersion: source.version,
    contentVersion: source.version + 1,
    origin: 'source',
    historyGroup: 'line-endings',
    changes,
  }
  if (target instanceof FormattedCounter) target.apply(operation)
  else {
    const prepared = store.prepare(operation)
    store.commit(prepared)
    target.apply(prepared)
  }
}
const boundaries = (model) => {
  const { source, owners } = model.state()
  for (const row of owners.records()) {
    assert.notEqual(source.rawToEditor(row.from), null)
    assert.notEqual(source.rawToEditor(row.to), null)
  }
}
const fresh = (store, counter = false) => {
  const target = counter
    ? new FormattedCounter(store, syntax)
    : new MarkdownSourceModel(store.snapshot(), dialect, 'gfm')
  try {
    return finish(target)
  } finally {
    target.dispose()
  }
}

const sequences = [
  [425, '\n', 0, 0, '\r', 2, 2, 'T'],
  [795, '\n', 1, 1, '\n', 0, 0, '\r'],
  [814, '\n', 1, 1, '\n', 0, 0, '\r'],
  [876, '\n', 0, 0, '\r', 2, 2, 'x'],
  [911, '\r', 1, 1, '\n', 0, 0, 'x'],
  [917, '\n', 0, 0, '\r', 2, 2, '\n'],
  [989, '\n#:', 0, 0, '\r', 3, 4, ''],
  [1074, '\r', 0, 0, '3', 2, 2, '\n'],
  [1100, '\n', 1, 1, '!', 0, 0, '\r'],
  [1135, '\n', 1, 1, '-', 0, 0, '\r'],
  [1169, '\n', 0, 0, '\r', 2, 2, '['],
  [1254, '\r', 0, 0, 'e', 2, 2, '\n'],
  [1283, '\n', 1, 1, ' ', 0, 0, '\r'],
]
for (const [
  seed,
  source,
  from,
  to,
  insert,
  lastFrom,
  lastTo,
  lastInsert,
] of sequences)
  for (const counter of [false, true])
    test(`minimized queued cr edits from seed ${seed}, counter=${counter}`, () => {
      const store = new SourceStore(source, { tabId: 'queued-cr', revision: 0 })
      const target = counter
        ? new FormattedCounter(store, syntax)
        : new MarkdownSourceModel(store.snapshot(), dialect, 'gfm')
      try {
        finish(target)
        apply(store, target, [{ from, to, insert }])
        apply(store, target, [
          { from: lastFrom, to: lastTo, insert: lastInsert },
        ])
        assert.deepEqual(finish(target), fresh(store, counter))
        if (!counter) boundaries(target)
      } finally {
        target.dispose()
      }
    })

test('pending owner boundaries stay outside joined crlf at chunk seams and mapped edit endpoints', () => {
  for (const chunkUnits of [16, 4096])
    for (const tail of ['', 'tail']) {
      const source = `${'a'.repeat(chunkUnits - 1)}\r${tail || 'x'}\n\nlast\r`
      const store = new SourceStore(
        source,
        { tabId: 'cr-seams', revision: 0 },
        0,
        { chunkUnits },
      )
      const model = new MarkdownSourceModel(store.snapshot(), dialect, 'gfm')
      try {
        finish(model)
        apply(store, model, [{ from: 0, to: 1, insert: 'bb' }])
        const at = chunkUnits + 1
        apply(store, model, [
          { from: 0, to: 0, insert: 'prefix' },
          { from: at, to: at + tail.length, insert: tail ? '' : '\n' },
          {
            from: store.snapshot().utf16Length,
            to: store.snapshot().utf16Length,
            insert: '\n',
          },
        ])
        boundaries(model)
        assert.deepEqual(finish(model), fresh(store))
        assert.equal(store.counters().materializations, 0)
      } finally {
        model.dispose()
      }
    }
})

test('random queued cr edits match fresh owners and formatted counts', (t) => {
  let seed = 89277
  const random = (max) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return Math.floor((seed / 4294967296) * max)
  }
  const parts = [
    '\r',
    '\n',
    '\r\n',
    'x',
    ' ',
    '# h\r',
    '> q\n',
    '- item\r\n',
    '\rX\n',
  ]
  const coverage = {
    insert: 0,
    delete: 0,
    replace: 0,
    join: 0,
    split: 0,
    gap: 0,
    pending: 0,
    partial: 0,
  }
  let comparisons = 0
  for (let run = 0; run < 100; run++) {
    const initial = `${'x'.repeat(15)}\r${parts[random(parts.length)]}\n\rX\n\r\nlast`
    const stores = [0, 1].map(
      (index) =>
        new SourceStore(
          initial,
          { tabId: `cr-fuzz-${index}`, revision: 0 },
          0,
          { chunkUnits: 16 },
        ),
    )
    const model = new MarkdownSourceModel(stores[0].snapshot(), dialect, 'gfm')
    const counter = new FormattedCounter(stores[1], syntax)
    try {
      finish(model)
      finish(counter)
      for (let step = 0; step < 30; step++) {
        const before = stores[0].snapshot()
        const source = before.sliceRaw(0, before.utf16Length)
        const kind = random(6)
        let from = random(source.length + 1)
        let to = Math.min(source.length, from + random(5))
        let insert = parts[random(parts.length)]
        if (kind === 0) {
          to = from
          coverage.insert++
        } else if (kind === 1) {
          insert = ''
          coverage.delete++
        } else if (kind === 2) {
          coverage.replace++
        } else {
          const matches = [
            ...source.matchAll(
              kind === 3 ? /\r(?!\n)/g : kind === 4 ? /\r\n/g : /\rX\n/g,
            ),
          ]
          if (!matches.length) continue
          const at = matches[random(matches.length)].index
          if (kind === 3) {
            from = to = at + 1
            insert = '\n'
            coverage.join++
          } else if (kind === 4) {
            from = at
            to = at + 2
            insert = '\rX\n'
            coverage.split++
          } else {
            from = at + 1
            to = at + 2
            insert = ''
            coverage.gap++
          }
        }
        while (!before.isEditBoundary(from)) from--
        while (!before.isEditBoundary(to)) to++
        if (source.slice(from, to) === insert) continue
        const changes = [{ from, to, insert }]
        apply(stores[0], model, changes)
        apply(stores[1], counter, changes)
        boundaries(model)
        const label = JSON.stringify({ run, step, source, changes })
        if (random(5) === 0) {
          model.advance()
          const work = counter.read()
          work.next()
          work.return()
          coverage.partial++
        }
        if (random(3) !== 0 && step !== 29) {
          coverage.pending++
          continue
        }
        assert.deepEqual(finish(model), fresh(stores[0]), label)
        assert.deepEqual(finish(counter), fresh(stores[1], true), label)
        comparisons++
      }
      assert.deepEqual(finish(model), fresh(stores[0]))
      assert.deepEqual(finish(counter), fresh(stores[1], true))
    } finally {
      model.dispose()
      counter.dispose()
    }
  }
  for (const count of Object.values(coverage)) assert.ok(count > 0)
  t.diagnostic(JSON.stringify({ comparisons, coverage }))
})
