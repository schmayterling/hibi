import assert from 'node:assert/strict'
import test from 'node:test'
import { GFM, parser } from '@lezer/markdown'
import { FrontmatterSourceModel } from '../src/shared/frontmatter-source-model.ts'
import { markdownLink } from '../src/shared/markdown-link.ts'
import { MarkdownSourceModel } from '../src/shared/markdown-source-model.ts'
import {
  MarkdownSourceReferences,
  markdownSourceParser,
} from '../src/shared/markdown-source-references.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'
import { SourceOwners } from '../src/shared/source-owners.ts'

const syntax = { gfm: true, alerts: true, textExtras: true }

const finish = (work) => {
  for (const _ of work) {
    /* Complete the cooperative read. */
  }
}

function fixture(t, text, frontmatter = false) {
  const Model = frontmatter ? FrontmatterSourceModel : MarkdownSourceModel
  const store = new SourceStore(text, { tabId: 'boundaries', revision: 0 }),
    model = new Model(store.snapshot(), parser.configure(GFM), 'gfm'),
    references = new MarkdownSourceReferences(syntax)
  t.after(() => {
    references.dispose()
    model.dispose()
  })
  const prepare = () => {
    while (!model.advance().complete) {}
    return references.update(store.snapshot(), model.state().owners)
  }
  const settle = () => finish(prepare())
  const edit = (from, to, insert, complete = true) => {
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
    text = text.slice(0, from) + insert + text.slice(to)
    const work = prepare()
    if (complete) finish(work)
    return work
  }
  const oracle = () => {
    const first = model.state().owners.get(0),
      body =
        first?.owner.kind === 'markdown:Frontmatter'
          ? text.slice(first.to)
          : text
    const markdown = markdownSourceParser(syntax)
    return new markdown.Lexer({
      ...markdown.defaults,
      tokenizer: null,
    }).lex(body).links
  }
  const check = (expected) => {
    assert.equal(oracle().ref?.href ?? null, expected, 'full Markdown oracle')
    assert.equal(
      references.lookup('ref')?.href ?? null,
      expected,
      'incremental reference index',
    )
  }
  const checkDefinitions = (labels) => {
    const expected = oracle(),
      value = (entry) =>
        entry ? { href: entry.href, title: entry.title ?? null } : null
    for (const label of new Set([...Object.keys(expected), ...labels]))
      assert.deepEqual(
        value(references.lookup(label)),
        value(Object.hasOwn(expected, label) ? expected[label] : null),
        `definition ${label}`,
      )
  }
  settle()
  return { check, checkDefinitions, edit, settle, references, model, store }
}

test('source links resolve whitespace and unicode-folded labels in indexed and fallback definitions', (t) => {
  for (const prefix of ['', '<div>\n\n'])
    for (const [link, definition] of [
      ['[label][ A  B ]', 'a b'],
      ['[label][ Straße ]', 'STRASSE'],
      ['[ẞ]', 'SS'],
      ['[ Straße ][]', 'STRASSE'],
    ]) {
      const f = fixture(t, `${prefix}${link}\n\n[${definition}]: /target`)
      assert.equal(f.references.semanticsAvailable(), !prefix, prefix)
      const target = markdownLink(link)
      assert.equal(
        f.references.lookup(target.label)?.href,
        '/target',
        `${prefix}${link}`,
      )
    }
})

for (const tag of ['script', 'style', 'pre', 'textarea']) {
  const wrong = tag === 'script' ? 'style' : 'script'
  test(`${tag} references stay hidden after a mismatched raw HTML closing tag`, (t) => {
    const text = `<${tag}>\n\n</${wrong}>\n\n[ref]: /hidden\n\n[ref]`
    fixture(t, text).check(null)
  })
  test(`${tag} references become visible only after the matching closing tag`, (t) => {
    const text = `<${tag}>\n\n</${wrong}>\n\n[ref]: /hidden\n\n</${tag}>\n\n[ref]: /visible\n\n[ref]`
    fixture(t, text).check('/visible')
  })
}

const controls = [
  [
    'matching raw HTML close',
    '<script>\n[ref]: /hidden\n</script>\n\n[ref]: /visible',
    '/visible',
  ],
  [
    'case-insensitive raw HTML close',
    '<SCRIPT>\n[ref]: /hidden\n</script>\n\n[ref]: /visible',
    '/visible',
  ],
  ['ordinary HTML blank-line boundary', '<div>\n\n[ref]: /visible', '/visible'],
  [
    'definitions in a lazy list continuation after raw HTML',
    '- <script>\n</script>\n[ref]: /visible\n\n[ref]',
    '/visible',
  ],
  [
    'raw HTML text inside a fence',
    '~~~\n<script>\n[ref]: /hidden\n~~~\n\n[ref]: /visible',
    '/visible',
  ],
  [
    'raw HTML-looking inline text',
    'paragraph <script>\n\n[ref]: /visible',
    '/visible',
  ],
]
for (const [name, text, expected] of controls)
  test(`reference boundaries preserve ${name}`, (t) =>
    fixture(t, text).check(expected))

