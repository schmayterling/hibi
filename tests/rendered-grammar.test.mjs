import assert from 'node:assert/strict'
import test from 'node:test'
import { textFeatures } from '../src/shared/formatted-text-rules.ts'
import { RenderedTextIndex } from '../src/shared/rendered-text.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'
import { searchRenderedLiteral } from '../src/shared/source-rendered-search.ts'

const config = {
  schema: 1,
  syntax: [
    'table@1',
    'tasks@1',
    'empty-tasks@1',
    'footnotes@1',
    'github-alerts@1',
    'strike@1',
    'autolink@1',
    'math-inline@1',
    'math-block@1',
    'subscript@1',
    'subtext@1',
    'obsidian@1',
  ],
  flavors: [
    'markdown.github',
    'markdown.obsidian',
    'math.latex',
    'text-extras.text-extras',
  ],
  literal: [],
  opaque: ['Table', 'BlockMath'],
  textFeatures: [...textFeatures],
  prefix: 0,
  chunkSize: 4096,
  groupSize: 64,
  giantBlock: 65536,
}
function index(text, options = config) {
  const source = new SourceStore(text, { tabId: 'grammar', revision: 0 })
  const result = new RenderedTextIndex(
    source.snapshot(),
    options.prefix,
    options,
  )
  for (const _ of result.build()) {
  }
  return result
}
function visible(text, options) {
  const projection = index(text, options)
  return [...projection.range(0, projection.length)]
    .map((chunk) => chunk.text)
    .join('')
}

test('rendered projection follows the formatted grammar including active flavors and literal features', () => {
  for (const [source, expected] of [
    ['hello ==world==', 'hello world'],
    ['see [[Page|Alias]] now', 'see Alias now'],
    ['H~2~O', 'H2O'],
    ['-# small **text**', 'small text'],
    ['- a\n\t- b', 'a\nb'],
    ['- a\n\n    **bold** c', 'a\nbold c'],
    ['x [a](b y', 'x a(b y'],
    ['Title\n===', 'Title'],
    ['- [ ] task', 'task'],
    ['> [!NOTE]\n> body', 'note\nbody'],
    ['<div>\n*a* b\n</div>', '<div>\n*a* b\n</div>'],
    [
      'see https://example.com/__init__ ok',
      'see https://example.com/__init__ ok',
    ],
    ['hello\nworld', 'hello world'],
    ['    a\n    b', 'a\nb'],
    ['-     a\n      b', 'a\nb'],
    ['```mermaid\nvisible code', 'visible code'],
    ['$$\nvisible formula', '$$ visible formula'],
    ['ref [^1]\n\n[^1]: footnote\n    continued', 'ref 1\nfootnote continued'],
    ['| a | b |\n|---|---|\n| **c** | d |', 'a\tb\nc\td'],
    ['| a\\|b | `c\\|d` |\n|---|---|\n| x | y |', 'a|b\tc|d\nx\ty'],
  ])
    assert.equal(visible(source), expected, source)

  assert.equal(
    visible('hello ==world==', { ...config, syntax: [] }),
    'hello ==world==',
  )
  assert.equal(
    visible('**bold**', { ...config, literal: ['StrongEmphasis'] }),
    '**bold**',
  )
  assert.equal(
    visible('[[Page|Alias]]', { ...config, literal: ['WikiLink'] }),
    '[[Page|Alias]]',
  )
})

test('projection window cache covers every requested source unit beyond parser lookahead', () => {
  const text = '- item\n'.repeat(100)
  const projection = index(text, {
    ...config,
    chunkSize: 16,
    groupSize: 4,
    giantBlock: 64,
  })
  for (let from = 0; from < text.length; from += 7)
    assert.equal(
      [...projection.range(from, from + 6)].map((chunk) => chunk.text).join(''),
      'item',
      String(from),
    )
})

test('syntax-free final paragraphs use a bounded configured grammar proof', () => {
  const options = { ...config, chunkSize: 16, groupSize: 4, giantBlock: 64 }
  for (const [prefix, expected] of [
    ['**title**\n\n', 'title\n'],
    ['', ''],
  ]) {
    const text = 'plain words. 😀 '.repeat(20)
    const projection = index(prefix + text, options)
    assert.equal(projection.counters().plainTailUnits, text.length)
    assert.ok(projection.counters().maximumYieldRead <= 8192)
    assert.equal(
      [...projection.range(0, projection.length)]
        .map((chunk) => chunk.text)
        .join(''),
      expected + text,
    )
  }
  for (const prefix of ['\x60\x60\x60\n', '> quote\n', '[label\n']) {
    const projection = index(prefix + 'ordinary '.repeat(20), options)
    assert.equal(projection.counters().plainTailUnits, 0, prefix)
  }
})

