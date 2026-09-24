import assert from 'node:assert/strict'
import test from 'node:test'
import { workspaceIndexStore } from '../src/addons/workspace-snapshot.ts'

test('mounted workspace panels share one index request per content change', async (t) => {
  const previousWindow = globalThis.window
  const requests = []
  let changed
  const focus = new Set()
  globalThis.window = {
    hibi: {
      getWorkspaceIndex: () =>
        new Promise((resolve) => {
          requests.push(resolve)
        }),
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
  const indexed = {
    workspace: { id: 'notes', name: 'Notes' },
    pages: [{ id: 'note', path: 'a.md', markdown: '# note' }],
  }
  requests.shift()(indexed)
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(workspaceIndexStore.snapshot().loading, false)

  changed({ id: 'notes' }, { kind: 'content', paths: ['ignored/image.svg'] })
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(requests.length, 0)
  changed({ id: 'notes' }, { kind: 'content', paths: ['a.md'] })
  changed({ id: 'notes' }, { kind: 'content', paths: ['a.md'] })
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(requests.length, 1)
  requests.shift()(indexed)
  await Promise.resolve()
  await Promise.resolve()

  removeGraph()
  for (const listener of focus) listener()
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(requests.length, 1)
  requests.shift()(indexed)
  await Promise.resolve()
  await Promise.resolve()
  removeTags()
  assert.equal(changed, undefined)
  assert.equal(focus.size, 0)
})
