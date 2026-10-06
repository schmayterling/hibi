import assert from 'node:assert/strict'
import test from 'node:test'
import { GFM, parser } from '@lezer/markdown'
import { Marked } from 'marked'
import { FrontmatterSourceModel } from '../src/shared/frontmatter-source-model.ts'
import {
  contextualTokens,
  MarkdownSemanticLexer,
  sameSemanticInput,
  semanticRegion,
} from '../src/shared/markdown-semantic-tokens.ts'
import { MarkdownSourceModel } from '../src/shared/markdown-source-model.ts'
import {
  MarkdownSourceReferences,
  markdownSourceParser,
} from '../src/shared/markdown-source-references.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'
import { SourceOrderPoints } from '../src/shared/source-order-points.ts'
import { SourceOwners } from '../src/shared/source-owners.ts'

const finish = (work) => {
  for (;;) {
    const step = work.next()
    if (step.done) return step.value
  }
}
function fixture(
  t,
  text,
  frontmatter = false,
  syntax = { gfm: true, alerts: true, textExtras: true },
) {
  const store = new SourceStore(text, { tabId: 'semantic', revision: 0 })
  const Model = frontmatter ? FrontmatterSourceModel : MarkdownSourceModel
  const model = new Model(store.snapshot(), parser.configure(GFM), 'gfm')
  const refs = new MarkdownSourceReferences(syntax),
    lexer = new MarkdownSemanticLexer(syntax)
  t.after(() => {
    refs.dispose()
    model.dispose()
  })
  const settle = (updateReferences = true) => {
    while (!model.advance().complete) {}
    const owners = model.state().owners
    if (updateReferences) finish(refs.update(store.snapshot(), owners))
    return owners
  }
  const edit = (from, to, insert, updateReferences = true) => {
    const before = store.snapshot(),
      change = store.prepare({
        document: before.document,
        operationId: crypto.randomUUID(),
        baseVersion: before.version,
        contentVersion: before.version + 1,
        origin: 'source',
        historyGroup: 'typing',
        changes: [{ from, to, insert }],
      })
    store.commit(change)
    model.apply(change)
    return settle(updateReferences)
  }
  return { store, model, refs, lexer, settle, edit }
}

test('semantic token reads preserve definition ownership and eager versus deferred references', (t) => {
  const f = fixture(
    t,
    '[early]: /first\r\n\r\n-# [later]\r\n\r\n# [later]\r\n\r\n[later]: /future\r\n\r\n[early]: /duplicate\r\n',
  )
  const owners = f.settle(),
    reads = [...owners.records()].flatMap(
      (row) =>
        f.lexer.read(f.store.snapshot(), owners, row.owner.slot, f.refs) ?? [],
    )
  const tokens = reads.flatMap((read) => read.tokens),
    subtext = tokens.find((token) => token.type === 'subtext'),
    heading = tokens.find((token) => token.type === 'heading')
  assert.deepEqual(
    subtext.tokens.map((token) => token.type),
    ['text'],
  )
  assert.equal(subtext.tokens[0].text, '[later]')
  assert.equal(heading.tokens[0].href, '/future')
  assert.equal(
    tokens.filter((token) => token.type === 'def' && token.tag === 'early')
      .length,
    1,
  )
  assert.ok(reads.every((read) => read.scope.current()))
  const selected = new Set(
    reads.filter((read) => read.nonSpace).map((read) => read.region.owner.slot),
  )
  const bounds = finish(
    SourceOrderPoints.build(owners, (owner) => selected.has(owner.slot)),
  ).bounds()
  for (const read of reads) {
    assert.equal(Object.hasOwn(read.tokens, 'links'), false)
    assert.deepEqual(structuredClone(read.tokens), read.tokens)
    const before = bounds.first.from < read.region.contentFrom,
      after = bounds.last.from > read.region.contentFrom
    const contextual = contextualTokens(read.tokens, before, after)
    assert.equal(
      contextual.length,
      read.tokens.length + Number(before) + Number(after),
    )
  }
  const foreign = new SourceOwners(
    [...owners.records()].map((row) => ({
      kind: row.owner.kind,
      length: row.owner.length,
    })),
  )
  assert.throws(
    () =>
      f.lexer.read(
        f.store.snapshot(),
        foreign,
        foreign.get(0).owner.slot,
        f.refs,
      ),
    /different owner snapshot/,
  )
})