test('editing raw HTML boundaries invalidates previously visible reference candidates', (t) => {
  const prefix = '<script>\n\n',
    close = '</script>',
    f = fixture(t, `${prefix}${close}\n\n[ref]: /target\n\n[ref]`)
  f.check('/target')
  f.edit(prefix.length, prefix.length + close.length, '</style>')
  f.check(null)
  f.edit(prefix.length, prefix.length + '</style>'.length, close)
  f.check('/target')
})

test('markup fallback excludes frontmatter definitions and markup', (t) => {
  const metadata = '---\nvalue: |\n\n  [ref]: /metadata\n  <script>\n---\n\n',
    body = '[ref]: /body\n\n[ref]',
    plain = fixture(t, metadata + body, true)
  plain.check('/body')
  assert.equal(plain.references.counters().fullParses, 0)
  assert.equal(plain.references.counters().markupOwners, 0)
  const markup = fixture(t, `${metadata}<div>\n\n${body}`, true)
  markup.check('/body')
  assert.equal(markup.references.counters().fullParses, 1)
  assert.equal(
    markup.references.counters().sourceUnits,
    '<div>\n\n'.length + body.length,
  )
})

test('an owner changed from markup to trivia clears fallback membership', (t) => {
  const prefix = '<div>x',
    definition = '[ref]: /target',
    store = new SourceStore(`${prefix}\n\n${definition}`, {
      tabId: 'trivia-boundary',
      revision: 0,
    }),
    references = new MarkdownSourceReferences(syntax)
  t.after(() => references.dispose())
  let owners = new SourceOwners([
    { kind: 'markdown:HTMLBlock', length: prefix.length },
    { kind: 'trivia', length: 2 },
    { kind: 'markdown:LinkReference', length: definition.length },
  ])
  finish(references.update(store.snapshot(), owners))
  assert.equal(references.lookup('ref').href, '/target')
  assert.equal(references.counters(true).markupOwners, 1)
  const before = store.snapshot(),
    change = store.prepare({
      document: before.document,
      operationId: 'remove-markup',
      baseVersion: 0,
      contentVersion: 1,
      origin: 'source',
      historyGroup: 'typing',
      changes: [
        { from: 0, to: prefix.length, insert: ' '.repeat(prefix.length) },
      ],
    }),
    slot = owners.get(0).owner.slot
  store.commit(change)
  owners = owners.update(0, { kind: 'trivia', length: prefix.length })
  assert.equal(owners.get(0).owner.slot, slot)
  finish(references.update(store.snapshot(), owners))
  assert.equal(references.counters().markupOwners, 0)
  assert.equal(references.counters().fullParses, 0)
  assert.equal(references.scope(owners).resolve('ref').value.href, '/target')
})

test('entering markup fallback invalidates old scopes and removing markup restores provenance', (t) => {
  const text = '[ref]: /target\n\n# [ref]',
    f = fixture(t, text),
    old = f.references.scope(f.model.state().owners)
  assert.equal(old.resolve('ref').value.href, '/target')
  assert.ok(old.current())
  const markup = '\n\n<div>'
  f.edit(text.length, text.length, markup)
  assert.equal(old.current(), false)
  assert.throws(() => f.references.scope(), /provenance/)
  f.references.counters(true)
  f.edit(text.length, text.length + markup.length, '')
  const current = f.references.scope(f.model.state().owners)
  assert.equal(current.resolve('ref').value.href, '/target')
  assert.ok(current.current())
  assert.equal(old.current(), false)
  assert.equal(f.references.counters().fullParses, 0)
})

test('canceling a warm markup update preserves the old lookup and retry refreshes it', (t) => {
  const text = '<div>\n\n[ref]: /before\n\n# [ref]',
    f = fixture(t, text),
    at = text.indexOf('/before')
  f.check('/before')
  f.references.counters(true)
  const work = f.edit(at, at + '/before'.length, '/after', false)
  try {
    assert.equal(work.next().done, false)
    assert.equal(f.references.lookup('ref').href, '/before')
    assert.equal(f.references.counters().fullParses, 0)
  } finally {
    work.return()
  }
  assert.equal(f.references.lookup('ref').href, '/before')
  f.settle()
  f.check('/after')
  assert.equal(f.references.counters().fullParses, 1)
  assert.throws(() => f.references.scope(), /provenance/)
})

test('fallback links resolve only own labels, including explicit prototype-like definitions', (t) => {
  const text = '<div>\n\n[ref]: /target',
    f = fixture(t, text)
  for (const label of ['constructor', '__proto__', 'toString'])
    assert.equal(f.references.lookup(label), null)
  f.edit(
    text.length,
    text.length,
    '\n\n[constructor]: /constructor\n[__proto__]: /proto',
  )
  assert.equal(f.references.lookup('constructor').href, '/constructor')
  assert.equal(f.references.lookup('__proto__').href, '/proto')
  assert.equal(f.references.lookup('toString'), null)
})

