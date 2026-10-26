import assert from 'node:assert/strict'
import test from 'node:test'
import { DocumentWorkerService } from '../src/shared/document-worker-service.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'
import { loadWorker } from './document-worker-transfer.mjs'

function fixture(t, source = 'one two one') {
  const messages = [],
    pending = new Set()
  const worker = new DocumentWorkerService((message) => {
    messages.push(message)
    for (const check of pending) check()
  })
  t.after(() => worker.dispose())
  const next = (predicate) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(check)
        reject(
          Object.assign(new Error('Missing worker reply'), {
            expected: String(predicate),
            recent: messages
              .slice(-8)
              .map(({ type, epoch, id, version, stage, message }) => ({
                type,
                epoch,
                id,
                version,
                stage,
                message,
              })),
          }),
        )
      }, 2000)
      const check = () => {
        const found = messages.find(predicate)
        if (!found) return
        pending.delete(check)
        clearTimeout(timer)
        resolve(found)
      }
      pending.add(check)
      check()
    })
  const load = (epoch = 'first', body = source) => {
    loadWorker(worker, messages, body, epoch)
  }
  const find = (id, version = 0, query = 'one', from = 0, to = 0) =>
    worker.receive({
      type: 'find',
      epoch: 'first',
      id,
      version,
      query,
      from,
      to,
    })
  load()
  return { worker, messages, next, load, find }
}

test('find uses channel tasks after real build steps and closes ports on completion, cancel and dispose', async (t) => {
  const NativeChannel = MessageChannel,
    channels = []
  t.mock.method(
    globalThis,
    'MessageChannel',
    class extends NativeChannel {
      constructor() {
        super()
        channels.push({
          channel: this,
          close1: t.mock.method(this.port1, 'close'),
          close2: t.mock.method(this.port2, 'close'),
          post: t.mock.method(this.port2, 'postMessage'),
        })
      }
    },
  )
  const f = fixture(t, 'one two '.repeat(100000)),
    timers = t.mock.method(globalThis, 'setTimeout')
  f.find(1)
  const result = await f.next((reply) => reply.type === 'find')
  assert.equal(result.location.total, 100000)
  // Only fixture.next owns a timeout; every find slice uses a channel task.
  assert.equal(timers.mock.calls.length, 1)
  assert.equal(channels.length, 1)
  assert.ok(channels[0].post.mock.calls.length > 1)
  assert.ok(f.messages.some((reply) => reply.type === 'find-progress'))
  assert.equal(channels[0].close1.mock.calls.length, 1)
  assert.equal(channels[0].close2.mock.calls.length, 1)
  f.find(2, 0, 'absent')
  f.worker.receive({ type: 'cancel-find', epoch: 'first', id: 2 })
  assert.equal(channels[1].close1.mock.calls.length, 1)
  assert.equal(channels[1].close2.mock.calls.length, 1)
  f.find(3, 0, 'one')
  f.worker.dispose()
  assert.equal(channels[2].close1.mock.calls.length, 1)
  assert.equal(channels[2].close2.mock.calls.length, 1)
})

test('worker acknowledges stream start without publishing an incomplete version', () => {
  const replies = []
  const worker = new DocumentWorkerService((reply) => replies.push(reply))
  try {
    worker.receive({
      type: 'load-start',
      epoch: 'stream-regression',
      head: {
        tabId: 'a',
        revision: 0,
        contentVersion: 3,
        streamId: 'bootstrap',
        length: 1,
      },
    })
    assert.equal(
      replies.at(-1)?.type,
      'load-ack',
      'worker must acknowledge stream start',
    )
    assert.equal(
      replies.some((reply) => reply.type === 'ack'),
      false,
    )
    worker.receive({
      type: 'load-chunk',
      epoch: 'stream-regression',
      chunk: { streamId: 'bootstrap', sequence: 0, chunks: ['x'], done: true },
    })
    assert.deepEqual(replies.at(-1).request, {
      streamId: 'bootstrap',
      sequence: 1,
    })
    assert.equal(
      replies.some((reply) => reply.type === 'ack'),
      false,
    )
    worker.receive({
      type: 'load-finish',
      epoch: 'stream-regression',
      request: { streamId: 'bootstrap', sequence: 1 },
    })
    assert.deepEqual(replies.at(-1), {
      type: 'ack',
      epoch: 'stream-regression',
      version: 3,
    })
  } finally {
    worker.dispose()
  }
})

