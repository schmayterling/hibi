import assert from 'node:assert/strict'
import test from 'node:test'
import {
  workspaceIndexNeedsDocumentRefresh,
  workspaceIndexStore,
} from '../src/addons/workspace-snapshot.ts'

test('mounted workspace panels share one index request per content change', async (t) => {
  const previousWindow = globalThis.window
  const requests = []
  const verifications = []
  let changed
  const focus = new Set()
  globalThis.window = {
    hibi: {
      getWorkspaceIndex: (verifyAll) => {
        verifications.push(verifyAll)
        return new Promise((resolve) => {
          requests.push(resolve)
        })
      },
      onWorkspaceChanged: (listener) => {
        changed = listener
        return () => {
          changed = undefined
        }
      },
    },
    addEventListener: (name, listener) => {
      if (name === 'focus') focus.add(listener)
    },
    removeEventListener: (name, listener) => {
      if (name === 'focus') focus.delete(listener)
    },
  }
  const removeGraph = workspaceIndexStore.subscribe(() => {})
  const removeTags = workspaceIndexStore.subscribe(() => {})
  t.after(() => {
    removeGraph()
    removeTags()
    globalThis.window = previousWindow
  })
  assert.equal(requests.length, 1)
  assert.deepEqual(verifications, [true])
  const indexed = {
    workspace: {
      id: 'notes',
      name: 'Notes',
      entries: [{ name: 'a.md', kind: 'file', path: 'a.md' }],
    },
    pages: [{ id: 'note', path: 'a.md', markdown: '# note' }],
  }
  requests.shift()(indexed)
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(workspaceIndexStore.snapshot().loading, false)

  changed(indexed.workspace, {
    kind: 'content',
    paths: ['ignored/image.svg'],
  })
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(requests.length, 0)
  const pending = {
    ...indexed.workspace,
    entries: [
      ...indexed.workspace.entries,
      { name: 'untitled.md', kind: 'file', path: 'untitled.md' },
    ],
  }
  changed(pending, { kind: 'content', paths: ['untitled.md'] })
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(requests.length, 1)
  requests.shift()({
    workspace: pending,
    pages: [
      ...indexed.pages,
      { id: 'draft', path: 'untitled.md', markdown: '' },
    ],
  })
  await Promise.resolve()
  await Promise.resolve()

  changed(pending, { kind: 'content', paths: ['a.md'] })
  changed(pending, { kind: 'content', paths: ['a.md'] })
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(requests.length, 1)
  assert.deepEqual(verifications, [true, false, false])
  requests.shift()(indexed)
  await Promise.resolve()
  await Promise.resolve()

  removeGraph()
  for (const listener of focus) listener()
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(requests.length, 1)
  assert.equal(verifications.at(-1), true)
  requests.shift()(indexed)
  await Promise.resolve()
  await Promise.resolve()
  removeTags()
  assert.equal(changed, undefined)
  assert.equal(focus.size, 0)
  const removeReopened = workspaceIndexStore.subscribe(() => {})
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(requests.length, 1)
  assert.equal(verifications.at(-1), true)
  requests.shift()(indexed)
  await Promise.resolve()
  await Promise.resolve()
  removeReopened()
})

test('selection stays local unless a draft needs to enter the shared index', () => {
  const index = {
    pages: [{ id: 'a', path: 'a.md', markdown: 'indexed draft' }],
  }
  assert.equal(
    workspaceIndexNeedsDocumentRefresh(
      index,
      { id: 'a', markdown: 'indexed draft', dirty: false },
      { id: 'b', markdown: '', dirty: false },
    ),
    false,
  )
  assert.equal(
    workspaceIndexNeedsDocumentRefresh(
      index,
      { id: 'a', markdown: 'new draft', dirty: true },
      { id: 'b', markdown: '', dirty: false },
    ),
    true,
  )
  assert.equal(
    workspaceIndexNeedsDocumentRefresh(
      index,
      { id: 'a', markdown: 'indexed draft', dirty: true },
      { id: 'a', markdown: 'saved text', dirty: false },
    ),
    true,
  )
})
