import assert from 'node:assert/strict'
import test from 'node:test'
import { DocumentRuntime } from '../src/renderer/src/document-runtime.ts'
import {
  afterDocumentQuiet,
  editorDocumentUpdates,
  largeOpening,
  largeSource,
  sameDocumentShell,
  subscribeDocumentShell,
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
  const current = { current: runtime.activate(document()) }
  const session = runtime.session()
  subscribeDocumentShell(
    runtime,
    current,
    (next) => shell.push(next),
    (next) => notices.push(next),
  )
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

test('edits from every origin, undo and save reach visual subscribers immediately', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const runtime = new DocumentRuntime({
    enqueue() {},
    onError(error) {
      throw error
    },
  })
  runtime.activate(document())
  const session = runtime.session()
  const updates = editorDocumentUpdates(runtime, false)
  let notifications = 0
  const stop = updates.subscribe(() => notifications++)
  for (const origin of ['source', 'addon', 'visual']) {
    session.edit([{ from: 0, to: 0, insert: 'x' }], origin, origin)
    assert.equal(updates.get(), runtime.get(), origin)
  }
  assert.equal(notifications, 3)
  session.undo()
  assert.equal(updates.get(), runtime.get())
  assert.equal(notifications, 4)
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

test('opening mode stays fixed while edits cross the threshold, then refreshes on activation', () => {
  for (const [initial, inserted] of [
    ['small', 'x'.repeat(290000)],
    ['x'.repeat(290000), 'small'],
  ]) {
    const runtime = new DocumentRuntime({
      enqueue() {},
      onError: (error) => {
        throw error
      },
    })
    runtime.activate(document({ markdown: initial, savedMarkdown: initial }))
    const before = largeOpening(runtime, runtime.get())
    const session = runtime.session()
    session.edit(
      [{ from: 0, to: initial.length, insert: inserted }],
      'source',
      'replace',
    )
    session.counters(true)
    assert.equal(largeOpening(runtime, runtime.get()), before)
    // The live size follows the edit, from the snapshot length alone.
    assert.equal(largeSource(runtime, 'one'), !before)
    assert.equal(largeSource(runtime, 'missing'), false)
    assert.equal(session.counters().materializations, 0)
    const next = { ...runtime.get(), revision: 2 }
    runtime.activate(next)
    assert.equal(largeOpening(runtime, runtime.get()), !before)
    runtime.dispose()
  }
})

test('large source opening policy reads only snapshot metrics and leaves small notes unchanged', () => {
  const state = document()
  Object.defineProperty(state, 'markdown', {
    get() {
      throw new Error('opening policy must not read whole source')
    },
  })
  for (const units of [
    0,
    16384,
    256 * 1024,
    256 * 1024 + 1,
    50 * 1024 * 1024,
  ]) {
    const runtime = {
      openingLength: (value) => {
        assert.equal(value, state)
        return units
      },
    }
    assert.equal(largeOpening(runtime, state), units > 256 * 1024)
  }
  assert.equal(
    largeOpening(
      {
        openingLength() {
          throw new Error('no document')
        },
      },
      null,
    ),
    false,
  )
})
