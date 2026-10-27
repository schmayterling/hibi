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
