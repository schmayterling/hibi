import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'
import { errorMessage } from '../src/shared/errors.ts'

const source = stripTypeScriptTypes(
  await readFile(
    new URL('../src/addons/use-workspace-query.ts', import.meta.url),
    'utf8',
  ),
)
  .replace(/^import .* from .*$/gm, '')
  .replace(
    'export function useWorkspaceQueryTarget',
    'return function useWorkspaceQueryTarget',
  )

// Exercise request scheduling without mounting a renderer or replacing the hook.
function mount(context) {
  let value, stop
  const run = new Function('useEffect', 'useState', 'errorMessage', source)(
    (effect) => {
      stop = effect()
    },
    (initial) => {
      value = initial
      return [
        initial,
        (next) => (value = typeof next === 'function' ? next(value) : next),
      ]
    },
    errorMessage,
  )
  run(context)
  return { read: () => value, stop: () => stop() }
}
const settle = () => new Promise((resolve) => setImmediate(resolve))
const workspace = (generation) => ({
  id: 'notes',
  workspaceGeneration: generation,
  name: 'Notes',
  entries: [],
  activePath: 'draft.md',
})

test('metadata panels use one workspace read per debounced refresh and capture its generation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let reads = 0,
    snapshots = 0,
    documentChanged,
    workspaceChanged,
    removed = 0,
    current = workspace(1)
  const query = mount({
    editor: {
      onDocumentChange(listener) {
        documentChanged = listener
        listener()
        return () => removed++
      },
    },
    workspace: {
      async get() {
        reads++
        return current
      },
      async changeSnapshot() {
        snapshots++
        return { target: { workspaceId: 'wrong', workspaceGeneration: 99 } }
      },
      async subscribeChanges(listener) {
        workspaceChanged = listener
        return { dispose: () => removed++ }
      },
    },
  })
  await settle()
  assert.equal(reads, 1)
  assert.equal(snapshots, 0)
  assert.deepEqual(query.read().target, {
    workspaceId: 'notes',
    workspaceGeneration: 1,
  })
  assert.equal(query.read().workspace, current)
  t.mock.timers.tick(150)
  await settle()
  assert.equal(reads, 1)
  documentChanged()
  documentChanged()
  documentChanged()
  assert.equal(reads, 1)
  t.mock.timers.tick(150)
  await settle()
  assert.equal(reads, 2)
  current = workspace(2)
  workspaceChanged()
  t.mock.timers.tick(150)
  await settle()
  assert.deepEqual(query.read().target, {
    workspaceId: 'notes',
    workspaceGeneration: 2,
  })
  for (const missing of [
    null,
    { ...workspace(2), id: undefined },
    { ...workspace(2), workspaceGeneration: undefined },
  ]) {
    current = missing
    workspaceChanged()
    t.mock.timers.tick(150)
    await settle()
    assert.equal(query.read().target, null)
  }
  query.stop()
  assert.equal(removed, 2)
})

test('older or disposed workspace reads cannot replace the latest generation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const pending = []
  let changed
  const query = mount({
    editor: { onDocumentChange: () => () => {} },
    workspace: {
      get: () => new Promise((resolve) => pending.push(resolve)),
      changeSnapshot: async () => ({ target: null }),
      async subscribeChanges(listener) {
        changed = listener
        return { dispose() {} }
      },
    },
  })
  await settle()
  changed()
  t.mock.timers.tick(150)
  await settle()
  pending[1](workspace(2))
  await settle()
  pending[0](workspace(1))
  await settle()
  assert.deepEqual(query.read().target, {
    workspaceId: 'notes',
    workspaceGeneration: 2,
  })
  changed()
  t.mock.timers.tick(150)
  await settle()
  query.stop()
  pending[2](workspace(3))
  await settle()
  assert.equal(query.read().workspace.workspaceGeneration, 2)
})
