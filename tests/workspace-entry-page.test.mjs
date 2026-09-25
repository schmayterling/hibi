import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_WORKSPACE_PAGE_BYTES,
  pageWorkspaceEntries,
} from '../src/main/workspace-entry-page.ts'

const target = { workspaceId: 'workspace', workspaceGeneration: 4 }
const snapshot = {
  target,
  sequence: 8,
  stale: false,
  complete: true,
  capReached: false,
}

test('workspace pages retain tree order and bind continuation to target and sequence', () => {
  const entries = [
    {
      path: 'folder',
      name: 'folder',
      kind: 'folder',
      children: [
        { path: 'folder/one.md', name: 'one.md', kind: 'file' },
        { path: 'folder/two.md', name: 'two.md', kind: 'file' },
      ],
    },
    { path: 'three.md', name: 'three.md', kind: 'file' },
  ]
  const first = pageWorkspaceEntries(entries, snapshot, { target, limit: 2 })
  assert.equal(first.ok, true)
  assert.deepEqual(
    first.value.entries.map((entry) => entry.path),
    ['folder', 'folder/one.md'],
  )
  assert.ok(first.value.nextCursor)
  assert.equal(first.value.sequence, 8)
  assert.equal(
    pageWorkspaceEntries(entries, snapshot, { target, sequence: 7 }).code,
    'resync-needed',
  )
  const next = pageWorkspaceEntries(entries, snapshot, {
    target,
    cursor: first.value.nextCursor,
    limit: 2,
  })
  assert.equal(next.ok, true)
  assert.deepEqual(
    next.value.entries.map((entry) => entry.path),
    ['folder/two.md', 'three.md'],
  )
  assert.equal(next.value.nextCursor, null)
  assert.equal(
    pageWorkspaceEntries(
      entries,
      { ...snapshot, sequence: 9 },
      {
        target,
        cursor: first.value.nextCursor,
      },
    ).code,
    'resync-needed',
  )
  assert.equal(
    pageWorkspaceEntries(entries, snapshot, {
      target: { ...target, workspaceGeneration: 5 },
      cursor: first.value.nextCursor,
    }).code,
    'stale',
  )
  assert.equal(
    pageWorkspaceEntries(entries, snapshot, {
      target,
      cursor: 'malformed',
    }).code,
    'resync-needed',
  )
})

test('workspace pages cap utf-8 payload bytes without dropping entries', () => {
  const prefix = '子/'.repeat(125)
  const entries = Array.from({ length: 320 }, (_, index) => ({
    path: `${prefix}${index}.md`,
    name: `${index}.md`,
    kind: 'file',
  }))
  const listed = []
  let cursor
  do {
    const page = pageWorkspaceEntries(entries, snapshot, {
      target,
      cursor,
      limit: 200,
    })
    assert.equal(page.ok, true)
    assert.ok(
      Buffer.byteLength(JSON.stringify(page.value)) <= MAX_WORKSPACE_PAGE_BYTES,
    )
    assert.ok(page.value.entries.length > 0)
    listed.push(...page.value.entries.map((entry) => entry.path))
    cursor = page.value.nextCursor ?? undefined
  } while (cursor)
  assert.deepEqual(
    listed,
    entries.map((entry) => entry.path),
  )
})

test('workspace pages report stale and capped retained trees', () => {
  const capped = {
    ...snapshot,
    stale: true,
    complete: false,
    capReached: true,
  }
  const result = pageWorkspaceEntries([], capped, { target })
  assert.equal(result.ok, true)
  assert.equal(result.value.stale, true)
  assert.equal(result.value.complete, false)
  assert.equal(result.value.capReached, true)
  assert.equal(result.value.nextCursor, null)
  assert.equal(
    pageWorkspaceEntries([], snapshot, { target, limit: 201 }).code,
    'limit-exceeded',
  )
  assert.equal(
    pageWorkspaceEntries([], { ...snapshot, target: null }, { target }).code,
    'stale',
  )
})
