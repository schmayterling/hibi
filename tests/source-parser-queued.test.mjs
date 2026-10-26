import assert from 'node:assert/strict'
import test from 'node:test'
import { GFM, parser } from '@lezer/markdown'
import { SourceOutlineModel } from '../src/renderer/src/source-outline.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'
import { SourceParserSession } from '../src/shared/source-parser.ts'
import { normalizedSource } from '../src/shared/source-projection.ts'

function fixture(eol, count = 5) {
  const source = `intro 🌿${eol}${eol}${Array.from(
    { length: count },
    (_, i) => `# heading ${i}${eol}${eol}body words 🌿 ${i}${eol}${eol}`,
  ).join('')}`
  return {
    source,
    store: new SourceStore(source, { tabId: 'queued', revision: 0 }),
  }
}

function edit(fixture, target, from, to, insert) {
  const before = fixture.store.snapshot()
  const prepared = fixture.store.prepare({
    document: before.document,
    operationId: crypto.randomUUID(),
    baseVersion: before.version,
    contentVersion: before.version + 1,
    origin: 'source',
    historyGroup: 'test',
    changes: [{ from, to, insert }],
  })
  fixture.store.commit(prepared)
  target.apply(prepared)
  fixture.source =
    fixture.source.slice(0, from) + insert + fixture.source.slice(to)
}

function finish(session) {
  for (let steps = 0; steps < 1000000; steps++) {
    const state = session.advance()
    if (state.complete) return state.tree
  }
  throw new Error('Parser did not converge.')
}

function outline(model) {
  const work = model.read()
  for (let steps = 0; steps < 1000000; steps++) {
    const result = work.next()
    if (result.done) return result.value
  }
  throw new Error('Outline did not converge.')
}

function shape(tree) {
  const result = []
  tree.iterate({
    enter: (node) => result.push([node.name, node.from, node.to]),
  })
  return result
}

function queuedEdits(fixture, target, eol, last) {
  const at = fixture.source.indexOf(`x heading ${last}`)
  const underline = fixture.source.indexOf(eol + eol, at) + eol.length
  edit(fixture, target, underline, underline, '---')
  const body = fixture.source.indexOf('body words') + 15
  edit(fixture, target, body, body, eol)
}

for (const eol of ['\n', '\r\n']) {
  const label = JSON.stringify(eol)
  test(`queued edits retain setext context in parser fragments with ${label}`, () => {
    for (const dialect of [parser, parser.configure(GFM)]) {
      const f = fixture(eol)
      const session = new SourceParserSession(
        f.store.snapshot(),
        dialect,
        'test',
      )
      try {
        finish(session)
        const at = f.source.indexOf('# heading 4')
        edit(f, session, at, at + 1, 'x')
        finish(session)
        queuedEdits(f, session, eol, 4)
        const warm = finish(session)
        const cold = dialect.parse(normalizedSource(f.source))
        assert.match(cold.toString(), /SetextHeading2/)
        assert.deepEqual(shape(warm), shape(cold))
        assert.equal(f.store.counters().materializations, 0)
      } finally {
        session.dispose()
      }
    }
  })

  test(`source outline retains a heading after distant queued edits with ${label}`, () => {
    const f = fixture(eol)
    const options = { gfm: true, frontmatter: true }
    const model = new SourceOutlineModel(f.store.snapshot(), options)
    let cold
    try {
      outline(model)
      const at = f.source.indexOf('# heading 4')
      edit(f, model, at, at + 1, 'x')
      outline(model)
      queuedEdits(f, model, eol, 4)
      const actual = outline(model)
      cold = new SourceOutlineModel(f.store.snapshot(), options)
      const expected = outline(cold)
      assert.ok(
        expected.some(
          (heading) => heading.label === 'x heading 4' && heading.level === 2,
        ),
      )
      assert.deepEqual(actual, expected)
      assert.equal(f.store.counters().materializations, 0)
    } finally {
      model.dispose()
      cold?.dispose()
    }
  })
}

test('distant queued edits retain bounded local parsing as notes grow', (t) => {
  for (const count of [1000, 4000]) {
    const f = fixture('\n', count)
    const session = new SourceParserSession(f.store.snapshot(), parser, 'test')
    try {
      finish(session)
      const at = f.source.indexOf(`# heading ${count - 1}`)
      edit(f, session, at, at + 1, 'x')
      finish(session)
      session.counters(true)
      f.store.counters(true)
      queuedEdits(f, session, '\n', count - 1)
      const actual = finish(session)
      const work = session.counters()
      assert.deepEqual(shape(actual), shape(parser.parse(f.source)))
      assert.ok(work.fragmentVisits > 0, JSON.stringify(work))
      assert.ok(work.readUnits < 4096, JSON.stringify({ count, work }))
      assert.ok(work.fragmentVisits <= 12, JSON.stringify({ count, work }))
      assert.equal(f.store.counters().materializations, 0)
      t.diagnostic(
        JSON.stringify({
          headings: count,
          readUnits: work.readUnits,
          maximumRead: work.maximumRead,
          fragmentVisits: work.fragmentVisits,
        }),
      )
    } finally {
      session.dispose()
    }
  }
})
