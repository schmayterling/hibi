import assert from 'node:assert/strict'
import test from 'node:test'
import { GFM, parser } from '@lezer/markdown'
import { Lexer } from 'marked'
import { MarkdownSemanticCache } from '../src/shared/markdown-semantic-cache.ts'
import { MarkdownSourceModel } from '../src/shared/markdown-source-model.ts'
import {
  MarkdownSourceReferences,
  markdownSourceParser,
} from '../src/shared/markdown-source-references.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'

const syntax = { gfm: true, alerts: true, textExtras: true }
function fixture(t, text, options = syntax) {
  const store = new SourceStore(text, { tabId: 'semantic-cache', revision: 0 }),
    model = new MarkdownSourceModel(
      store.snapshot(),
      parser.configure(GFM),
      'gfm',
    ),
    references = new MarkdownSourceReferences(options)
  t.after(() => {
    references.dispose()
    model.dispose()
  })
  const settle = (updateReferences = true) => {
    while (!model.advance().complete) {}
    const owners = model.state().owners
    if (updateReferences)
      for (const _ of references.update(store.snapshot(), owners)) {
        /* Complete reference discovery before semantic reads. */
      }
    return owners
  }
  const edit = (from, to, insert, updateReferences = true) => {
    const before = store.snapshot(),
      operation = store.prepare({
        document: before.document,
        operationId: crypto.randomUUID(),
        baseVersion: before.version,
        contentVersion: before.version + 1,
        origin: 'source',
        historyGroup: 'typing',
        changes: [{ from, to, insert }],
      })
    store.commit(operation)
    model.apply(operation)
    return settle(updateReferences)
  }
  const read = (cache, owners, slot) =>
    cache.read(store.snapshot(), owners, slot, references)
  return { store, model, references, settle, edit, read }
}

const headings = (owners) =>
  [...owners.records()].filter(
    (row) => row.owner.kind === 'markdown:ATXHeading1',
  )
const headingText = (value) =>
  value.tokens
    .filter((token) => token.type === 'heading')
    .map((token) => token.text)

test('prefix cache hits rebind positions without lexing or materializing source', (t) => {
  const f = fixture(
      t,
      '# before\n\n# body **bold** [ref]\n\n[ref]: /one\n\n# tail\n',
    ),
    cache = new MarkdownSemanticCache(syntax),
    owners = f.settle(),
    slot = headings(owners)[1].owner.slot,
    before = f.read(cache, owners, slot),
    current = f.edit(0, 0, '# prefix\n\n'),
    lex = Lexer.prototype.lex
  let lexicalReads = 0
  t.mock.method(Lexer.prototype, 'lex', function (...args) {
    lexicalReads++
    return lex.apply(this, args)
  })
  f.store.counters(true)
  const after = f.read(cache, current, slot)
  assert.equal(after.tokens, before.tokens)
  assert.notEqual(after.region, before.region)
  assert.equal(after.region.from, before.region.from + 10)
  assert.equal(lexicalReads, 0)
  assert.equal(f.store.counters().materializations, 0)
  assert.ok(f.store.counters().sourceUnitsRead < 96)
  assert.equal(cache.counters().hits, 1)
  assert.equal(cache.counters().reads, 1)
  assert.equal(cache.counters().entries, 1)
})

test('changed definitions invalidate cached inline links', (t) => {
  const source = '# [ref]\n\n[ref]: /one\n',
    f = fixture(t, source),
    cache = new MarkdownSemanticCache(syntax),
    owners = f.settle(),
    slot = owners.get(0).owner.slot,
    before = f.read(cache, owners, slot),
    start = source.indexOf('/one'),
    current = f.edit(start, start + 4, '/two'),
    after = f.read(cache, current, slot)
  assert.notEqual(after.tokens, before.tokens)
  assert.equal(before.scope.current(), false)
  assert.equal(before.tokens[0].tokens[0].href, '/one')
  assert.equal(after.tokens[0].tokens[0].href, '/two')
  assert.equal(cache.counters().reads, 2)
  assert.equal(cache.counters().hits, 0)
  assert.equal(cache.counters().entries, 1)
})

