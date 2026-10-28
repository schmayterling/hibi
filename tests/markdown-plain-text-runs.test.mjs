import assert from 'node:assert/strict'
import test from 'node:test'
import { NodeProp, TreeFragment } from '@lezer/common'
import { getStyleTags, tags } from '@lezer/highlight'
import {
  Emoji,
  GFM,
  parseCode,
  parser,
  Subscript,
  Superscript,
} from '@lezer/markdown'
import { obsidianSyntax } from '../src/addons/markdown/formatted-syntax.ts'
import { inlineMathSyntax } from '../src/addons/math/formatted-syntax.ts'
import { subscriptSyntax } from '../src/addons/text-extras/formatted-syntax.ts'
import { ChunkedMarkdownParser } from '../src/shared/chunked-markdown.ts'
import { FrontmatterParser } from '../src/shared/frontmatter-parser.ts'
import { Footnotes } from '../src/shared/markdown-extra-syntax.ts'
import { createPlainTextRunExtension } from '../src/shared/markdown-plain-text-runs.ts'

const optimize = (baseline) => {
  const fast = createPlainTextRunExtension()
  const optimized = baseline.configure(fast.extension)
  fast.allow(optimized)
  return optimized
}

const shape = (tree) => {
  const result = []
  tree.iterate({
    enter(node) {
      result.push([node.name, node.from, node.to])
    },
  })
  return result
}

const sameTree = (baseline, optimized, source) => {
  assert.deepEqual(
    shape(optimized.parse(source)),
    shape(baseline.parse(source)),
    JSON.stringify(source),
  )
}

test('disabling read tracking retains the approved plain text shortcut', () => {
  const runs = createPlainTextRunExtension()
  let calls = 0
  const full = parser.configure([
    runs.extension,
    {
      parseInline: [
        {
          name: 'ProbePlainText',
          after: 'Escape',
          parse() {
            calls++
            return -1
          },
        },
      ],
    },
  ])
  runs.allow(full)
  const chunks = new ChunkedMarkdownParser(full, parser, {
    trackReadAhead: false,
  })
  const source = 'ordinary words '.repeat(20000)
  assert.deepEqual(
    shape(chunks.full.parse(source)),
    shape(parser.parse(source)),
  )
  assert.ok(calls < source.length / 100, String(calls))
})

const inlineCases = [
  '',
  'ordinary words with numbers 0123456789',
  'spaces  between\twords and trailing spaces  ',
  'plain\nline\r\nnext\rfinal',
  'two spaces  \nhard break',
  'two spaces  \r\nhard break',
  'three spaces   \nhard break',
  'escaped\\\nhard break',
  'tab\t\nsoft break',
  'space tab \t \nsoft break',
  '*italic* **bold** ***both*** _other_ __strong__ a_b_c',
  'plain***adjacent***plain __bold *inner*__ tail',
  '`inline` ``a ` backtick`` and ```three```',
  '[label](https://example.com "title") ![alt](/image.png)',
  '[[nested] text](<https://example.com/a(b)>) [ref][id] [id][]',
  '[unclosed ![image and ] unmatched ) brackets',
  '<https://example.com/a> <hello@example.com> <not a link>',
  '<span title="a > b">inline &amp; html</span><!-- comment -->',
  '&amp; &#38; &#x1F600; &#0; &unknown; &amp no-semicolon',
  '\\*literal\\* \\_literal\\_ \\[label\\] \\`code\\` \\$math\\$',
  '$math$ $$math$$ \\(math\\) \\[math\\] currency $12.50',
  '~~deleted~~ ~subscript~ ^superscript^ :smile: :not-emoji:',
  'a|b : {brace} (parenthesis) + - = / ? ; , . ! @ %',
  '中文 日本語 한글 русский العربية עברית café naïve',
  '😀🧑🏽‍💻e\u0301 🇵🇭 punctuation—“quote”…，。«text»',
  'nonbreaking\u00a0space\u202fthin\u2009space\u200bzero-width',
  'lone high \ud800 and low \udc00 surrogates',
]