test('prefix shifts preserve untouched semantic input and reference scopes', (t) => {
  const f = fixture(t, '[ref]: /target\n\n' + '# [ref]\n\n'.repeat(1000))
  let owners = f.settle()
  const target = [...owners.records()].filter(
    (row) => row.owner.kind !== 'trivia',
  )[500]
  const before = f.lexer.read(
    f.store.snapshot(),
    owners,
    target.owner.slot,
    f.refs,
  )
  owners = f.edit(0, 0, '# prefix\n\n')
  f.store.counters(true)
  const after = f.lexer.read(
    f.store.snapshot(),
    owners,
    target.owner.slot,
    f.refs,
  )
  assert.ok(sameSemanticInput(before.region, after.region))
  assert.ok(before.scope.current())
  assert.deepEqual(after.tokens, before.tokens)
  assert.equal(after.region.from, before.region.from + 10)
  assert.equal(f.store.counters().materializations, 0)
  assert.ok(f.store.counters().sourceUnitsRead < 100)
  const start = f.store.snapshot().materialize().indexOf('/target')
  f.edit(start, start + 7, '/changed')
  assert.equal(after.scope.current(), false)
})

test('region boundaries preserve indentation and find large whitespace gaps without reading them', () => {
  const gap = '\r\n'.repeat(100000),
    store = new SourceStore('# a' + gap + '  # b', {
      tabId: 'gap',
      revision: 0,
    })
  const owners = new SourceOwners([
    { kind: 'markdown:ATXHeading1', length: 3 },
    { kind: 'trivia', length: gap.length + 2 },
    { kind: 'markdown:ATXHeading1', length: 3 },
  ])
  store.counters(true)
  const first = semanticRegion(
      store.snapshot(),
      owners,
      owners.get(0).owner.slot,
    ),
    last = semanticRegion(store.snapshot(), owners, owners.get(2).owner.slot)
  assert.equal(first.to, 3 + gap.length)
  assert.equal(last.from, first.to)
  assert.equal(last.contentFrom - last.from, 2)
  assert.equal(store.counters().materializations, 0)
  assert.ok(store.counters().sourceUnitsRead < 32)
})

test('frontmatter is opaque to semantic regions and definitions', (t) => {
  const source =
    '---\nvalue: |\n\n  [ref]: /metadata\n---\n\n# [ref]\n\n[ref]: /body\n'
  const f = fixture(t, source, true),
    owners = f.settle()
  assert.equal(
    f.lexer.read(f.store.snapshot(), owners, owners.get(0).owner.slot, f.refs),
    null,
  )
  const reads = [...owners.records()].flatMap(
    (row) =>
      f.lexer.read(f.store.snapshot(), owners, row.owner.slot, f.refs) ?? [],
  )
  assert.ok(reads.every((read) => read.region.from >= owners.get(0).to))
  const links = []
  const markdown = new Marked()
  for (const read of reads)
    markdown.walkTokens(read.tokens, (token) => {
      if (token.type === 'link') links.push(token.href)
    })
  assert.deepEqual(links, ['/body'])
})

test('whitespace-only bodies retain their lexical paragraph context', (t) => {
  for (const frontmatter of [false, true]) {
    const prefix = frontmatter ? '---\nname: empty\n---\n' : '',
      f = fixture(t, prefix + '\n\n\n\n', frontmatter),
      owners = f.settle(),
      reads = [...owners.records()].flatMap(
        (row) =>
          f.lexer.read(f.store.snapshot(), owners, row.owner.slot, f.refs) ??
          [],
      )
    if (frontmatter) {
      // The existing frontmatter projection owns its trailing blank lines.
      assert.equal(owners.get(0).to, prefix.length + 4)
      assert.deepEqual(reads, [])
      continue
    }
    assert.equal(reads.length, 1)
    assert.equal(reads[0].region.from, prefix.length)
    assert.equal(reads[0].region.to, prefix.length + 4)
    assert.equal(reads[0].nonSpace, false)
    assert.deepEqual(reads[0].tokens, [{ type: 'space', raw: '\n\n\n\n' }])
  }
})

