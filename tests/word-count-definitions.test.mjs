import assert from 'node:assert/strict'
import test from 'node:test'
import { countText } from '../src/addons/word-count/count.ts'
import { countMarkdownSyntax } from '../src/addons/word-count/formatted-count-syntax.ts'
import {
  countParser,
  richText,
  richTokens,
} from '../src/addons/word-count/formatted-text.ts'
import { MarkdownSemanticCache } from '../src/shared/markdown-semantic-cache.ts'
import {
  MarkdownSourceModel,
  metadataParsers,
} from '../src/shared/markdown-worker-parser.ts'
import { defaultNoteSyntax } from '../src/shared/note-syntax.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'
import { SourceReferences } from '../src/shared/source-references.ts'

const syntax = { ...defaultNoteSyntax, frontmatter: false }
const finish = (work) => {
  for (;;) {
    const step = work.next()
    if (step.done) return step.value
  }
}
function fixture(t, text, config = syntax) {
  const store = new SourceStore(text, { tabId: 'definitions', revision: 0 })
  const base = metadataParsers[config.gfm ? 'gfm' : 'commonmark']
  const model = new MarkdownSourceModel(
    store.snapshot(),
    base.configure(countMarkdownSyntax(config)),
    'word-count',
  )
  const parser = countParser(config)
  const cache = new MarkdownSemanticCache(config, undefined, parser)
  let references
  t.after(() => {
    references?.dispose()
    cache.clear()
    model.dispose()
  })
  const read = () => {
    while (!model.advance().complete) {}
    const { source, owners } = model.state()
    references ??= new SourceReferences(owners)
    finish(
      references.updateWork(owners, (region) => {
        return new parser.Lexer({ ...parser.defaults, tokenizer: null }).lex(
          source.sliceRaw(region.from, region.to),
        ).links
      }),
    )
    const total = { words: 0, characters: 0 }
    for (const { owner } of owners.records()) {
      const value = cache.read(source, owners, owner.slot, references)
      if (!value) continue
      const { region } = value
      const count = countText(
        richTokens(value.tokens, config, {
          references: value.scope.links,
          before: region.index > region.leading.length,
          after: !region.last,
        }),
      )
      total.words += count.words
      total.characters += count.characters
    }
    total.characters = Math.max(0, total.characters - 1)
    return total
  }
  const edit = (from, to, insert, origin = 'source') => {
    const before = store.snapshot()
    const prepared = store.prepare({
      document: before.document,
      operationId: crypto.randomUUID(),
      baseVersion: before.version,
      contentVersion: before.version + 1,
      origin,
      historyGroup: 'definitions',
      changes: [{ from, to, insert }],
    })
    store.commit(prepared)
    model.apply(prepared)
  }
  const expected = () => {
    const source = store.snapshot()
    return countText(
      richText(source.sliceRaw(0, source.utf16Length), config).slice(1),
    )
  }
  return { store, model, read, edit, expected }
}

const references = [
  '[ref\n\n]: ht',
  '[re\n\nf]: https://example.test',
  '[ref]: /target "first\n\nlast"',
  "[ref]: /target 'first\nlast'",
  '[ref]: /target (first\n\nlast)',
  '[ref]:\n  /target\n  "first\n\nlast"',
  '[escaped\\]\n\nlabel]: /target',
]
const footnotes = [
  '[^a]: note\n\n    second',
  '[^a]: note\n\nlazy continuation\n\nstill lazy',
  '[^a]: note\n\n\tsecond',
  '[^a]: note\n\n \tsecond\nlazy\n\ncontinued',
  '[^a]: note\n\n    second\n~😀^a]: note',
  '[^a]: note\n\n    second😀H~2~Oword1. one\n2. two',
  '[^a]: note\n\n    cond**<div>\ntext\n</di',
]

test('multiline reference labels and titles retain complete semantic ownership', (t) => {
  for (const gfm of [false, true])
    for (const eol of ['\n', '\r\n'])
      for (const definition of references) {
        const source = `> quote\n\n${definition}\n\nlast`.replaceAll('\n', eol)
        const f = fixture(t, source, { ...syntax, gfm })
        assert.deepEqual(f.read(), f.expected(), JSON.stringify(source))
      }
})

test('footnote ownership follows exact lazy, indented and tabbed continuation grammar', (t) => {
  for (const eol of ['\n', '\r\n'])
    for (const definition of footnotes) {
      const source = `text[^a]\n\n${definition}\n\n# last`.replaceAll('\n', eol)
      const f = fixture(t, source)
      assert.deepEqual(f.read(), f.expected(), JSON.stringify(source))
    }
})