test('worker aborts malformed or out of order streams and requires a fresh start', () => {
  const replies = []
  const worker = new DocumentWorkerService((reply) => replies.push(reply))
  const epoch = 'invalid-stream'
  const head = {
    tabId: 'a',
    revision: 2,
    contentVersion: 7,
    streamId: 'stream',
    length: 2,
  }
  const chunk = { streamId: 'stream', sequence: 0, chunks: ['xy'], done: true }
  try {
    for (const invalid of [
      { ...chunk, sequence: 1 },
      { ...chunk, streamId: 'old' },
      { ...chunk, chunks: ['x'.repeat(65537)] },
      { ...chunk, chunks: ['x'.repeat(32769), 'x'.repeat(32769)] },
      { ...chunk, chunks: Array(17).fill('x') },
      { ...chunk, chunks: [42] },
      { ...chunk, chunks: ['x'] },
      { ...chunk, chunks: [] },
    ]) {
      worker.receive({ type: 'load-start', epoch, head })
      worker.receive({ type: 'load-chunk', epoch, chunk: invalid })
      assert.equal(replies.at(-1).stage, 'replica')
      worker.receive({ type: 'load-chunk', epoch, chunk })
      assert.equal(replies.at(-1).stage, 'replica')
      worker.receive({
        type: 'load-finish',
        epoch,
        request: { streamId: 'stream', sequence: 1 },
      })
      assert.equal(replies.at(-1).stage, 'replica')
    }
    for (const request of [
      { streamId: 'stream', sequence: 0 },
      { streamId: 'old', sequence: 1 },
      { streamId: 'stream', sequence: 2 },
    ]) {
      worker.receive({ type: 'load-start', epoch, head })
      worker.receive({ type: 'load-chunk', epoch, chunk })
      worker.receive({ type: 'load-finish', epoch, request })
      assert.equal(replies.at(-1).stage, 'replica')
    }
    worker.receive({ type: 'load-start', epoch, head })
    worker.receive({
      type: 'load-finish',
      epoch,
      request: { streamId: 'stream', sequence: 0 },
    })
    assert.equal(replies.at(-1).stage, 'replica')
    worker.receive({ type: 'load-start', epoch, head })
    worker.receive({ type: 'load-chunk', epoch, chunk })
    worker.receive({ type: 'load-chunk', epoch, chunk })
    assert.equal(replies.at(-1).stage, 'replica')
    assert.equal(
      replies.some((reply) => reply.type === 'ack'),
      false,
    )
    loadWorker(worker, replies, 'fresh', epoch, { tabId: 'a', revision: 2 }, 8)
    assert.equal(replies.at(-1).version, 8)
  } finally {
    worker.dispose()
  }
})

test('worker start replaces partial streams and stale epochs cannot publish old source', async (t) => {
  const f = fixture(t)
  const start = (epoch, streamId, contentVersion) =>
    f.worker.receive({
      type: 'load-start',
      epoch,
      head: { tabId: 'a', revision: 1, contentVersion, streamId, length: 3 },
    })
  start('old', 'old', 4)
  f.worker.receive({
    type: 'load-chunk',
    epoch: 'old',
    chunk: { streamId: 'old', sequence: 0, chunks: ['x'], done: false },
  })
  start('fresh', 'fresh', 5)
  const count = f.messages.length
  f.worker.receive({
    type: 'load-finish',
    epoch: 'old',
    request: { streamId: 'old', sequence: 1 },
  })
  assert.equal(f.messages.length, count)
  f.worker.receive({
    type: 'load-chunk',
    epoch: 'fresh',
    chunk: { streamId: 'fresh', sequence: 0, chunks: ['one'], done: true },
  })
  f.worker.receive({
    type: 'load-finish',
    epoch: 'fresh',
    request: { streamId: 'fresh', sequence: 1 },
  })
  assert.equal(f.messages.at(-1).version, 5)
  f.worker.receive({
    type: 'find',
    epoch: 'fresh',
    id: 1,
    version: 5,
    query: 'one',
    from: 0,
    to: 0,
  })
  assert.equal(
    (await f.next((reply) => reply.type === 'find')).location.total,
    1,
  )
  start('fresh', 'partial', 6)
  start('fresh', 'replacement', 7)
  f.worker.receive({
    type: 'load-chunk',
    epoch: 'fresh',
    chunk: { streamId: 'partial', sequence: 0, chunks: ['old'], done: true },
  })
  assert.equal(f.messages.at(-1).stage, 'replica')
  f.worker.receive({
    type: 'load-finish',
    epoch: 'fresh',
    request: { streamId: 'replacement', sequence: 0 },
  })
  assert.equal(f.messages.at(-1).stage, 'replica')
})

