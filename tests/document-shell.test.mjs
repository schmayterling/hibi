import assert from 'node:assert/strict'
import test from 'node:test'
import { DocumentRuntime } from '../src/renderer/src/document-runtime.ts'
import {
  afterDocumentQuiet,
  certifyVisualEcho,
  editorDocumentUpdates,
  sameDocumentShell,
} from '../src/renderer/src/document-shell.ts'

const document = (overrides = {}) => ({
  tabId: 'one',
  tabs: [{ id: 'one', name: 'one.md', dirty: false }],
  tabsEnabled: true,
  id: 'file-one',
  ephemeral: false,
  markdown: 'initial',
  savedMarkdown: 'initial',
  name: 'one.md',
  dirty: false,
  revision: 1,
  contentVersion: 0,
  canAutosave: true,
  ...overrides,
})

test('typing keeps shell metadata stable while every canonical edit reaches subscribers', async () => {
  const operations = [],
    notices = [],
    shell = []
  const runtime = new DocumentRuntime({
    enqueue: (operation) => operations.push(operation),
    onError: (error) => {
      throw error
    },
  })
  let current = runtime.activate(document())
  const session = runtime.session()
  runtime.subscribe((next, changes) => {
    notices.push(next)
    if (!changes || !sameDocumentShell(current, next)) {
      current = next
      shell.push(next)
    }
  })
  session.counters(true)
  for (let i = 0; i < 100; i++) {
    const at = session.snapshot().utf16Length
    session.edit([{ from: at, to: at, insert: 's' }], 'source', 'typing')
  }
  assert.equal(operations.length, 100)
  assert.equal(notices.length, 100)
  assert.equal(shell.length, 1)
  assert.equal(shell[0].dirty, true)
  assert.equal(runtime.get().contentVersion, 100)
  assert.equal(session.counters().materializations, 0)
  assert.equal(runtime.get().markdown, `initial${'s'.repeat(100)}`)
  const saved = { ...runtime.get(), savedMarkdown: runtime.get().markdown }
  const token = runtime.beginSave()
  session.edit([{ from: 0, to: 0, insert: 'new ' }], 'source', 'later')
  runtime.acknowledgeSave(saved, token)
  assert.equal(shell.length, 2)
  assert.equal(shell.at(-1).dirty, true)
  assert.equal(shell.at(-1).savedMarkdown, saved.savedMarkdown)
  session.undo()
  await session.settled()
  assert.equal(shell.length, 3)
  assert.equal(shell.at(-1).dirty, false)
  runtime.dispose()
})

test('shell metadata notices identity, permissions and tabs without reading source getters', () => {
  const previous = document()
  // Define the getters on the fixture without spreading them.
  Object.defineProperties(previous, {
    markdown: {
      get() {
        throw new Error('must not read live source')
      },
    },
    savedMarkdown: {
      get() {
        throw new Error('must not read saved source')
      },
    },
  })
  const next = Object.create(previous)
  Object.defineProperty(next, 'contentVersion', { value: 20 })
  assert.equal(sameDocumentShell(previous, next), true)
  for (const [key, value] of Object.entries({
    id: 'other',
    tabId: 'two',
    revision: 2,
    name: 'renamed.md',
    dirty: true,
    ephemeral: true,
    canAutosave: false,
    tabsEnabled: false,
    tabs: [],
  })) {
    const changed = Object.create(previous)
    Object.defineProperty(changed, key, { value })
    assert.equal(sameDocumentShell(previous, changed), false, key)
  }
  assert.equal(sameDocumentShell(null, next), false)
})

test('source-only snapshots stay pinned during typing and refresh before entering a rich view', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const runtime = new DocumentRuntime({
    enqueue() {},
    onError(error) {
      throw error
    },
  })
  const original = runtime.activate(document())
  const updates = editorDocumentUpdates(runtime, true)
  let notices = 0
  const stop = updates.subscribe(() => notices++)
  const session = runtime.session()
  session.counters(true)
  for (let i = 0; i < 30; i++) {
    const at = session.snapshot().utf16Length
    session.edit([{ from: at, to: at, insert: 's' }], 'source', 'typing')
    t.mock.timers.tick(100)
    assert.equal(updates.get(), original)
  }
  assert.equal(notices, 0)
  assert.equal(session.counters().materializations, 0)
  const rich = editorDocumentUpdates(runtime, false)
  assert.equal(rich.get(), runtime.get())
  t.mock.timers.tick(150)
  assert.equal(updates.get(), runtime.get())
  assert.equal(notices, 1)
  session.edit([{ from: 0, to: 0, insert: 'new ' }], 'source', 'more')
  stop()
  t.mock.timers.tick(500)
  assert.equal(notices, 1)
  const reconnect = updates.subscribe(() => notices++)
  assert.equal(updates.get(), runtime.get())
  assert.equal(notices, 2)
  reconnect()
  runtime.dispose()
})

