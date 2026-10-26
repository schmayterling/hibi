import assert from 'node:assert/strict'
import test from 'node:test'
import { EditorState } from '@codemirror/state'
import { parser } from '@lezer/markdown'
import { createSourceSession } from '../src/renderer/src/source-session.ts'
import { DocumentSession } from '../src/shared/document-session.ts'
import { MarkdownSourceModel } from '../src/shared/markdown-source-model.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'
import { SourceMaintenance } from '../src/shared/source-maintenance.ts'
import { SourceParserSession } from '../src/shared/source-parser.ts'
import { sourceEditorText } from './source-editor-text.mjs'

const source = 'a'.repeat(80 * 4096)
const holes = Array.from({ length: 80 }, (_, n) => ({
  from: n * 4096,
  to: (n + 1) * 4096 - 1,
  insert: '',
}))
const fragment = (store) => {
  const before = store.snapshot()
  const prepared = store.prepare({
    document: before.document,
    operationId: `holes-${before.version}`,
    baseVersion: before.version,
    contentVersion: before.version + 1,
    historyGroup: 'holes',
    origin: 'source',
    changes: holes,
  })
  store.commit(prepared)
  return prepared
}

test('ENG23: maintenance publishes bounded storage without a source/history/selection transaction', async () => {
  const journal = [],
    errors = []
  const session = new DocumentSession(
    source,
    { tabId: 'maintenance', revision: 0 },
    0,
    {
      enqueue: (operation) => journal.push(operation),
      onError: (error) => errors.push(error),
    },
  )
  try {
    const bridge = createSourceSession(session)
    let updates = 0
    const view = {
      state: EditorState.create({ doc: sourceEditorText(session.snapshot()) }),
      update(transactions) {
        updates++
        this.state = transactions.at(-1).state
      },
    }
    const detach = bridge.attach(view)
    session.edit(holes, 'source', 'holes')
    session.select({
      ranges: [{ anchor: 12, head: 15, association: 1 }],
      mainIndex: 0,
    })
    session.markSaved(session.snapshot())
    const before = session.snapshot(),
      state = session.state(),
      selection = session.selection(),
      depth = session.historyDepth()
    const nativeState = view.state
    let contentNotifications = 0,
      storageNotifications = 0
    session.subscribe(() => contentNotifications++)
    session.subscribeStorage(() => storageNotifications++)
    session.counters(true)
    await session.maintainStorage()
    const after = session.snapshot()
    assert.notEqual(after, before)
    assert.equal(after.storageEpoch, before.storageEpoch + 1)
    assert.equal(after.materialize(), 'a'.repeat(80))
    assert.equal(session.state(), state)
    assert.equal(session.selection(), selection)
    assert.equal(session.savedSnapshot(), after)
    assert.equal(session.ownsCurrentSnapshot(before), true)
    assert.equal(
      session.ownsCurrentSnapshot(
        new SourceStore(
          'a'.repeat(80),
          after.document,
          after.version,
        ).snapshot(),
      ),
      false,
    )
    assert.deepEqual(session.historyDepth(), depth)
    assert.equal(journal.length, 1)
    assert.equal(contentNotifications, 0)
    assert.equal(storageNotifications, 1)
    assert.equal(updates, 1)
    assert.equal(view.state, nativeState)
    assert.equal(bridge.snapshot(), after)
    session.undo()
    assert.equal(session.snapshot().materialize(), source)
    session.redo()
    assert.equal(session.snapshot().materialize(), 'a'.repeat(80))
    assert.equal(session.state().dirty, false)
    assert.equal(session.ownsCurrentSnapshot(before), false)
    bridge.dispatch(
      [view.state.update({ changes: { from: 1, insert: '!' } })],
      view,
    )
    assert.equal(session.snapshot().sliceRaw(0, 3), 'a!a')
    assert.deepEqual(errors, [])
    detach()
  } finally {
    session.dispose()
  }
})

test('maintenance skips dense storage, cancels pinned work, and releases disposed jobs', async () => {
  const store = new SourceStore(source, { tabId: 'cancel', revision: 0 })
  const errors = []
  let commits = 0
  const maintenance = new SourceMaintenance(
    store,
    (change) => {
      store.commitCompaction(change)
      commits++
    },
    (error) => errors.push(error),
  )
  await maintenance.request()
  assert.equal(commits, 0)
  fragment(store)
  const canceled = maintenance.request()
  maintenance.cancel()
  await canceled
  assert.equal(commits, 0)
  await maintenance.request()
  assert.equal(commits, 1)
  const disposed = maintenance.request()
  maintenance.dispose()
  await disposed
  assert.equal(commits, 1)
  assert.deepEqual(errors, [])
})