test('obsolete single payload loads are rejected even with valid bounded source', (t) => {
  const f = fixture(t)
  f.worker.receive({
    type: 'load',
    epoch: 'first',
    document: { tabId: 'a', revision: 0 },
    version: 0,
    chunks: ['x'],
  })
  assert.equal(f.messages.at(-1).stage, 'replica')
  assert.equal(f.messages.at(-1).message, 'Unknown document worker request.')
  f.load('replacement', 'fresh')
  assert.equal(f.messages.at(-1).type, 'ack')
})

test('math reference grammar invalidates cached definitions and hides opaque math contents', async (t) => {
  const source = '$$\n\n[ref]: /hidden\n\n$$\n\n[ref]: /real\n',
    f = fixture(t, source)
  const request = async (id, math, version = 0) => {
    f.worker.receive({
      type: 'metadata',
      epoch: 'first',
      id,
      version,
      dialect: 'gfm',
      from: 0,
      to: 0,
      limit: 1,
      reference: {
        label: 'ref',
        gfm: true,
        alerts: false,
        textExtras: false,
        math,
      },
    })
    return f.next((reply) => reply.type === 'metadata' && reply.id === id)
  }
  assert.equal((await request(1, true)).reference.href, '/real')
  assert.equal((await request(2, false)).reference.href, '/hidden')
  assert.equal((await request(3, true)).reference.href, '/real')
  const from = source.indexOf('/real')
  f.worker.receive({
    type: 'edit',
    epoch: 'first',
    operation: {
      document: { tabId: 'a', revision: 0 },
      operationId: 'math-reference-edit',
      baseVersion: 0,
      contentVersion: 1,
      origin: 'source',
      historyGroup: 'typing',
      changes: [{ from, to: from + 5, insert: '/updated' }],
    },
  })
  assert.equal((await request(4, true, 1)).reference.href, '/updated')
  f.worker.receive({
    type: 'metadata',
    epoch: 'first',
    id: 5,
    version: 1,
    dialect: 'gfm',
    from: 0,
    to: 0,
    limit: 1,
    reference: {
      label: 'ref',
      gfm: true,
      alerts: false,
      textExtras: false,
      math: 'yes',
    },
  })
  await f.next(
    (reply) =>
      reply.type === 'error' && reply.id === 5 && reply.stage === 'metadata',
  )
})