test('visual snapshots and save acknowledgments update immediately', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const runtime = new DocumentRuntime({
    enqueue() {},
    onError(error) {
      throw error
    },
  })
  runtime.activate(document())
  const updates = editorDocumentUpdates(runtime, false)
  let notices = 0
  const stop = updates.subscribe(() => notices++)
  runtime.session().edit([{ from: 0, to: 0, insert: 'x' }], 'source', 'typing')
  assert.equal(updates.get(), runtime.get())
  assert.equal(notices, 1)
  stop()
  const deferred = editorDocumentUpdates(runtime, true)
  const stopDeferred = deferred.subscribe(() => notices++)
  const token = runtime.beginSave()
  runtime.acknowledgeSave(
    {
      ...runtime.get(),
      savedMarkdown: runtime.get().markdown,
    },
    token,
  )
  assert.equal(deferred.get(), runtime.get())
  assert.equal(deferred.get().dirty, false)
  assert.equal(notices, 2)
  stopDeferred()
  runtime.dispose()
})

test('display detection cancels on canonical input while source props stay pinned', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const runtime = new DocumentRuntime({
    enqueue() {},
    onError(error) {
      throw error
    },
  })
  const original = runtime.activate(document())
  const updates = editorDocumentUpdates(runtime, true)
  const stopUpdates = updates.subscribe(() => {})
  let reads = 0
  const stopRead = afterDocumentQuiet(runtime, original, () => reads++)
  t.mock.timers.tick(100)
  runtime.session().edit([{ from: 0, to: 0, insert: 's' }], 'source', 'typing')
  assert.equal(updates.get(), original)
  t.mock.timers.tick(100)
  assert.equal(reads, 0)
  // An edit between render and effect setup must not start an obsolete read.
  assert.equal(
    afterDocumentQuiet(runtime, original, () => reads++),
    undefined,
  )
  t.mock.timers.tick(150)
  assert.equal(updates.get(), runtime.get())
  const stopLatest = afterDocumentQuiet(runtime, updates.get(), () => reads++)
  t.mock.timers.tick(200)
  assert.equal(reads, 1)
  stopRead()
  stopLatest()
  const stopDisposed = afterDocumentQuiet(runtime, updates.get(), () => reads++)
  stopDisposed()
  t.mock.timers.tick(200)
  assert.equal(reads, 1)
  const stopSwitch = afterDocumentQuiet(runtime, updates.get(), () => reads++)
  // Activation replaces the runtime snapshot without publishing an edit.
  runtime.activate(document({ revision: 2, tabId: 'two', id: 'file-two' }))
  t.mock.timers.tick(200)
  assert.equal(reads, 1)
  stopSwitch()
  stopUpdates()
  runtime.dispose()
})

test('only certified visual echoes coalesce without delaying canonical operations', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let canonical = 0
  const runtime = new DocumentRuntime({
    enqueue() {
      canonical++
    },
    onError(error) {
      throw error
    },
  })
  const original = runtime.activate(document())
  const updates = editorDocumentUpdates(runtime, false, true)
  let notifications = 0
  const stop = updates.subscribe(() => notifications++)
  const session = runtime.session()
  session.counters(true)
  for (let key = 0; key < 20; key++) {
    const at = session.snapshot().utf16Length
    const accepted = session.beginEdit(
      [{ from: at, to: at, insert: 's' }],
      'visual',
      'typing',
    )
    certifyVisualEcho(accepted.prepared.after)
    accepted.finish()
    t.mock.timers.tick(100)
    assert.equal(updates.get(), original)
  }
  assert.equal(canonical, 20)
  assert.equal(runtime.get().contentVersion, 20)
  assert.equal(notifications, 0)
  assert.equal(session.counters().materializations, 0)
  t.mock.timers.tick(150)
  assert.equal(notifications, 1)
  assert.equal(updates.get(), runtime.get())
  stop()
  runtime.dispose()
})

test('visual configuration opt-out, unproved edits, undo and save remain immediate', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const runtime = new DocumentRuntime({
    enqueue() {},
    onError(error) {
      throw error
    },
  })
  runtime.activate(document())
  const session = runtime.session()
  const guarded = editorDocumentUpdates(runtime, false)
  const stopGuarded = guarded.subscribe(() => {})
  const certified = (group) => {
    const accepted = session.beginEdit(
      [{ from: 0, to: 0, insert: 's' }],
      'visual',
      group,
    )
    certifyVisualEcho(accepted.prepared.after)
    accepted.finish()
  }
  certified('unknown-protection')
  assert.equal(guarded.get(), runtime.get())
  stopGuarded()
  const updates = editorDocumentUpdates(runtime, false, true)
  let notifications = 0
  const stop = updates.subscribe(() => notifications++)
  certified('safe')
  assert.notEqual(updates.get(), runtime.get())
  // A view or grammar change creates a fresh subscription before using props.
  assert.equal(editorDocumentUpdates(runtime, false).get(), runtime.get())
  for (const origin of ['source', 'addon', 'visual']) {
    session.edit([{ from: 0, to: 0, insert: 'x' }], origin, origin)
    assert.equal(updates.get(), runtime.get(), origin)
  }
  assert.equal(notifications, 3)
  certified('undo-target')
  session.undo()
  assert.equal(updates.get(), runtime.get())
  assert.equal(notifications, 4)
  certified('save-target')
  const token = runtime.beginSave()
  runtime.acknowledgeSave(
    {
      ...runtime.get(),
      savedMarkdown: runtime.get().markdown,
    },
    token,
  )
  assert.equal(updates.get(), runtime.get())
  assert.equal(notifications, 5)
  t.mock.timers.tick(250)
  assert.equal(notifications, 5)
  stop()
  runtime.dispose()
})
