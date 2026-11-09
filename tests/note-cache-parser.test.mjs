import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { InlineContext, MarkdownParser } from '@lezer/markdown'
import { createServer } from 'vite'
import { Parser as YAMLParser } from 'yaml'
import { noteReferences } from '../src/shared/note-links.ts'
import { noteHeadings } from '../src/shared/note-metadata.ts'
import { defaultNoteSyntax } from '../src/shared/note-syntax-config.ts'
import { noteTags } from '../src/shared/note-tags.ts'

const cacheDir = await mkdtemp(join(tmpdir(), 'hibi-note-cache-'))
const server = await createServer({
  configFile: false,
  cacheDir,
  server: { middlewareMode: true, watch: null, hmr: false, ws: false },
  optimizeDeps: { noDiscovery: true, include: [] },
})
after(async () => {
  await server.close()
  await rm(cacheDir, { recursive: true, force: true })
})
const { noteCacheParse, noteCacheEntries } = await server.ssrLoadModule(
  '/src/shared/note-cache-parser.ts',
)
const { metadataParsers } = await server.ssrLoadModule(
  '/src/shared/markdown-worker-parser.ts',
)
const { boundarySyntax } = await server.ssrLoadModule(
  '/src/shared/markdown-boundary-syntax.ts',
)
const entries = (source, syntax = defaultNoteSyntax) => [
  ...noteCacheEntries(source, syntax),
]
const values = (rows, kind) =>
  rows.filter((row) => row.kind === kind).map((row) => row.value)
const raw = (source, value) =>
  source.slice(value.position.start.offset, value.position.end.offset)
function location(source, offset) {
  const before = source.slice(0, offset)
  const breaks = [...before.matchAll(/\r\n|\r|\n/g)]
  return {
    line: breaks.length,
    col:
      offset -
      (breaks.at(-1) ? breaks.at(-1).index + breaks.at(-1)[0].length : 0),
    offset,
  }
}
function positioned(source, row) {
  const { start, end } = row.value.position
  assert.ok(start.offset <= end.offset)
  assert.deepEqual(start, location(source, start.offset))
  assert.deepEqual(end, location(source, end.offset))
}

test('rich cache keeps raw crlf/bom/utf16 positions and nested block ownership', () => {
  const source =
    '\uFEFF# **hé😀** [[target|alias]]\r\n\r\n> - [x] #Raw/Tag [local](./a.md) ^item\r\n>   - child ![[image.png|alt]]\r\n\r\nparagraph 😀\r\nsecond ^para\r\n'
  const rows = entries(source)
  for (const row of rows) positioned(source, row)
  const heading = values(rows, 'heading')[0]
  assert.equal(heading.depth, 1)
  assert.equal(heading.text, 'hé😀 alias')
  assert.equal(heading.position.start.offset, 1)
  assert.equal(raw(source, heading), '# **hé😀** [[target|alias]]')
  assert.deepEqual(
    values(rows, 'link').map((link) => [link.link, link.original]),
    [
      ['target', '[[target|alias]]'],
      ['./a.md', '[local](./a.md)'],
    ],
  )
  assert.equal(values(rows, 'embed')[0].original, '![[image.png|alt]]')
  assert.equal(values(rows, 'tag')[0].tag, '#Raw/Tag')
  const items = values(rows, 'listItem')
  assert.equal(items[0].parent, -2)
  assert.equal(items[0].task, 'x')
  assert.equal(items[0].id, 'item')
  assert.equal(items[1].parent, items[0].position.start.line)
  const blocks = values(rows, 'block')
  assert.equal(
    blocks.find((block) => block.id === 'item').position.start.offset,
    items[0].position.start.offset,
  )
  assert.equal(
    raw(
      source,
      blocks.find((block) => block.id === 'para'),
    ),
    'paragraph 😀\r\nsecond ^para',
  )
})

