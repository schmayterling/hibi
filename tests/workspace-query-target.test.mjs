import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'
import { errorMessage } from '../src/shared/errors.ts'

const source = `${stripTypeScriptTypes(
  await readFile(
    new URL('../src/addons/use-workspace-query.ts', import.meta.url),
    'utf8',
  ),
)
  .replace(/^import .* from .*$/gm, '')
  .replaceAll('export function', 'function')}
return { useWorkspaceQueryTarget, useSerialRead }`

// Exercise request scheduling without mounting a renderer or replacing the hooks.
function hooks() {
  let value, stop
  const { useWorkspaceQueryTarget: queryTarget, useSerialRead: serialRead } =
    new Function('useEffect', 'useState', 'errorMessage', source)(
      (effect) => {
        stop = effect()
      },
      (initial) => {
        value = typeof initial === 'function' ? initial() : initial
        return [
          value,
          (next) => (value = typeof next === 'function' ? next(value) : next),
        ]
      },
      errorMessage,
    )
  return {
    target(context) {
      queryTarget(context)
      return { read: () => value, stop: () => stop() }
    },
    serial() {
      const run = serialRead()
      return { run, stop: () => stop() }
    },
  }
}
const mount = (context) => hooks().target(context)
const settle = () => new Promise((resolve) => setImmediate(resolve))
const workspace = (generation, activePath = 'draft.md') => ({
  id: 'notes',
  workspaceGeneration: generation,
  name: 'Notes',
  entries: [],
  activePath,
})
const note = (tabId, contentVersion, dirty = false) => ({
  tabId,
  id: `${tabId}-file`,
  revision: 1,
  contentVersion,
  dirty,
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
        listener(note('draft', 1))
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
  const target = query.read().target
  assert.deepEqual(target, { workspaceId: 'notes', workspaceGeneration: 1 })
  assert.equal(query.read().workspace, current)
  const revision = query.read().revision
  t.mock.timers.tick(150)
  await settle()
  assert.equal(reads, 1)
  documentChanged(note('draft', 2))
  documentChanged(note('draft', 3))
  documentChanged(note('draft', 4))
  assert.equal(reads, 1)
  t.mock.timers.tick(150)
  await settle()
  assert.equal(reads, 2)
  // Same generation: panels keep their target and see an edit through revision.
  assert.equal(query.read().target, target)
  assert.notEqual(query.read().revision, revision)
  current = workspace(2)
  workspaceChanged()
  t.mock.timers.tick(150)
  await settle()
  assert.deepEqual(query.read().target, {
    workspaceId: 'notes',
    workspaceGeneration: 2,
  })
  assert.notEqual(query.read().target, target)
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

test('switching notes refreshes the current note without invalidating metadata', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let reads = 0,
    documentChanged,
    current = workspace(1, 'a.md')
  const query = mount({
    editor: {
      onDocumentChange(listener) {
        documentChanged = listener
        listener(note('a', 1))
        return () => {}
      },
    },
    workspace: {
      async get() {
        reads++
        return current
      },
      async subscribeChanges() {
        return { dispose() {} }
      },
    },
  })
  await settle()
  const { target, revision } = query.read()
  // Repeated notices for the same text, such as saving, read nothing.
  documentChanged(note('a', 1))
  documentChanged({ ...note('a', 1), dirty: true })
  t.mock.timers.tick(150)
  await settle()
  assert.equal(reads, 1)
  // A clean note opened in another tab moves only the highlight.
  current = workspace(1, 'b.md')
  documentChanged(note('b', 7))
  t.mock.timers.tick(150)
  await settle()
  assert.equal(reads, 2)
  assert.equal(query.read().workspace.activePath, 'b.md')
  assert.equal(query.read().target, target)
  assert.equal(query.read().revision, revision)
  // Opening another note in the same tab loads a new revision: no invalidation.
  documentChanged({ ...note('b', 0), id: 'other-file', revision: 2 })
  t.mock.timers.tick(150)
  await settle()
  assert.equal(query.read().revision, revision)
  // Coming back to an unchanged tab does not invalidate either.
  documentChanged(note('a', 1))
  t.mock.timers.tick(150)
  await settle()
  assert.equal(query.read().revision, revision)
  // Unsaved edits, and a tab that arrives with unsaved edits, do.
  documentChanged(note('a', 2))
  t.mock.timers.tick(150)
  await settle()
  const edited = query.read().revision
  assert.notEqual(edited, revision)
  documentChanged(note('c', 1, true))
  t.mock.timers.tick(150)
  await settle()
  assert.notEqual(query.read().revision, edited)
  query.stop()
})

test('older or disposed workspace reads cannot replace the latest generation or drop an edit', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const pending = []
  let changed, documentChanged
  const query = mount({
    editor: {
      onDocumentChange(listener) {
        documentChanged = listener
        return () => {}
      },
    },
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
  pending[0](workspace(1))
  await settle()
  const revision = query.read().revision
  // An edit's read loses to a later read; the later one still carries the edit.
  documentChanged(note('a', 1))
  documentChanged(note('a', 2))
  t.mock.timers.tick(150)
  await settle()
  changed()
  t.mock.timers.tick(150)
  await settle()
  pending[2](workspace(2))
  await settle()
  pending[1](workspace(1))
  await settle()
  assert.deepEqual(query.read().target, {
    workspaceId: 'notes',
    workspaceGeneration: 2,
  })
  assert.notEqual(query.read().revision, revision)
  changed()
  t.mock.timers.tick(150)
  await settle()
  query.stop()
  pending[3](workspace(3))
  await settle()
  assert.equal(query.read().workspace.workspaceGeneration, 2)
})

test('serial reads run one at a time and keep only the newest waiting read', async () => {
  const { run, stop } = hooks().serial()
  const started = []
  const finish = []
  const read = (name) => async (alive) => {
    started.push(name)
    await new Promise((resolve) => finish.push(resolve))
    if (!alive()) started.push(`${name} stopped`)
  }
  run(read('first'))
  run(read('second'))
  run(read('third'))
  await settle()
  assert.deepEqual(started, ['first'])
  finish.shift()()
  await settle()
  assert.deepEqual(started, ['first', 'third'])
  stop()
  run(read('after unmount'))
  finish.shift()()
  await settle()
  assert.deepEqual(started, ['first', 'third', 'third stopped'])
})
