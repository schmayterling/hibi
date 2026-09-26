import assert from 'node:assert/strict'
import test from 'node:test'
import {
  journalHead,
  verifyJournalCheckpoint,
} from '../src/shared/document-checkpoint.ts'
import {
  createDocumentJournal,
  createJournalReceiver,
  sourceChange,
} from '../src/shared/document-journal.ts'
import { DocumentSession } from '../src/shared/document-session.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'

function fixture() {
  const store = new SourceStore('', { tabId: 'a', revision: 0 }, 0, {
    maximumBytes: 1024,
  })
  const state = {
    tabId: 'a',
    revision: 0,
    get contentVersion() {
      return store.snapshot().version
    },
    get markdown() {
      return store.snapshot().materialize()
    },
  }
  const receive = createJournalReceiver(() => {
    store.reidentify(state)
    return store
  })
  const change = (before, after, version) => ({
    ...sourceChange(before, after),
    tabId: 'a',
    revision: 0,
    baseVersion: version,
    contentVersion: version + 1,
  })
  return { state, receive, change, store }
}

test('source deltas round trip Unicode boundaries, insertions, replacements, and deletions', () => {
  const values = [
    '',
    'a',
    '😀',
    '😎',
    '😀😀',
    'a😀b',
    'a😎b',
    'é',
    '## note\n\ntext',
    '[]()*&<>',
  ]
  for (const before of values)
    for (const after of values) {
      const edit = sourceChange(before, after)
      if (before === after) {
        assert.equal(edit, null)
        continue
      }
      assert.equal(
        before.slice(0, edit.from) + edit.insert + before.slice(edit.to),
        after,
      )
      assert.equal(/[\uD800-\uDFFF]/u.test(edit.insert), false)
    }
})

test('receiver routes interleaved edits to their owning tab', () => {
  const stores = new Map(
    ['a', 'b'].map((id) => [
      id,
      new SourceStore('', { tabId: id, revision: 1 }, 0),
    ]),
  )
  const receive = createJournalReceiver((id) => {
    const store = stores.get(id)
    if (!store) throw new Error('closed tab')
    return store
  })
  const edit = (tabId, baseVersion, from, insert) =>
    receive({
      tabId,
      revision: 1,
      baseVersion,
      contentVersion: baseVersion + 1,
      from,
      to: from,
      insert,
    })
  edit('a', 0, 0, 'a')
  edit('b', 0, 0, 'b')
  edit('a', 1, 1, '2')
  assert.equal(stores.get('a').snapshot().materialize(), 'a2')
  assert.equal(stores.get('b').snapshot().materialize(), 'b')
  assert.throws(() => edit('closed', 0, 0, 'x'), /closed tab/)
})

test('receiver enforces order and identity and deduplicates accepted retries', () => {
  const { state, receive, change } = fixture()
  const first = change('', 'hello', 0)
  assert.throws(() => receive(change('hello', 'hello!', 1)), /document changed/)
  const ack = receive(first)
  assert.deepEqual(receive(first), ack)
  assert.equal(state.contentVersion, 1)
  assert.throws(() => receive({ ...first, insert: 'other' }), /sequence/)
  for (const input of [
    { ...change('hello', 'hi', 1), tabId: 'b' },
    { ...change('hello', 'hi', 1), revision: 1 },
    { ...change('hello', 'hi', 1), from: -1 },
    { ...change('hello', 'hi', 1), to: 100 },
    { ...change('hello', 'hi', 1), insert: 'x'.repeat(1025) },
  ])
    assert.throws(() => receive(input))
  assert.equal(state.markdown, 'hello')
  receive(change('hello', '😀', 1))
  assert.throws(() => receive({ ...change('😀', 'x', 2), from: 1 }), /Unicode/)
  state.tabId = 'b'
  assert.deepEqual(receive(first), ack)
  assert.equal(state.markdown, '😀')
})