test('one tree powers all entries and reuse never reparses markdown', () => {
  const source = '# Heading\n\n[a][ref] [[wiki]] #Tag\n\n[ref]: ./a.md'
  const parsed = noteCacheParse(source)
  const first = [...noteCacheEntries(source, defaultNoteSyntax, parsed)]
  const saved = MarkdownParser.prototype.createParse
  MarkdownParser.prototype.createParse = () => {
    throw Error('second parse')
  }
  try {
    assert.deepEqual(
      [...noteCacheEntries(source, defaultNoteSyntax, parsed)],
      first,
    )
  } finally {
    MarkdownParser.prototype.createParse = saved
  }
  assert.equal(values(first, 'link')[0].link, './a.md')
  assert.deepEqual(parsed.flags, {
    references: true,
    headings: true,
    frontmatter: true,
    properties: true,
  })
})

test('yaml mapping retains nested values and positioned property links once', () => {
  const source =
    '\uFEFF---\r\nnested:\r\n  target: "[[Notes/😀|alias]]"\r\n  list:\r\n    - "[local](./a.md)"\r\n    - { next: "![[image.png]]" }\r\ncopy: &copy { rating: 3 }\r\nalias: *copy\r\n---\r\n# Body'
  const parsed = noteCacheParse(source)
  const rows = [...noteCacheEntries(source, defaultNoteSyntax, parsed)]
  for (const row of rows) positioned(source, row)
  const fm = values(rows, 'frontmatter')[0]
  assert.equal(fm.values.nested.target, '[[Notes/😀|alias]]')
  assert.deepEqual(fm.values.alias, { rating: 3 })
  assert.equal(fm.position.start.offset, 0)
  assert.ok(raw(source, fm).endsWith('---'))
  assert.equal(parsed.flags.frontmatter, true)
  assert.equal(parsed.flags.properties, false)
  assert.deepEqual(
    values(rows, 'frontmatterLink').map((link) => [
      link.key,
      link.link,
      raw(source, link),
    ]),
    [
      ['nested.target', 'Notes/😀', '[[Notes/😀|alias]]'],
      ['nested.list.0', './a.md', '[local](./a.md)'],
      ['nested.list.1.next', 'image.png', '![[image.png]]'],
    ],
  )
  assert.equal(values(rows, 'link').length, 0)
  assert.equal(values(rows, 'heading')[0].text, 'Body')
})

test('invalid/incomplete/non-mapping yaml and alias bombs report incomplete', () => {
  for (const source of [
    '---\nbad: [\n---\n# Body',
    '---\n- sequence\n---\n# Body',
    '---\nbad: unfinished\n',
    `---\na: &a one\nlist: [${Array(60).fill('*a').join(', ')}]\n---\nbody`,
    '---\na: 1\na: 2\n---\nbody',
  ]) {
    const parsed = noteCacheParse(source)
    assert.equal(parsed.flags.frontmatter, false, source)
    assert.equal(parsed.flags.properties, false, source)
    assert.equal(
      values(
        [...noteCacheEntries(source, defaultNoteSyntax, parsed)],
        'frontmatter',
      ).length,
      0,
    )
  }
})

test('grammar excludes code/math/html/escapes/highlights from references, tags and ids', () => {
  const source = [
    '~~~md',
    '[[code]] #code ^code',
    '~~~',
    '',
    '    [[indent]] #indent ^indent',
    '',
    '`[[inline]] #inline ^inline`',
    '',
    '$[[math]] #math ^math$',
    '',
    '$$',
    '[[display]] #display ^display',
    '$$',
    '',
    '<div>',
    '[[html]] #html ^html',
    '</div>',
    '',
    '==[[highlight]] #highlight ^highlight==',
    '',
    '\\#escaped \\^escaped #Visible [[real]] ^real',
  ].join('\n')
  const rows = entries(source)
  assert.deepEqual(
    values(rows, 'link').map((link) => link.link),
    ['real'],
  )
  assert.deepEqual(
    values(rows, 'tag').map((tag) => tag.tag),
    ['#highlight', '#Visible'],
  )
  assert.deepEqual(
    values(rows, 'block').map((block) => block.id),
    ['real'],
  )
  assert.ok(values(rows, 'section').some((section) => section.type === 'code'))
})

