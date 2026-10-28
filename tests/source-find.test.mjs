import assert from 'node:assert/strict'
import test from 'node:test'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { sourceFindHighlights } from '../src/renderer/src/source-find.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'
import { searchSourceLiteral } from '../src/shared/source-search.ts'
import { SourceSearchIndex } from '../src/shared/source-search-index.ts'

function checkpoints(text, query) {
  const store = new SourceStore(text, { tabId: 'highlights', revision: 0 }, 0)
  const index = new SourceSearchIndex(store.snapshot(), query)
  for (const _ of index.build()) {
    /* complete worker coverage */
  }
  return index.highlightStarts()
}

function highlights(
  text,
  query,
  visible,
  selection,
  starts = checkpoints(text, query),
) {
  const doc = EditorState.create({ doc: text }).doc
  const state = EditorState.create({
    doc,
    selection,
    extensions: [sourceFindHighlights(query, doc, starts)],
  })
  const decorate = state.facet(EditorView.decorations)[0]
  const result = []
  decorate({
    state,
    visibleRanges: visible ?? [{ from: 0, to: text.length }],
  }).between(0, text.length, (from, to, value) => {
    result.push({ from, to, class: value.spec.class })
  })
  return result
}

test('source highlights agree with worker ranges across sigma, expansions and scalar seams', () => {
  const text = `${'x'.repeat(15)}😀İ e\u0301 ß ẞ ΟΔΟΣ οδος οδοσ;ΑΣΑ ΑςΑ ΣΣ.`
  const store = new SourceStore(text, { tabId: 'highlights', revision: 0 }, 0, {
    chunkUnits: 16,
  })
  for (const query of [
    'ΟΔΟΣ',
    'οδος',
    'οδοσ',
    'Σ',
    'σ',
    'ς',
    'ΑΣΑ',
    '😀',
    'İ',
    'i',
    'i\u0307',
    'e\u0301',
    'ß',
    'ẞ',
    'ss',
    'ﬃ',
    '',
  ]) {
    const expected = [...searchSourceLiteral(store.snapshot(), query)].flatMap(
      (batch) => batch.matches.map(({ from, to }) => ({ from, to })),
    )
    assert.deepEqual(
      highlights(text, query).map(({ from, to }) => ({ from, to })),
      expected,
      query,
    )
    if (expected.length) {
      const { from, to } = expected[0]
      const selected = highlights(text, query, undefined, {
        anchor: from,
        head: to,
      })
      assert.equal(selected[0].class, 'cm-searchMatch cm-searchMatch-selected')
    }
  }
})

test('viewport highlights retain worker nonoverlap phase and selected matches', () => {
  for (const [text, query, from = 41] of [
    ['ab'.repeat(100), 'aba', 43],
    ['a'.repeat(100), 'aa'],
    ['Σ'.repeat(100), 'σς'],
    ['😀'.repeat(100), '😀😀'],
    ['ﬃ'.repeat(100), 'ffi'],
  ]) {
    const store = new SourceStore(text, { tabId: 'phase', revision: 0 }, 0)
    const visible = { from, to: 60 }
    const expected = [...searchSourceLiteral(store.snapshot(), query)]
      .flatMap((batch) => batch.matches)
      .filter((match) => match.to > visible.from && match.from < visible.to)
      .map(({ from, to }) => ({ from, to }))
    const selected = expected[1]
    const found = highlights(text, query, [visible], {
      anchor: selected.from,
      head: selected.to,
    }).filter((match) => match.to > visible.from && match.from < visible.to)
    assert.deepEqual(
      found.map(({ from, to }) => ({ from, to })),
      expected,
      query,
    )
    assert.equal(
      found.find((match) => match.from === selected.from)?.class,
      'cm-searchMatch cm-searchMatch-selected',
      query,
    )
  }
})

