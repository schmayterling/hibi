import assert from 'node:assert/strict'
import nodeTest from 'node:test'
import { DocumentWorkerService } from '../src/shared/document-worker-service.ts'
import { RenderedTextIndex } from '../src/shared/rendered-text.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'
import { loadWorker } from './document-worker-transfer.mjs'
import { renderedConfig } from './rendered-config.mjs'
import { WORKER_HANG_TIMEOUT, waitForProgress } from './worker-progress.mjs'

const test = (name, run) =>
  nodeTest(name, { timeout: WORKER_HANG_TIMEOUT }, run)

function fixture(t, source = 'one two one') {
  const messages = [],
    pending = new Set()
  const worker = new DocumentWorkerService((message) => {
    messages.push(message)
    for (const check of pending) check()
  })
  t.after(() => worker.dispose())
  const next = (predicate) =>
    waitForProgress(
      () => messages.find(predicate),
      () => messages.length,
      2000,
      () =>
        Object.assign(new Error('Missing worker reply: no progress'), {
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
      {
        subscribe: (check) => {
          pending.add(check)
          return () => pending.delete(check)
        },
      },
    )
  const load = (epoch = 'first', body = source) => {
    loadWorker(worker, messages, body, epoch)
  }
  const find = (
    id,
    version = 0,
    query = 'one',
    from = 0,
    to = 0,
    options = {},
  ) =>
    worker.receive({
      type: 'find',
      epoch: 'first',
      id,
      version,
      query,
      from,
      to,
      ...(options.mode === 'rendered'
        ? { config: { ...renderedConfig, prefix: options.prefix ?? 0 } }
        : {}),
      ...options,
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
  const channels = [],
    tasks = []
  t.mock.method(
    globalThis,
    'MessageChannel',
    class {
      port1 = { onmessage: null, close: t.mock.fn() }
      port2 = {
        close: t.mock.fn(),
        postMessage: () => tasks.push(() => this.port1.onmessage?.()),
      }
      constructor() {
        channels.push(this)
      }
    },
  )
  const { MarkdownSourceModel } = await import(
    '../src/shared/markdown-source-model.ts'
  )
  const advance = MarkdownSourceModel.prototype.advance
  let turn = 0,
    advances = 0,
    clock = 0,
    settled = false
  t.mock.method(performance, 'now', () => (clock += 0.01))
  const batches = new Map()
  t.mock.method(MarkdownSourceModel.prototype, 'advance', function () {
    advances++
    batches.set(turn, (batches.get(turn) ?? 0) + 1)
    return advance.call(this)
  })
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
  const pending = f
    .next((message) => message.type === 'metadata')
    .finally(() => {
      settled = true
    })
  void pending.catch(() => {})
  while (!settled) {
    if (tasks.length) {
      turn++
      tasks.shift()()
    } else await new Promise(setImmediate)
  }
  const reply = await pending
  assert.equal(reply.page.rows.length, 4)
  assert.equal(reply.page.complete, true)
  assert.ok(advances > 2000)
  assert.ok(batches.size > 1, 'metadata must yield to the worker event loop')
  assert.ok(Math.max(...batches.values()) > 1, 'cheap blocks share a slice')
  const progress = f.messages.filter(
    (message) => message.type === 'metadata-progress',
  )
  assert.ok(
    progress.length > 1,
    'real metadata work reports progress across slices',
  )
  for (const reply of progress)
    assert.deepEqual(reply, {
      type: 'metadata-progress',
      epoch: 'first',
      id: 1,
      version: 0,
    })
  assert.equal(channels.length, 1, 'metadata slices use channel tasks')
  assert.equal(channels[0].port1.close.mock.callCount(), 1)
  assert.equal(channels[0].port2.close.mock.callCount(), 1)
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

test('rendered find reuses one replica, projection and scheduler for navigation and viewport pages', async (t) => {
  const text = 'hello **world**\n\nhello world\n\nHELLO world'
  const original = RenderedTextIndex.prototype.build,
    projections = []
  t.mock.method(RenderedTextIndex.prototype, 'build', function* () {
    projections.push(this)
    return yield* original.call(this)
  })
  const f = fixture(t, text)
  f.find(1, 0, 'hello world')
  assert.equal(
    (await f.next((reply) => reply.type === 'find' && reply.id === 1)).location
      .total,
    2,
  )
  f.find(2, 0, 'hello world', 0, 0, {
    mode: 'rendered',
    highlights: true,
    viewport: { from: 0, to: text.length, limit: 2 },
  })
  const rendered = await f.next(
    (reply) => reply.type === 'find' && reply.id === 2,
  )
  assert.equal(rendered.mode, 'rendered')
  assert.equal(rendered.location.total, 3)
  assert.equal(rendered.highlightStarts, undefined)
  assert.equal(rendered.highlights.matches.length, 2)
  assert.equal(rendered.highlights.next, text.indexOf('HELLO'))
  const first = rendered.highlights.matches[0]
  assert.deepEqual(first.segments, [
    { from: 0, to: 6 },
    { from: 8, to: 13 },
  ])
  const work = projections[0].counters()
  f.find(3, 0, 'hello world', first.from, first.to, { mode: 'rendered' })
  const selected = await f.next(
    (reply) => reply.type === 'find' && reply.id === 3,
  )
  assert.equal(selected.location.current, 1)
  assert.equal(projections.length, 1)
  f.find(4, 0, 'world', 0, 0, { mode: 'rendered' })
  assert.equal(
    (await f.next((reply) => reply.type === 'find' && reply.id === 4)).location
      .total,
    3,
  )
  assert.equal(projections[1], projections[0])
  assert.equal(projections[0].counters().sourceUnits, work.sourceUnits)
  f.find(5, 0, 'hello world')
  const raw = await f.next((reply) => reply.type === 'find' && reply.id === 5)
  assert.equal(raw.location.total, 2)
  assert.equal(raw.mode, undefined)
  assert.equal(projections.length, 2)
})

test('rendered find checks bracket labels against the worker reference index', async (t) => {
  const { MarkdownSourceReferences } = await import(
    '../src/shared/markdown-source-references.ts'
  )
  const lookup = t.mock.method(MarkdownSourceReferences.prototype, 'lookup')
  const source =
    'a [sic] b\n\narray[0] value\n\nsee [1] here\n\n[elsewhere]: /url'
  const f = fixture(t, source)
  let id = 0
  for (const query of ['[sic]', 'array[0]', '[1]']) {
    const request = ++id
    f.find(request, 0, query, 0, 0, { mode: 'rendered' })
    const reply = await f.next(
      (message) =>
        message.id === request &&
        (message.type === 'find' || message.type === 'error'),
    )
    assert.equal(reply.type, 'find', JSON.stringify(reply))
    assert.equal(reply.location.total, 1)
    assert.equal(reply.location.next.match.from, source.indexOf(query))
  }
  assert.ok(lookup.mock.calls.some((call) => call.arguments[0] === 'sic'))
  assert.ok(lookup.mock.calls.some((call) => call.arguments[0] === '0'))
  assert.ok(lookup.mock.calls.some((call) => call.arguments[0] === '1'))
  const from = source.indexOf('sic')
  f.find(++id, 0, 'sic', from, from + 3, {
    mode: 'rendered',
    replacement: 'new',
  })
  const prepared = await f.next(
    (message) =>
      message.id === id &&
      (message.type === 'find' || message.type === 'error'),
  )
  assert.ok(prepared.replacement?.edits, JSON.stringify(prepared))
  let replaced = source
  for (const edit of [...prepared.replacement.edits].reverse())
    replaced =
      replaced.slice(0, edit.from) + edit.insert + replaced.slice(edit.to)
  assert.equal(replaced, source.replace('[sic]', '[new]'))
})

test('rendered bracket-label decisions are invalidated when definitions change', async (t) => {
  const source = 'a [sic] b'
  const f = fixture(t, source)
  const query = async (id, version) => {
    f.find(id, version, '[sic]', 0, 0, { mode: 'rendered' })
    return f.next(
      (message) =>
        message.id === id &&
        (message.type === 'find' || message.type === 'error'),
    )
  }
  assert.equal((await query(1, 0)).location?.total, 1)
  const definition = '\n\n[sic]: /defined'
  f.worker.receive({
    type: 'edit',
    epoch: 'first',
    operation: {
      document: { tabId: 'a', revision: 0 },
      operationId: 'define-label',
      historyGroup: 'typing',
      origin: 'source',
      baseVersion: 0,
      contentVersion: 1,
      changes: [{ from: source.length, to: source.length, insert: definition }],
    },
  })
  assert.equal((await query(2, 1)).reason, 'unsupported')
  f.worker.receive({
    type: 'edit',
    epoch: 'first',
    operation: {
      document: { tabId: 'a', revision: 0 },
      operationId: 'undefine-label',
      historyGroup: 'typing',
      origin: 'source',
      baseVersion: 1,
      contentVersion: 2,
      changes: [
        {
          from: source.length,
          to: source.length + definition.length,
          insert: '',
        },
      ],
    },
  })
  assert.equal((await query(3, 2)).location?.total, 1)
  f.find(4, 2, '[sic]')
  assert.equal(
    (await f.next((message) => message.type === 'find' && message.id === 4))
      .location.total,
    1,
  )
})

test('rendered bracket lookup reuses ready metadata references and survives their release', async (t) => {
  const { MarkdownSourceReferences } = await import(
    '../src/shared/markdown-source-references.ts'
  )
  const update = t.mock.method(MarkdownSourceReferences.prototype, 'update')
  const source = 'a [sic] b\n\n[other]: /url'
  const f = fixture(t, source)
  f.worker.receive({
    type: 'metadata',
    epoch: 'first',
    id: 1,
    version: 0,
    dialect: 'gfm',
    from: 0,
    to: 0,
    limit: 1,
    reference: {
      label: 'other',
      gfm: true,
      alerts: true,
      textExtras: false,
      math: false,
    },
  })
  assert.equal(
    (await f.next((message) => message.type === 'metadata' && message.id === 1))
      .reference.href,
    '/url',
  )
  const before = update.mock.calls.length
  f.find(1, 0, '[sic]', 0, 0, { mode: 'rendered' })
  assert.equal(
    (await f.next((message) => message.type === 'find' && message.id === 1))
      .location.total,
    1,
  )
  assert.equal(
    update.mock.calls.length,
    before,
    'reuse the complete reference index',
  )
  f.worker.receive({
    type: 'cancel-metadata',
    epoch: 'first',
    id: 1,
    release: true,
  })
  const from = source.indexOf('sic')
  f.find(2, 0, 'sic', from, from + 3, { mode: 'rendered', replacement: 'new' })
  const reply = await f.next(
    (message) =>
      message.id === 2 && (message.type === 'find' || message.type === 'error'),
  )
  assert.ok(reply.replacement?.edits, JSON.stringify(reply))
})

test('rendered reference lookup respects the opaque prefix and math grammar changes', async (t) => {
  const source = '---\nvalue: |\n  [sic]: /metadata\n---\n\na [sic] b'
  const f = fixture(t, source)
  f.find(1, 0, '[sic]', 0, 0, {
    mode: 'rendered',
    prefix: source.indexOf('a [sic]'),
  })
  assert.equal(
    (
      await f.next(
        (message) =>
          message.id === 1 &&
          (message.type === 'find' || message.type === 'error'),
      )
    ).location?.total,
    1,
  )
  f.messages.length = 0
  f.load('first', '$$\n\n[sic]: /math\n\n$$\n\n[sic]')
  const math = {
    ...renderedConfig,
    syntax: [...renderedConfig.syntax, 'math-block@1'],
    flavors: [...renderedConfig.flavors, 'math.latex'],
    textFeatures: [...renderedConfig.textFeatures, 'math.block'],
  }
  f.find(1, 0, '[sic]', 0, 0, { mode: 'rendered', config: math })
  assert.equal(
    (
      await f.next(
        (message) =>
          message.id === 1 &&
          (message.type === 'find' || message.type === 'error'),
      )
    ).location?.total,
    1,
  )
  f.find(2, 0, '[sic]', 0, 0, {
    mode: 'rendered',
    config: {
      ...renderedConfig,
      flavors: [...renderedConfig.flavors, 'math.latex'],
    },
  })
  assert.equal(
    (
      await f.next(
        (message) =>
          message.id === 2 &&
          (message.type === 'find' || message.type === 'error'),
      )
    ).location?.total,
    1,
    'reference semantics follow the selected flavor even when its renderer is off',
  )
  f.find(3, 0, '[sic]', 0, 0, { mode: 'rendered' })
  assert.equal(
    (
      await f.next(
        (message) =>
          message.id === 3 &&
          (message.type === 'find' || message.type === 'error'),
      )
    ).reason,
    'unsupported',
  )
})

test('reference links return unsupported without hiding source find on the same replica', async (t) => {
  const f = fixture(t, 'hello [label][hidden]\n\n[hidden]: /url')
  f.find(1, 0, 'hidden', 0, 0, { mode: 'rendered' })
  const unsupported = await f.next(
    (reply) => reply.type === 'error' && reply.id === 1,
  )
  assert.equal(unsupported.stage, 'find')
  assert.equal(unsupported.reason, 'unsupported')
  assert.ok(
    !f.messages.some((reply) => reply.type === 'find' && reply.id === 1),
  )
  f.find(2, 0, 'hidden')
  const source = await f.next(
    (reply) => reply.type === 'find' && reply.id === 2,
  )
  assert.equal(source.location.total, 2)
  assert.equal(f.messages.filter((reply) => reply.type === 'ack').length, 1)
})

test('rendered replacements return only grammar-verified edits for an exact match', async (t) => {
  const f = fixture(t, '2 * 3 * 4\n\nTARGET tail')
  f.find(1, 0, ' 3 ', 3, 6, { mode: 'rendered', replacement: '3' })
  const refused = await f.next(
    (reply) => reply.type === 'find' && reply.id === 1,
  )
  assert.equal(refused.location.current, 1)
  assert.deepEqual(refused.replacement, {
    from: 3,
    to: 6,
    text: '3',
    edits: null,
  })
  f.find(2, 0, 'TARGET', 11, 17, {
    mode: 'rendered',
    replacement: '#tag',
    viewport: { from: 0, to: 22 },
  })
  const prepared = await f.next(
    (reply) => reply.type === 'find' && reply.id === 2,
  )
  assert.equal(prepared.location.current, 1)
  assert.deepEqual(prepared.replacement, {
    from: 11,
    to: 17,
    text: '#tag',
    edits: [{ from: 11, to: 17, insert: '#tag' }],
  })
  assert.equal(prepared.highlights.matches.length, 1)
  f.find(3, 0, 'TARGET', 11, 16, { mode: 'rendered', replacement: 'X' })
  assert.equal(
    (await f.next((reply) => reply.type === 'find' && reply.id === 3))
      .replacement.edits,
    null,
  )
})

test('deep shared-parser recursion fails closed and leaves source find available', async (t) => {
  const marks = '*'.repeat(20000),
    text = marks + 'word' + marks
  const f = fixture(t, text)
  f.find(1, 0, 'word', 20000, 20004, { mode: 'rendered', replacement: 'X' })
  const error = await f.next(
    (reply) => reply.type === 'error' && reply.id === 1,
  )
  assert.equal(error.stage, 'find')
  assert.match(error.message, /call stack/i)
  assert.ok(
    !f.messages.some((reply) => reply.type === 'find' && reply.id === 1),
  )
  f.find(2, 0, 'word')
  const result = await f.next(
    (reply) => reply.type === 'find' && reply.id === 2,
  )
  assert.equal(result.location.total, 1)
  assert.equal(result.location.next.match.from, 20000)
})

test('unsupported cold rendered configuration replies with a find error', async (t) => {
  const f = fixture(t, 'note')
  f.find(1, 0, 'note', 0, 0, {
    mode: 'rendered',
    config: { ...renderedConfig, textSyntax: null },
  })
  assert.match(
    (await f.next((reply) => reply.type === 'error' && reply.id === 1)).message,
    /configuration is unsupported/,
  )
})

test('rendered grammar config changes invalidate projection and unknown renderers are refused', async (t) => {
  const f = fixture(t, 'hello ==world==')
  const config = {
    ...renderedConfig,
    syntax: [...renderedConfig.syntax, 'obsidian@1'],
    textFeatures: [...renderedConfig.textFeatures, 'markdown.obsidian'],
  }
  f.find(1, 0, 'hello world', 0, 0, { mode: 'rendered', config })
  assert.equal(
    (await f.next((reply) => reply.type === 'find' && reply.id === 1)).location
      .total,
    1,
  )
  f.find(2, 0, 'hello world', 0, 0, {
    mode: 'rendered',
    config: { ...config, literal: ['Highlight'] },
  })
  assert.equal(
    (await f.next((reply) => reply.type === 'find' && reply.id === 2)).location
      .total,
    0,
  )
  f.find(3, 0, 'hello', 0, 0, {
    mode: 'rendered',
    config: { ...config, textFeatures: ['unknown.custom'] },
  })
  const error = await f.next(
    (reply) => reply.type === 'error' && reply.id === 3,
  )
  assert.match(error.message, /configuration is unsupported/)
})

test('rendered replacement validation cancels through the existing find channel', async (t) => {
  const original = RenderedTextIndex.prototype.prepareReplacement
  let steps = 0
  t.mock.method(
    RenderedTextIndex.prototype,
    'prepareReplacement',
    function* (...args) {
      for (const step of original.apply(this, args)) {
        steps++
        yield step
      }
    },
  )
  const f = fixture(t, 'TARGET\n\n' + 'plain words.\n'.repeat(1024))
  f.find(1, 0, 'TARGET', 0, 6, { mode: 'rendered', replacement: 'X' })
  await f.next(
    (reply) => reply.type === 'find-progress' && reply.id === 1 && steps > 0,
  )
  f.worker.receive({ type: 'cancel-find', epoch: 'first', id: 1 })
  await f.next((reply) => reply.type === 'canceled' && reply.id === 1)
  const before = steps
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(steps, before)
  assert.ok(
    !f.messages.some((reply) => reply.type === 'find' && reply.id === 1),
  )
})

test('rendered projection cancels through queued tasks and resumes without another replica', async (t) => {
  const original = RenderedTextIndex.prototype.build,
    projections = []
  t.mock.method(RenderedTextIndex.prototype, 'build', function* () {
    projections.push(this)
    return yield* original.call(this)
  })
  const f = fixture(t, 'hello **world**\n\n' + 'ordinary words. '.repeat(16384))
  f.find(1, 0, 'hello world', 0, 0, { mode: 'rendered' })
  await f.next((reply) => reply.type === 'find-progress' && reply.id === 1)
  const before = projections[0].counters()
  f.worker.receive({ type: 'cancel-find', epoch: 'first', id: 1 })
  await f.next((reply) => reply.type === 'canceled' && reply.id === 1)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(projections[0].counters(), before)
  f.find(2, 0, 'hello world', 0, 0, { mode: 'rendered' })
  const result = await f.next(
    (reply) => reply.type === 'find' && reply.id === 2,
  )
  assert.equal(result.location.total, 1)
  assert.equal(projections[1], projections[0])
  assert.ok(
    !f.messages.some((reply) => reply.type === 'find' && reply.id === 1),
  )
  assert.ok(projections[0].counters().maximumStep <= 2048)
})

test('rendered projection, search and viewport paging use one find channel without a timer', async (t) => {
  const NativeChannel = MessageChannel,
    channels = []
  t.mock.method(
    globalThis,
    'MessageChannel',
    class extends NativeChannel {
      constructor() {
        super()
        channels.push(this)
      }
    },
  )
  t.mock.method(
    performance,
    'now',
    (() => {
      let now = 0
      return () => ++now
    })(),
  )
  const f = fixture(t, 'x**y** '.repeat(2048))
  const timers = t.mock.method(globalThis, 'setTimeout')
  f.find(1, 0, 'xy', 0, 0, {
    mode: 'rendered',
    viewport: { from: 0, to: 7 * 2048, limit: 512 },
  })
  const result = await f.next(
    (reply) => reply.type === 'find' && reply.id === 1,
  )
  assert.equal(result.location.total, 2048)
  assert.equal(result.highlights.matches.length, 512)
  assert.equal(channels.length, 1)
  assert.equal(
    timers.mock.calls.length,
    1,
    'only fixture deadline uses a timer',
  )
  assert.ok(
    f.messages.filter((reply) => reply.type === 'find-progress').length > 1,
  )
})

test('rendered prefix follows normalized CRLF coordinates and invalidates only the projection configuration', async (t) => {
  const header = '---\r\ntitle: hello **world**\r\n---\r\n\r\n'
  const f = fixture(t, header + 'hello **world**')
  f.find(1, 0, 'hello world', 0, 0, {
    mode: 'rendered',
    prefix: header.replace(/\r\n/g, '\n').length,
  })
  assert.equal(
    (await f.next((reply) => reply.type === 'find' && reply.id === 1)).location
      .total,
    1,
  )
  f.find(2, 0, 'hello world', 0, 0, { mode: 'rendered', prefix: 0 })
  assert.equal(
    (await f.next((reply) => reply.type === 'find' && reply.id === 2)).location
      .total,
    2,
  )
  f.find(3, 0, 'hello world')
  assert.equal(
    (await f.next((reply) => reply.type === 'find' && reply.id === 3)).location
      .total,
    0,
  )
})

test('rendered find validates mode, prefix and bounded viewport payloads', async (t) => {
  const f = fixture(t, '😀 hello **world**')
  let id = 0
  for (const options of [
    { mode: 'unknown' },
    { mode: 'rendered', prefix: 1 },
    { mode: 'rendered', viewport: { from: 0, to: 8, limit: 513 } },
    { mode: 'rendered', viewport: null },
  ]) {
    f.find(++id, 0, 'hello world', 0, 0, options)
    const error = await f.next(
      (reply) => reply.type === 'error' && reply.id === id,
    )
    assert.equal(error.stage, 'find')
  }
  f.find(++id, 0, 'world')
  assert.equal(
    (await f.next((reply) => reply.type === 'find' && reply.id === id)).location
      .total,
    1,
  )
})