test('semantic regions preserve CRLF indentation and nested definition precedence', (t) => {
  const cases = [
    '- [ ]\r\n',
    '- [ ] \r\n',
    '- [x]\r\n',
    '- [ ] a\r\n- [ ]\r\n- bullet\r\n',
    '- parent\r\n  - [ ]\r\n  - [x]\r\n',
    '- [ ]\r\n  - child\r\n',
    '  # [ref]\r\n\r\n> [ref]\r\n>\r\n> [ref]: /quote\r\n\r\n- item\r\n  continuation\r\n\r\n[ref]: /outer\r\n',
    '[ref]: /first\r\n\r\n- [ref]\r\n\r\n  [ref]: /inside\r\n\r\n[ref]: /last\r\n',
    '\r\n\r\n\tcode\r\n\r\n  # indented\r\n',
    '> [!NOTE]\r\n> [ref]\r\n>\r\n> [ref]: /alert\r\n\r\n-# [future]\r\n\r\n[future]: /future\r\n',
  ]
  for (const source of cases) {
    const f = fixture(t, source),
      owners = f.settle(),
      reads = [...owners.records()].flatMap(
        (row) =>
          f.lexer.read(f.store.snapshot(), owners, row.owner.slot, f.refs) ??
          [],
      ),
      markdown = markdownSourceParser({
        gfm: true,
        alerts: true,
        textExtras: true,
      })
    assert.equal(reads[0].region.from, 0)
    assert.equal(reads.at(-1).region.to, source.length)
    for (let index = 1; index < reads.length; index++)
      assert.equal(reads[index - 1].region.to, reads[index].region.from)
    // Compare independent whole-document parsing, including links inside containers.
    assert.equal(
      markdown.parser(reads.flatMap((read) => read.tokens)),
      markdown.parse(source),
      source,
    )
    assert.ok(reads.every((read) => read.scope.current()))
  }
})

test('semantic readers keep built-in syntax options independent across repeated reads', (t) => {
  const source =
    '| a | b |\r\n| - | - |\r\n| [ref] | ~~gone~~ |\r\n\r\n> [!NOTE]\r\n> [ref]\r\n\r\n-# [ref] ==mark==\r\n\r\n[ref]: /target\r\n'
  const readers = Array.from({ length: 8 }, (_, mask) => {
    const syntax = {
      gfm: Boolean(mask & 1),
      alerts: Boolean(mask & 2),
      textExtras: Boolean(mask & 4),
    }
    const f = fixture(t, source, false, syntax)
    return { f, owners: f.settle(), syntax }
  })
  for (const { f, owners, syntax } of [...readers, ...readers.toReversed()]) {
    const tokens = [...owners.records()].flatMap(
        (row) =>
          f.lexer.read(f.store.snapshot(), owners, row.owner.slot, f.refs)
            ?.tokens ?? [],
      ),
      markdown = markdownSourceParser(syntax),
      types = new Set(tokens.map((token) => token.type))
    assert.equal(types.has('table'), syntax.gfm)
    assert.equal(types.has('githubAlert'), syntax.alerts)
    assert.equal(types.has('subtext'), syntax.textExtras)
    assert.equal(markdown.parser(tokens), markdown.parse(source))
  }
})

test('canceling a warm reference update preserves prior reads and rejects unmatched owners', (t) => {
  const f = fixture(t, '[ref]: /old\n\n# [ref]\n\n# tail\n'),
    previous = f.settle(),
    source = f.store.snapshot(),
    slot = [...previous.records()].find(
      (row) => row.owner.kind === 'markdown:ATXHeading1',
    ).owner.slot,
    read = f.lexer.read(source, previous, slot, f.refs),
    current = f.edit(7, 11, '/new', false),
    work = f.refs.update(f.store.snapshot(), current)
  assert.equal(work.next().done, false)
  assert.throws(
    () => f.lexer.read(f.store.snapshot(), current, slot, f.refs),
    /different owner snapshot/,
  )
  work.return()
  assert.ok(read.scope.current())
  assert.deepEqual(
    f.lexer.read(source, previous, slot, f.refs).tokens,
    read.tokens,
  )
  finish(f.refs.update(f.store.snapshot(), current))
  assert.equal(read.scope.current(), false)
  const updated = f.lexer.read(f.store.snapshot(), current, slot, f.refs)
  assert.equal(updated.tokens[0].tokens[0].href, '/new')
  assert.throws(
    () => f.lexer.read(source, previous, slot, f.refs),
    /different owner snapshot/,
  )
})

