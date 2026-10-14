import assert from 'node:assert/strict'
import { GFM, parser } from '@lezer/markdown'
import { bench, describe } from 'vitest'
import {
  MarkdownSourceModel,
  type MarkdownSourceState,
} from '../../src/shared/markdown-source-model.ts'
import { SourceStore } from '../../src/shared/source-buffer.ts'
import type { RawEdit } from '../../src/shared/source-operations.ts'
import { normalizedSource } from '../../src/shared/source-projection.ts'
import { fenceNote, sourceNote } from '../fixtures.ts'

const options = { time: 0, iterations: 32, warmupTime: 0, warmupIterations: 8 }
const syntax = parser.configure(GFM)
const text = sourceNote()
const local = {
  from: text.indexOf('source edit target') + 'source '.length,
  to: text.indexOf('source edit target') + 'source '.length,
  insert: 'local ',
}
const store = (source: string) =>
  new SourceStore(source, { tabId: 'source-benchmark', revision: 0 })

function edit(source: SourceStore, changes: readonly RawEdit[]) {
  const before = source.snapshot()
  const prepared = source.prepare({
    document: before.document,
    operationId: `bench-${before.version}`,
    baseVersion: before.version,
    contentVersion: before.version + 1,
    origin: 'source',
    historyGroup: 'benchmark',
    changes,
  })
  source.commit(prepared)
  return prepared
}

function finish(model: MarkdownSourceModel) {
  let state = model.advance()
  while (!state.complete) state = model.advance()
  return state
}

function metadata(source: string) {
  const buffer = store(source)
  const model = new MarkdownSourceModel(buffer.snapshot(), syntax, 'gfm')
  finish(model)
  return { buffer, model }
}

function bufferRoundtrip(buffer: SourceStore) {
  const changed = edit(buffer, [local])
  const restored = edit(buffer, changed.inverse)
  return { changed: changed.after, restored: restored.after }
}

function parserRoundtrip(
  { buffer, model }: ReturnType<typeof metadata>,
  change: RawEdit,
) {
  const prepared = edit(buffer, [change])
  model.apply(prepared)
  const changed = finish(model)
  model.apply(edit(buffer, prepared.inverse))
  return { changed, restored: finish(model) }
}

/** Compare raw owner ranges with an independent full Lezer parse. */
function checkOwners(state: MarkdownSourceState, expectedText: string) {
  assert.equal(state.complete, true)
  assert.equal(state.source.materialize(), expectedText)
  assert.ok(state.owners)
  const expected: {
    kind: string
    from: number
    to: number
    parsed: boolean
  }[] = []
  let position = 0
  syntax.parse(normalizedSource(expectedText)).iterate({
    enter(node) {
      if (node.name === 'Document' || node.type.isAnonymous) return
      const from = state.source.editorToRaw(node.from)
      const to = state.source.editorToRaw(node.to)
      assert.ok(from !== null && to !== null)
      if (from > position)
        expected.push({
          kind: 'trivia',
          from: position,
          to: from,
          parsed: true,
        })
      if (from < to)
        expected.push({ kind: `markdown:${node.name}`, from, to, parsed: true })
      position = to
      return false
    },
  })
  if (position < state.source.utf16Length)
    expected.push({
      kind: 'trivia',
      from: position,
      to: state.source.utf16Length,
      parsed: true,
    })
  assert.deepEqual(
    [...state.owners.records()].map(({ owner, from, to }) => ({
      kind: owner.kind,
      from,
      to,
      parsed: owner.parsed,
    })),
    expected,
  )
}

const initial = store(text).snapshot()
function parseInitial() {
  const model = new MarkdownSourceModel(initial, syntax, 'gfm')
  const state = finish(model)
  model.dispose()
  return state
}

// Preflight uses the same operations, outside every timed callback.
const bufferCheck = store(text)
const bufferResult = bufferRoundtrip(bufferCheck)
const editedText =
  text.slice(0, local.from) + local.insert + text.slice(local.to)
assert.equal(bufferResult.changed.materialize(), editedText)
assert.equal(bufferResult.restored.materialize(), text)
assert.equal(initial.materialize(), text)
checkOwners(parseInitial(), text)

const fences = fenceNote()
const fence = { from: 0, to: 0, insert: '```\r\n' }
for (const [source, change] of [
  [text, local],
  [fences, fence],
] as const) {
  const fixture = metadata(source)
  const before = fixture.buffer.snapshot()
  const result = parserRoundtrip(fixture, change)
  checkOwners(
    result.changed,
    source.slice(0, change.from) + change.insert + source.slice(change.to),
  )
  checkOwners(result.restored, source)
  assert.equal(before.materialize(), source)
  fixture.model.dispose()
}

const fragmented = store(text)
const changes = [...text.matchAll(/^## /gm)]
  .filter((_, index) => index % 2 === 0)
  .map((match) => ({
    from: match.index + 3,
    to: match.index + 3,
    insert: 'fragment ',
  }))
assert.equal(changes.length, 64)
edit(fragmented, changes)
let fragmentedText = text
for (const change of [...changes].reverse())
  fragmentedText =
    fragmentedText.slice(0, change.from) +
    change.insert +
    fragmentedText.slice(change.to)
const snapshot = fragmented.snapshot()
const from = snapshot.lineStart(Math.floor(snapshot.lineCount / 2))
assert.ok(from !== null)
const to = from + 4096
assert.equal(snapshot.materialize(), fragmentedText)
assert.equal(snapshot.sliceRaw(from, to), fragmentedText.slice(from, to))
assert.equal(to - from, 4096)

const editBuffer = store(text)
const localMetadata = metadata(text)
const fenceMetadata = metadata(fences)

describe('source buffer', () => {
  bench(
    'insert and restore a middle word in a 128-section note',
    () => {
      bufferRoundtrip(editBuffer)
    },
    options,
  )

  bench(
    'read 4 KiB from a note fragmented by 64 edits',
    () => {
      snapshot.sliceRaw(from, to)
    },
    options,
  )
})

describe('incremental source parser', () => {
  bench(
    'initialize, fully parse and dispose a 128-section note',
    () => {
      parseInitial()
    },
    options,
  )

  bench(
    'insert, parse, restore and parse a middle word in a 128-section note',
    () => {
      parserRoundtrip(localMetadata, local)
    },
    options,
  )

  bench(
    'insert, parse, restore and parse a leading fence before 512 fences',
    () => {
      parserRoundtrip(fenceMetadata, fence)
    },
    options,
  )
})