test('definition body, delimiter and distant reference edits survive undo', (t) => {
  for (const definition of [...references, ...footnotes]) {
    const source = `text[^a] [label][ref]\n\n${definition}\n\n# last`
    const f = fixture(t, source)
    assert.deepEqual(f.read(), f.expected(), JSON.stringify(source))
    const start = source.indexOf(definition)
    for (const change of [
      { from: start, to: start + 1, insert: '' },
      { from: start + 2, to: start + 3, insert: '\n\n' },
      {
        from: source.lastIndexOf('last'),
        to: source.length,
        insert: 'body edit',
      },
    ]) {
      const removed = source.slice(change.from, change.to)
      f.edit(change.from, change.to, change.insert)
      assert.deepEqual(f.read(), f.expected(), JSON.stringify(change))
      f.edit(change.from, change.from + change.insert.length, removed, 'undo')
      assert.deepEqual(f.read(), f.expected(), JSON.stringify(source))
      assert.equal(f.store.snapshot().sliceRaw(0, source.length), source)
    }
  }
})

test('adjacent definitions cannot split another definition across owner boundaries', (t) => {
  for (const source of [
    '[a]: /a\n\n[b\n\n]: /b\n\nlast',
    '[broken\n\n[ref\n\n]: /target\n\nlast',
    '[a]: /a\n\n[^b]: first\n\n    second\n\n# last',
    '[^a]: first\n\n    second\n\n[b\n\n]: /b\n\nlast',
    '[a]: /a\n[b]: /b "title\n\nlast"\n\n# end',
  ]) {
    const f = fixture(t, source)
    assert.deepEqual(f.read(), f.expected(), JSON.stringify(source))
  }
})

test('boundary edits expand definitions across blanks and undo restores distant references', (t) => {
  for (const eol of ['\n', '\r\n'])
    for (const [before, after] of [
      ['[ref]: /target\n\n# body', '[ref]: /target\n\n    body'],
      ['[ref]: /target\n"title\n\nend"', '[ref]: /target\nxtitle\n\nend"'],
      [
        '[^a]: note\n\n    second\n\nlast',
        '[^a]: note\n\n    second\n\n    last',
      ],
      ['[^a]: note\n\n# body', '[^a]: note\n\n  body'],
      ['[a]: /a\n\n[b\n\n]: /b\n\nlast', '[a]: /a\n\nxb\n\n]: /b\n\nlast'],
    ]) {
      const prefix = `text[^a] [label][ref]${eol}${eol}`
      const source = prefix + before.replaceAll('\n', eol)
      const changed = prefix + after.replaceAll('\n', eol)
      const f = fixture(t, source)
      assert.deepEqual(f.read(), f.expected(), JSON.stringify(source))
      let start = 0
      while (source[start] === changed[start]) start++
      let end = source.length,
        changedEnd = changed.length
      while (source[end - 1] === changed[changedEnd - 1]) {
        end--
        changedEnd--
      }
      f.edit(start, end, changed.slice(start, changedEnd))
      assert.deepEqual(f.read(), f.expected(), JSON.stringify(changed))
      f.edit(start, changedEnd, source.slice(start, end), 'undo')
      assert.deepEqual(f.read(), f.expected(), JSON.stringify(source))
    }
})

test('syntax switches and non-definition containers retain projection behavior', (t) => {
  for (const config of [
    syntax,
    { ...syntax, gfm: false },
    { ...syntax, disabledFeatures: ['core.links', 'core.code-blocks'] },
  ])
    for (const source of [
      'before\n\n[^a]: note\n\n    second\n\n# last',
      'before\n\n> [ref]: /target\n>\n> body\n\nlast',
      '- [^a]: note\n\n    second\n\nlast',
      '```\n[ref\n\n]: /target\n```\n\nlast',
      '    [ref]: /target\n\nlast',
      '[[Target|alias]]\n\nbody',
      '[literal]\n\nbody',
      '[ref]: <broken\n\nbody',
      '[ref]: /target "broken\n\nbody',
    ]) {
      const f = fixture(t, source, config)
      assert.deepEqual(f.read(), f.expected(), JSON.stringify(source))
    }
})

test('ordinary body edits reuse definition owners and keep parser reads local', (t) => {
  const unit = '[ref\n\nlabel]: /target "first\n\nlast"\n\n# body\n\n'
  const source = unit.repeat(2000)
  const f = fixture(t, source)
  assert.deepEqual(f.read(), f.expected())
  const owners = f.model.state().owners
  const unchanged = [...owners.records()].find(
    (row) => row.owner.kind !== 'trivia',
  ).owner
  f.model.counters(true)
  const from = source.indexOf('body', source.length / 2)
  f.edit(from, from + 4, 'local words')
  assert.deepEqual(f.read(), f.expected())
  const work = f.model.counters()
  assert.ok(f.model.state().owners.bySlot(unchanged.slot)?.owner === unchanged)
  assert.ok(work.parser.readUnits < 8192, JSON.stringify(work))
  assert.ok(work.regions < 16, JSON.stringify(work))
})
