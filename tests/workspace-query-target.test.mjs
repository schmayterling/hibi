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

// Maps the hooks create, so tests can see how much they remember and touch.
const maps = []
let operations = 0
class TrackedMap extends Map {
  constructor(...entries) {
    super(...entries)
    maps.push(this)
  }
  get(key) {
    operations++
    return super.get(key)
  }
  set(key, value) {
    operations++
    return super.set(key, value)
  }
}
// Exercise request scheduling without mounting a renderer or replacing the hooks.
function hooks() {
  let value, stop
  const { useWorkspaceQueryTarget: queryTarget, useSerialRead: serialRead } =
    new Function('useEffect', 'useState', 'errorMessage', 'Map', source)(
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
      TrackedMap,
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
// The active tab's notice; `open` lists every open tab and `unsaved` the others with edits.
const note = (
  tabId,
  contentVersion,
  dirty = false,
  open = [tabId],
  unsaved = [],
) => ({
  tabId,
  id: `${tabId}-file`,
  revision: 1,
  contentVersion,
  dirty,
  tabs: open.map((id) => ({
    id,
    name: `${id}.md`,
    dirty: id === tabId ? dirty : unsaved.includes(id),
  })),
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
        listener(note('a', 1, false, ['a', 'b']))
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
  // Repeated notices for the same text read nothing.
  documentChanged(note('a', 1, false, ['a', 'b']))
  t.mock.timers.tick(150)
  await settle()
  assert.equal(reads, 1)
  // A clean note in another tab moves only the highlight.
  current = workspace(1, 'b.md')
  documentChanged(note('b', 7, false, ['a', 'b']))
  t.mock.timers.tick(150)
  await settle()
  assert.equal(reads, 2)
  assert.equal(query.read().workspace.activePath, 'b.md')
  assert.equal(query.read().target, target)
  assert.equal(query.read().revision, revision)
  // Opening another clean note in the same tab loads a new revision.
  documentChanged({
    ...note('b', 0, false, ['a', 'b']),
    id: 'other-file',
    revision: 2,
  })
  t.mock.timers.tick(150)
  await settle()
  assert.equal(query.read().revision, revision)
  // Coming back to an unchanged tab does not invalidate either.
  documentChanged(note('a', 1, false, ['a', 'b']))
  t.mock.timers.tick(150)
  await settle()
  assert.equal(query.read().revision, revision)
  // Unsaved edits, and a tab that arrives with unsaved edits, do.
  documentChanged(note('a', 2, true, ['a', 'b']))
  t.mock.timers.tick(150)
  await settle()
  const edited = query.read().revision
  assert.notEqual(edited, revision)
  documentChanged(note('c', 1, true, ['a', 'b', 'c'], ['a']))
  t.mock.timers.tick(150)
  await settle()
  assert.notEqual(query.read().revision, edited)
  query.stop()
})

test('dropping unsaved edits invalidates metadata, and only open tabs are remembered', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let documentChanged
  const query = mount({
    editor: {
      onDocumentChange(listener) {
        documentChanged = listener
        listener(note('a', 1, false, ['a', 'b']))
        return () => {}
      },
    },
    workspace: {
      get: async () => workspace(1),
      subscribeChanges: async () => ({ dispose() {} }),
    },
  })
  await settle()
  const step = async (document) => {
    documentChanged(document)
    t.mock.timers.tick(150)
    await settle()
    return query.read().revision
  }
  // An unsaved edit in a, then closing a without saving it.
  const edited = await step(note('a', 2, true, ['a', 'b']))
  const closed = await step(note('b', 1, false, ['b']))
  assert.notEqual(closed, edited)
  // Reverting unsaved edits in place.
  const unsaved = await step(note('b', 2, true, ['b']))
  assert.notEqual(await step(note('b', 2, false, ['b'])), unsaved)
  // Replacing an edited note in the same tab.
  const replacing = await step(note('b', 3, true, ['b']))
  assert.notEqual(
    await step({
      ...note('b', 0, false, ['b']),
      id: 'other-file',
      revision: 2,
    }),
    replacing,
  )
  // Showing 20,000 notes in two tabs remembers two tabs, not 20,000 notes.
  maps.length = 0
  for (let shown = 0; shown < 20000; shown++)
    documentChanged({
      ...note(shown % 2 ? 'a' : 'b', 0, false, ['a', 'b']),
      revision: shown + 10,
    })
  assert.ok(Math.max(...maps.map((map) => map.size)) <= 2)
  query.stop()
})

test('typing in one of 10,000 open tabs touches only that tab', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let documentChanged
  const query = mount({
    editor: {
      onDocumentChange(listener) {
        documentChanged = listener
        return () => {}
      },
    },
    workspace: {
      get: async () => workspace(1),
      subscribeChanges: async () => ({ dispose() {} }),
    },
  })
  await settle()
  const open = Array.from({ length: 10000 }, (_, index) => `t${index}`)
  const typing = note('t0', 1, true, open)
  documentChanged(typing)
  t.mock.timers.tick(150)
  await settle()
  const revision = query.read().revision
  // The editor keeps the same tab list while only the text changes.
  operations = 0
  for (let version = 2; version <= 101; version++)
    documentChanged({ ...typing, contentVersion: version })
  assert.ok(operations <= 200, `${operations} map operations for 100 keys`)
  t.mock.timers.tick(150)
  await settle()
  assert.notEqual(query.read().revision, revision)
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

test('a stale read runs again shortly unless a newer read was requested', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { run, stop } = hooks().serial()
  const runs = []
  const read = (name, retries) => async (_alive, retry) => {
    runs.push(name)
    if (runs.filter((entry) => entry === name).length <= retries) retry()
  }
  run(read('first', 1))
  await settle()
  assert.deepEqual(runs, ['first'])
  t.mock.timers.tick(150)
  await settle()
  assert.deepEqual(runs, ['first', 'first'])
  // A newer request replaces a pending retry.
  run(read('second', 1))
  await settle()
  run(read('third', 0))
  await settle()
  t.mock.timers.tick(150)
  await settle()
  assert.deepEqual(runs, ['first', 'first', 'second', 'third'])
  stop()
})

test('cancelled reads stop paging, drop the waiting read, and skip retries', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { run, stop } = hooks().serial()
  const runs = []
  run(async (_alive, retry) => {
    runs.push('stale')
    retry()
  })
  await settle()
  // No workspace: the stale read's retry must not query the old one.
  run(null)
  t.mock.timers.tick(150)
  await settle()
  assert.deepEqual(runs, ['stale'])
  let finish, paging
  run(async (alive) => {
    await new Promise((resolve) => {
      finish = resolve
    })
    paging = alive()
  })
  run(async () => {
    runs.push('waiting')
  })
  await settle()
  run(null)
  finish()
  await settle()
  assert.equal(paging, false)
  assert.deepEqual(runs, ['stale'])
  stop()
})
