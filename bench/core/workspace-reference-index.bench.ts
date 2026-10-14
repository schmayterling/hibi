import assert from 'node:assert/strict'
import { bench, describe } from 'vitest'
import { WorkspaceReferenceIndex } from '../../src/main/workspace-reference-index.ts'
import type { WorkspaceId } from '../../src/shared/foundation-contracts.ts'
import { linkedNotes } from '../fixtures.ts'

const options = { time: 0, iterations: 32, warmupTime: 0, warmupIterations: 8 }
const workspace = {
  workspaceId: 'benchmark' as WorkspaceId,
  workspaceGeneration: 1,
}
const pages = linkedNotes()
const first = pages[0]
assert.ok(first)
const changedPages = [
  {
    ...first,
    markdown: first.markdown.replace('[next](note-1.md)', '[next](note-2.md)'),
  },
  ...pages.slice(1),
]

function build() {
  const index = new WorkspaceReferenceIndex()
  return { index, result: index.apply(workspace, pages) }
}

function changeRoundtrip(index: WorkspaceReferenceIndex) {
  const changed = index.apply(workspace, changedPages)
  const restored = index.apply(workspace, pages)
  return { changed, restored }
}

// Verify cache states and real link resolution before registering benchmarks.
const check = build()
assert.deepEqual(check.result, { parsed: 128, resolved: 128 })
for (let page = 0; page < pages.length; page++) {
  assert.deepEqual(check.index.links(`note-${page}.md`, 0, 10).items, [
    `note-${(page + 1) % pages.length}.md`,
  ])
  assert.deepEqual(check.index.backlinks(`note-${page}.md`, 0, 10).items, [
    `note-${(page + pages.length - 1) % pages.length}.md`,
  ])
}
assert.deepEqual(check.index.apply(workspace, pages), {
  parsed: 0,
  resolved: 0,
})
assert.deepEqual(check.index.apply(workspace, changedPages), {
  parsed: 1,
  resolved: 1,
})
assert.deepEqual(check.index.links('note-0.md', 0, 10).items, ['note-2.md'])
assert.deepEqual(check.index.backlinks('note-1.md', 0, 10).items, [])
assert.deepEqual([...check.index.backlinks('note-2.md', 0, 10).items].sort(), [
  'note-0.md',
  'note-1.md',
])
check.index.apply(workspace, pages)
assert.deepEqual(changeRoundtrip(check.index), {
  changed: { parsed: 1, resolved: 1 },
  restored: { parsed: 1, resolved: 1 },
})
assert.deepEqual(check.index.backlinks('note-1.md', 0, 10).items, ['note-0.md'])
assert.equal(check.index.isComplete(), true)
check.index.clear()

const warm = build().index
const changing = build().index

describe('workspace reference index', () => {
  bench(
    'construct and build a 128-note linked workspace',
    () => {
      build()
    },
    options,
  )

  bench(
    'reapply 128 unchanged notes to a warm index',
    () => {
      warm.apply(workspace, pages)
    },
    options,
  )

  bench(
    'change and restore one link in a 128-note workspace',
    () => {
      changeRoundtrip(changing)
    },
    options,
  )
})