test('missing references and equal-value declaration replacements invalidate cached semantics', (t) => {
  const missing = fixture(t, '# before\n\n# [later]\n\n# tail\n'),
    missingCache = new MarkdownSemanticCache(syntax),
    previous = missing.settle(),
    slot = headings(previous)[1].owner.slot,
    unresolved = missing.read(missingCache, previous, slot),
    end = missing.store.snapshot().utf16Length,
    current = missing.edit(end, end, '\n[later]: /found\n'),
    resolved = missing.read(missingCache, current, slot)
  assert.equal(unresolved.tokens[0].tokens[0].type, 'text')
  assert.equal(resolved.tokens[0].tokens[0].href, '/found')
  assert.notEqual(resolved.tokens, unresolved.tokens)

  const declared = fixture(
      t,
      '# before\n\n[ref]: /same\n\n# [ref]\n\n# tail\n',
    ),
    declarationCache = new MarkdownSemanticCache(syntax),
    owners = declared.settle(),
    declaration = [...owners.records()].find(
      (row) => row.owner.kind === 'markdown:LinkReference',
    ).owner.slot,
    winner = declared.read(declarationCache, owners, declaration),
    replaced = declared.edit(0, 0, '[ref]: /same\n\n'),
    duplicate = declared.read(declarationCache, replaced, declaration)
  assert.equal(winner.tokens.filter((token) => token.type === 'def').length, 1)
  assert.equal(
    duplicate.tokens.filter((token) => token.type === 'def').length,
    0,
  )
  assert.notEqual(duplicate.tokens, winner.tokens)
  assert.equal(winner.scope.current(), false)
})

test('group membership changes retire old anchors and refresh joined tokens', (t) => {
  const source = '> [ref]: /quote\n\nplain text\n\n# tail\n',
    joinAt = source.indexOf('plain text') - 1,
    f = fixture(t, source),
    cache = new MarkdownSemanticCache(syntax),
    initial = f.settle(),
    [first, second] = [...initial.records()]
      .filter((row) => row.owner.kind !== 'trivia')
      .map((row) => row.owner.slot),
    firstRead = f.read(cache, initial, first),
    secondRead = f.read(cache, initial, second),
    joined = f.edit(joinAt, joinAt + 1, ''),
    joinedRead = f.read(cache, joined, first)
  assert.notEqual(joinedRead.tokens, firstRead.tokens)
  assert.equal(joinedRead.tokens[0].type, 'blockquote')
  assert.equal(
    joinedRead.tokens[0].tokens.find((token) => token.type === 'paragraph')
      .text,
    'plain text',
  )
  assert.equal(f.read(cache, joined, second), null)
  assert.equal(cache.counters().entries, 1)
  const split = f.edit(joinAt, joinAt, '\n'),
    firstSplit = f.read(cache, split, first),
    secondSplit = f.read(cache, split, second)
  assert.notEqual(firstSplit.tokens, joinedRead.tokens)
  assert.notEqual(secondSplit.tokens, secondRead.tokens)
  assert.deepEqual(firstSplit.tokens, firstRead.tokens)
  assert.deepEqual(secondSplit.tokens, secondRead.tokens)
  assert.equal(cache.counters().entries, 2)
})

test('entry limits evict least recently used lexical payloads', (t) => {
  const f = fixture(t, '# a\n\n# b\n\n# c\n'),
    cache = new MarkdownSemanticCache(syntax, {
      maximumEntries: 2,
      maximumBytes: 1024 * 1024,
    }),
    owners = f.settle(),
    [a, b, c] = headings(owners).map((row) => row.owner.slot),
    firstA = f.read(cache, owners, a),
    firstB = f.read(cache, owners, b)
  assert.equal(f.read(cache, owners, a).tokens, firstA.tokens)
  f.read(cache, owners, c)
  assert.equal(cache.counters().entries, 2)
  assert.equal(cache.counters().evictions, 1)
  assert.equal(f.read(cache, owners, a).tokens, firstA.tokens)
  assert.notEqual(f.read(cache, owners, b).tokens, firstB.tokens)
  assert.equal(cache.counters().evictions, 2)
})

test('byte limits evict payloads independently of entry capacity', (t) => {
  const f = fixture(t, '# alpha\n\n# bravo\n'),
    owners = f.settle(),
    [a, b] = headings(owners).map((row) => row.owner.slot),
    measured = new MarkdownSemanticCache(syntax)
  f.read(measured, owners, a)
  const bytesA = measured.counters().bytes
  measured.clear()
  f.read(measured, owners, b)
  const bytesB = measured.counters().bytes,
    maximumBytes = Math.max(bytesA, bytesB),
    cache = new MarkdownSemanticCache(syntax, {
      maximumEntries: 10,
      maximumBytes,
    }),
    first = f.read(cache, owners, a),
    second = f.read(cache, owners, b)
  assert.equal(cache.counters().entries, 1)
  assert.equal(cache.counters().bytes, bytesB)
  assert.equal(cache.counters().evictions, 1)
  assert.equal(f.read(cache, owners, b).tokens, second.tokens)
  assert.notEqual(f.read(cache, owners, a).tokens, first.tokens)
  assert.equal(cache.counters().entries, 1)
  assert.equal(cache.counters().bytes, bytesA)
  assert.ok(cache.counters().bytes <= maximumBytes)
})

