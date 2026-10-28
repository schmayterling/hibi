import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { EditorState } from '@codemirror/state'
import { Autolink, Strikethrough, Table, TaskList } from '@lezer/markdown'
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
const { formattedSelectionText, formattedSelectionPreview } = await import(
  '../src/renderer/src/formatted-selection-text.ts'
)
const { formattedSyntax } = await import(
  '../src/renderer/src/formatted-syntax.ts'
)
const {
  formattedLiteral,
  formattedMarkdown,
  formattedOpaque,
  formattedTextFeatures,
} = await import('../src/renderer/src/formatted-contributions.ts')
const { referenceLinks } = await import(
  '../src/renderer/src/formatted-references.ts'
)
const { definitionsRead, footnoteDefinitions, footnoteScan, readDefinitions } =
  await import('../src/renderer/src/formatted/footnote-definitions.ts')

function fixture(doc, drain = true) {
  const probe = {
    parsedChunks: 0,
    parsedUnits: 0,
    scannedUnits: 0,
    reusedNodes: 0,
    builtGroups: 0,
  }
  const syntax = formattedSyntax({ slice: 0, probe })
  let state = EditorState.create({
    doc,
    extensions: [
      [
        Table,
        TaskList,
        EmptyTask,
        Footnotes,
        GithubAlerts,
        Strikethrough,
        Autolink,
      ].map((config) => formattedMarkdown.of(config)),
      formattedOpaque.of('Table'),
      renderedConfig.literal.map((name) => formattedLiteral.of(name)),
      renderedConfig.textFeatures.map((name) => formattedTextFeatures.of(name)),
      footnoteDefinitions,
      referenceLinks,
      syntax.extension,
    ],
  })
  const read = (from = 0, to = state.doc.length, separator = '\n') =>
    formattedSelectionText(
      state,
      syntax.selectionTree(state, from, to),
      from,
      to,
      separator,
    )
  const value = {
    syntax,
    probe,
    read,
    preview: (from = 0, to = state.doc.length, separator = '') =>
      formattedSelectionPreview(state, syntax, from, to, separator),
    get state() {
      return state
    },
    drain() {
      while (!definitionsRead(state))
        state = state.update({
          effects: readDefinitions.of(footnoteScan.slice),
        }).state
    },
    answer(label, answer, definitive = true) {
      state
        .field(referenceLinks[0])
        .answers.entries.set(label, { answer, checked: 0, definitive })
    },
  }
  if (drain) value.drain()
  return value
}

test('app selection path uses inline cell syntax for every scalar-valid range', (t) => {
  let checks = 0
  for (const cell of [
    '# x',
    '```js',
    '***',
    '<!-- c --> \\* y',
    '> q',
    '- x',
    '1. one',
    '**word**',
    '`code`',
    'a &amp; b',
    '😀 \\*',
  ]) {
    const doc = '| ' + cell + ' | b |\n| --- | --- |\n| c | d |\n\nafter\n'
    const value = fixture(doc)
    const index = new RenderedTextIndex(
      new SourceStore(doc, { tabId: 'cell', revision: 0 }).snapshot(),
      0,
      renderedConfig,
    )
    for (const _ of index.build()) {
    }
    for (let from = 0; from <= doc.length; from++) {
      if (
        !renderedBoundary(
          { length: doc.length, read: (a, b) => doc.slice(a, b) },
          from,
        )
      )
        continue
      for (let to = from; to <= doc.length; to++) {
        if (
          !renderedBoundary(
            { length: doc.length, read: (a, b) => doc.slice(a, b) },
            to,
          )
        )
          continue
        const actual = value.read(from, to)
        const expected = [...index.range(from, to)]
          .map((chunk) => chunk.text)
          .join('')
        assert.equal(
          actual,
          expected,
          JSON.stringify({ cell, from, to, actual, expected }),
        )
        checks++
      }
    }
  }
  t.diagnostic(JSON.stringify({ appCellChecks: checks, mismatches: 0 }))
})

