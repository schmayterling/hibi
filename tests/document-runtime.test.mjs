import assert from 'node:assert/strict'
import test from 'node:test'
import { DocumentRuntime } from '../src/renderer/src/document-runtime.ts'

const document = (text, overrides = {}) => ({
  tabId: 'one',
  tabs: [{ id: 'one', name: 'one.md', dirty: false }],
  tabsEnabled: true,
  id: 'file-one',
  ephemeral: false,
  markdown: text,
  savedMarkdown: text,
  name: 'one.md',
  dirty: false,
  revision: 1,
  contentVersion: 0,
  canAutosave: true,
  ...overrides,
})
const fixture = (options = {}) => {
  const operations = [],
    errors = []
  const runtime = new DocumentRuntime({
    ...options,
    enqueue: (op) => operations.push(op),
    onError: (error) => errors.push(error),
  })
  return { runtime, operations, errors }
}

test('first edit opens a tab from the zero-tab start view', () => {
  const { runtime } = fixture()
  runtime.activate(
    document('', {
      tabs: [],
      name: 'untitled.md',
      id: 'start-draft',
      revision: 0,
      canAutosave: false,
    }),
  )
  assert.equal(runtime.get().tabs.length, 0)
  runtime.replace('hello')
  assert.deepEqual(runtime.get().tabs, [
    { id: 'one', name: 'untitled.md', dirty: true },
  ])
  runtime.session().undo()
  assert.equal(runtime.get().tabs.length, 1)
  runtime.dispose()
})

test('runtime facades capture immutable full snapshots and do not flatten on publication', () => {
  const { runtime, operations } = fixture()
  const original = runtime.activate(document('old source'))
  const session = runtime.session()
  const notices = []
  runtime.subscribe((next, changes) => notices.push({ next, changes }))
  session.counters(true)
  session.edit([{ from: 0, to: 3, insert: 'new' }], 'source', 'typing', () => {
    assert.equal(runtime.get().contentVersion, 1)
    assert.equal(operations.length, 1)
  })
  assert.equal(session.counters().materializations, 0)
  const current = runtime.get()
  assert.equal(runtime.get(), current)
  assert.equal(notices[0].next, current)
  assert.equal(notices[0].changes[0].insert, 'new')
  assert.equal(runtime.sourceFor(current).sliceRaw(0, 3), 'new')
  assert.equal(current.markdown, 'new source')
  assert.equal(original.markdown, 'old source')
  assert.equal(original.contentVersion, 0)
  assert.equal(current.savedMarkdown, 'old source')
  assert.throws(() => {
    current.markdown = 'bad'
  }, TypeError)
  runtime.dispose()
})

test('runtime imports saved V while V+1 remains dirty and preserves history across tab revisions', async () => {
  const { runtime, operations, errors } = fixture()
  runtime.activate(document('a'))
  runtime.replace('ab')
  const saving = { ...runtime.get(), savedMarkdown: 'ab', dirty: false }
  runtime.replace('abc')
  runtime.acknowledgeSave(saving)
  assert.equal(runtime.get().dirty, true)
  assert.equal(runtime.get().savedMarkdown, 'ab')
  const first = { ...runtime.get() },
    firstSession = runtime.session()
  const tabs = [
    { id: 'one', name: 'one.md', dirty: true },
    { id: 'two', name: 'two.md', dirty: false },
  ]
  runtime.activate(
    document('other', { tabId: 'two', id: 'file-two', revision: 2, tabs }),
  )
  runtime.activate({ ...first, revision: 3, tabs })
  assert.equal(runtime.session(), firstSession)
  firstSession.undo()
  await firstSession.settled()
  assert.equal(runtime.get().markdown, 'ab')
  assert.equal(runtime.get().dirty, false)
  assert.equal(operations.at(-1).document.revision, 3)
  assert.deepEqual(errors, [])
  runtime.dispose()
})

test('runtime treats whole-source line-ending transforms as explicit atomic compatibility edits', () => {
  const { runtime, operations } = fixture()
  runtime.activate(document('a\r\nb\n'))
  runtime.replace('a\nb\n')
  assert.equal(runtime.get().markdown, 'a\nb\n')
  assert.equal(operations.length, 1)
  runtime.session().undo()
  assert.equal(runtime.get().markdown, 'a\r\nb\n')
  runtime.dispose()
})