test('plain text runs preserve core trees and exact ranges across inline and block contexts', () => {
  const optimized = optimize(parser)
  for (const source of inlineCases) {
    for (const wrap of [
      (value) => value,
      (value) => `# ${value}\n`,
      (value) => `> ${value.replaceAll('\n', '\n> ')}\n`,
      (value) => `- ${value.replaceAll('\n', '\n  ')}\n`,
      (value) => `before\n\n${value}\n\n[id]: /destination\n`,
    ]) {
      sameTree(parser, optimized, wrap(source))
    }
  }
  for (let code = 0; code < 128; code++) {
    sameTree(
      parser,
      optimized,
      `ordinary${String.fromCharCode(code)}text *emphasis* tail`,
    )
  }
})

const autolinks = [
  'www.example.com',
  'www.example.com/path?a=1&b=2#section',
  'http://example.com',
  'https://example.com/a_(b)',
  'HTTP://example.com',
  'mailto:hello@example.com',
  'xmpp:hello@example.com/resource',
  'hello@example.com',
  'first.last+tag@example.co.uk',
  'with_under_score@example.com',
  '_leading@example.com',
  'trailing_@example.com',
  'one-two@example.com',
  'first..last@example.com',
  'www.',
  'www..example.com',
  'http:/example.com',
  'https://',
  'mailto:no-domain',
  'xmpp:invalid',
  '@example.com',
  'hello@',
  'hello@localhost',
  'hello@example.c',
  'hello@under_score.example.com',
  `${'a'.repeat(100)}@example.com`,
  `${'a'.repeat(101)}@example.com`,
  `${'a'.repeat(255)}@example.com`,
  `${'a_'.repeat(80)}b@example.com`,
]

test('plain text runs preserve GFM autolinks, including invalid and embedded candidates', () => {
  for (const baseline of [parser, parser.configure(GFM)]) {
    const optimized = optimize(baseline)
    for (const candidate of autolinks) {
      for (const [before, after] of [
        ['', ''],
        ['ordinary ', ' tail'],
        ['ordinary', 'suffix'],
        ['(', ').'],
        ['_', '_'],
        ['[', '](/other)'],
        ['<', '>'],
        ['é😀', ','],
        ['! ', '&amp;'],
      ]) {
        sameTree(baseline, optimized, `${before}${candidate}${after}`)
      }
    }
    for (const source of [
      '| first | second |\n| --- | --- |\n| www.example.com | a_b@c.com |',
      '- [x] www.example.com\n- [ ] mailto:a@b.com\n',
      '~~www.example.com~~ **a_b@example.com** : http://example.com',
    ]) {
      sameTree(baseline, optimized, source)
    }
  }
})

test('plain text runs preserve known subscript, superscript and emoji extensions', () => {
  const baseline = parser.configure([GFM, Subscript, Superscript, Emoji])
  const optimized = optimize(baseline)
  for (const source of [
    ...inlineCases,
    'before~sub~after before^super^after before:smile:after',
    'a~sub\\ script~b a^super\\ script^b :a_b12: :bad-name:',
    '~~strike ~sub~ ^super^ :smile:~~ and ~a\nb~ ^a\nb^',
    '[~sub~ ^super^ :smile:](https://example.com)',
    ':www.example.com: ^hello@example.com^ ~a_b@example.com~',
  ]) {
    sameTree(baseline, optimized, source)
  }
})

