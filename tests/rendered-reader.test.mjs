import assert from 'node:assert/strict'
import test from 'node:test'
import { formattedTextEffects } from '../src/shared/formatted-text-effects.ts'
import { formattedTextRuns } from '../src/shared/formatted-text-runs.ts'
import {
  boundaryInlineParser,
  boundaryParser,
} from '../src/shared/markdown-boundary-syntax.ts'
import { renderedRange } from '../src/shared/rendered-range.ts'
import { RenderedTextIndex } from '../src/shared/rendered-text.ts'
import { SourceSnapshot, SourceStore } from '../src/shared/source-buffer.ts'
import { normalizedSource } from '../src/shared/source-projection.ts'
import { renderedConfig } from './rendered-config.mjs'

const finish = (work) => {
  for (;;) {
    const next = work.next()
    if (next.done) return next.value
  }
}
const render = (index, from = 0, to = index.length) =>
  [...index.range(from, to)].map((chunk) => chunk.text).join('')

test('list projection derives line bounds without per-item source tree seeks', (t) => {
  const text = '- item\n'.repeat(20000)
  const store = new SourceStore(text, { tabId: 'reader-work', revision: 0 })
  const original = SourceSnapshot.prototype.lineAt
  let seeks = 0
  SourceSnapshot.prototype.lineAt = function (position) {
    seeks++
    return original.call(this, position)
  }
  const index = new RenderedTextIndex(store.snapshot(), 0, renderedConfig)
  let retainedDuringBuild = 0
  try {
    for (const _ of index.build())
      retainedDuringBuild = Math.max(
        retainedDuringBuild,
        index.counters().retainedWindows,
      )
  } finally {
    SourceSnapshot.prototype.lineAt = original
  }
  t.diagnostic(
    JSON.stringify({ length: text.length, seeks, counters: index.counters() }),
  )
  assert.ok(seeks <= Math.ceil(text.length / 4096) * 10, String(seeks))
  assert.ok(
    index.counters().maximumWindowNodes <= 49152,
    JSON.stringify(index.counters()),
  )
  assert.equal(
    retainedDuringBuild,
    0,
    'a build must release each syntax window after projecting it',
  )
  for (const from of [0, 70000, 139993])
    assert.equal(render(index, from, from + 6), 'item')
  assert.equal(store.counters().materializations, 0)
})

test('page-derived line bounds agree with source line metadata at normalized seams and eof', () => {
  const body =
    '- alpha **bold**\n- beta\n\n> quote\n> continued\n\n\x60\x60\x60js\ncode\n\nlast code\n\x60\x60\x60\n\nlast'
  const fixtures = [
    '',
    '\n',
    '\n\n',
    'plain',
    'plain\n',
    'x'.repeat(10000) + '\n\n' + body,
    ...[4093, 4094, 4095, 4096, 4097].map(
      (offset) => 'x'.repeat(offset - 2) + '\n\n' + body,
    ),
    ...[4094, 4095, 4096].map((offset) =>
      ('x'.repeat(offset - 2) + '\n\n' + body + '\n').replaceAll('\n', '\r\n'),
    ),
    ('\n' + body + '\n\n').replaceAll('\n', '\r'),
  ]
  for (const text of fixtures) {
    const store = new SourceStore(text, { tabId: 'reader-seams', revision: 0 })
    const snapshot = store.snapshot(),
      normalized = normalizedSource(text)
    const input = {
      length: normalized.length,
      read: (from, to) => normalized.slice(from, to),
      lineAt(at) {
        const line = snapshot.lineAt(snapshot.editorToRaw(at))
        return {
          from: snapshot.rawToEditor(line.from),
          to: snapshot.rawToEditor(line.to),
        }
      },
    }
    const range = { from: 0, to: normalized.length }
    const effects = formattedTextEffects(
      boundaryParser(renderedConfig).parse(normalized),
      0,
      input,
      range,
      renderedConfig,
      boundaryInlineParser(renderedConfig),
      new Set(),
      false,
    )
    const expected = [
      ...renderedRange(
        formattedTextRuns(effects, input, { window: range, selection: range }),
        0,
        normalized.length,
        input,
      ),
    ]
      .map((chunk) => chunk.text)
      .join('')
    const index = new RenderedTextIndex(snapshot, 0, renderedConfig)
    finish(index.build())
    assert.equal(
      render(index),
      expected,
      JSON.stringify({ length: text.length, tail: text.slice(-40) }),
    )
  }
})
