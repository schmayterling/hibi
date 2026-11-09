import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { createServer } from 'vite'
import { defaultNoteSyntax } from '../src/shared/note-syntax-config.ts'

const cacheDir = await mkdtemp(join(tmpdir(), 'hibi-note-cache-'))
const server = await createServer({
  configFile: false,
  cacheDir,
  server: { middlewareMode: true, watch: null },
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
  assert.equal(items[0].parent, -1)
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
  const parsers = Object.values(metadataParsers)
  const saved = parsers.map((parser) => parser.createParse)
  for (const parser of parsers)
    parser.createParse = () => {
      throw Error('second parse')
    }
  try {
    assert.deepEqual(
      [...noteCacheEntries(source, defaultNoteSyntax, parsed)],
      first,
    )
  } finally {
    parsers.forEach((parser, index) => {
      parser.createParse = saved[index]
    })
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
    ['#Visible'],
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
