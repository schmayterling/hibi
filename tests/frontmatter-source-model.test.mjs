import assert from 'node:assert/strict'
import test from 'node:test'
import { GFM, parser } from '@lezer/markdown'
import { readFrontmatter } from '../src/shared/frontmatter.ts'
import { FrontmatterParser } from '../src/shared/frontmatter-parser.ts'
import { FrontmatterSourceModel } from '../src/shared/frontmatter-source-model.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'
import { normalizedSource } from '../src/shared/source-projection.ts'

const finish = (model) => {
  for (let i = 0; i < 1000000; i++) {
    const state = model.advance()
    if (state.complete) return state
  }
  throw new Error('Frontmatter metadata did not converge.')
}
const rows = (state) =>
  [...state.owners.records()].map((row) => ({
    from: row.from,
    to: row.to,
    kind: row.owner.kind,
  }))
const oracle = (source, markdown) => {
  const block = readFrontmatter(source.materialize()),
    prefix = block?.prefix.length ?? 0,
    offset = source.rawToEditor(prefix),
    body = block?.content ?? source.materialize(),
    blocks = prefix
      ? [{ from: 0, to: prefix, kind: 'markdown:Frontmatter' }]
      : []
  markdown.parse(normalizedSource(body)).iterate({
    enter(node) {
      if (node.name === 'Document' || node.type.isAnonymous) return
      blocks.push({
        from: source.editorToRaw(offset + node.from),
        to: source.editorToRaw(offset + node.to),
        kind: `markdown:${node.name}`,
      })
      return false
    },
  })
  const result = []
  let from = 0
  for (const block of blocks) {
    if (from < block.from) result.push({ from, to: block.from, kind: 'trivia' })
    result.push(block)
    from = block.to
  }
  if (from < source.utf16Length)
    result.push({ from, to: source.utf16Length, kind: 'trivia' })
  return result
}
const edit = (store, model, changes) => {
  const source = store.snapshot()
  const prepared = store.prepare({
    document: source.document,
    operationId: crypto.randomUUID(),
    baseVersion: source.version,
    contentVersion: source.version + 1,
    origin: 'source',
    historyGroup: 'test',
    changes,
  })
  store.commit(prepared)
  model.apply(prepared)
}

test('frontmatter parser preserves body semantics and exact prefix bounds for every accepted separator', () => {
  for (const ending of ['', '\n', '\r\n', '\rbody', '\u2028body', '\u2029body'])
    for (const body of [
      '',
      '# heading\r\n\r\nparagraph',
      '> # quote\n\n- item\n\n```\n# code\n```',
      '| a | b |\n|---|---|\n| c | d |',
    ]) {
      const text = `\uFEFF---\r\na: 1\r\n---${ending}${body}`
      for (const markdown of [parser, parser.configure(GFM)]) {
        const store = new SourceStore(
          text,
          { tabId: 'frontmatter-model', revision: 0 },
          0,
          { chunkUnits: 7 },
        )
        const model = new FrontmatterSourceModel(
          store.snapshot(),
          markdown,
          'test+frontmatter',
        )
        assert.deepEqual(
          rows(finish(model)),
          oracle(store.snapshot(), markdown),
          JSON.stringify(text),
        )
        model.dispose()
      }
    }
  assert.throws(() => new FrontmatterParser(parser, 0), /boundary/)
  const wrapped = new FrontmatterParser(parser, 4)
  assert.throws(
    () => wrapped.startParse('123456', [], [{ from: 1, to: 6 }]),
    /complete source/,
  )
  const partial = wrapped.startParse('1234# one\n\n# two\n')
  partial.stopAt(10)
  assert.equal(partial.stoppedAt, 10)
})

test('frontmatter owner updates agree with full projected parsing under randomized prefix and body edits', () => {
  let seed = 93842
  const random = (max) => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return (seed >>> 0) % max
  }
  for (const markdown of [parser, parser.configure(GFM)]) {
    const store = new SourceStore(
      '---\na: 1\n---\n\n# first\n\nparagraph\n\n# last\n',
      { tabId: 'frontmatter-random', revision: 0 },
    )
    const model = new FrontmatterSourceModel(
      store.snapshot(),
      markdown,
      'test+frontmatter',
    )
    for (let i = 0; i < 200; i++) {
      assert.deepEqual(
        rows(finish(model)),
        oracle(store.snapshot(), markdown),
        `iteration ${i}`,
      )
      const text = store.snapshot().materialize(),
        prefix = readFrontmatter(text)?.prefix.length ?? 0,
        start = i % 7 ? prefix : 0
      let from = start + random(text.length - start + 1),
        to = Math.min(text.length, from + random(5))
      while (!store.snapshot().isEditBoundary(from)) from--
      while (!store.snapshot().isEditBoundary(to)) to++
      const insert = [
        '# h\n',
        '\n',
        '\r\n',
        '---\n',
        'a: 1\n',
        '```\n',
        '😀',
        '> quote\n',
        '',
      ][random(9)]
      if (text.slice(from, to) !== insert)
        edit(store, model, [{ from, to, insert }])
    }
    model.dispose()
  }
})

test('body edits reuse prefix decisions and parser owners without whole-body boundary expansion', () => {
  const prefix = '---\ntitle: hello\n---\n\n'
  const store = new SourceStore(
    prefix + '# heading\n\ntext\n\n'.repeat(10000),
    { tabId: 'frontmatter-local', revision: 0 },
  )
  const model = new FrontmatterSourceModel(
    store.snapshot(),
    parser,
    'commonmark+frontmatter',
  )
  const first = finish(model),
    epoch = first.owners.epoch
  model.counters(true)
  edit(store, model, [
    { from: prefix.length + 2, to: prefix.length + 2, insert: 'new ' },
  ])
  const state = finish(model),
    counters = model.counters()
  assert.equal(state.owners.epoch, epoch)
  assert.equal(state.owners.get(0).owner, first.owners.get(0).owner)
  assert.ok(counters.nodesVisited < 100, JSON.stringify(counters))
  assert.ok(counters.rowsWritten < 10, JSON.stringify(counters))
  assert.deepEqual(rows(state), oracle(store.snapshot(), parser))
  const work = store.prepareCompaction()
  let step = work.next()
  while (!step.done) step = work.next()
  store.commitCompaction(step.value)
  model.adoptStorage(step.value)
  assert.equal(model.state().source, store.snapshot())
  assert.equal(model.state().owners, state.owners)
  assert.equal(model.state().complete, true)
  model.dispose()
})

test('prefix edits cancel unfinished scanning and recognize the new source generation', () => {
  const store = new SourceStore('---\na: 1\n' + '# heading\n'.repeat(10000), {
    tabId: 'frontmatter-cancel',
    revision: 0,
  })
  const model = new FrontmatterSourceModel(
    store.snapshot(),
    parser,
    'commonmark+frontmatter',
  )
  assert.equal(model.advance().complete, false)
  edit(store, model, [{ from: 9, to: 9, insert: '---\n\n' }])
  assert.deepEqual(rows(finish(model)), oracle(store.snapshot(), parser))
  model.dispose()
})