test('sections follow existing grammar boundaries and block ids resolve deterministically', () => {
  const source = [
    '# H',
    '',
    'paragraph ^same',
    '',
    'again ^same',
    '',
    '> [!note] Title',
    '> body',
    '',
    '- item',
    '',
    '| h |',
    '| - |',
    '| c |',
    '',
    '~~~',
    'code',
    '~~~',
  ].join('\n')
  const rows = entries(source)
  assert.deepEqual(
    values(rows, 'block')
      .filter((block) => block.id === 'same')
      .map((block) => raw(source, block)),
    ['paragraph ^same'],
  )
  assert.deepEqual(
    values(rows, 'section').map((section) => section.type),
    ['heading', 'paragraph', 'paragraph', 'callout', 'list', 'table', 'code'],
  )
  const tree = metadataParsers.gfm
    .configure([
      boundarySyntax['obsidian@1'],
      boundarySyntax['empty-tasks@1'],
      boundarySyntax['github-alerts@1'],
      boundarySyntax['math-inline@1'],
      boundarySyntax['math-block@1'],
    ])
    .parse(source)
  const expected = []
  for (let node = tree.topNode.firstChild; node; node = node.nextSibling)
    expected.push([node.from, node.to])
  assert.deepEqual(
    values(rows, 'section').map((section) => [
      section.position.start.offset,
      section.position.end.offset,
    ]),
    expected,
  )
})

test('settings preserve disabled syntax and task-vs-bullet precedence', () => {
  const source =
    '# [hidden](a.md) #hidden\n\n- [ ] [[next]] #todo\n\n[shown](b.md) #shown'
  const rows = entries(source, {
    ...defaultNoteSyntax,
    disabledFeatures: ['core.heading-1', 'markdown.tasks'],
  })
  assert.deepEqual(values(rows, 'heading'), [])
  assert.deepEqual(
    values(rows, 'link').map((link) => link.link),
    ['b.md'],
  )
  assert.deepEqual(
    values(rows, 'tag').map((tag) => tag.tag),
    ['#shown'],
  )
  const task = entries('- [ ] [[next]] #todo', {
    ...defaultNoteSyntax,
    disabledFeatures: ['core.bullet-lists'],
  })
  assert.equal(values(task, 'link')[0].link, 'next')
  assert.equal(values(task, 'tag')[0].tag, '#todo')
  assert.equal(
    values(
      entries('[[literal]] #tag', {
        ...defaultNoteSyntax,
        wikilinks: false,
        hashtags: false,
      }),
      'tag',
    ).length,
    0,
  )
})

test('reference forms resolve definitions and never invent unresolved destinations', () => {
  const source =
    '[a][ref] [missing] [empty]() ![img](a.png) <x@example.com> www.example.com\n\n[ref]: <./a.md> "Title"'
  const rows = entries(source)
  assert.deepEqual(
    values(rows, 'link').map((link) => link.link),
    ['./a.md', '', 'mailto:x@example.com', 'http://www.example.com'],
  )
  assert.equal(values(rows, 'embed')[0].link, 'a.png')
})

test('single markdown and yaml parse covers body and property references', () => {
  const markdown = MarkdownParser.prototype.createParse
  const yaml = YAMLParser.prototype.parse
  let markdownCount = 0,
    yamlCount = 0
  MarkdownParser.prototype.createParse = function (...args) {
    markdownCount++
    return markdown.apply(this, args)
  }
  YAMLParser.prototype.parse = function (...args) {
    yamlCount++
    return yaml.apply(this, args)
  }
  try {
    const source = '---\nnested: {link: "[[property]]"}\n---\n# body [[body]]'
    const parsed = noteCacheParse(source)
    const first = [...noteCacheEntries(source, defaultNoteSyntax, parsed)]
    assert.equal(markdownCount, 1)
    assert.equal(yamlCount, 1)
    assert.deepEqual(
      values(first, 'frontmatterLink').map((link) => link.link),
      ['property'],
    )
    assert.deepEqual(
      [...noteCacheEntries(source, defaultNoteSyntax, parsed)],
      first,
    )
    assert.equal(markdownCount, 1)
    assert.equal(yamlCount, 1)
  } finally {
    MarkdownParser.prototype.createParse = markdown
    YAMLParser.prototype.parse = yaml
  }
})

