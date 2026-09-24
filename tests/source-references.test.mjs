import assert from 'node:assert/strict'
import test from 'node:test'
import { GFM, parser } from '@lezer/markdown'
import { Lexer, Marked } from 'marked'
import { alertMarkdown } from '../src/addons/markdown/alerts.ts'
import { textExtrasMarkdown } from '../src/addons/text-extras/syntax.ts'
import { MarkdownSourceModel } from '../src/shared/markdown-source-model.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'
import { SourceOwners } from '../src/shared/source-owners.ts'
import { SourceReferences } from '../src/shared/source-references.ts'

test('cooperative reference preparation cancels atomically and protects incomplete reads', () => {
  const owners = new SourceOwners([
    { kind: 'a', length: 3 },
    { kind: 'b', length: 3 },
  ])
  const index = new SourceReferences(owners)
  const coldScope = index.scope()
  assert.equal(coldScope.current(), false)
  assert.throws(() => coldScope.links.ref, /not ready/)
  let count = 0
  const read = (region) => {
    count++
    return { ref: { href: region.owner.kind } }
  }
  const cold = index.updateWork(owners, read)
  assert.equal(count, 0)
  while (!count) assert.equal(cold.next().done, false)
  assert.equal(count, 1)
  assert.equal(coldScope.current(), false)
  assert.throws(() => coldScope.links.ref, /not ready/)
  assert.throws(() => index.dispose(), /updating/)
  cold.return()
  assert.equal(index.counters().definitions, 0)
  index.update(owners, read)
  const scope = index.scope()
  assert.equal(scope.links.ref.href, 'a')
  const changed = owners.update(0, { kind: 'changed', length: 4 })
  const warm = index.updateWork(changed, read)
  assert.equal(warm.next().done, false)
  assert.equal(scope.current(), true)
  assert.equal(index.scope().links.ref.href, 'a')
  assert.throws(() => index.update(changed, read), /updating/)
  warm.return()
  assert.equal(scope.current(), true)
  index.update(changed, read)
  assert.equal(index.scope().links.ref.href, 'changed')
  assert.equal(scope.current(), false)
  index.dispose()
})

test('prefix context reparsing preserves readers of an unchanged definition owner and value', () => {
  const store = new SourceStore(
    '[ref]: /target\n\n' + '# [ref]\n\n'.repeat(1000),
    { tabId: 'prefix-scopes', revision: 0 },
  )
  const model = new MarkdownSourceModel(
    store.snapshot(),
    parser.configure(GFM),
    'gfm',
  )
  const finish = () => {
    while (!model.advance().complete) {}
    return model.state().owners
  }
  const markdown = new Marked({ gfm: true }),
    before = finish()
  const read = (region) =>
    markdown.lexer(store.snapshot().sliceRaw(region.from, region.to)).links
  const refs = new SourceReferences(before, read),
    scope = refs.scope(),
    candidate = scope.resolve('ref')
  const change = store.prepare({
    document: store.snapshot().document,
    operationId: 'prefix',
    baseVersion: 0,
    contentVersion: 1,
    origin: 'source',
    historyGroup: 'typing',
    changes: [{ from: 0, to: 0, insert: '# prefix\n\n' }],
  })
  store.commit(change)
  model.apply(change)
  const after = finish()
  refs.update(after, read)
  assert.equal(after.bySlot(candidate.owner.slot).owner, candidate.owner)
  assert.equal(refs.scope().resolve('ref'), candidate)
  assert.ok(scope.current())
  refs.dispose()
  model.dispose()
})

test('reference provenance reads track first declarations even when values remain equal', () => {
  let owners = new SourceOwners([
    { kind: 'first', length: 5 },
    { kind: 'later', length: 5 },
  ])
  const read = () => ({ ref: { href: '/same' } })
  const index = new SourceReferences(owners, read)
  const scope = index.scope(),
    winner = scope.resolve('ref')
  assert.equal(winner.owner, owners.get(0).owner)
  assert.equal(winner.value, scope.links.ref)
  assert.ok(Object.isFrozen(winner))
  assert.equal(scope.resolve('missing'), undefined)
  owners = owners.splice(0, 1, [])
  index.update(owners, read)
  assert.equal(scope.current(), false)
  assert.equal(index.scope().resolve('ref').owner, owners.get(0).owner)
  assert.deepEqual(index.scope().resolve('ref').value, winner.value)
  index.dispose()
  assert.throws(() => scope.resolve('ref'), /disposed/)
})