test('barriers recover lost acknowledgments and failed sends without duplicating edits', async () => {
  const { state, receive, change } = fixture()
  let sends = 0
  const journal = createDocumentJournal(async (request) => {
    sends++
    if (sends === 1) {
      receive(request)
      throw new Error('lost acknowledgment')
    }
    if (sends === 2) throw new Error('not delivered')
    return receive(request)
  })
  await assert.rejects(journal.append(change('', 'a', 0)))
  await assert.rejects(journal.append(change('a', 'ab', 1)))
  await journal.flush()
  assert.equal(state.markdown, 'ab')
  assert.equal(state.contentVersion, 2)
  assert.equal(journal.hasPending(), false)
  const previous = journal.flush()
  void journal.append(change('ab', 'abc', 2))
  await journal.flush()
  await previous
  assert.equal(state.markdown, 'abc')
})

test('a failed barrier blocks dependent actions and retains its pending edit for retry', async () => {
  const { state, receive, change } = fixture()
  let failed = true
  const journal = createDocumentJournal(async (request) => {
    if (failed) throw new Error('unavailable')
    return receive(request)
  })
  await assert.rejects(journal.append(change('', 'kept', 0)))
  let saved = false
  await assert.rejects(
    journal.flush().then(() => {
      saved = true
    }),
    /unavailable/,
  )
  assert.equal(saved, false)
  assert.equal(journal.hasPending(), true)
  failed = false
  await journal.flush()
  assert.equal(state.markdown, 'kept')
})

test('atomic operations share legacy ordering and reject partial batches and conflicting receipts', async () => {
  const { state, receive, change, store } = fixture()
  const journal = createDocumentJournal(async (message) => receive(message))
  await journal.append(change('', 'abcdef', 0))
  const operation = {
    document: { tabId: 'a', revision: 0 },
    operationId: 'batch',
    baseVersion: 1,
    contentVersion: 2,
    origin: 'visual',
    historyGroup: 'format',
    changes: [
      { from: 0, to: 1, insert: 'A' },
      { from: 5, to: 6, insert: 'F' },
    ],
  }
  assert.throws(() =>
    receive({
      ...operation,
      changes: [operation.changes[0], { from: 99, to: 99, insert: 'invalid' }],
    }),
  )
  assert.equal(state.markdown, 'abcdef')
  const ack = await journal.appendOperation(operation)
  assert.equal(ack.operationId, 'batch')
  assert.equal(state.markdown, 'AbcdeF')
  assert.deepEqual(receive(operation), ack)
  assert.throws(
    () => receive({ ...operation, operationId: 'conflict' }),
    /sequence/,
  )
  assert.equal(store.snapshot().version, 2)
  await journal.append(change('AbcdeF', 'AbcdeF!', 2))
  assert.equal(state.markdown, 'AbcdeF!')
  assert.equal(journal.pendingBytes(), 0)
})

test('synchronous transport failure retains an operation and pending-byte accounting until retry', async () => {
  const { receive, change } = fixture()
  let fail = true
  const journal = createDocumentJournal((message) => {
    if (fail) throw new Error('transport stopped')
    return Promise.resolve(receive(message))
  })
  await assert.rejects(
    journal.append(change('', 'kept', 0)),
    /transport stopped/,
  )
  assert.ok(journal.pendingBytes() > 0)
  assert.equal(journal.hasPending(), true)
  fail = false
  await journal.flush()
  assert.equal(journal.pendingBytes(), 0)
})

test('legacy raw line-ending changes preserve meaning without native whole-source reconstruction', () => {
  const store = new SourceStore('a\r\nb'.repeat(100_000), {
    tabId: 'a',
    revision: 0,
  })
  const receive = createJournalReceiver(() => store)
  store.counters(true)
  receive({
    tabId: 'a',
    revision: 0,
    baseVersion: 0,
    contentVersion: 1,
    from: 1,
    to: 2,
    insert: '',
  })
  assert.equal(store.counters().materializations, 0)
  assert.equal(store.snapshot().sliceRaw(0, 6), 'a\nba\r\n')
})