test('metadata reference lookup uses exact edits, grammar, first definitions and opaque frontmatter', async (t) => {
  const source =
    '---\nvalue: |\n\n  [ref]: /metadata\n---\n\n[ref]\n\n[REF]: /first\n\n[ref]: /second\n'
  const f = fixture(t, source)
  let id = 0
  const request = (version, frontmatter = true, label = 'ref', extras = {}) => {
    const requestId = ++id
    f.worker.receive({
      type: 'metadata',
      epoch: 'first',
      id: requestId,
      version,
      dialect: 'gfm',
      frontmatter,
      from: 0,
      to: 0,
      limit: 1,
      reference: {
        label,
        gfm: true,
        alerts: true,
        textExtras: true,
        ...extras,
      },
    })
    return f.next(
      (reply) =>
        reply.id === requestId &&
        (reply.type === 'metadata' || reply.type === 'error'),
    )
  }
  assert.equal((await request(0)).reference.href, '/first')
  const from = source.indexOf('[REF]:'),
    to = source.indexOf('[ref]: /second')
  f.worker.receive({
    type: 'edit',
    epoch: 'first',
    operation: {
      document: { tabId: 'a', revision: 0 },
      operationId: 'remove-first',
      baseVersion: 0,
      contentVersion: 1,
      origin: 'source',
      historyGroup: 'typing',
      changes: [{ from, to, insert: '' }],
    },
  })
  assert.equal((await request(1)).reference.href, '/second')
  assert.equal((await request(1, true, 'missing')).reference, null)
  f.worker.receive({
    type: 'cancel-metadata',
    epoch: 'first',
    id,
    release: true,
  })
  assert.equal((await request(1)).reference.href, '/second')
  assert.equal(
    (await request(1, true, 'ref', { gfm: false })).stage,
    'metadata',
  )
  f.load('first', '-# small\n[ref]: /extra\n\n[ref]\n')
  assert.equal((await request(0)).reference.href, '/extra')
  assert.equal(
    (await request(0, true, 'ref', { textExtras: false })).reference,
    null,
  )
})

test('reference preparation yields to find, cancels and reacquires without partial publication', async (t) => {
  const { MarkdownSourceReferences } = await import(
    '../src/shared/markdown-source-references.ts'
  )
  const update = MarkdownSourceReferences.prototype.update
  // Every two slow steps below cost a timer turn. Few definitions keep each reply
  // within a handful of turns on coarse or busy Windows timers.
  const f = fixture(t, '[ref]: /first\n\n'.repeat(5))
  let entered = false,
    cancel = false,
    turn = 0
  const turns = new Set()
  const timer = setInterval(() => turn++, 0)
  t.after(() => clearInterval(timer))
  t.mock.method(
    MarkdownSourceReferences.prototype,
    'update',
    function* (...args) {
      for (const step of update.apply(this, args)) {
        turns.add(turn)
        if (!entered) {
          entered = true
          f.find(1, 0, 'absent')
          if (cancel)
            setTimeout(
              () =>
                f.worker.receive({
                  type: 'cancel-metadata',
                  epoch: 'first',
                  id: 2,
                  release: false,
                }),
              0,
            )
        }
        // Slow steps make slicing deterministic across timer resolutions.
        const end = performance.now() + 1
        while (performance.now() < end) {}
        yield step
      }
    },
  )
  const request = (id) =>
    f.worker.receive({
      type: 'metadata',
      epoch: 'first',
      id,
      version: 0,
      dialect: 'gfm',
      from: 0,
      to: 0,
      limit: 1,
      reference: { label: 'ref', gfm: true, alerts: false, textExtras: false },
    })
  request(1)
  const reply = await f.next(
    (message) => message.type === 'metadata' && message.id === 1,
  )
  assert.equal(reply.reference.href, '/first')
  assert.ok(turns.size > 1, 'definition reading must yield to the event loop')
  assert.ok(
    f.messages.findIndex((message) => message.type === 'find') <
      f.messages.indexOf(reply),
  )
  f.worker.receive({
    type: 'cancel-metadata',
    epoch: 'first',
    id: 1,
    release: true,
  })
  entered = false
  cancel = true
  request(2)
  await f.next(
    (message) => message.type === 'metadata-canceled' && message.id === 2,
  )
  assert.equal(
    f.messages.some(
      (message) => message.type === 'metadata' && message.id === 2,
    ),
    false,
  )
  // Cancellation alone must stop preparation; request 3 would replace it anyway.
  assert.equal(
    MarkdownSourceReferences.prototype.update.mock.calls.at(-1).result.next()
      .done,
    true,
  )
  cancel = false
  request(3)
  assert.equal(
    (await f.next((message) => message.type === 'metadata' && message.id === 3))
      .reference.href,
    '/first',
  )
})