test('canceling cold reference discovery cannot publish partial semantic reads', (t) => {
  const f = fixture(t, '# [ref]\n\n[ref]: /target\n'),
    owners = f.settle(false),
    slot = owners.get(0).owner.slot,
    work = f.refs.update(f.store.snapshot(), owners)
  assert.equal(work.next().done, false)
  work.return()
  assert.throws(
    () => f.lexer.read(f.store.snapshot(), owners, slot, f.refs),
    /not ready/,
  )
  finish(f.refs.update(f.store.snapshot(), owners))
  const read = f.lexer.read(f.store.snapshot(), owners, slot, f.refs)
  assert.equal(read.tokens[0].tokens[0].href, '/target')
  assert.ok(read.scope.current())
})

test('definition-only blockquotes keep their lazy paragraph continuation inside the quote', (t) => {
  for (const continuation of ['![ref]', 'plain text']) {
    const source = '> [ref]: /quote\n' + continuation,
      f = fixture(t, source),
      owners = f.settle(),
      tokens = [...owners.records()].flatMap(
        (row) =>
          f.lexer.read(f.store.snapshot(), owners, row.owner.slot, f.refs)
            ?.tokens ?? [],
      ),
      text = {
        type: 'text',
        raw: continuation,
        text: continuation,
        escaped: false,
      }
    assert.deepEqual(tokens, [
      {
        type: 'blockquote',
        raw: source,
        text: '[ref]: /quote\n' + continuation,
        tokens: [
          {
            type: 'def',
            tag: 'ref',
            raw: '[ref]: /quote',
            href: '/quote',
            title: undefined,
          },
          {
            type: 'paragraph',
            raw: continuation,
            text: continuation,
            tokens:
              continuation === 'plain text'
                ? [text]
                : [
                    {
                      type: 'image',
                      raw: '![ref]',
                      href: '/quote',
                      title: null,
                      text: 'ref',
                      tokens: [
                        {
                          type: 'text',
                          raw: 'ref',
                          text: 'ref',
                          escaped: false,
                        },
                      ],
                    },
                  ],
          },
        ],
      },
    ])
  }
})

test('adjacent owner edits invalidate their shared semantic input', (t) => {
  const source = '> [ref]: /quote\nfirst text\n\n# tail\n',
    f = fixture(t, source),
    previous = f.settle(),
    anchor = previous.get(0).owner.slot,
    before = f.lexer.read(f.store.snapshot(), previous, anchor, f.refs),
    from = source.indexOf('first'),
    current = f.edit(from, from + 5, 'other'),
    after = f.lexer.read(f.store.snapshot(), current, anchor, f.refs)
  assert.equal(after.region.owner, before.region.owner)
  assert.equal(after.region.members.length, before.region.members.length)
  assert.equal(sameSemanticInput(before.region, after.region), false)
  assert.equal(after.tokens[0].type, 'blockquote')
  assert.equal(
    after.tokens[0].tokens.find((token) => token.type === 'paragraph').text,
    'other text',
  )
  assert.equal(
    before.tokens[0].tokens.find((token) => token.type === 'paragraph').text,
    'first text',
  )
})

test('blank lines split and rejoin semantic anchors without duplicate tokens', (t) => {
  const source = '> [ref]: /quote\nplain text\n\n# tail\n',
    splitAt = source.indexOf('plain text'),
    f = fixture(t, source),
    readAll = (owners) =>
      [...owners.records()].flatMap(
        (row) =>
          f.lexer.read(f.store.snapshot(), owners, row.owner.slot, f.refs) ??
          [],
      ),
    paragraphs = (reads) => {
      const result = []
      for (const read of reads)
        new Marked().walkTokens(read.tokens, (token) => {
          if (token.type === 'paragraph') result.push(token.text)
        })
      return result
    },
    joined = readAll(f.settle()),
    split = readAll(f.edit(splitAt, splitAt, '\n')),
    rejoined = readAll(f.edit(splitAt, splitAt + 1, ''))
  assert.equal(joined.length, 2)
  assert.equal(split.length, 3)
  assert.equal(rejoined.length, 2)
  assert.equal(sameSemanticInput(joined[0].region, split[0].region), false)
  assert.equal(sameSemanticInput(split[0].region, rejoined[0].region), false)
  for (const reads of [joined, split, rejoined])
    assert.deepEqual(paragraphs(reads), ['plain text'])
  assert.deepEqual(
    rejoined.map((read) => read.tokens),
    joined.map((read) => read.tokens),
  )
})