test('J07: saturation rejects before source/history/view commit and accepts input after recovery', async () => {
  const { receive } = fixture()
  let available = false
  const journal = createDocumentJournal(
    async (operation) => {
      if (!available) throw new Error('offline')
      return receive(operation)
    },
    { maximumBytes: 600, maximumBulkBytes: 600 },
  )
  const session = new DocumentSession('', { tabId: 'a', revision: 0 }, 0, {
    admit: journal.assertCapacity,
    enqueue: (operation) => {
      void journal.appendOperation(operation).catch(() => {})
    },
    onError: () => {},
  })
  session.edit([{ from: 0, to: 0, insert: 'a'.repeat(100) }], 'source', 'first')
  const before = session.snapshot(),
    history = session.historyDepth()
  let reconciled = false
  assert.throws(
    () =>
      session.edit(
        [{ from: 100, to: 100, insert: 'b'.repeat(100) }],
        'source',
        'second',
        () => {
          reconciled = true
        },
      ),
    /recovery is full/,
  )
  assert.equal(session.snapshot(), before)
  assert.deepEqual(session.historyDepth(), history)
  assert.equal(reconciled, false)
  assert.ok(journal.pendingBytes() <= 600)
  available = true
  await journal.flush()
  session.edit([{ from: 100, to: 100, insert: 'b' }], 'source', 'second')
  await journal.flush()
  assert.equal(session.snapshot().version, 2)
  session.dispose()
})

test('J02: delivery deadline retains edits and ignores a late acknowledgement after checkpoint recovery', async () => {
  const { receive, change, state, store } = fixture()
  let late,
    calls = 0
  const journal = createDocumentJournal(
    (request) => {
      calls++
      const ack = receive(request)
      return calls === 1
        ? new Promise((resolve) => {
            late = () => resolve(ack)
          })
        : Promise.resolve(ack)
    },
    {
      timeoutMs: 10,
      checkpoint: () => ({ ...journalHead(store), source: 'a' }),
      head: async () => journalHead(store),
      verify: (checkpoint) =>
        verifyJournalCheckpoint(() => store, checkpoint, 1024),
    },
  )
  await assert.rejects(journal.append(change('', 'a', 0)), /timed out/)
  assert.equal(journal.hasPending(), true)
  await journal.flush()
  assert.equal(state.markdown, 'a')
  assert.equal(state.contentVersion, 1)
  assert.equal(journal.state().inFlightCount, 1)
  assert.equal(calls, 1)
  await assert.rejects(journal.append(change('', 'b', 0)), /Conflicting/)
  await journal.append(change('a', 'ab', 1))
  late()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(journal.pendingBytes(), 0)
  assert.equal(calls, 2)
  assert.equal(journal.state().inFlightCount, 0)
  assert.equal(journal.state().lastMemoryAck.contentVersion, 2)
})

test('timed-out transport and checkpoint calls stay bounded across repeated barriers', async () => {
  const { change, receive, store } = fixture()
  let sends = 0,
    verifies = 0
  const journal = createDocumentJournal(
    (request) => {
      sends++
      receive(request)
      return new Promise(() => {})
    },
    {
      timeoutMs: 2,
      checkpoint: () => ({ ...journalHead(store), source: 'a' }),
      head: async () => journalHead(store),
      verify: () => {
        verifies++
        return new Promise(() => {})
      },
    },
  )
  await assert.rejects(journal.append(change('', 'a', 0)))
  for (let i = 0; i < 5; i++) await assert.rejects(journal.flush())
  assert.equal(sends, 1)
  assert.equal(verifies, 1)
  assert.equal(journal.state().inFlightCount, 1)
  assert.equal(journal.state().pendingCount, 1)
})