test('frontmatter boundary changes replace reference owner namespaces safely', async (t) => {
  const source = '---\nname: hibi\n---\n\n[ref]: /body\n'
  const f = fixture(t, source)
  const request = (id, version) => {
    f.worker.receive({
      type: 'metadata',
      epoch: 'first',
      id,
      version,
      dialect: 'gfm',
      frontmatter: true,
      from: 0,
      to: 0,
      limit: 1,
      reference: { label: 'ref', gfm: true, alerts: false, textExtras: false },
    })
    return f.next((message) => message.type === 'metadata' && message.id === id)
  }
  const before = await request(1, 0)
  const from = source.indexOf('hibi')
  f.worker.receive({
    type: 'edit',
    epoch: 'first',
    operation: {
      document: { tabId: 'a', revision: 0 },
      operationId: 'header',
      baseVersion: 0,
      contentVersion: 1,
      origin: 'source',
      historyGroup: 'typing',
      changes: [{ from, to: from + 4, insert: 'longer workspace name' }],
    },
  })
  const after = await request(2, 1)
  assert.notEqual(after.page.epoch, before.page.epoch)
  assert.equal(after.reference.href, '/body')
})

test('metadata batches cheap parser advances while yielding between work slices', async (t) => {
  const { MarkdownSourceModel } = await import(
    '../src/shared/markdown-source-model.ts'
  )
  const advance = MarkdownSourceModel.prototype.advance
  let turn = 0,
    advances = 0
  const batches = new Map()
  t.mock.method(MarkdownSourceModel.prototype, 'advance', function () {
    advances++
    batches.set(turn, (batches.get(turn) ?? 0) + 1)
    return advance.call(this)
  })
  const timer = setInterval(() => turn++, 0)
  t.after(() => clearInterval(timer))
  const f = fixture(t, '# heading\n\nparagraph\n\n'.repeat(2000))
  f.worker.receive({
    type: 'metadata',
    epoch: 'first',
    id: 1,
    version: 0,
    dialect: 'commonmark',
    from: 0,
    to: 500,
    limit: 4,
  })
  const reply = await f.next((message) => message.type === 'metadata')
  assert.equal(reply.page.rows.length, 4)
  assert.equal(reply.page.complete, true)
  assert.ok(advances > 2000)
  assert.ok(batches.size > 1, 'metadata must yield to the worker event loop')
  assert.ok(Math.max(...batches.values()) > 1, 'cheap blocks share a slice')
})

test('worker source replication is ordered, atomic, and query replies name the exact accepted version', async (t) => {
  const f = fixture(t)
  assert.deepEqual(f.messages.at(-1), {
    type: 'ack',
    epoch: 'first',
    version: 0,
  })
  f.find(1)
  const original = await f.next(
    (reply) => reply.type === 'find' && reply.id === 1,
  )
  assert.equal(original.location.total, 2)
  assert.equal(original.location.next.match.from, 0)
  const operation = {
    document: { tabId: 'a', revision: 0 },
    operationId: 'change',
    baseVersion: 0,
    contentVersion: 1,
    origin: 'source',
    historyGroup: 'typing',
    changes: [{ from: 0, to: 3, insert: 'zero' }],
  }
  f.worker.receive({ type: 'edit', epoch: 'first', operation })
  f.find(2, 1, 'one')
  const edited = await f.next(
    (reply) => reply.type === 'find' && reply.id === 2,
  )
  assert.equal(edited.version, 1)
  assert.equal(edited.location.total, 1)
  assert.equal(edited.location.next.match.from, 9)
  f.find(3, 1, 'one', 9, 12)
  const selected = await f.next(
    (reply) => reply.type === 'find' && reply.id === 3,
  )
  assert.equal(selected.location.current, 1)
  f.worker.receive({ type: 'edit', epoch: 'first', operation })
  assert.equal(f.messages.at(-1).stage, 'replica')
  f.load('second', 'fresh')
  f.worker.receive({ type: 'edit', epoch: 'first', operation })
  assert.deepEqual(f.messages.at(-1), {
    type: 'ack',
    epoch: 'second',
    version: 0,
  })
})