test('plain paragraph proof separates bounded reads at a source-page seam', () => {
  const projection = index('hello **world**\n\n' + 'a'.repeat(4096 * 20))
  assert.equal(projection.counters().plainTailUnits, 4096 * 20)
  assert.ok(
    projection.counters().maximumYieldRead <= 8192,
    JSON.stringify(projection.counters()),
  )
})

test('table roots project their source beyond syntax coverage windows', () => {
  const options = { ...config, chunkSize: 16, groupSize: 4, giantBlock: 64 }
  const table = index(
    '| left | right |\n|---|---|\n' +
      Array.from({ length: 50 }, (_, at) => '| **r' + at + '** | x |').join(
        '\n',
      ),
    options,
  )
  assert.equal(
    [...searchRenderedLiteral(table, '*')].flatMap((batch) => batch.matches)
      .length,
    0,
  )
  assert.equal(
    [...searchRenderedLiteral(table, 'r27')].flatMap((batch) => batch.matches)
      .length,
    1,
  )
})

test('table cells retain inline provenance after escaped-pipe normalization', () => {
  const source =
    '| ' +
    String.raw`a\\\|b` +
    ' | &copy;\\|x |\n|---|---|\n| **bold** | `code` |'
  const projection = index(source)
  assert.equal(
    [...projection.range(0, projection.length)]
      .map((chunk) => chunk.text)
      .join(''),
    'a\\|b\t©|x\nbold\tcode',
  )
  const [pipe] = [...searchRenderedLiteral(projection, '|x')].flatMap(
    (batch) => batch.matches,
  )
  assert.equal(pipe.from, source.indexOf('\\|x'))
  const [code] = [...searchRenderedLiteral(projection, 'code')].flatMap(
    (batch) => batch.matches,
  )
  assert.ok(code.context.code?.width)
  const [bold] = [...searchRenderedLiteral(projection, 'bold')].flatMap(
    (batch) => batch.matches,
  )
  const work = projection.prepareReplacement(bold, '')
  let next = work.next()
  while (!next.done) next = work.next()
  assert.ok(next.value.edits)
  let changed = source
  for (const edit of [...next.value.edits].reverse())
    changed = changed.slice(0, edit.from) + edit.insert + changed.slice(edit.to)
  assert.ok(!changed.includes('**'))
})

test('semantic block separators survive chunk and syntax-window boundaries', () => {
  const options = { ...config, chunkSize: 16, groupSize: 4, giantBlock: 64 }
  const source = Array.from(
    { length: 40 },
    (_, at) => '**word' + at + '**',
  ).join('\n\n')
  const projection = index(source, options)
  const chunks = [...projection.range(0, projection.length)]
  assert.equal(
    chunks.map((chunk) => chunk.text).join(''),
    Array.from({ length: 40 }, (_, at) => 'word' + at).join('\n'),
  )
  assert.equal(
    [...projection.range(0, projection.length, { blockSeparator: '' })]
      .map((chunk) => chunk.text)
      .join(''),
    Array.from({ length: 40 }, (_, at) => 'word' + at).join(''),
  )
})

test('replacement proof uses active flavour syntax and widget rules', () => {
  for (const value of [
    '[[Page|Alias]]',
    '==value==',
    'H~2~O',
    '$a*b*c$',
    '-# small',
    '> [!NOTE]',
    '&copy;',
  ]) {
    const projection = index('TARGET tail')
    const [match] = [...searchRenderedLiteral(projection, 'TARGET')].flatMap(
      (batch) => batch.matches,
    )
    const work = projection.prepareReplacement(match, value)
    let next = work.next()
    while (!next.done) next = work.next()
    const edits = next.value.edits
    if (!edits) continue
    let result = 'TARGET tail'
    for (const edit of [...edits].reverse())
      result = result.slice(0, edit.from) + edit.insert + result.slice(edit.to)
    assert.equal(visible(result), value + ' tail', value)
  }
})

test('atomic formatted widgets are barriers and do not expose hidden source', () => {
  for (const source of [
    'x ![alt](pic.png) y',
    'x $a*b*c$ y',
    'x\n\n$$\na*b*c\n$$\n\ny',
    'x\n\n---\n\ny',
  ]) {
    const projection = index(source)
    for (const query of ['alt', 'pic.png', 'a*b*c', 'x  y', 'x\n\ny'])
      assert.equal(
        [...searchRenderedLiteral(projection, query)].flatMap(
          (batch) => batch.matches,
        ).length,
        0,
        source + ':' + query,
      )
  }
})