test('root list parents group disjoint lists by negative first source line', () => {
  for (const eol of ['\n', '\r\n', '\r']) {
    const source =
      '\uFEFF' +
      [
        '- first',
        '- peer',
        '',
        '1. second',
        '   - nested',
        '     - deeper',
        '2. peer',
      ].join(eol)
    const items = values(entries(source), 'listItem')
    assert.deepEqual(
      items.map((item) => [item.position.start.line, item.parent]),
      [
        [0, -0],
        [1, -0],
        [3, -3],
        [4, 3],
        [5, 4],
        [6, -3],
      ],
    )
    assert.equal(Object.is(items[0].parent, -0), true)
  }
})

test('raw numeric coordinate golden covers bom/crlf/astral/tab and nested grammar', () => {
  const source =
    '\uFEFF# 😀\r\n\r\n> - [X] [[n]] #T ^b\r\n>   -\t![x](a.png)\r\n'
  const rows = entries(source)
  assert.deepEqual(values(rows, 'heading')[0].position, {
    start: { line: 0, col: 1, offset: 1 },
    end: { line: 0, col: 5, offset: 5 },
  })
  assert.deepEqual(values(rows, 'link')[0].position, {
    start: { line: 2, col: 8, offset: 17 },
    end: { line: 2, col: 13, offset: 22 },
  })
  assert.deepEqual(values(rows, 'tag')[0].position, {
    start: { line: 2, col: 14, offset: 23 },
    end: { line: 2, col: 16, offset: 25 },
  })
  assert.deepEqual(values(rows, 'embed')[0].position, {
    start: { line: 3, col: 6, offset: 36 },
    end: { line: 3, col: 17, offset: 47 },
  })
  assert.deepEqual(
    values(rows, 'listItem').map((item) => item.parent),
    [-2, 2],
  )
  for (const source of [
    '\uFEFF# 😀\r# second',
    '\uFEFF# 😀\r\n# second',
    '# 😀\n# second',
  ]) {
    const headings = values(entries(source), 'heading')
    assert.equal(headings.length, 2)
    for (const row of entries(source)) positioned(source, row)
  }
})