test('combined history limits trim older tabs without changing their source or saved baselines', () => {
  const { runtime, errors } = fixture({ historyGroups: 3 })
  const tabs = ['one', 'two'].map((id) => ({
    id,
    name: `${id}.md`,
    dirty: true,
  }))
  runtime.activate(document('a', { tabs }))
  const first = runtime.session()
  runtime.replace('a1')
  runtime.replace('a12')
  const firstDocument = { ...runtime.get() }
  const firstSource = first.snapshot(),
    firstSaved = first.savedSnapshot()
  runtime.activate(
    document('b', { tabId: 'two', id: 'file-two', revision: 2, tabs }),
  )
  const second = runtime.session()
  first.counters(true)
  runtime.replace('b1')
  runtime.replace('b12')
  assert.equal(runtime.retainedHistory().groups, 3)
  assert.deepEqual(first.historyDepth(), { undo: 1, redo: 0 })
  assert.deepEqual(second.historyDepth(), { undo: 2, redo: 0 })
  assert.equal(first.snapshot(), firstSource)
  assert.equal(first.savedSnapshot(), firstSaved)
  assert.equal(first.counters().materializations, 0)
  assert.equal(first.state().dirty, true)
  runtime.activate({ ...firstDocument, revision: 3, tabs })
  assert.equal(runtime.session(), first)
  runtime.replace('a123')
  assert.deepEqual(second.historyDepth(), { undo: 1, redo: 0 })
  first.undo()
  first.undo()
  assert.equal(runtime.get().markdown, 'a1')
  assert.equal(first.undo(), null)
  assert.equal(runtime.get().dirty, true)
  runtime.activate({ ...runtime.get(), revision: 4, tabs: [tabs[0]] })
  assert.deepEqual(runtime.retainedHistory(), {
    ...first.historySize(),
    sessions: 1,
  })
  assert.throws(
    () => second.edit([{ from: 0, to: 0, insert: 'x' }], 'source', 'closed'),
    /disposed/,
  )
  runtime.activate(document('replacement', { revision: 5 }))
  assert.deepEqual(runtime.retainedHistory(), {
    bytes: 0,
    groups: 0,
    sessions: 0,
  })
  assert.deepEqual(errors, [])
  runtime.dispose()
})

test('combined history byte limits release payloads, and inactive completed edits are accounted for', () => {
  const { runtime, errors } = fixture({ historyBytes: 300 })
  const tabs = ['one', 'two'].map((id) => ({
    id,
    name: `${id}.md`,
    dirty: true,
  }))
  runtime.activate(document('', { tabs }))
  const first = runtime.session()
  runtime.replace('a'.repeat(50))
  runtime.activate(
    document('', { tabId: 'two', id: 'file-two', revision: 2, tabs }),
  )
  const second = runtime.session()
  runtime.replace('b'.repeat(50))
  assert.equal(first.historySize().groups, 0)
  assert.equal(first.snapshot().materialize(), 'a'.repeat(50))
  assert.ok(runtime.retainedHistory().bytes <= 300)
  first.edit([{ from: 0, to: 0, insert: 'c'.repeat(50) }], 'source', 'inactive')
  assert.equal(second.historySize().groups, 0)
  assert.equal(second.snapshot().materialize(), 'b'.repeat(50))
  assert.deepEqual(runtime.retainedHistory(), {
    ...first.historySize(),
    sessions: 1,
  })
  runtime.dispose()
  assert.deepEqual(runtime.retainedHistory(), {
    bytes: 0,
    groups: 0,
    sessions: 0,
  })
  assert.deepEqual(errors, [])
})

test('history accounting is updated before an eviction observer edits another session', () => {
  const { runtime, errors } = fixture({ historyGroups: 2 })
  const tabs = ['one', 'two', 'three'].map((id) => ({
    id,
    name: `${id}.md`,
    dirty: true,
  }))
  runtime.activate(document('a', { tabs }))
  const first = runtime.session()
  runtime.replace('a1')
  runtime.activate(
    document('b', { tabId: 'two', id: 'file-two', revision: 2, tabs }),
  )
  const second = runtime.session()
  runtime.replace('b1')
  runtime.activate(
    document('c', { tabId: 'three', id: 'file-three', revision: 3, tabs }),
  )
  const third = runtime.session()
  let observed = false
  first.subscribe(() => {
    if (observed) return
    observed = true
    second.edit([{ from: 2, to: 2, insert: '2' }], 'source', 'observer')
  })
  runtime.replace('c1')
  assert.equal(observed, true)
  assert.equal(first.snapshot().materialize(), 'a1')
  assert.equal(second.snapshot().materialize(), 'b12')
  assert.equal(third.snapshot().materialize(), 'c1')
  assert.equal(runtime.retainedHistory().groups, 2)
  assert.equal(
    first.historySize().groups +
      second.historySize().groups +
      third.historySize().groups,
    2,
  )
  assert.deepEqual(errors, [])
  runtime.dispose()
})

test('combined history limits reject invalid values and allow history-free editing', () => {
  for (const invalid of [-1, NaN, Infinity, 1.5]) {
    assert.throws(() => fixture({ historyGroups: invalid }), /Invalid/)
    assert.throws(() => fixture({ historyBytes: invalid }), /Invalid/)
  }
  const { runtime, errors } = fixture({ historyGroups: 0, historyBytes: 0 })
  runtime.activate(document('a'))
  runtime.replace('b')
  assert.equal(runtime.get().markdown, 'b')
  assert.equal(runtime.get().dirty, true)
  assert.equal(runtime.session().state().canUndo, false)
  assert.deepEqual(runtime.retainedHistory(), {
    bytes: 0,
    groups: 0,
    sessions: 0,
  })
  assert.deepEqual(errors, [])
  runtime.dispose()
})