test('unread footnote definitions decline until the note-wide answer is ready', () => {
  const doc =
    'start[^later]\n\n' + 'body\n\n'.repeat(2000) + '[^later]: defined'
  const value = fixture(doc, false)
  const to = doc.indexOf('\n')
  assert.equal(definitionsRead(value.state), false)
  assert.equal(value.read(0, to), null)
  value.drain()
  assert.equal(value.read(0, to), 'startlater')
  const missing = fixture('start[^missing]\n\nbody')
  assert.equal(missing.read(0, 'start[^missing]'.length), 'start[^missing]')
})

test('reference capture distinguishes unknown, defined and definitely missing labels', () => {
  const doc = 'see [text][foo] here\n\n[foo]: /url'
  const value = fixture(doc)
  const to = doc.indexOf('\n')
  assert.equal(value.read(0, to), null)
  value.answer('foo', { title: null })
  assert.equal(value.read(0, to), 'see text here')
  const missing = fixture('see [text][missing] here')
  assert.equal(missing.read(), null)
  missing.answer('missing', null, false)
  assert.equal(missing.read(), null)
  missing.answer('missing', null)
  assert.equal(missing.read(), 'see [text][missing] here')
})

test('non-toolbar select-all preview keeps parsing and rendered-node work bounded', (t) => {
  const counts = []
  for (const blocks of [20000, 40000]) {
    const value = fixture('**alpha** &amp; beta\n\n'.repeat(blocks), false)
    const prototype = Object.getPrototypeOf(
      value.syntax.tree(value.state).cursor(),
    )
    const restore = []
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
    const before = { ...value.probe }
    let text
    try {
      text = value.preview(0, value.state.doc.length, '')
    } finally {
      for (const reset of restore.reverse()) reset()
    }
    const work = {
      blocks,
      moves,
      parsedChunks: value.probe.parsedChunks - before.parsedChunks,
      parsedUnits: value.probe.parsedUnits - before.parsedUnits,
      scannedUnits: value.probe.scannedUnits - before.scannedUnits,
      length: text?.length,
    }
    t.diagnostic(JSON.stringify({ prosePreview: work }))
    assert.equal(text, 'alpha & beta'.repeat(40).slice(0, 256))
    // The source page and the parser's fixed context bound cursor work.
    assert.ok(moves > 0 && moves <= 4 * 4096, JSON.stringify(work))
    assert.ok(
      work.parsedChunks > 0 &&
        work.parsedChunks <= 8 &&
        work.parsedUnits > 0 &&
        work.parsedUnits <= 8 * 4096,
      JSON.stringify(work),
    )
    // Boundary proof uses the parser's existing 64 kib giant-block window.
    assert.ok(
      work.scannedUnits > 0 && work.scannedUnits <= 16 * 4096,
      JSON.stringify(work),
    )
    counts.push(work)
  }
  assert.equal(counts[0].moves, counts[1].moves)
})

test('oversized table-cell context keeps preview reads bounded or declines', (t) => {
  const value = fixture(
    '| ' +
      'a'.repeat(256 * 1024) +
      ' | b |\n| --- | --- |\n| c | d |\n\nafter\n',
    false,
  )
  const doc = value.state.doc
  const original = doc.sliceString
  let units = 0
  t.mock.method(doc, 'sliceString', function (...args) {
    const result = original.apply(this, args)
    units += result.length
    return result
  })
  const result = value.preview(0, doc.length)
  t.diagnostic(
    JSON.stringify({ wideCellPreview: { units, length: result?.length } }),
  )
  assert.ok(units <= 128 * 1024)
  assert.ok(result === null || result === 'a'.repeat(256))
})

test('a source page must prove the complete preview or decline', (t) => {
  const value = fixture('&ClockwiseContourIntegral;'.repeat(300), false)
  const text = value.preview(0, value.state.doc.length)
  t.diagnostic(
    JSON.stringify({
      completePreview: { length: text?.length, first: text?.slice(0, 40) },
    }),
  )
  assert.ok(text === null || text === '\u2232'.repeat(256))
})
