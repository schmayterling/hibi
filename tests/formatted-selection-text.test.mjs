import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { DocInput } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { Autolink, Strikethrough, Table, TaskList } from '@lezer/markdown'
import { formattedTextWindow } from '../src/shared/formatted-text-effects.ts'
import { boundaryParser } from '../src/shared/markdown-boundary-syntax.ts'
import {
  EmptyTask,
  Footnotes,
  GithubAlerts,
} from '../src/shared/markdown-extra-syntax.ts'
import { renderedBoundary } from '../src/shared/rendered-range.ts'
import { RenderedTextIndex } from '../src/shared/rendered-text.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'
import { renderedConfig } from './rendered-config.mjs'

registerHooks({
  load: (url, context, next) =>
    url.endsWith('.css')
      ? { format: 'module', source: '', shortCircuit: true }
      : next(url, context),
})
const { formattedSelectionText } = await import(
  '../src/renderer/src/formatted-selection-text.ts'
)
const { formattedLiteral, formattedMarkdown, formattedTextFeatures } =
  await import('../src/renderer/src/formatted-contributions.ts')
const { definitionsRead, footnoteDefinitions, footnoteScan, readDefinitions } =
  await import('../src/renderer/src/formatted/footnote-definitions.ts')

function fixture(text, config = renderedConfig) {
  let state = EditorState.create({
    doc: text,
    extensions: [
      config.literal.map((name) => formattedLiteral.of(name)),
      config.textFeatures.map((name) => formattedTextFeatures.of(name)),
      [
        Table,
        TaskList,
        EmptyTask,
        Footnotes,
        GithubAlerts,
        Strikethrough,
        Autolink,
      ].map((config) => formattedMarkdown.of(config)),
      footnoteDefinitions,
    ],
  })
  while (!definitionsRead(state))
    state = state.update({
      effects: readDefinitions.of(footnoteScan.slice),
    }).state
  const tree = boundaryParser(config).parse(new DocInput(state.doc))
  return {
    state,
    tree,
    read: (from = 0, to = state.doc.length, separator = '\n') =>
      formattedSelectionText(state, tree, from, to, separator),
  }
}

function projection(text, config) {
  const store = new SourceStore(text, { tabId: 'selection', revision: 0 })
  const index = new RenderedTextIndex(store.snapshot(), 0, config)
  for (const _ of index.build()) {
  }
  return index
}

test('formatted selection renders marks, block separators, cells and decoded atoms', () => {
  for (const [text, expected] of [
    ['hello\n\n`world`', 'hello\nworld'],
    ['**bold** _word_ ~~cut~~', 'bold word cut'],
    ['> - first\n>   **word**', 'first word'],
    ['- [x] task\n- plain', 'task\nplain'],
    ['# heading\n\nbody &amp; \\*literal\\*', 'heading\nbody & *literal*'],
    ['| a | b |\n| - | - |\n| **c** | d |', 'a\tb\nc\td'],
    ['before\n\n[id]: /hidden\n\nafter', 'before\nafter'],
  ])
    assert.equal(fixture(text).read(), expected, text)
  const value = fixture('hello\n\n`world`\nsoft\nline')
  assert.equal(
    value.read(0, value.state.doc.length, ''),
    'helloworld soft line',
  )
})

test('selection context preserves source positions and literal ancestor settings', () => {
  const text = '> **first**\n> second\n\nlast'
  const from = text.indexOf('first') + 1,
    to = text.indexOf('second') + 3
  const value = fixture(text)
  assert.equal(value.read(from, to), 'irst sec')
  assert.deepEqual(
    formattedTextWindow(
      value.tree,
      { from, to },
      new Set(value.state.facet(formattedLiteral)),
    ),
    {
      from: 0,
      to: text.length,
    },
  )
  const literal = fixture('> **word**', {
    ...renderedConfig,
    literal: ['Blockquote'],
  })
  assert.equal(literal.read(), '> **word**')
})

