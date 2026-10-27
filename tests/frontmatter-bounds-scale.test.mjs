import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { EditorState } from '@codemirror/state'
import { parseDocument } from 'yaml'

const limit = 256 * 1024
const parses = { calls: 0, units: 0 }
// Count the actual YAML calls in both readers, without parsing oversized controls.
globalThis.frontmatterParse = (source) => {
  parses.calls++
  parses.units += source.length
  return source.length > limit ? { contents: null } : parseDocument(source)
}
registerHooks({
  load(url, context, next) {
    const loaded = next(url, context)
    if (/\/src\/shared\/(?:source-)?frontmatter\.ts$/.test(url))
      return {
        ...loaded,
        source: String(loaded.source).replaceAll(
          'parseDocument(',
          'globalThis.frontmatterParse(',
        ),
      }
    return loaded
  },
})
const { frontmatterBounds, frontmatterSearch } = await import(
  '../src/renderer/src/formatted-frontmatter.ts'
)
const { readSourceFrontmatter } = await import(
  '../src/shared/source-frontmatter.ts'
)
const { SourceStore } = await import('../src/shared/source-buffer.ts')
const reset = () => Object.assign(parses, { calls: 0, units: 0 })
const finishBounds = (state) => {
  while (!state.field(frontmatterBounds).complete)
    state = state.update({ effects: frontmatterSearch.of(null) }).state
  return state
}
const body = 'plain words in a line\n'.repeat(
  Math.ceil((50 * 1024 * 1024) / 22),
)

for (const prefix of ['', 'title: large\nvalue: |\n']) {
  const source = `---\n${prefix}${prefix ? body.replaceAll('plain', '  plain') : body}---\n\ntail`
  test(`50 mib closed candidate bounds YAML work per keystroke (${prefix ? 'mapping' : 'scalar'})`, (t) => {
    reset()
    let state = finishBounds(
      EditorState.create({ doc: source, extensions: frontmatterBounds }),
    )
    t.diagnostic(`open: ${JSON.stringify(parses)}`)
    assert.equal(state.field(frontmatterBounds).end, 0)
    for (let key = 0; key < 4; key++) {
      reset()
      state = state.update({ changes: { from: 1000, insert: 'x' } }).state
      t.diagnostic(`keystroke ${key}: ${JSON.stringify(parses)}`)
      assert.deepEqual(
        { ...parses },
        { calls: 0, units: 0 },
        `keystroke ${key}`,
      )
    }
  })
  test(`50 mib cooperative reads bound YAML work per slash query (${prefix ? 'mapping' : 'scalar'})`, (t) => {
    const store = new SourceStore(source, { tabId: 'bounded', revision: 0 })
    for (let query = 0; query < 3; query++) {
      reset()
      const work = readSourceFrontmatter(store.snapshot())
      let step
      do step = work.next()
      while (!step.done)
      t.diagnostic(`query ${query}: ${JSON.stringify(parses)}`)
      assert.equal(step.value.bounds, null)
      assert.deepEqual({ ...parses }, { calls: 0, units: 0 })
      const before = store.snapshot()
      store.commit(
        store.prepare({
          document: before.document,
          operationId: `query-${query}`,
          historyGroup: 'typing',
          origin: 'source',
          baseVersion: before.version,
          contentVersion: before.version + 1,
          changes: [{ from: 1000, to: 1000, insert: 'x' }],
        }),
      )
    }
    assert.equal(store.counters().materializations, 0)
  })
}

test('both readers recognize through the exact prefix limit and reject beyond it', () => {
  for (const extra of [0, 1]) {
    const opening = '---\ntitle: '
    const source = `${opening}${'x'.repeat(limit + extra - opening.length - 1)}\n---\nbody`
    const state = finishBounds(
      EditorState.create({ doc: source, extensions: frontmatterBounds }),
    )
    const work = readSourceFrontmatter(
      new SourceStore(source, { tabId: 'limit', revision: 0 }).snapshot(),
    )
    let step
    do step = work.next()
    while (!step.done)
    assert.equal(!!state.field(frontmatterBounds).end, extra === 0)
    assert.equal(!!step.value.bounds, extra === 0)
  }
})

test('closed metadata parses once inside its bounds and never for body keystrokes', () => {
  reset()
  let state = EditorState.create({
    doc: `---\ntitle: small\n---\n\n${body}`,
    extensions: frontmatterBounds,
  })
  assert.equal(parses.calls, 1)
  assert.ok(parses.units < limit)
  for (let key = 0; key < 4; key++) {
    reset()
    state = state.update({
      changes: { from: state.doc.length, insert: 'x' },
    }).state
    assert.deepEqual({ ...parses }, { calls: 0, units: 0 })
  }
  reset()
  state = state.update({ changes: { from: 12, insert: 'x' } }).state
  assert.equal(parses.calls, 1)
  assert.ok(parses.units < limit)
  assert.ok(state.field(frontmatterBounds).end > 0)
})