test('parser and owner metadata retain identity across trusted storage changes, including in-flight parsing', () => {
  const store = new SourceStore('# title\r\n\r\nhello\r\n'.repeat(200), {
    tabId: 'parser-storage',
    revision: 0,
  })
  const parse = new SourceParserSession(store.snapshot(), parser, 'commonmark')
  const model = new MarkdownSourceModel(store.snapshot(), parser, 'commonmark')
  parse.advance()
  while (!model.advance().complete) {}
  const owners = model.state().owners
  const work = store.prepareCompaction()
  let next = work.next()
  while (!next.done) next = work.next()
  const change = next.value
  assert.throws(() => parse.adoptStorage(change), /untrusted/)
  store.commitCompaction(change)
  assert.throws(() => model.adoptStorage({ ...change }), /untrusted/)
  parse.adoptStorage(change)
  model.adoptStorage(change)
  assert.equal(model.state().owners, owners)
  assert.equal(model.state().complete, true)
  while (!parse.advance().complete) {}
  assert.equal(parse.state().source, change.after)
  assert.equal(parse.state().tree.length, change.after.normalizedLength)
  assert.throws(() => parse.adoptStorage(change), /stale/)
  model.dispose()
  parse.dispose()
})

test('input cancels an unfinished replacement before it can publish over newer source', async (t) => {
  const store = new SourceStore(source, { tabId: 'interrupt', revision: 0 })
  fragment(store)
  const pending = new Map(),
    errors = []
  let clock = 0,
    id = 0,
    commits = 0
  t.mock.method(performance, 'now', () => (clock += 2))
  t.mock.method(globalThis, 'setTimeout', (callback) => {
    pending.set(++id, callback)
    return id
  })
  t.mock.method(globalThis, 'clearTimeout', (timer) => pending.delete(timer))
  const maintenance = new SourceMaintenance(
    store,
    (change) => {
      commits++
      store.commitCompaction(change)
    },
    (error) => errors.push(error),
  )
  const finished = maintenance.request()
  while (!store.counters().compactionUnits) {
    assert.ok(pending.size)
    const [timer, callback] = pending.entries().next().value
    pending.delete(timer)
    callback()
  }
  const before = store.snapshot()
  store.commit(
    store.prepare({
      document: before.document,
      operationId: 'interrupt',
      baseVersion: before.version,
      contentVersion: before.version + 1,
      historyGroup: 'interrupt',
      origin: 'source',
      changes: [{ from: 0, to: 0, insert: 'new' }],
    }),
  )
  maintenance.changed(3)
  await finished
  assert.equal(commits, 0)
  assert.equal(pending.size, 0)
  assert.equal(store.snapshot().sliceRaw(0, 3), 'new')
  assert.equal(store.snapshot().storageEpoch, before.storageEpoch)
  assert.deepEqual(errors, [])
  maintenance.dispose()
})

test('saving an owned pre-compaction snapshot preserves reconciled content identity', async () => {
  const session = new DocumentSession(
    'a'.repeat(80),
    { tabId: 'saved-storage', revision: 0 },
    0,
    {
      enqueue: () => {},
      onError: (error) => {
        throw error
      },
    },
  )
  try {
    const initialSave = session.snapshot()
    session.edit([{ from: 0, to: 80, insert: source }], 'source', 'grow')
    session.markSaved(session.snapshot())
    session.edit(holes, 'source', 'holes')
    const laterSave = session.snapshot()
    await session.maintainStorage()
    assert.notEqual(session.snapshot(), laterSave)
    // A delayed earlier save completes, and exact deferred equality makes it clean.
    session.markSaved(initialSave)
    await session.settled()
    assert.equal(session.state().dirty, false)
    let notifications = 0
    session.subscribe(() => notifications++)
    session.markSaved(laterSave)
    assert.equal(session.state().dirty, false)
    assert.equal(notifications, 0)
    assert.equal(session.savedSnapshot(), session.snapshot())
  } finally {
    session.dispose()
  }
})