test('J09: a lost receipt beyond the horizon is retired only by exact checkpoint verification', async () => {
  const { receive, change, store, state } = fixture()
  let verifications = 0
  const journal = createDocumentJournal(
    async (request) => {
      const ack = receive(request)
      if (request.contentVersion === 1) throw new Error('lost oldest receipt')
      return ack
    },
    {
      checkpoint: () => ({ ...journalHead(store), source: 'x'.repeat(140) }),
      head: async () => journalHead(store),
      verify: async (checkpoint) => {
        verifications++
        return verifyJournalCheckpoint(() => store, checkpoint, 1024)
      },
    },
  )
  await assert.rejects(journal.append(change('', 'x', 0)))
  for (let version = 1; version < 140; version++)
    await journal.append(
      change('x'.repeat(version), 'x'.repeat(version + 1), version),
    )
  assert.equal(journal.state().pendingCount, 1)
  await journal.flush()
  assert.equal(verifications, 1)
  assert.equal(journal.hasPending(), false)
  assert.equal(journal.state().lastMemoryAck.contentVersion, 140)
  assert.equal(state.contentVersion, 140)
})

test('lost acknowledgement for an inactive tab uses that tab for recovery', async () => {
  const stores = new Map(
    ['a', 'b'].map((tabId) => [
      tabId,
      new SourceStore('', { tabId, revision: 0 }, 0),
    ]),
  )
  const storeFor = (tabId) => {
    const store = stores.get(tabId)
    if (!store) throw new Error('This tab is no longer open.')
    return store
  }
  const receive = createJournalReceiver(storeFor)
  const requested = []
  const journal = createDocumentJournal(
    async (change) => {
      receive(change)
      throw new Error('lost acknowledgement')
    },
    {
      checkpoint: (tabId) => {
        requested.push(tabId)
        const store = storeFor(tabId)
        return { ...journalHead(store), source: store.snapshot().materialize() }
      },
      head: async (tabId) => journalHead(storeFor(tabId)),
      verify: (checkpoint) =>
        verifyJournalCheckpoint(
          () => storeFor(checkpoint.tabId),
          checkpoint,
          1024,
        ),
    },
  )
  await assert.rejects(
    journal.append({
      tabId: 'b',
      revision: 0,
      baseVersion: 0,
      contentVersion: 1,
      from: 0,
      to: 0,
      insert: 'b',
    }),
    /lost acknowledgement/,
  )
  await journal.flush()
  assert.deepEqual(requested, ['b'])
  assert.equal(storeFor('a').snapshot().materialize(), '')
  assert.equal(storeFor('b').snapshot().materialize(), 'b')
  assert.equal(storeFor('b').snapshot().version, 1)
  assert.equal(journal.pendingBytes(), 0)
})

test('mixed pending tabs retire only groups with retained, verified checkpoints', async () => {
  const stores = new Map([
    ['a', new SourceStore('', { tabId: 'a', revision: 0 }, 0)],
    ['b', new SourceStore('', { tabId: 'b', revision: 1 }, 0)],
  ])
  const storeFor = (tabId) => {
    const store = stores.get(tabId)
    if (!store) throw new Error('This tab is no longer open.')
    return store
  }
  const receive = createJournalReceiver(storeFor)
  const verified = []
  let retainedB = false
  const journal = createDocumentJournal(
    async (change) => {
      receive(change)
      throw new Error('lost acknowledgement')
    },
    {
      checkpoint: (tabId) => {
        if (tabId === 'b' && !retainedB)
          throw new Error('No retained document recovery checkpoint.')
        const store = storeFor(tabId)
        return { ...journalHead(store), source: store.snapshot().materialize() }
      },
      head: async (tabId) => journalHead(storeFor(tabId)),
      verify: async (checkpoint) => {
        const head = await verifyJournalCheckpoint(
          () => storeFor(checkpoint.tabId),
          checkpoint,
          1024,
        )
        verified.push(`${head.tabId}:${head.revision}`)
        return head
      },
    },
  )
  for (const [tabId, revision] of [
    ['a', 0],
    ['b', 1],
  ])
    await assert.rejects(
      journal.append({
        tabId,
        revision,
        baseVersion: 0,
        contentVersion: 1,
        from: 0,
        to: 0,
        insert: tabId,
      }),
      /lost acknowledgement/,
    )
  await assert.rejects(journal.flush(), /No retained/)
  assert.deepEqual(verified, ['a:0'])
  assert.equal(journal.state().pendingCount, 1)
  assert.equal(storeFor('a').snapshot().materialize(), 'a')
  assert.equal(storeFor('b').snapshot().materialize(), 'b')
  retainedB = true
  await journal.flush()
  assert.deepEqual(verified, ['a:0', 'b:1'])
  assert.equal(storeFor('a').snapshot().version, 1)
  assert.equal(storeFor('b').snapshot().version, 1)
  assert.equal(journal.pendingBytes(), 0)
})