test('reference winners, misses, mixed reads and disposal retain exact dependency meaning', () => {
  let owners = new SourceOwners([
    { kind: 'first', length: 5 },
    { kind: 'second', length: 5 },
  ])
  const first = owners.get(0).owner.slot,
    second = owners.get(1).owner.slot
  const definitions = new Map([
    [first, { ref: { href: '/first' } }],
    [second, { ref: { href: '/second' } }],
  ])
  const read = (region) => definitions.get(region.owner.slot) ?? {}
  const index = new SourceReferences(owners, read)
  const scope = index.scope()
  assert.deepEqual(scope.links.ref, { href: '/first', title: null })
  assert.equal(scope.links.absent, undefined)
  assert.ok(scope.current())
  definitions.set(second, { ref: { href: '/changed nonwinner' } })
  owners = owners.update(1, { kind: 'second', length: 6 })
  index.update(owners, read)
  assert.ok(scope.current())
  owners = owners.splice(0, 1, [])
  index.update(owners, read)
  assert.equal(scope.current(), false)
  assert.equal(index.scope().links.ref.href, '/changed nonwinner')
  const missing = index.scope()
  assert.equal(missing.links.future, undefined)
  definitions.set(second, {
    future: { href: '/new' },
    ref: { href: '/changed nonwinner' },
  })
  owners = owners.update(0, { kind: 'second', length: 7 })
  index.update(owners, read)
  assert.equal(missing.current(), false)
  assert.equal(missing.links.future.href, '/new')
  definitions.set(second, {})
  owners = owners.update(0, { kind: 'second', length: 8 })
  index.update(owners, read)
  assert.equal(missing.links.future, undefined)
  assert.equal(
    missing.current(),
    false,
    'observed mixed environments never become valid again',
  )
  const empty = index.scope()
  assert.equal(empty.links.future, undefined)
  assert.ok(empty.current())
  assert.equal(index.counters().labels, 0)
  assert.equal(index.counters().definitions, 0)
  assert.throws(() => {
    empty.links.future = { href: '/forged' }
  }, /must be indexed/)
  index.dispose()
  assert.equal(empty.current(), false)
  assert.throws(() => empty.links.future, /disposed/)
  assert.throws(() => index.update(owners, read), /disposed/)
})

test('reference updates are atomic on reader failure and reject incomplete or foreign ownership', () => {
  let owners = new SourceOwners([
    { kind: 'a', length: 2 },
    { kind: 'b', length: 2 },
  ])
  const index = new SourceReferences(owners, (region) => ({
    [region.owner.kind]: { href: region.owner.kind },
  }))
  const scope = index.scope()
  assert.equal(scope.links.a.href, 'a')
  const next = owners
    .update(0, { kind: 'new', length: 3 })
    .update(1, { kind: 'bad', length: 4 })
  assert.throws(
    () =>
      index.update(next, (region) => {
        if (region.owner.kind === 'bad') throw Error('reader failed')
        return { a: { href: 'new' } }
      }),
    /reader failed/,
  )
  assert.ok(scope.current())
  assert.equal(index.scope().links.a.href, 'a')
  assert.throws(
    () =>
      index.update(next, () => {
        index.dispose()
        return {}
      }),
    /already updating/,
  )
  assert.ok(scope.current())
  assert.throws(
    () =>
      index.update(
        owners.update(0, { kind: 'pending', length: 2, parsed: false }),
        () => ({}),
      ),
    /complete/,
  )
  assert.throws(
    () => index.update(new SourceOwners([]), () => ({})),
    /different arenas/,
  )
  assert.throws(
    () => index.update(next, () => ({ a: { href: 3 } })),
    /Invalid reference/,
  )
  assert.ok(scope.current())
  owners = next
  index.update(owners, (region) => ({
    [region.owner.kind]: { href: region.owner.kind },
  }))
  assert.equal(scope.current(), false)
  assert.equal(index.scope().links.new.href, 'new')
})