test('plain text runs preserve the inline syntax of bundled formatted view contributions', () => {
  const baseline = parser.configure([
    GFM,
    Footnotes,
    subscriptSyntax,
    inlineMathSyntax,
    obsidianSyntax,
  ])
  const optimized = optimize(baseline)
  for (const source of [
    ...inlineCases,
    'prose ==highlight== tail [[Target|label]] ![[photo.png|20]]',
    'a==b==c ===a=== ==a == \\==literal== `==code==` text == spaced ==',
    '[[a]][[b]] ![[a]]![[b.png]] [[a|b|c]] [link [[inner]]](url)',
    '**==bold==** ==a [[b]] c== ==&lt;tag&gt;== [[Other|&amp;]]',
    'two  \n==hard break== ==a\nb== [[a\nb]]',
    '> quoted [[a]]\n- listed ==b==\n# heading ![[c.png]]',
    'note[^1] [^a b] ~sub~ H~2~O ~~strike~~ ~~~a~~~ $x^2$ $$y$$ \\$5 a$b$c',
    '[^1]: defined ==here== $z$ ~s~\n\n| ==a== | $b$ |\n| - | - |\n| [[c]] | ~d~ |',
  ]) {
    sameTree(baseline, optimized, source)
  }
  // Random text over the syntax's characters and the text around them.
  let state = 7
  const random = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    return state / 0x7fffffff
  }
  const alphabet = '[[]]==!|$~^ a\\`\n'
  for (let run = 0; run < 2000; run++) {
    let source = ''
    for (let index = 2 + Math.floor(random() * 14); index > 0; index--)
      source += alphabet[Math.floor(random() * alphabet.length)]
    sameTree(baseline, optimized, source)
  }
})

test('approved plain text runs skip later inline probes while preserving punctuation boundaries', () => {
  let calls = 0
  const baseline = parser.configure([
    GFM,
    {
      parseInline: [
        {
          name: 'CountOrdinaryText',
          after: 'Escape',
          parse() {
            calls++
            return -1
          },
        },
      ],
    },
  ])
  const optimized = optimize(baseline)
  const source = `${'ordinary'.repeat(512)}, *emphasis* ${'z'.repeat(1024)}.\n`
  const expected = shape(baseline.parse(source))
  const baselineCalls = calls
  calls = 0
  assert.deepEqual(shape(optimized.parse(source)), expected)
  assert.ok(baselineCalls > 4000)
  assert.ok(calls < 50, `later inline parsers called ${calls} times`)
})

test('frontmatter wrappers preserve approved parser identity and ordinary text skipping', () => {
  let calls = 0
  const baseline = parser.configure([
    GFM,
    {
      defineNodes: [{ name: 'Frontmatter', block: true }],
      parseInline: [
        {
          name: 'CountOrdinaryText',
          after: 'Escape',
          parse() {
            calls++
            return -1
          },
        },
      ],
    },
  ])
  const optimized = optimize(baseline)
  const prefix = '---\ntitle: frontmatter\n---\n\n'
  const source = `${prefix}${'ordinary'.repeat(512)}, *emphasis* ${'z'.repeat(1024)}.\n`
  const expected = shape(
    new FrontmatterParser(baseline, prefix.length).parse(source),
  )
  const baselineCalls = calls
  calls = 0
  const actual = shape(
    new FrontmatterParser(optimized, prefix.length).parse(source),
  )
  assert.deepEqual(actual, expected)
  assert.deepEqual(
    actual.find(([name]) => name === 'Frontmatter'),
    ['Frontmatter', 0, prefix.length],
  )
  assert.ok(baselineCalls > 4000)
  assert.ok(calls < 50, `wrapped inline parsers called ${calls} times`)
})

test('frontmatter wrapper reuse preserves preexisting custom node groups and styles', () => {
  for (const group of [undefined, ['CustomFrontmatter']]) {
    const baseline = parser.configure({
      defineNodes: [
        { name: 'Frontmatter', block: false, style: tags.annotation },
      ],
      props: group ? [NodeProp.group.add({ Frontmatter: group })] : [],
    })
    const previouslyConfigured = baseline.configure({
      defineNodes: [{ name: 'Frontmatter', block: true }],
    })
    const prefix = '---\ntitle: custom node\n---\n\n'
    const source = `${prefix}ordinary *body*\n`
    const actual = new FrontmatterParser(baseline, prefix.length).parse(source)
    const expected = new FrontmatterParser(
      previouslyConfigured,
      prefix.length,
    ).parse(source)
    const type = baseline.nodeSet.types.find(
      (node) => node.name === 'Frontmatter',
    )
    assert.deepEqual(shape(actual), shape(expected))
    assert.equal(actual.topNode.firstChild.type, type)
    assert.deepEqual(actual.topNode.firstChild.type.prop(NodeProp.group), group)
    assert.deepEqual(
      actual.topNode.firstChild.type.prop(NodeProp.group),
      expected.topNode.firstChild.type.prop(NodeProp.group),
    )
    assert.deepEqual(getStyleTags(actual.topNode.firstChild)?.tags, [
      tags.annotation,
    ])
    assert.deepEqual(
      getStyleTags(actual.topNode.firstChild),
      getStyleTags(expected.topNode.firstChild),
    )
  }
})

