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
const { obsidianSyntax } = await import(
  '../src/addons/markdown/formatted-syntax.ts'
)

const syntax = { ...defaultNoteSyntax, gfm: true }
// The editor's document holds CRLF lines as LF lines.
const markers = (source) => {
  let found = 0
  formattedMarkdownParser([
    ...contributions.flatMap((item) => item.syntax ?? []),
    obsidianSyntax,
  ])
    .parse(source.replaceAll('\r\n', '\n'))
    .iterate({
      enter: (node) => {
        if (node.name === 'TaskMarker') found++
      },
    })
  return found
}
const incremental = (source) => {
  const counter = new FormattedCounter(
    new SourceStore(source, { tabId: 'empty-tasks', revision: 0 }),
    syntax,
  )
  try {
    const work = counter.read()
    for (;;) {
      const next = work.next()
      if (next.done) return next.value
    }
  } finally {
    counter.dispose()
  }
}

// [source, rich view checkboxes, words]; each empty case has a control with text.
const cases = [
  ['- [x]', 1, 0],
  ['- [x] a', 1, 1],
  ['1. [x]', 1, 0],
  ['1. [x] a', 1, 1],
  ['1. [x] [x] a', 1, 2],
  ['1) [ ]', 1, 0],
  ['1) [ ] a', 1, 1],
  ['> 1. [x]', 1, 0],
  ['> 1. [x] a', 1, 1],
  ['- a\n  1. [x]', 1, 1],
  ['- a\n  1. [x] b', 1, 2],
  ['1. a\n   - [ ]', 1, 1],
  ['1. a\n   - [ ] b', 1, 2],
  ['1. [x]\n\n2. [ ]', 2, 0],
  ['1. [x] a\n\n2. [ ] b', 2, 2],
  ['1. [x]\r\n2. [ ]\r\n', 2, 0],
  // Bracketed text that is not a task marker stays text.
  ['1. [ ]x', 0, 1],
  ['1. [x]x', 0, 2],
  ['2) [ ]x\n   lazy', 0, 2],
  ['1. \\[x]', 0, 1],
  ['1. `[x]`', 0, 1],
  ['1. [[x]](u)', 0, 2],
  // Continuation lines stay task text, whatever they would be on their own.
  ['1. [x]\n   [y]: /u', 1, 2],
  ['   1. [x]\n     - n', 1, 1],
  ['   10. [ ]\n      - nested', 1, 1],
  // A reference definition makes the marker a link; it is still a checkbox.
  ['[x]: /u\n\n1. [x]', 1, 0],
  ['[x]: /u\n\n- [x]', 1, 0],
  ['[x]: /u\n\n1. [x] a', 1, 1],
  ['1. [x] a\r\n2. [ ] b\r\n', 2, 2],
]

test('word count reads empty task markers as the rich view does: checkboxes, not words', () => {
  for (const [source, checkboxes, words] of cases) {
    assert.equal(
      markers(source),
      checkboxes,
      `rich view ${JSON.stringify(source)}`,
    )
    assert.equal(
      countText(richText(source, syntax).slice(1)).words,
      words,
      JSON.stringify(source),
    )
  }
})

test('word count of empty task markers agrees between single-pass and incremental counts', () => {
  for (const [source] of cases)
    assert.deepEqual(
      incremental(source),
      countText(richText(source, syntax).slice(1)),
      JSON.stringify(source),
    )
})

test('word count reads lazy text after an empty ordered task as that task text', () => {
  const count = (source) => countText(richText(source, syntax).slice(1))
  assert.equal(markers('1. [x]\n   lazy'), 1)
  assert.deepEqual(count('1. [x]\n   lazy'), count('1. [x] lazy'))
  assert.deepEqual(count('1. [x]\r\n   lazy'), count('1. [x] lazy'))
})

test('word count keeps bracketed text that is not a task marker, as the rich view shows it', () => {
  for (const [source, counts] of [
    ['1. [ ]x', { words: 1, characters: 6 }],
    ['1. [x]x', { words: 2, characters: 6 }],
    ['2) [ ]x\n   lazy', { words: 2, characters: 11 }],
    ['1. \\[x]', { words: 1, characters: 5 }],
    ['1. `[x]`', { words: 1, characters: 5 }],
    ['1. [[x]](u)', { words: 2, characters: 6 }],
  ]) {
    assert.equal(markers(source), 0, `rich view ${JSON.stringify(source)}`)
    assert.deepEqual(
      countText(richText(source, syntax).slice(1)),
      counts,
      JSON.stringify(source),
    )
  }
})

test('word count keeps empty task markers as words when task syntax is off', () => {
  const off = { ...syntax, disabledFeatures: ['markdown.tasks'] }
  for (const source of ['- [x]', '1. [x]', '> 1. [x]'])
    assert.equal(
      countText(richText(source, off).slice(1)).words,
      1,
      JSON.stringify(source),
    )
})