test('worker restart points preserve disjoint viewports, scalar seams and bounded scanning', (t) => {
  const lower = String.prototype.toLowerCase
  const normalize = String.prototype.normalize
  let scanned = 0
  let folded = 0
  t.mock.method(String.prototype, 'normalize', function (...args) {
    scanned += this.length
    return normalize.apply(this, args)
  })
  t.mock.method(String.prototype, 'toLowerCase', function () {
    folded += this.length
    return lower.call(this)
  })
  for (const [unit, query] of [
    ['ab', 'aba'],
    ['Σ', 'σς'],
    ['😀', '😀😀'],
    ['İ', 'i'],
    ['ﬃ', 'f'],
    ['é\r\n', 'e'],
    ['z', 'absent'],
  ]) {
    const raw = unit.repeat(12000)
    const text = EditorState.create({ doc: raw }).doc.toString()
    const starts = checkpoints(raw, query)
    const source = new SourceStore(raw, { tabId: 'seams', revision: 0 }, 0)
    const matches = [...searchSourceLiteral(source.snapshot(), query)].flatMap(
      (batch) => batch.matches,
    )
    const visible = [
      { from: 8211, to: 8240 },
      { from: text.length - 43, to: text.length - 3 },
    ]
    scanned = folded = 0
    const found = highlights(text, query, visible, undefined, starts)
    assert.ok(scanned < 17000, `${query}: ${scanned} scanned source units`)
    t.diagnostic(JSON.stringify({ query, units: text.length, scanned, folded }))
    const inView = (match) =>
      visible.some(({ from, to }) => match.to > from && match.from < to)
    assert.deepEqual(
      found.filter(inView).map(({ from, to }) => ({ from, to })),
      matches.filter(inView).map(({ from, to }) => ({ from, to })),
      query,
    )
    assert.equal(
      new Set(found.map(({ from, to }) => `${from}:${to}`)).size,
      found.length,
    )
  }
})

test('highlights stop using checkpoints after a document edit', () => {
  const doc = EditorState.create({ doc: 'aaaaaa' }).doc
  const state = EditorState.create({
    doc,
    extensions: [sourceFindHighlights('aa', doc, [0])],
  })
  const changed = state.update({ changes: { from: 0, insert: 'a' } }).state
  const decorate = changed.facet(EditorView.decorations)[0]
  assert.equal(
    decorate({ state: changed, visibleRanges: [{ from: 0, to: 7 }] }).size,
    0,
  )
})

test('source highlights scan only visible ranges and merge overlapping margins', (t) => {
  const lower = String.prototype.toLowerCase
  let folded = 0
  t.mock.method(String.prototype, 'toLowerCase', function () {
    folded += this.length
    return lower.call(this)
  })
  let previous
  for (const count of [1000, 10000, 100000]) {
    const text = 'ΟΔΟΣ '.repeat(count)
    const starts = checkpoints(text, 'οδος')
    folded = 0
    const found = highlights(
      text,
      'οδος',
      [
        { from: 40, to: 60 },
        { from: 65, to: 80 },
        { from: 200, to: 220 },
      ],
      undefined,
      starts,
    )
    const ranges = found.map(({ from, to }) => `${from}:${to}`)
    assert.equal(new Set(ranges).size, ranges.length)
    assert.ok(folded < 512, `${folded} folded units for ${count} words`)
    previous ??= found
    assert.deepEqual(found, previous)
  }
})

test('formatted highlights check only selections that can be a match outside their window', (t) => {
  const lower = String.prototype.toLowerCase
  let folded = 0
  t.mock.method(String.prototype, 'toLowerCase', function () {
    folded += this.length
    return lower.call(this)
  })
  const text = 'needle word '.repeat(100000)
  const starts = checkpoints(text, 'needle')
  const doc = EditorState.create({ doc: text }).doc
  const shown = { from: text.length - 6000, to: text.length }
  const work = (selection) => {
    const state = EditorState.create({
      doc,
      selection,
      extensions: [sourceFindHighlights('needle', doc, starts)],
    })
    let marks = 0
    folded = 0
    state
      .facet(EditorView.decorations)[0]({
        // The formatted view's highlight window, as its state field holds it.
        state: { doc, selection: state.selection, field: () => shown },
        visibleRanges: [shown],
      })
      .between(0, text.length, () => {
        marks++
      })
    return { folded, marks }
  }
  const caret = work(EditorSelection.single(0))
  assert.deepEqual(work(EditorSelection.single(0, 600000)), caret)
  assert.equal(work(EditorSelection.single(12, 18)).marks, caret.marks + 1)
})