test('duplicate-reference heaps match first-owner order under randomized updates and removals', () => {
  let owners = new SourceOwners(
    Array.from({ length: 500 }, () => ({ kind: 'body', length: 1 })),
  )
  const definitions = new Map()
  for (const row of owners.records())
    definitions.set(row.owner.slot, { ref: { href: String(row.owner.slot) } })
  const reader = (region) => definitions.get(region.owner.slot) ?? {}
  const index = new SourceReferences(owners, reader)
  let seed = 7193
  const random = (max) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed % max
  }
  for (let step = 0; step < 500; step++) {
    const at = random(owners.count + 1),
      removed = Math.min(owners.count, at + random(4))
    owners = owners.splice(at, removed, [{ kind: 'inserted', length: 1 }])
    const slot = owners.get(at).owner.slot
    definitions.set(slot, { ref: { href: String(slot) } })
    if (owners.count > 2 && step % 2 === 0) {
      const position = random(owners.count),
        changed = owners.get(position).owner.slot
      owners = owners.update(position, { kind: 'edited', length: 2 })
      definitions.set(
        changed,
        step % 4 === 0 ? {} : { ref: { href: 'changed' + step } },
      )
    }
    index.update(owners, reader)
    const expected = [...owners.records()]
      .map((row) => definitions.get(row.owner.slot)?.ref)
      .find(Boolean)
    assert.equal(index.scope().links.ref?.href, expected?.href)
  }
})

test('prefix updates and many duplicate definitions avoid scanning or rewriting unaffected owners', () => {
  let owners = new SourceOwners(
    Array.from({ length: 100000 }, () => ({ kind: 'body', length: 1 })),
  )
  const first = owners.get(0).owner.slot
  const index = new SourceReferences(owners, (region) => ({
    ref: { href: String(region.owner.slot) },
  }))
  const scope = index.scope()
  assert.equal(scope.links.ref.href, String(first))
  index.counters(true)
  const prefix = owners.splice(0, 0, [{ kind: 'prefix', length: 2 }])
  index.update(prefix, (region) =>
    region.owner.kind === 'prefix'
      ? {}
      : { ref: { href: String(region.owner.slot) } },
  )
  assert.ok(scope.current())
  assert.equal(index.counters().ownersRead, 1)
  assert.equal(index.counters().comparisons, 0)
  index.counters(true)
  owners = prefix.splice(1, 2, [])
  index.update(owners, (region) => ({
    ref: { href: String(region.owner.slot) },
  }))
  assert.equal(index.scope().links.ref.href, String(owners.get(1).owner.slot))
  assert.ok(index.counters().comparisons < 40, JSON.stringify(index.counters()))
  assert.equal(index.counters().ownersRead, 0)
  index.dispose()
  assert.equal(index.counters().definitions, 0)
})

test('regional reference discovery and scoped semantic reads match full Marked through source edits', () => {
  const markdown = new Marked({ gfm: true }, textExtrasMarkdown, alertMarkdown)
  const store = new SourceStore(
    '# [link][target]\r\n\r\n -# small\r\n\r\n[target]: /first\r\n\r\n[TARGET]: /second\r\n',
    { tabId: 'references', revision: 0 },
  )
  const model = new MarkdownSourceModel(
    store.snapshot(),
    parser.configure(GFM),
    'gfm',
  )
  const finish = () => {
    for (let n = 0; n < 100000; n++) {
      const state = model.advance()
      if (state.complete) return state.owners
    }
    throw Error('metadata did not settle')
  }
  let owners = finish()
  const read = (region) =>
    markdown.lexer(store.snapshot().sliceRaw(region.from, region.to)).links
  const index = new SourceReferences(owners, read)
  const check = () => {
    const scopes = []
    const actual = []
    // Reuse the exact input regions supplied to definition discovery.
    const collector = new SourceReferences(owners, (region) => {
      const scope = index.scope(),
        lexer = new Lexer({ ...markdown.defaults, tokenizer: undefined })
      lexer.tokens.links = scope.links
      actual.push(
        markdown.parser(
          lexer.lex(store.snapshot().sliceRaw(region.from, region.to)),
          markdown.defaults,
        ),
      )
      scopes.push(scope)
      return {}
    })
    collector.dispose()
    assert.equal(
      actual.join(''),
      markdown.parse(store.snapshot().materialize()),
    )
    assert.ok(scopes.every((scope) => scope.current()))
    return scopes
  }
  check()
  const edit = (from, to, insert) => {
    const source = store.snapshot()
    const prepared = store.prepare({
      document: source.document,
      operationId: crypto.randomUUID(),
      baseVersion: source.version,
      contentVersion: source.version + 1,
      origin: 'source',
      historyGroup: 'test',
      changes: [{ from, to, insert }],
    })
    store.commit(prepared)
    model.apply(prepared)
    owners = finish()
    index.update(owners, read)
    check()
  }
  let text = store.snapshot().materialize(),
    at = text.indexOf(' -#')
  edit(at, at, ' ')
  text = store.snapshot().materialize()
  at = text.indexOf('[target]:')
  edit(at, at + '[target]: /first\r\n\r\n'.length, '')
  edit(0, 0, '[target]: /new\r\n\r\n')
  text = store.snapshot().materialize()
  at = text.indexOf('/second')
  edit(at, at + '/second'.length, '/changed')
  index.dispose()
  model.dispose()
})