test('non-anchor reads do not rescan a long adjacent semantic group', (t) => {
  const count = 4096,
    line = '[x]: /v',
    store = new SourceStore(`${line}\n`.repeat(count), {
      tabId: 'adjacent',
      revision: 0,
    }),
    owners = new SourceOwners(
      Array.from({ length: count }, () => [
        { kind: 'markdown:LinkReference', length: line.length },
        { kind: 'trivia', length: 1 },
      ]).flat(),
    ),
    rows = [...owners.records()].filter((row) => row.owner.kind !== 'trivia'),
    get = SourceOwners.prototype.get
  let visits = 0
  t.mock.method(SourceOwners.prototype, 'get', function (...args) {
    visits++
    return get.apply(this, args)
  })
  const first = semanticRegion(store.snapshot(), owners, rows[0].owner.slot)
  assert.equal(first.endIndex, rows.at(-1).index)
  assert.equal(
    first.members.filter((owner) => owner.kind !== 'trivia').length,
    count,
  )
  assert.ok(visits < count * 3, `${visits} owner visits`)
  visits = 0
  for (const row of rows.slice(1))
    assert.equal(semanticRegion(store.snapshot(), owners, row.owner.slot), null)
  assert.ok(visits < count * 4, `${visits} owner visits`)
})

test('contiguous heading boundaries keep semantic reads local across neighbor edits', (t) => {
  const count = 4096,
    f = fixture(t, '# x\n'.repeat(count)),
    owners = f.settle(),
    rows = [...owners.records()].filter((row) => row.owner.kind !== 'trivia'),
    get = SourceOwners.prototype.get
  let visits = 0
  t.mock.method(SourceOwners.prototype, 'get', function (...args) {
    visits++
    return get.apply(this, args)
  })
  f.store.counters(true)
  const reads = rows.map((row) => {
    const read = f.lexer.read(
      f.store.snapshot(),
      owners,
      row.owner.slot,
      f.refs,
    )
    assert.equal(read.region.members.length, 1)
    assert.equal(read.region.endIndex, row.index)
    assert.equal(read.region.to - read.region.from, 4)
    assert.equal(read.tokens[0].type, 'heading')
    return read
  })
  assert.ok(visits < count * 6, `${visits} owner visits`)
  assert.equal(f.store.counters().materializations, 0)
  // Includes physical-line boundary checks, while bounding reads per heading.
  assert.ok(f.store.counters().sourceUnitsRead < count * 64)
  const index = count / 2,
    edited = rows[index + 1],
    current = f.edit(edited.from + 2, edited.from + 3, 'y'),
    unchanged = f.lexer.read(
      f.store.snapshot(),
      current,
      rows[index].owner.slot,
      f.refs,
    ),
    changed = f.lexer.read(
      f.store.snapshot(),
      current,
      edited.owner.slot,
      f.refs,
    )
  assert.ok(sameSemanticInput(reads[index].region, unchanged.region))
  assert.equal(
    sameSemanticInput(reads[index + 1].region, changed.region),
    false,
  )
  assert.equal(unchanged.tokens[0].text, 'x')
  assert.equal(changed.tokens[0].text, 'y')
})

test('physical-line regions keep synthetic long-heading fragments together', (t) => {
  const source = `# small\n\n# ${'large '.repeat(2000)}\n`,
    f = fixture(t, source),
    owners = f.settle(),
    rows = [...owners.records()].filter((row) => row.owner.kind !== 'trivia'),
    heading = rows[1],
    region = semanticRegion(f.store.snapshot(), owners, heading.owner.slot)
  assert.equal(heading.owner.kind, 'markdown:ATXHeading1')
  assert.ok(heading.to < source.length - 1)
  assert.equal(region.from, source.indexOf('# large'))
  assert.equal(region.to, source.length)
  assert.ok(region.members.length > 1)
  assert.equal(
    f.store.snapshot().sliceRaw(region.from, region.to),
    source.slice(region.from),
  )
  for (const row of rows.slice(2))
    assert.equal(
      semanticRegion(f.store.snapshot(), owners, row.owner.slot),
      null,
    )
})