test('oversized values remain readable without retaining or evicting useful entries', (t) => {
  const expectedText = 'large '.repeat(2000).trim(),
    f = fixture(t, `# small\n\n${expectedText}\n`),
    owners = f.settle(),
    [small, large] = [...owners.records()]
      .filter((row) => row.owner.kind !== 'trivia')
      .map((row) => row.owner.slot),
    measured = new MarkdownSemanticCache(syntax)
  f.read(measured, owners, small)
  const bytes = measured.counters().bytes,
    cache = new MarkdownSemanticCache(syntax, {
      maximumEntries: 10,
      maximumBytes: bytes,
    }),
    smallRead = f.read(cache, owners, small),
    firstLarge = f.read(cache, owners, large),
    secondLarge = f.read(cache, owners, large)
  assert.equal(firstLarge.tokens[0].text.length, expectedText.length)
  assert.equal(firstLarge.tokens[0].text, expectedText)
  assert.notEqual(secondLarge.tokens, firstLarge.tokens)
  assert.deepEqual(secondLarge.tokens, firstLarge.tokens)
  assert.equal(f.read(cache, owners, small).tokens, smallRead.tokens)
  assert.equal(cache.counters().oversized, 2)
  assert.equal(cache.counters().evictions, 0)
  assert.equal(cache.counters().entries, 1)
  assert.equal(cache.counters().bytes, bytes)
})

test('long physical headings preserve full-source cache tokens and metadata', (t) => {
  for (const ending of ['\n', '\r\n']) {
    const text = `${'large 😀 '.repeat(2000)}**bold** [ref]`,
      source = ['# small', '', `# ${text}`, '', '[ref]: /target', ''].join(
        ending,
      ),
      full = markdownSourceParser(syntax).lexer(source),
      f = fixture(t, source),
      owners = f.settle(),
      cache = new MarkdownSemanticCache(syntax),
      rows = headings(owners),
      heading = rows[1],
      from = source.indexOf('# large'),
      to = source.indexOf('[ref]: /target')
    assert.equal(rows.length, 2)
    assert.equal(heading.from, from)
    assert.equal(heading.to, from + 2 + text.length)
    assert.equal(f.references.semanticsAvailable(), true)
    assert.equal(f.references.counters().fullParses, 0)
    const reads = [...owners.records()].flatMap(
        (row) => f.read(cache, owners, row.owner.slot) ?? [],
      ),
      read = reads.find((value) => value.region.owner === heading.owner)
    assert.deepEqual(
      reads.flatMap((value) => value.tokens),
      [...full],
    )
    assert.deepEqual(headingText(read), [text])
    assert.equal(read.nonSpace, true)
    assert.equal(read.region.from, from)
    assert.equal(read.region.contentFrom, from)
    assert.equal(read.region.to, to)
    assert.equal(read.region.index, heading.index)
    assert.equal(read.region.endIndex, heading.index)
    assert.deepEqual(read.region.members, [heading.owner])
    assert.equal(read.region.first, false)
    assert.equal(read.region.last, false)
    assert.equal(
      f.store.snapshot().sliceRaw(read.region.from, read.region.to),
      source.slice(from, to),
    )
    assert.equal(read.scope.current(), true)
    assert.deepEqual(read.scope.resolve('ref').value, {
      ...full.links.ref,
      title: full.links.ref.title ?? null,
    })
    assert.equal(f.references.lookup('ref').href, '/target')
    const cached = f.read(cache, owners, heading.owner.slot)
    assert.equal(cached.tokens, read.tokens)
    assert.deepEqual(cached.region, read.region)
    assert.equal(cached.scope.current(), true)
    assert.equal(cache.counters().reads, reads.length)
    assert.equal(cache.counters().hits, 1)
    assert.equal(cache.counters().entries, reads.length)
    assert.ok(cache.counters().bytes > 0)
    assert.equal(f.store.counters().materializations, 0)
  }
})