test('incremental reference definitions match complete readers through randomized block edits', () => {
  const markdown = new Marked({ gfm: true }, textExtrasMarkdown, alertMarkdown)
  const variants = [
    '# [link][a]\n\n',
    '[a]: /one\n\n',
    '[A]: /two "title"\n\n',
    '> [b]: /quote\n> text\n\n',
    '- [c]: /list\n- text\n\n',
    'ordinary [a] [b] [c]\n\n',
    '-# small [a]\n\n',
    '    [a]: literal code\n\n',
    '```\n[a]: fenced code\n```\n\n',
    ' -# first\n[a]: /after-small\n\n',
    '> [!NOTE]\n> [a]\n\n',
    '# [unknown][missing]\n\n',
    '[__proto__]: /safe\n\n',
  ]
  let blocks = [...variants],
    seed = 19823
  const random = (max) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed % max
  }
  const store = new SourceStore(blocks.join(''), {
    tabId: 'reference-oracle',
    revision: 0,
  })
  const model = new MarkdownSourceModel(
    store.snapshot(),
    parser.configure(GFM),
    'gfm',
  )
  const finish = () => {
    for (let n = 0; n < 100000; n++) {
      const state = model.advance()
      if (state.complete) return state.owners
    }
    throw Error('metadata did not settle')
  }
  let owners = finish()
  const read = (region) =>
    markdown.lexer(store.snapshot().sliceRaw(region.from, region.to)).links
  const index = new SourceReferences(owners, read)
  for (let step = 0; step < 300; step++) {
    const at = random(blocks.length + 1),
      remove = Math.min(blocks.length - at, random(3))
    const additions = Array.from(
      { length: random(3) },
      () => variants[random(variants.length)],
    )
    const from = blocks.slice(0, at).join('').length,
      before = blocks.slice(at, at + remove).join(''),
      insert = additions.join('')
    if (before === insert) continue
    const source = store.snapshot()
    const prepared = store.prepare({
      document: source.document,
      operationId: crypto.randomUUID(),
      baseVersion: source.version,
      contentVersion: source.version + 1,
      origin: 'source',
      historyGroup: 'oracle',
      changes: [{ from, to: from + before.length, insert }],
    })
    store.commit(prepared)
    model.apply(prepared)
    blocks.splice(at, remove, ...additions)
    owners = finish()
    index.update(owners, read)
    const text = blocks.join(''),
      expected = markdown.lexer(text).links,
      scope = index.scope()
    for (const label of ['a', 'b', 'c', 'missing', '__proto__']) {
      const actual = scope.links[label]
      assert.deepEqual(
        actual,
        expected[label]
          ? { href: expected[label].href, title: expected[label].title ?? null }
          : undefined,
        `step ${step}, label ${label}\n${text}`,
      )
    }
    assert.ok(scope.current())
  }
  index.dispose()
  model.dispose()
})
