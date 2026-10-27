import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { EditorState } from '@codemirror/state'
import { parseDocument } from 'yaml'

const limit = 256 * 1024
const calls = []
let comparisons = 0
let compareKeys = false
globalThis.guardYaml = (source, options) => {
  calls.push({ units: source.length, uniqueKeys: options?.uniqueKeys })
  if (source.length > limit * 2) return { contents: null }
  return parseDocument(source, {
    ...options,
    uniqueKeys:
      options?.uniqueKeys === false || !compareKeys
        ? false
        : (a, b) => {
            comparisons++
            return a.value === b.value
          },
  })
}
registerHooks({
  load(url, context, next) {
    const result = next(url, context)
    return /\/src\/shared\/(?:source-)?frontmatter\.ts$/.test(url)
      ? {
          ...result,
          source: String(result.source).replaceAll(
            'parseDocument(',
            'globalThis.guardYaml(',
          ),
        }
      : result
  },
})
const { frontmatterBounds, frontmatterSearch } = await import(
  '../src/renderer/src/formatted-frontmatter.ts'
)
const { frontmatterState, updateFrontmatterState } = await import(
  '../src/addons/tags/decorations.ts'
)
const { readSourceFrontmatter } = await import(
  '../src/shared/source-frontmatter.ts'
)
const { hasFrontmatter } = await import('../src/addons/frontmatter/slash.ts')
const { SourceStore } = await import('../src/shared/source-buffer.ts')
const scan = (source) => {
  const store = new SourceStore(source, { tabId: 'guard', revision: 0 })
  store.counters(true)
  const work = readSourceFrontmatter(store.snapshot())
  try {
    for (let steps = 0; steps < 140; steps++) {
      const next = work.next()
      if (next.done)
        return { ...next.value, steps, units: store.counters().sourceUnitsRead }
    }
    assert.fail('frontmatter read exceeded bounded prefix steps')
  } finally {
    work.return()
  }
}
const settle = (state) => {
  for (let steps = 0; steps < 20; steps++) {
    const bounds = state.field(frontmatterBounds)
    if (bounds.complete || bounds.closer || bounds.searched >= state.doc.length)
      return state
    state = state.update({ effects: frontmatterSearch.of(null) }).state
  }
  assert.fail('frontmatter field exceeded bounded prefix slices')
}

test('tags share the bounded frontmatter field and never parse a 50 mib candidate', () => {
  const source = `---\n${'plain words\n'.repeat(Math.ceil((50 * 1024 * 1024) / 12))}---\nbody`
  let state = EditorState.create({ doc: source, extensions: frontmatterBounds })
  let tags = frontmatterState(state)
  calls.length = 0
  for (let key = 0; key < 3; key++) {
    const transaction = state.update({ changes: { from: 1000, insert: 'x' } })
    state = transaction.state
    tags = updateFrontmatterState(tags, transaction.changes, state)
    assert.equal(calls.length, 0)
  }
})

test('mapping recognition performs no pairwise key comparisons and tags add no parse', () => {
  const source = `---\n${Array.from({ length: 10480 }, (_, i) => `key${i}: value ${i}`).join('\n')}\n---\nbody`
  compareKeys = true
  try {
    let state = settle(
      EditorState.create({ doc: source, extensions: frontmatterBounds }),
    )
    const tags = frontmatterState(state)
    calls.length = 0
    comparisons = 0
    const transaction = state.update({ changes: { from: 10, insert: 'x' } })
    state = settle(transaction.state)
    updateFrontmatterState(tags, transaction.changes, state)
    assert.equal(comparisons, 0)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].uniqueKeys, false)
    calls.length = 0
    const bodyEdit = state.update({
      changes: { from: state.doc.length - 4, insert: 'x' },
    })
    updateFrontmatterState(
      frontmatterState(state),
      bodyEdit.changes,
      bodyEdit.state,
    )
    assert.equal(
      calls.length,
      0,
      'body-start edits must retain mapping recognition',
    )
  } finally {
    compareKeys = false
  }
})

test('oversized metadata remains present for slash availability', () => {
  const source = `\uFEFF---\ntitle: ${'x'.repeat(300000)}\n...\nbody`
  const read = scan(source)
  assert.equal(read.oversized, true)
  const state = settle(
    EditorState.create({ doc: source, extensions: frontmatterBounds }),
  )
  assert.equal(state.field(frontmatterBounds).oversized, true)
  const note = {
    length: source.length,
    slice: (from, to) => source.slice(from, to),
  }
  for (let check = 0; check < 100; check++)
    assert.equal(hasFrontmatter(note), true)
})

test('raw crlf and editor lf headers share one recognition budget', () => {
  const header = Array.from(
    { length: 10000 },
    (_, i) => `k${i}: ${'x'.repeat(18)}`,
  )
  const raw = `---\r\n${header.join('\r\n')}\r\n---\r\nbody`
  const normalized = raw.replaceAll('\r\n', '\n')
  assert.ok(raw.indexOf('\r\n---', 4) > limit)
  assert.ok(normalized.indexOf('\n---', 4) < limit)
  assert.ok(scan(raw).bounds)
  assert.ok(scan(normalized).bounds)
  assert.ok(
    settle(
      EditorState.create({ doc: raw, extensions: frontmatterBounds }),
    ).field(frontmatterBounds).end,
  )
})

test('50 mib reads and idle searches stop at the normalized prefix budget', () => {
  const source = `---\n${'plain words\n'.repeat(Math.ceil((50 * 1024 * 1024) / 12))}---\nbody`
  const read = scan(source)
  assert.equal(read.oversized, true)
  assert.ok(read.inspectedTo <= limit + 8192)
  assert.ok(read.steps <= 70)
  assert.ok(read.units <= limit + 8192)
  const state = settle(
    EditorState.create({ doc: source, extensions: frontmatterBounds }),
  )
  assert.equal(state.field(frontmatterBounds).oversized, true)
})