test('worker replaces pending queries, cancels coverage on edits, and releases disposed work', async (t) => {
  const f = fixture(t, 'one two '.repeat(100000))
  f.find(1, 0, 'one')
  f.find(2, 0, 'two')
  const result = await f.next(
    (reply) => reply.type === 'find' && reply.id === 2,
  )
  assert.equal(result.location.total, 100000)
  assert.equal(
    f.messages.some((reply) => reply.type === 'find' && reply.id === 1),
    false,
  )
  f.find(1, 0, 'one')
  f.find(3, 0, 'one')
  f.worker.receive({ type: 'cancel-find', epoch: 'first', id: 3 })
  f.find(4, 0, 'absent')
  f.worker.dispose()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(
    f.messages.some(
      (reply) => reply.type === 'find' && [1, 3, 4].includes(reply.id),
    ),
    false,
  )
})

test('worker validates bootstrap and query limits without executing document content', async (t) => {
  const f = fixture(t, '<script>throw new Error("never execute")</script>')
  f.find(1, 0, 'script')
  assert.equal(
    (await f.next((reply) => reply.type === 'find')).location.total,
    2,
  )
  f.find(2, 0, 'x'.repeat(65537))
  assert.equal(f.messages.at(-1).stage, 'find')
  assert.equal(f.messages.at(-1).id, 2)
  f.find(3, 0, 'script', -1, 0)
  assert.equal(f.messages.at(-1).id, 3)
  f.worker.receive({
    type: 'load-start',
    epoch: 'bad',
    head: {
      tabId: 'a',
      revision: 0,
      contentVersion: -1,
      streamId: 'bad',
      length: 1,
    },
  })
  assert.equal(f.messages.at(-1).stage, 'replica')
})

test('iterable source bootstrap preserves raw seams without joining the document', () => {
  const source = 'a\r\n😀b'.repeat(5000),
    parts = Array.from(source, (character) => character)
  // Explicitly split a surrogate pair, as transport chunk boundaries may do.
  parts.splice(3, 1, '\ud83d', '\ude00')
  const reconstructed = parts.join('')
  const store = new SourceStore(parts, { tabId: 'a', revision: 0 }),
    contiguous = new SourceStore(reconstructed, { tabId: 'a', revision: 0 })
  assert.deepEqual(store.snapshot().metrics, contiguous.snapshot().metrics)
  assert.equal(store.counters().materializations, 0)
  assert.equal(store.snapshot().materialize(), reconstructed)
  assert.throws(
    () => new SourceStore(['a', 42], { tabId: 'a', revision: 0 }),
    /strings/,
  )
})

