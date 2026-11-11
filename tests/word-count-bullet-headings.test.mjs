import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { countText } from '../src/addons/word-count/count.ts'
import { FormattedCounter } from '../src/addons/word-count/formatted-counter.ts'
import { richText } from '../src/addons/word-count/formatted-text.ts'
import { formattedMarkdownParser } from '../src/shared/formatted-markdown.ts'
import { defaultNoteSyntax } from '../src/shared/note-syntax.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'

// Feature modules import their styles; these tests need only the code.
registerHooks({
  load: (url, context, next) =>
    url.endsWith('.css')
      ? { format: 'module', source: '', shortCircuit: true }
      : next(url, context),
})
const { obsidianSyntax } = await import(
  '../src/addons/markdown/formatted-syntax.ts'
)
// The rich view's grammar: every formatted contribution with syntax.
const contributions = await Promise.all(
  [
    'autolinks',
    'entities',
    'footnotes',
    'html',
    'media',
    'rule',
    'strikethrough',
    'tables',
    'tasks',
  ].map(async (name) => {
    const module = await import(`../src/renderer/src/formatted/${name}.ts`)
    return module.contributions ?? [module.contribution]
  }),
).then((all) => all.flat())

const syntax = { ...defaultNoteSyntax, gfm: true }
const words = (source) => countText(richText(source, syntax).slice(1)).words
// The rich view's heading end and first checkbox start.
const view = (source) => {
  let heading = -1,
    marker = Infinity
  formattedMarkdownParser([
    ...contributions.flatMap((item) => item.syntax ?? []),
    obsidianSyntax,
  ])
    .parse(source)
    .iterate({
      enter: (node) => {
        if (/Heading/.test(node.name)) heading = Math.max(heading, node.to)
        if (node.name === 'TaskMarker') marker = Math.min(marker, node.from)
      },
    })
  return { heading, marker }
}

const headings = [
  ['- [ ] a\n  ---\n  b', 2],
  ['- [ ] a\n  ===\n  b', 2],
  ['- [x]\n  ===\n  b', 2],
  ['* [X]\n  ---\n  t', 2],
  ['- [x]\n  ---', 1],
  ['[l]: /w\n\n- [x]\n  ===\n\n  [l] text', 3],
  ['- a\n  ---\n  b', 2],
  ['- # h\n  b', 2],
  ['- # h\n  b\n- c', 3],
  ['> - # h\n>   b', 2],
]

test('word count reads a heading in a bullet item as its own block, as the rich view does', () => {
  for (const [source, count] of headings) {
    const { heading, marker } = view(source)
    assert.ok(
      heading > 0 && marker > heading,
      `rich view ${JSON.stringify(source)}`,
    )
    assert.equal(words(source), count, JSON.stringify(source))
  }
})

test('word count keeps bullet tasks and paragraphs that are not headings', () => {
  for (const [source, count] of [
    ['- [x]', 0],
    ['- [x] a', 1],
    ['- [ ]\n  lazy', 1],
    ['- a\n  b', 2],
    ['- # h\n\n  b', 2],
    ['1. # h\n   b', 2],
  ])
    assert.equal(words(source), count, JSON.stringify(source))
})

test('word count of bullet headings agrees between single-pass and incremental counts', () => {
  for (const [source] of headings) {
    const counter = new FormattedCounter(
      new SourceStore(source, { tabId: 'bullet-headings', revision: 0 }),
      syntax,
    )
    try {
      const work = counter.read()
      let step
      do step = work.next()
      while (!step.done)
      assert.deepEqual(
        step.value,
        countText(richText(source, syntax).slice(1)),
        JSON.stringify(source),
      )
    } finally {
      counter.dispose()
    }
  }
})

test('word count keeps a bullet task whose next line is a lone dash, as the rich view does', () => {
  for (const [source, count] of [
    ['- [x]\n  -', 0],
    ['- [x]\n  - ', 0],
    ['> - [x]\n>   - ', 0],
    ['- [x]\n  -\n  b', 1],
    ['- [ ]\n  -\t', 0],
  ]) {
    const { marker } = view(source)
    assert.ok(marker < Infinity, `rich view ${JSON.stringify(source)}`)
    assert.equal(words(source), count, JSON.stringify(source))
    assert.doesNotMatch(
      richText(source, syntax),
      /\[[ xX]\]/,
      JSON.stringify(source),
    )
  }
})