test('J06/J09: restarted receipt cache replays a contiguous suffix and preserves edits during verification', async () => {
  const { store, change, state } = fixture()
  let receive = createJournalReceiver(() => store),
    failed = true
  let beginVerification, releaseVerification
  const verifying = new Promise((resolve) => {
    beginVerification = resolve
  })
  const hold = new Promise((resolve) => {
    releaseVerification = resolve
  })
  let source = 'ab'
  const journal = createDocumentJournal(
    async (request) => {
      if (failed) {
        if (request.contentVersion === 1) receive(request)
        throw new Error('lost delivery')
      }
      return receive(request)
    },
    {
      checkpoint: () => ({
        tabId: 'a',
        revision: 0,
        contentVersion: 2,
        source,
      }),
      head: async () => journalHead(store),
      verify: async (checkpoint) => {
        beginVerification()
        await hold
        return verifyJournalCheckpoint(() => store, checkpoint, 1024)
      },
    },
  )
  await assert.rejects(journal.append(change('', 'a', 0)))
  await assert.rejects(journal.append(change('a', 'ab', 1)))
  receive = createJournalReceiver(() => store)
  failed = false
  const barrier = journal.flush()
  await verifying
  source = 'abc'
  const third = journal.append(change('ab', source, 2))
  assert.equal(state.markdown, 'ab')
  assert.equal(journal.state().pendingCount, 2)
  releaseVerification()
  await barrier
  await third
  assert.equal(state.markdown, 'abc')
  assert.equal(state.contentVersion, 3)
  assert.equal(journal.pendingBytes(), 0)
})

test('checkpoint mismatch or missing suffix never retires pending edits or overwrites native text', async () => {
  for (const invalid of ['content', 'identity', 'suffix', 'ack']) {
    const { store, receive, change, state } = fixture()
    const journal = createDocumentJournal(
      async (request) => {
        if (state.contentVersion === 0) receive(request)
        throw new Error('lost')
      },
      {
        checkpoint: () => ({
          tabId: invalid === 'identity' ? 'b' : 'a',
          revision: 0,
          contentVersion: invalid === 'suffix' ? 2 : 1,
          source: invalid === 'content' ? 'b' : 'a',
        }),
        head: async () => journalHead(store),
        verify: async (checkpoint) =>
          invalid === 'ack'
            ? { ...journalHead(store), contentVersion: 0 }
            : verifyJournalCheckpoint(() => store, checkpoint, 1024),
      },
    )
    await assert.rejects(journal.append(change('', 'a', 0)))
    await assert.rejects(journal.flush())
    assert.equal(journal.state().pendingCount, 1, invalid)
    assert.equal(state.markdown, 'a', invalid)
  }
})

test('background retry budget is finite; manual barriers can retry after exhaustion', async () => {
  const { receive, change } = fixture()
  let calls = 0,
    unavailable = true
  const journal = createDocumentJournal(
    async (request) => {
      calls++
      if (unavailable) throw new Error('offline')
      return receive(request)
    },
    { retryDelays: [1, 1] },
  )
  await assert.rejects(journal.append(change('', 'a', 0)))
  await new Promise((resolve) => setTimeout(resolve, 35))
  assert.equal(calls, 3)
  assert.equal(journal.hasPending(), true)
  unavailable = false
  await journal.flush()
  assert.equal(calls, 4)
  assert.equal(journal.hasPending(), false)
})