test('chunk-boundary definitions stay literal in complete heading cache reads', (t) => {
  const text = `${'a'.repeat(4094)}[other]: /fake`,
    source = `# ${text}\n\n[other]`,
    f = fixture(t, source),
    owners = f.settle(),
    cache = new MarkdownSemanticCache(syntax),
    paragraphFrom = source.lastIndexOf('[other]')
  assert.equal(f.references.semanticsAvailable(), true)
  assert.equal(f.references.counters().fullParses, 0)
  assert.equal(f.references.lookup('other'), null)
  const reads = [...owners.records()].flatMap(
    (row) => f.read(cache, owners, row.owner.slot) ?? [],
  )
  assert.deepEqual(
    reads.flatMap((value) => value.tokens),
    [...markdownSourceParser(syntax).lexer(source)],
  )
  assert.deepEqual(
    reads.map(({ region, nonSpace }) => [
      region.from,
      region.contentFrom,
      region.to,
      nonSpace,
    ]),
    [
      [0, 0, paragraphFrom, true],
      [paragraphFrom, paragraphFrom, source.length, true],
    ],
  )
  assert.deepEqual(headingText(reads[0]), [text])
  assert.equal(reads[1].tokens[0].tokens[0].type, 'text')
})

test('owner arenas and grammar configurations cannot reuse foreign cache entries', (t) => {
  const a = fixture(t, '# first\n'),
    b = fixture(t, '# other\n'),
    cache = new MarkdownSemanticCache(syntax),
    aOwners = a.settle(),
    bOwners = b.settle(),
    first = a.read(cache, aOwners, aOwners.get(0).owner.slot),
    other = b.read(cache, bOwners, bOwners.get(0).owner.slot)
  assert.notEqual(aOwners.epoch, bOwners.epoch)
  assert.notEqual(other.tokens, first.tokens)
  assert.deepEqual(headingText(other), ['other'])
  assert.equal(cache.counters().entries, 1)
  assert.notEqual(
    a.read(cache, aOwners, aOwners.get(0).owner.slot).tokens,
    first.tokens,
  )

  const text = '> [!NOTE]\n> body\n\n-# detail\n',
    disabledSyntax = { gfm: false, alerts: false, textExtras: false },
    enabled = fixture(t, text),
    disabled = fixture(t, text, disabledSyntax),
    enabledOwners = enabled.settle(),
    disabledOwners = disabled.settle(),
    enabledCache = new MarkdownSemanticCache(syntax),
    disabledCache = new MarkdownSemanticCache(disabledSyntax),
    enabledRead = enabled.read(
      enabledCache,
      enabledOwners,
      enabledOwners.get(0).owner.slot,
    ),
    disabledRead = disabled.read(
      disabledCache,
      disabledOwners,
      disabledOwners.get(0).owner.slot,
    )
  assert.equal(enabledRead.tokens[0].type, 'githubAlert')
  assert.equal(disabledRead.tokens[0].type, 'blockquote')
  assert.equal(
    enabled.read(enabledCache, enabledOwners, enabledOwners.get(0).owner.slot)
      .tokens,
    enabledRead.tokens,
  )
  assert.equal(
    disabled.read(
      disabledCache,
      disabledOwners,
      disabledOwners.get(0).owner.slot,
    ).tokens,
    disabledRead.tokens,
  )
})

test('cache hits still reject an unmatched reference snapshot', (t) => {
  const f = fixture(t, '# before\n\n# cached\n\n# tail\n'),
    cache = new MarkdownSemanticCache(syntax),
    owners = f.settle(),
    slot = headings(owners)[1].owner.slot,
    before = f.read(cache, owners, slot),
    current = f.edit(0, 0, '# prefix\n\n', false)
  assert.throws(() => f.read(cache, current, slot), /different owner snapshot/)
  assert.equal(cache.counters().entries, 1)
  f.settle()
  assert.equal(f.read(cache, current, slot).tokens, before.tokens)
})

test('cached token trees are immutable and clearing drops retained accounting', (t) => {
  const f = fixture(t, '# **bold** [ref]\n\n[ref]: /target\n'),
    cache = new MarkdownSemanticCache(syntax),
    owners = f.settle(),
    slot = owners.get(0).owner.slot,
    first = f.read(cache, owners, slot)
  assert.throws(
    () => first.tokens.push({ type: 'space', raw: '\n' }),
    TypeError,
  )
  assert.throws(() => {
    first.tokens[0].tokens[0].tokens[0].text = 'corrupted'
  }, TypeError)
  assert.equal(
    f.read(cache, owners, slot).tokens[0].tokens[0].tokens[0].text,
    'bold',
  )
  assert.ok(cache.counters().bytes > 0)
  cache.clear()
  assert.equal(cache.counters().entries, 0)
  assert.equal(cache.counters().bytes, 0)
  assert.notEqual(f.read(cache, owners, slot).tokens, first.tokens)
})
