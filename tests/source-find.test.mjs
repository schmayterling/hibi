import assert from 'node:assert/strict'
import test from 'node:test'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { sourceFindHighlights } from '../src/renderer/src/source-find.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'
import { searchSourceLiteral } from '../src/shared/source-search.ts'

function highlights(text, query, visible, selection) {
  const state = EditorState.create({
    doc: text,
    selection,
    extensions: [sourceFindHighlights(query)],
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
    folded = 0
    const found = highlights(text, 'οδος', [
      { from: 40, to: 60 },
      { from: 65, to: 80 },
      { from: 200, to: 220 },
    ])
    const ranges = found.map(({ from, to }) => `${from}:${to}`)
    assert.equal(new Set(ranges).size, ranges.length)
    assert.ok(folded < 200, `${folded} folded units for ${count} words`)
    previous ??= found
    assert.deepEqual(found, previous)
  }
})