test('plain text runs preserve public inline parsing at nonzero source offsets', () => {
  const baseline = parser.configure([GFM, Subscript, Superscript, Emoji])
  const optimized = optimize(baseline)
  const elements = (markdown, text, offset) =>
    markdown
      .parseInline(text, offset)
      .map((element) => [
        markdown.nodeSet.types[element.type].name,
        element.from,
        element.to,
      ])
  for (const source of [...inlineCases, ...autolinks]) {
    for (const offset of [0, 1, 73, 8192]) {
      assert.deepEqual(
        elements(optimized, source, offset),
        elements(baseline, source, offset),
        `${offset}: ${JSON.stringify(source)}`,
      )
    }
  }
})

test('plain text runs preserve nested trees through public code parsing wrappers', () => {
  const nested = parser.configure([GFM, Subscript, Superscript, Emoji])
  const baseline = parser.configure([
    GFM,
    parseCode({ codeParser: () => nested, htmlParser: nested }),
  ])
  const optimized = optimize(baseline)
  for (const source of [
    '# outer\n\n```markdown\n# inner\n\nwww.example.com **strong**\n```\n',
    '    # indented heading\n    \n    hello@example.com :smile:\n',
    '<div>**inner** hello@example.com</div>\n\nordinary *tail*',
    'ordinary <span>**inner**</span> *tail*',
  ]) {
    sameTree(baseline, optimized, source)
  }
})

test('reconfigured parsers preserve later letter-start inline addons without reapproval', () => {
  const addon = {
    defineNodes: ['HibiWord'],
    parseInline: [
      {
        name: 'HibiWord',
        after: 'Escape',
        parse(cx, next, pos) {
          return next === 104 && cx.slice(pos, pos + 4) === 'hibi'
            ? cx.addElement(cx.elt('HibiWord', pos, pos + 4))
            : -1
        },
      },
    ],
  }
  const optimized = optimize(parser.configure(GFM)).configure(addon)
  const baseline = parser.configure([GFM, addon])
  const source = 'ordinary hibi text prehibipost **hibi** [hibi](/hibi)'
  assert.equal(
    shape(baseline.parse(source)).filter(([name]) => name === 'HibiWord')
      .length,
    4,
  )
  sameTree(baseline, optimized, source)
  sameTree(baseline, optimized.configure({}), source)
})

test('plain text runs preserve incremental trees through delimiter and URL edits', () => {
  for (const baseline of [
    parser,
    parser.configure(GFM),
    parser.configure([GFM, Subscript, Superscript, Emoji]),
  ]) {
    const optimized = optimize(baseline)
    let source = (
      '# heading\n\nordinary text *styled* with www.example.com\n\n' +
      '> quoted plain text\n\n- item :smile: and a_b@example.com\n\n'
    ).repeat(24)
    let tree = optimized.parse(source)
    const insertions = [
      '*',
      '**bold**',
      '\n\n',
      'www.example.com',
      'a_b@example.com',
      '[text](/link)',
      '`',
      '\\',
      '&amp;',
      '<b>',
      '😀',
      ':smile:',
    ]
    for (let step = 0; step < 36; step++) {
      const from = (step * 131 + 19) % (source.length + 1)
      const to = Math.min(source.length, from + (step % 4))
      const insert = insertions[step % insertions.length]
      const fragments = TreeFragment.applyChanges(
        TreeFragment.addTree(tree),
        [{ fromA: from, toA: to, fromB: from, toB: from + insert.length }],
        0,
      )
      source = source.slice(0, from) + insert + source.slice(to)
      tree = optimized.parse(source, fragments)
      assert.deepEqual(
        shape(tree),
        shape(baseline.parse(source)),
        `edit ${step}`,
      )
    }
  }
})