test('windowed selections agree with note projection at blank lines and atom boundaries', (t) => {
  const corpus = [
    'one\n\n**two**\n\nthree\n',
    '> one\n>\n> - two\n> - **three**\n\nfour\n\n',
    '# heading\n\n- [ ] task\n- item\n\nlast\n',
    'before\n\n[id]: /hidden\n\nafter\n',
    'before\n\n[id]: /hidden\n[other]: /also-hidden\n\nafter\n',
    '| a | b |\n| - | - |\n| **c** | d |\n\nafter\n',
    'a &amp; 😀 b &#x1f600; c \\*d\\*\n\ne\n',
    '```txt\none\ntwo\n```\n\nthree\n',
    'first[^note]\n\nlast\n\n[^note]: outside selection\n',
  ]
  let checks = 0,
    mismatches = 0
  const examples = []
  for (const text of corpus) {
    const value = fixture(text),
      index = projection(text, renderedConfig),
      input = new DocInput(value.state.doc)
    for (let from = 0; from <= text.length; from++) {
      if (!renderedBoundary(input, from)) continue
      for (let to = from; to <= text.length; to++) {
        if (!renderedBoundary(input, to)) continue
        const expected = [...index.range(from, to)]
          .map((chunk) => chunk.text)
          .join('')
        const actual = value.read(from, to)
        if (actual !== expected) {
          mismatches++
          if (examples.length < 8)
            examples.push({ text, from, to, actual, expected })
        }
        checks++
      }
    }
  }
  t.diagnostic(JSON.stringify({ checks, mismatches }))
  assert.equal(mismatches, 0, JSON.stringify(examples))
})

test('neighbor windows seek past unselected blocks with bounded cursor work', (t) => {
  const counts = []
  for (const blocks of [20000, 40000]) {
    const value = fixture('block\n\n'.repeat(blocks)),
      prototype = Object.getPrototypeOf(value.tree.cursor()),
      restore = []
    let moves = 0
    for (const [name, { value: original }] of Object.entries(
      Object.getOwnPropertyDescriptors(prototype),
    )) {
      if (typeof original !== 'function' || name === 'constructor') continue
      prototype[name] = function (...args) {
        moves++
        return original.apply(this, args)
      }
      restore.push(() => {
        prototype[name] = original
      })
    }
    let window
    try {
      window = formattedTextWindow(
        value.tree,
        { from: 19000 * 7, to: 19000 * 7 + 5 },
        new Set(value.state.facet(formattedLiteral)),
      )
    } finally {
      for (const reset of restore) reset()
    }
    assert.deepEqual(window, { from: 19000 * 7 - 7, to: 19000 * 7 + 12 })
    assert.ok(moves > 0 && moves <= 16, JSON.stringify({ blocks, moves }))
    counts.push(moves)
  }
  t.diagnostic(JSON.stringify({ moves: counts }))
})

test('unproved neighboring context declines capture without exposing source markup', () => {
  const text =
      'before\n\n' +
      Array.from({ length: 200 }, (_, i) => `[id${i}]: /hidden\n`).join('') +
      '\n**after**',
    value = fixture(text),
    from = text.indexOf('after')
  assert.equal(value.read(from, from + 5), null)
  assert.equal(value.read(from, from), '')
})

test('footnotes resolve against cached definitions outside the projected window', () => {
  const text =
    'start[^later]\n\n' + 'body\n\n'.repeat(20000) + '[^later]: defined'
  const value = fixture(text),
    to = text.indexOf('\n')
  assert.equal(value.read(0, to), 'startlater')
  assert.ok(
    formattedTextWindow(
      value.tree,
      { from: 0, to },
      new Set(value.state.facet(formattedLiteral)),
    ).to < 100,
  )
})

test('completing selection syntax skips code-language parsing', async (t) => {
  const { javascriptLanguage } = await import('@codemirror/lang-javascript')
  const { codeLanguages } = await import(
    '../src/renderer/src/code-languages.ts'
  )
  const { formattedSyntax } = await import(
    '../src/renderer/src/formatted-syntax.ts'
  )
  const remove = codeLanguages.register('selection-text-tests', {
    id: 'selection-text',
    language: javascriptLanguage,
  })
  t.after(remove)
  const parse = t.mock.method(javascriptLanguage.parser, 'startParse')
  for (const lines of [20000, 40000]) {
    const body = 'const value = 1\n'.repeat(lines)
    const syntax = formattedSyntax({ slice: 0 })
    const state = EditorState.create({
      doc: '**before**\n\n```selection-text\n' + body + '```\n\n**after**\n',
      extensions: syntax.extension,
    })
    const before = parse.mock.calls.length
    const tree = syntax.selectionTree(state, 0, state.doc.length)
    assert.equal(parse.mock.calls.length, before)
    assert.equal(
      formattedSelectionText(state, tree, 0, state.doc.length, '\n'),
      'before\n' + body.slice(0, -1) + '\nafter',
    )
    assert.equal(parse.mock.calls.length, before)
  }
})