test('worker maintenance preserves live find results and disposes its previous replica owner', async (t) => {
  const commits = []
  const commit = SourceStore.prototype.commitCompaction
  t.mock.method(SourceStore.prototype, 'commitCompaction', function (change) {
    commits.push(change.after.version)
    return commit.call(this, change)
  })
  const f = fixture(t, 'x'.repeat(80 * 4096))
  f.worker.receive({
    type: 'edit',
    epoch: 'first',
    operation: {
      document: { tabId: 'a', revision: 0 },
      operationId: 'holes',
      baseVersion: 0,
      contentVersion: 1,
      origin: 'source',
      historyGroup: 'holes',
      changes: Array.from({ length: 80 }, (_, n) => ({
        from: n * 4096,
        to: (n + 1) * 4096 - 1,
        insert: '',
      })),
    },
  })
  f.find(1, 1, 'x')
  assert.equal(
    (await f.next((reply) => reply.type === 'find' && reply.id === 1)).location
      .total,
    80,
  )
  const deadline = performance.now() + 2000
  while (!commits.length && performance.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(commits, [1])
  f.find(2, 1, 'x', 40, 41)
  const result = await f.next(
    (reply) => reply.type === 'find' && reply.id === 2,
  )
  assert.equal(result.location.total, 80)
  assert.equal(result.location.current, 41)
  f.load('replacement', 'fresh')
  f.worker.dispose()
  await new Promise((resolve) => setTimeout(resolve, 550))
  assert.deepEqual(commits, [1])
  assert.equal(
    f.messages.some((reply) => reply.type === 'error'),
    false,
  )
})

test('metadata validates bounded dialect requests independently and rejects stale epochs', async (t) => {
  const f = fixture(t, '| one | two |\n| --- | --- |\n| a | b |\n')
  const request = {
    type: 'metadata',
    epoch: 'first',
    id: 1,
    version: 0,
    dialect: 'gfm',
    from: 0,
    to: 5,
    limit: 2,
  }
  f.worker.receive(request)
  const reply = await f.next(
    (message) => message.type === 'metadata' && message.id === 1,
  )
  assert.equal(reply.page.complete, true)
  assert.equal(reply.page.rows[0].owner.kind, 'markdown:Table')
  for (const change of [
    { from: -1 },
    { to: 1000 },
    { limit: 257 },
    { dialect: 'custom-code' },
    { frontmatter: 'yes' },
    { version: 1 },
  ])
    f.worker.receive({ ...request, id: 2, ...change })
  assert.equal(
    f.messages.filter(
      (message) => message.type === 'error' && message.stage === 'metadata',
    ).length,
    6,
  )
  f.find(1, 0, 'one')
  assert.equal(
    (await f.next((message) => message.type === 'find')).location.total,
    1,
  )
  f.worker.receive({ ...request, id: 3 })
  f.load('replacement', '# fresh')
  f.worker.receive({
    ...request,
    id: 1,
    epoch: 'replacement',
    dialect: 'commonmark',
    to: 7,
  })
  const fresh = await f.next(
    (message) => message.type === 'metadata' && message.epoch === 'replacement',
  )
  assert.equal(fresh.page.rows[0].owner.kind, 'markdown:ATXHeading1')
  assert.equal(fresh.page.rows[0].to, 7)
  assert.notEqual(fresh.page.epoch, reply.page.epoch)
  assert.equal(
    f.messages.some(
      (message) =>
        message.type === 'metadata' &&
        message.epoch === 'first' &&
        message.id === 3,
    ),
    false,
  )
})

test('metadata frontmatter opt-in owns only the proven prefix and reconfigures on demand', async (t) => {
  const source = '---\r\ntitle: one\r\n---\r\n\r\n# body\r\n',
    prefix = source.indexOf('# body')
  const f = fixture(t, source)
  const request = {
    type: 'metadata',
    epoch: 'first',
    id: 1,
    version: 0,
    dialect: 'gfm',
    frontmatter: true,
    from: 0,
    to: source.length,
    limit: 4,
  }
  f.worker.receive(request)
  const projected = await f.next(
    (reply) => reply.type === 'metadata' && reply.id === 1,
  )
  assert.equal(projected.page.dialect, 'gfm+frontmatter')
  assert.equal(projected.page.rows[0].owner.kind, 'markdown:Frontmatter')
  assert.equal(projected.page.rows[0].to, prefix)
  assert.equal(projected.page.rows[1].from, prefix)
  assert.equal(projected.page.rows[1].owner.kind, 'markdown:ATXHeading1')
  f.worker.receive({ ...request, id: 2, frontmatter: false })
  const plain = await f.next(
    (reply) => reply.type === 'metadata' && reply.id === 2,
  )
  assert.equal(plain.page.dialect, 'gfm')
  assert.equal(plain.page.rows[0].owner.kind, 'markdown:HorizontalRule')
  assert.notEqual(plain.page.epoch, projected.page.epoch)
  f.worker.receive({ ...request, id: 3 })
  f.worker.receive({
    type: 'cancel-metadata',
    epoch: 'first',
    id: 3,
    release: true,
  })
  f.worker.receive({ ...request, id: 4, frontmatter: false })
  const latest = await f.next(
    (reply) => reply.type === 'metadata' && reply.id === 4,
  )
  assert.equal(latest.page.dialect, 'gfm')
  assert.equal(
    f.messages.some((reply) => reply.type === 'metadata' && reply.id === 3),
    false,
  )
})