test('pure reference edits do not trigger whole-source fallback reads', (t) => {
  const text = '[ref]: /first\n\n# [ref]',
    f = fixture(t, text)
  f.check('/first')
  assert.equal(f.references.counters().fullParses, 0)
  const at = text.indexOf('/first')
  f.edit(at, at + '/first'.length, '/second')
  f.check('/second')
  assert.equal(f.references.counters().fullParses, 0)
  assert.equal(f.references.counters().sourceUnits, 0)
  assert.equal(f.references.counters().markupOwners, 0)
})

for (const [name, open, close] of [
  ['double-quoted', '"', '"'],
  ['single-quoted', "'", "'"],
  ['parenthesized', '(', ')'],
])
  for (const [layout, separator] of [
    ['tab-indented', '\n\t'],
    ['four-space-indented', '\n    '],
    ['inline opening', ' '],
  ])
    test(`${layout} ${name} multiline reference titles hide declaration-like text`, (t) => {
      const title = 'title\n[other]: /hidden\nend',
        text = `[ref]: /x${separator}${open}${title}${close}\n\n[other]\n\n[visible]: /outside "outside title"`,
        f = fixture(t, text)
      f.checkDefinitions(['ref', 'other', 'visible', 'missing'])
      assert.deepEqual(f.references.lookup('ref'), { href: '/x', title })
      assert.equal(f.references.lookup('other'), null)
      assert.deepEqual(f.references.lookup('visible'), {
        href: '/outside',
        title: 'outside title',
      })
    })

test('multiline title lookup preserves proven list and quote continuation cases', (t) => {
  const cases = [
    '- [ref]: /x\n\t"title\n[other]: /hidden\nend"\n\n[other]',
    "- [ref]: /x\n    'title\n[other]: /hidden\nend'\n\n[other]",
    '1. [ref]: /x\n    (title\n[other]: /hidden\nend)\n\n[other]',
    '> [ref]: /x\n> \t"title\n> [other]: /hidden\n> end"\n\n[other]',
    '> - [ref]: /x\n>   \t"title\n>   [other]: /hidden\n>   end"\n\n[other]',
    '> [ref]: /x\n\t"title\n[other]: /visible\nend"\n\n[other]',
  ]
  for (const text of cases)
    fixture(t, text).checkDefinitions(['ref', 'other', 'missing'])
})

test('reference lookup follows edits to multiline title closing delimiters', (t) => {
  const text = '[ref]: /x\n\t"title\n[other]: /inside\nend"\n\n[other]',
    f = fixture(t, text),
    close = text.indexOf('end"') + 'end'.length
  f.checkDefinitions(['ref', 'other'])
  assert.equal(f.references.lookup('other'), null)
  f.edit(close, close + 1, '')
  f.checkDefinitions(['ref', 'other'])
  assert.equal(f.references.lookup('other').href, '/inside')
  f.edit(close, close, '"')
  f.checkDefinitions(['ref', 'other'])
  assert.equal(f.references.lookup('other'), null)
  assert.equal(f.references.lookup('ref').title, 'title\n[other]: /inside\nend')
})

test('an indented multiline title can contain heading, rule, and fence-looking lines', (t) => {
  for (const line of ['# heading', '***', '~~~']) {
    const title = `title\n${line}\n[other]: /hidden\nend`,
      f = fixture(t, `[ref]: /x\n\t"${title}"\n\n[other]`)
    f.checkDefinitions(['ref', 'other'])
    assert.deepEqual(f.references.lookup('ref'), { href: '/x', title })
    assert.equal(f.references.lookup('other'), null)
  }
})

test('definitions embedded in long physical lines stay literal across source input chunks', (t) => {
  for (const type of ['paragraph', 'heading', 'fence'])
    for (const at of [4094, 4095, 4096, 4097, 8192, 12288]) {
      const prefix =
          type === 'heading' ? '# ' : type === 'fence' ? '~~~\n' : '',
        suffix = type === 'fence' ? '\n~~~' : '',
        text = `${prefix}${'a'.repeat(at - prefix.length)}[other]: /fake${suffix}\n\n[other]`,
        f = fixture(t, text)
      f.checkDefinitions(['other', 'missing'])
      assert.equal(f.references.lookup('other'), null, `${type} at ${at}`)
    }
})

test('a mid-heading definition cannot shadow a real definition after the physical line', (t) => {
  const text = `# ${'a'.repeat(4094)}[other]: /fake\n\n[other]: /real\n\n[other]`,
    f = fixture(t, text)
  f.checkDefinitions(['other'])
  assert.equal(f.references.lookup('other').href, '/real')
})

test('a newline edit changes a chunk-boundary literal into a real reference definition', (t) => {
  const at = 4096,
    text = `# ${'a'.repeat(at - 2)}[other]: /target\n\n[other]`,
    f = fixture(t, text)
  f.checkDefinitions(['other'])
  assert.equal(f.references.lookup('other'), null)
  f.edit(at, at, '\n')
  f.checkDefinitions(['other'])
  assert.equal(f.references.lookup('other').href, '/target')
  f.edit(at, at + 1, '')
  f.checkDefinitions(['other'])
  assert.equal(f.references.lookup('other'), null)
})