test('legacy projections retain refs order, normalized tags, heading display and settings', () => {
  const sources = [
    '# **bold** _italic_ `code` &amp; \\*',
    '# [a](a.md) ![b](b.png) <https://ex.com>',
    '> multi *word\n> next*\n> ---',
    '- multi *word\n  next*\n  ---',
    'hello\n  next\n---',
    '- hello\n    next\n  ---',
    '> hello\n>   next\n> ---',
    '[a][ref] ![b][ref] [ref][] [ref]\n\n[ref]: a.md',
    '> # h\n> - #tag\n>   - [[next]] #Tag2',
    '==#hi [hidden](x.md)== #tag **#bold**',
    'email@example.com <x@y.com> www.example.com https://example.com',
    '[a](<a b.md>) [a](a&amp;b.md) [z](a%20b.md)',
    '- [ ] task [a](a.md) #tag\n- ordinary [b](b.md) #b',
    '| links | tags |\n| - | - |\n| [[wiki]] | #tag |',
  ]
  const settings = [
    defaultNoteSyntax,
    { ...defaultNoteSyntax, gfm: false },
    { ...defaultNoteSyntax, wikilinks: false },
    ...[
      'core.links',
      'core.bold',
      'core.italic',
      'core.bullet-lists',
      'markdown.tasks',
      'core.quotes',
      'core.images',
    ].map((feature) => ({ ...defaultNoteSyntax, disabledFeatures: [feature] })),
  ]
  for (const syntax of settings)
    for (const source of sources) {
      const rows = entries(source, syntax),
        references = { links: [], wikilinks: [] }
      for (const { kind, value } of rows)
        if (kind === 'link' || kind === 'embed') {
          if (/^!?\[\[/.test(value.original))
            references.wikilinks.push(value.link)
          else if (kind === 'link') references.links.push(value.link)
        }
      assert.deepEqual(references, noteReferences(source, syntax), source)
      assert.deepEqual(
        values(rows, 'heading').map(({ depth, text }) => ({ depth, text })),
        noteHeadings(source, syntax).items,
        source,
      )
      assert.deepEqual(
        [
          ...new Set(
            values(rows, 'tag').map(({ tag }) =>
              tag.slice(1).normalize('NFC').toLowerCase(),
            ),
          ),
        ].sort(),
        noteTags(source, syntax),
        source,
      )
    }
})

test('standalone ids own preceding blocks and custom task statuses stay positioned', () => {
  const source = [
    '- first',
    '- second',
    '',
    '^list',
    '',
    '| h |',
    '| - |',
    '| c |',
    '',
    '^table',
    '',
    '> quote',
    '',
    '^quote',
    '',
    '~~~',
    'inside ^hidden',
    '~~~',
    '',
    '^fence',
    '',
    '- [/] progress ^task',
  ].join('\n')
  const rows = entries(source)
  assert.deepEqual(
    values(rows, 'block').map((block) => [block.id, raw(source, block)]),
    [
      ['list', '- first\n- second\n\n^list'],
      ['table', '| h |\n| - |\n| c |\n\n^table'],
      ['quote', '> quote\n\n^quote'],
      ['fence', '~~~\ninside ^hidden\n~~~\n\n^fence'],
      ['task', '- [/] progress ^task'],
    ],
  )
  assert.equal(values(rows, 'listItem').at(-1).task, '/')
})

test('sections keep yaml, thematic breaks, html, math and footnote definitions', () => {
  const source =
    '---\ntitle: one\n---\n\n---\n\n<div>html</div>\n\n$$\nx\n$$\n\n[^one]: footnote'
  assert.deepEqual(
    values(entries(source), 'section').map((section) => section.type),
    ['yaml', 'thematicBreak', 'html', 'math', 'footnoteDefinition'],
  )
})

test('cyclic aliases and unsupported yaml objects never become successful cache records', () => {
  for (const yaml of [
    'a: &a { self: *a }',
    'data: !!set {one, two}',
    'number: .inf',
    'data: !!binary YQ==',
  ]) {
    const source = '---\n' + yaml + '\n---\n# Body [[body]]'
    const parsed = noteCacheParse(source)
    assert.deepEqual(parsed.flags, {
      references: true,
      headings: true,
      frontmatter: false,
      properties: false,
    })
    const rows = [...noteCacheEntries(source, defaultNoteSyntax, parsed)]
    assert.equal(values(rows, 'frontmatter').length, 0)
    assert.equal(values(rows, 'heading')[0].text, 'Body body')
    assert.equal(values(rows, 'link')[0].link, 'body')
  }
})

test('plain body runs do bounded inline work while preserving existing grammar tree', () => {
  const char = InlineContext.prototype.char
  let reads = 0
  InlineContext.prototype.char = function (...args) {
    reads++
    return char.apply(this, args)
  }
  try {
    noteCacheParse(
      '# note 0\n\n#work [[note-00000]]\n\n' + 'body '.repeat(2048),
    )
    assert.ok(reads < 200, 'plain body character reads: ' + reads)
    reads = 0
    noteCacheParse(
      `---\nlong: ${'body '.repeat(2048)}\n---\n${'body '.repeat(2048)}`,
    )
    assert.ok(reads < 200, 'frontmatter configured parser reads: ' + reads)
  } finally {
    InlineContext.prototype.char = char
  }
})

test('plain-run optimization matches independent existing grammar across delimiter combinations', () => {
  function nodes(tree) {
    const rows = []
    tree.iterate({
      enter(node) {
        rows.push([node.name, node.from, node.to])
      },
    })
    return rows
  }
  const fragments = [
    'body ',
    '**bold**',
    '_em_',
    '`code`',
    '\\*escaped\\*',
    '&amp;',
    '[a](a.md)',
    '[b][ref]',
    '![alt](image.png)',
    '[[wiki|label]]',
    '![[embed]]',
    '==highlight==',
    '$math$',
    '<span>tag</span>',
    '<!-- comment -->',
    '<https://ex.com>',
    'x.y+z@example.com',
    'www.example.com',
    'https://example.com/a(b)',
    'mailto:x@example.com',
    'xmpp:x@example.com/a',
    '  \nnext',
    '\\\nnext',
    '\nsoft',
    '😀*word*',
    `${'a'.repeat(101)}@example.com`,
    `${'x.'.repeat(51)}@example.com`,
    `é${'a'.repeat(100)}@example.com`,
    '😀a@example.com',
    '^block',
    ':value',
    '[',
    ']',
    '~~~',
    '$',
    '==',
    '\t',
  ]
  for (const gfm of [false, true])
    for (const wikilinks of [false, true]) {
      const syntax = { ...defaultNoteSyntax, gfm, wikilinks }
      const grammar = (
        gfm ? metadataParsers.gfm : metadataParsers.commonmark
      ).configure([
        ...(wikilinks ? [boundarySyntax['obsidian@1']] : []),
        ...(gfm
          ? [
              boundarySyntax['empty-tasks@1'],
              boundarySyntax['github-alerts@1'],
              boundarySyntax['footnotes@1'],
            ]
          : []),
        boundarySyntax['math-inline@1'],
        boundarySyntax['math-block@1'],
      ])
      for (let index = 0; index < fragments.length; index++)
        for (let next = 0; next < fragments.length; next++) {
          const source =
            '# title ' +
            fragments[index] +
            ' ' +
            fragments[next] +
            '\n\n[ref]: a.md'
          assert.deepEqual(
            nodes(noteCacheParse(source, syntax).tree),
            nodes(grammar.parse(source)),
            source,
          )
        }
    }
})

test('property links use yaml cooked values with exact escaped and folded source spans', () => {
  const source =
    '\uFEFF---\r\nlinks:\r\n  - "[[Notes\\u002fDaily|Day]]"\r\n  - "\\u005b\\u005bEscaped\\u005d\\u005d"\r\n  - "[label](a\\u002emd)"\r\nfolded: >-\r\n  [[Long\r\n  name]]\r\nliteral: |-\r\n  [[one]]\r\n  [[two]]\r\nquoted: "[[quote\\"target]]"\r\nsingle: \'[[It\'\'s]]\'\r\n---\r\n# Body [[body]]'
  const parsed = noteCacheParse(source)
  const rows = [...noteCacheEntries(source, defaultNoteSyntax, parsed)]
  assert.equal(parsed.flags.frontmatter, true)
  assert.equal(parsed.flags.references, true)
  const links = values(rows, 'frontmatterLink')
  assert.deepEqual(
    links.map(({ key, link }) => [key, link]),
    [
      ['links.0', 'Notes/Daily'],
      ['links.1', 'Escaped'],
      ['links.2', 'a.md'],
      ['folded', 'Long name'],
      ['literal', 'one'],
      ['literal', 'two'],
      ['quoted', 'quote"target'],
      ['single', "It's"],
    ],
  )
  assert.deepEqual(
    links.map((link) => raw(source, link)),
    [
      '[[Notes\\u002fDaily|Day]]',
      '\\u005b\\u005bEscaped\\u005d\\u005d',
      '[label](a\\u002emd)',
      '[[Long\r\n  name]]',
      '[[one]]',
      '[[two]]',
      '[[quote\\"target]]',
      "[[It''s]]",
    ],
  )
  for (const row of rows) positioned(source, row)
  assert.deepEqual(
    values(rows, 'link').map((link) => link.link),
    ['body'],
  )
  assert.equal(raw(source, values(rows, 'heading')[0]), '# Body [[body]]')
})

test('yaml scalar projection preserves escaped unicode, joins and supported scalar styles', () => {
  const cases = [
    ['"[[\\U0001f600]]"', '😀'],
    ['"[[\\x41\\u0042]]"', 'AB'],
    ['"[[Long\\\n  name]]"', 'Longname'],
    ['"[[Long\n  name]]"', 'Long name'],
    ["'[[Long\n  name]]'", 'Long name'],
    ['>2-\n  [[Long\n  name]]', 'Long name'],
    ['|+\n  [[literal]]\n\n', 'literal'],
  ]
  for (const [yaml, target] of cases) {
    const source = '---\nlink: ' + yaml + '\n---\n# Body'
    const rows = entries(source)
    assert.deepEqual(
      values(rows, 'frontmatterLink').map((link) => link.link),
      [target],
      source,
    )
    for (const row of rows) positioned(source, row)
  }
})
