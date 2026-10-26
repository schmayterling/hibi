import assert from 'node:assert/strict'
import test from 'node:test'
import { DocumentWorkerClient } from '../src/renderer/src/document-worker-client.ts'
import { DocumentSession } from '../src/shared/document-session.ts'
import { DocumentWorkerService } from '../src/shared/document-worker-service.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'
import { SourceSearchIndex } from '../src/shared/source-search-index.ts'

const wait = async (predicate) => {
  const end = Date.now() + 3000
  while (!predicate()) {
    if (Date.now() > end) throw new Error('Worker condition did not settle')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}
class TestWorker {
  messages = []
  terminated = false
  blocked = false
  onmessage = null
  onerror = null
  onmessageerror = null
  replies = []
  service = new DocumentWorkerService((reply) => {
    this.replies.push(reply)
    setImmediate(() => {
      if (!this.terminated) this.onmessage?.({ data: structuredClone(reply) })
    })
  })
  postMessage(message) {
    const copy = structuredClone(message)
    this.messages.push(copy)
    if (!this.blocked)
      setImmediate(() => {
        if (!this.terminated) this.service.receive(copy)
      })
  }
  terminate() {
    this.terminated = true
    this.service.dispose()
  }
}
function fixture(t, source = 'one two one', extra = {}) {
  const workers = [],
    results = [],
    errors = []
  const session = new DocumentSession(source, { tabId: 'a', revision: 0 }, 0, {
    enqueue: () => {},
    onError: (error) => errors.push(error),
  })
  let query = 'one',
    from = 0,
    to = 0
  const client = new DocumentWorkerClient(session, {
    changed: () => client.find(query, from, to),
    pending: () => {},
    result: (location, action) => results.push({ location, action }),
    error: (error) => errors.push(error),
    worker: () => {
      const worker = new TestWorker()
      workers.push(worker)
      return worker
    },
    ...extra,
  })
  t.after(() => {
    client.dispose()
    session.dispose()
  })
  const find = (text, start = 0, end = 0, action = null) => {
    query = text
    from = start
    to = end
    client.find(query, from, to, action)
  }
  const append = (text) => {
    const length = session.snapshot().utf16Length
    session.edit(
      [{ from: length, to: length, insert: text }],
      'source',
      'typing',
    )
  }
  return { client, session, workers, results, errors, find, append }
}

function queuedFixture(t, source = 'one two one', extra = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const tasks = [],
    channels = [],
    builds = t.mock.method(SourceSearchIndex.prototype, 'build')
  let clock = 0
  // One real generator advance per channel task, independent of machine speed.
  t.mock.method(performance, 'now', () => clock++)
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
  const f = fixture(t, source, {
    timeoutMs: 100,
    ...extra,
    worker: () => {
      const worker = new TestWorker()
      worker.service = new DocumentWorkerService((reply) => {
        worker.replies.push(reply)
        tasks.push(() => {
          if (!worker.terminated) worker.onmessage?.({ data: reply })
        })
      })
      worker.postMessage = (message) => {
        const copy = structuredClone(message)
        worker.messages.push(copy)
        if (!worker.blocked)
          tasks.push(() => {
            if (!worker.terminated) worker.service.receive(copy)
          })
      }
      f.workers.push(worker)
      return worker
    },
  })
  const drain = () => {
    while (tasks.length) tasks.shift()()
  }
  const step = () => {
    assert.ok(tasks.length, 'expected a queued worker task')
    tasks.shift()()
  }
  return { ...f, tasks, channels, builds, drain, step }
}

test('highlight checkpoints transfer once per query version and refresh after cancel or edit', async (t) => {
  const starts = []
  const f = fixture(t, 'ab'.repeat(10000), {
    result: (_location, _action, highlightStarts, query) => {
      assert.equal(query, starts.length < 4 ? 'aba' : 'ab')
      starts.push(highlightStarts)
    },
  })
  f.find('aba')
  await wait(() => starts.length === 1)
  assert.ok(starts[0].length > 1)
  f.find('aba', 44, 47)
  await wait(() => starts.length === 2)
  assert.equal(starts[1], undefined)
  f.client.cancelFind()
  f.find('aba')
  await wait(() => starts.length === 3)
  assert.ok(starts[2].length > 1)
  f.append('ab')
  await wait(() => starts.length === 4)
  assert.ok(starts[3].length > 1)
  f.find('ab')
  await wait(() => starts.length === 5)
  assert.ok(starts[4].length > 1)
  assert.deepEqual(f.errors, [])
})

test('typing burst rebuilds once after quiet time with exact latest query and version', (t) => {
  const f = queuedFixture(t, 'one two '.repeat(10000))
  f.find('one')
  t.mock.timers.tick(0)
  f.drain()
  assert.equal(f.results.at(-1).location.total, 10000)
  assert.equal(f.builds.mock.callCount(), 1)

  // Leave a real build in flight when the first edit arrives.
  f.find('two')
  f.step()
  f.step()
  f.step()
  assert.equal(f.builds.mock.callCount(), 2)
  const stale = f.workers[0].messages.at(-1),
    activeChannel = f.channels.at(-1),
    before = f.results.length
  for (let n = 0; n < 29; n++) {
    f.append(' two')
    f.find(n % 2 ? 'absent' : 'two', 0, 0, 'first')
    f.drain()
    assert.equal(activeChannel.port1.close.mock.callCount(), 1)
    assert.equal(activeChannel.port2.close.mock.callCount(), 1)
    t.mock.timers.tick(250)
    f.drain()
  }
  t.diagnostic(
    JSON.stringify({
      keys: 29,
      initialBuilds: 2,
      buildsDuringBurst: f.builds.mock.callCount() - 2,
    }),
  )
  assert.equal(
    f.builds.mock.callCount(),
    2,
    'no index builds during typing burst',
  )
  assert.equal(f.results.length, before)
  assert.equal(
    f.workers.length,
    1,
    'quiet time must not consume a find timeout',
  )

  const worker = f.workers[0]
  worker.onmessage({ data: { ...stale, type: 'find-progress' } })
  worker.onmessage({
    data: {
      type: 'find',
      epoch: stale.epoch,
      id: stale.id,
      version: stale.version,
      location: f.results[0].location,
    },
  })
  assert.equal(f.results.length, before)
  t.mock.timers.tick(49)
  f.drain()
  assert.equal(f.builds.mock.callCount(), 2)
  t.mock.timers.tick(1)
  f.drain()
  assert.equal(f.builds.mock.callCount(), 3, 'one rebuild after typing pauses')
  const request = worker.messages.at(-1)
  assert.equal(request.type, 'find')
  assert.equal(request.version, 29)
  assert.equal(request.query, 'two')
  assert.equal(f.results.at(-1).location.total, 10029)
  assert.equal(f.results.at(-1).action, 'first')
  assert.deepEqual(
    worker.messages
      .filter((message) => message.type === 'edit')
      .map((message) => message.operation.contentVersion),
    Array.from({ length: 29 }, (_, n) => n + 1),
  )
  assert.ok(
    f.channels.every(
      (channel) =>
        channel.port1.close.mock.callCount() === 1 &&
        channel.port2.close.mock.callCount() === 1,
    ),
  )
  assert.deepEqual(f.errors, [])
  t.diagnostic(
    JSON.stringify({
      rebuildsAfterPause: 1,
      version: request.version,
      total: 10029,
    }),
  )
})

test('quiet time starts the find deadline only on dispatch and rejects stale progress', (t) => {
  const f = queuedFixture(t)
  f.find('one')
  t.mock.timers.tick(0)
  f.drain()
  const worker = f.workers[0],
    stale = worker.messages.at(-1)
  f.append(' two')
  f.drain()
  worker.blocked = true
  t.mock.timers.tick(299)
  assert.equal(worker.terminated, false)
  assert.equal(f.builds.mock.callCount(), 1)
  t.mock.timers.tick(1)
  assert.equal(worker.messages.at(-1).type, 'find')
  assert.equal(worker.messages.at(-1).version, 1)
  t.mock.timers.tick(60)
  worker.onmessage({ data: { ...stale, type: 'find-progress' } })
  t.mock.timers.tick(39)
  assert.equal(worker.terminated, false)
  t.mock.timers.tick(1)
  assert.equal(worker.terminated, true)
})

test('cancel and dispose clear quiet timers and close in-flight channel ports', (t) => {
  const f = queuedFixture(t),
    timers = t.mock.method(globalThis, 'setTimeout'),
    cleared = t.mock.method(globalThis, 'clearTimeout')
  f.find('one')
  t.mock.timers.tick(0)
  f.drain()
  f.append(' two')
  f.drain()
  const quiet = timers.mock.calls.findLast(
    (call) => call.arguments[1] === 300,
  ).result
  f.client.cancelFind()
  assert.ok(cleared.mock.calls.some((call) => call.arguments[0] === quiet))
  t.mock.timers.tick(300)
  f.drain()
  assert.equal(f.builds.mock.callCount(), 1)

  f.find('two')
  f.step()
  const channel = f.channels.at(-1)
  assert.equal(channel.port1.close.mock.callCount(), 0)
  f.client.dispose()
  assert.equal(channel.port1.close.mock.callCount(), 1)
  assert.equal(channel.port2.close.mock.callCount(), 1)
  f.drain()
  assert.equal(f.results.length, 1)

  // A second client disposed during quiet time must cancel that timer too.
  const pending = fixture(t)
  pending.append('x')
  const pendingQuiet = timers.mock.calls.findLast(
    (call) => call.arguments[1] === 300,
  ).result
  pending.client.dispose()
  assert.ok(
    cleared.mock.calls.some((call) => call.arguments[0] === pendingQuiet),
  )
  const builds = f.builds.mock.callCount()
  t.mock.timers.tick(1000)
  f.drain()
  assert.equal(f.builds.mock.callCount(), builds)
  assert.equal(pending.workers.length, 0)
  assert.deepEqual(f.errors, [])
})

test('quiet time spans immutable bootstrap, ordered suffix and the remaining restart interval', (t) => {
  const f = queuedFixture(t, 'one two '.repeat(10000), { timeoutMs: 1000 })
  f.find('two')
  t.mock.timers.tick(0)
  f.step()
  f.step()
  f.append(' two')
  t.mock.timers.tick(200)
  f.drain()
  const first = f.workers[0]
  assert.equal(first.messages[0].head.contentVersion, 0)
  assert.deepEqual(
    first.messages
      .filter((message) => message.type === 'edit')
      .map((message) => message.operation.contentVersion),
    [1],
  )
  assert.equal(f.builds.mock.callCount(), 0)
  first.onerror({ preventDefault() {} })
  t.mock.timers.tick(0)
  f.drain()
  assert.equal(f.workers.length, 2)
  assert.equal(f.workers[1].messages[0].head.contentVersion, 1)
  t.mock.timers.tick(99)
  f.drain()
  assert.equal(f.builds.mock.callCount(), 0)
  t.mock.timers.tick(1)
  f.drain()
  assert.equal(f.builds.mock.callCount(), 1)
  assert.equal(f.results.at(-1).location.total, 10001)
  assert.deepEqual(f.errors, [])
})

test('operation overflow restart preserves quiet time before rebuilding the latest snapshot', (t) => {
  const f = queuedFixture(t, 'one two one', { maximumPendingBytes: 700 })
  f.find('two')
  t.mock.timers.tick(0)
  f.drain()
  const first = f.workers[0]
  first.blocked = true
  for (let n = 0; n < 8; n++) f.append(' two')
  assert.equal(first.terminated, true)
  // Delay the scheduled replacement's start without consuming the quiet interval.
  t.mock.timers.tick(100)
  f.drain()
  assert.equal(f.workers.length, 2)
  assert.equal(f.workers[1].messages[0].head.contentVersion, 8)
  assert.equal(f.builds.mock.callCount(), 1)
  t.mock.timers.tick(199)
  f.drain()
  assert.equal(f.builds.mock.callCount(), 1)
  t.mock.timers.tick(1)
  f.drain()
  assert.equal(f.builds.mock.callCount(), 2)
  assert.equal(f.results.at(-1).location.total, 9)
  assert.deepEqual(f.errors, [])
})

test('32 mib real find build completes with progress on one worker', {
  timeout: 60000,
}, async (t) => {
  // Same ordinary-word corpus as the review probe, with one distant match.
  const unit = `${'ordinary words '.repeat(16)}\n\n`,
    length = 32 * 1024 * 1024,
    source =
      unit.repeat(Math.ceil(length / unit.length)).slice(0, length - 11) +
      'scale-start',
    done = Promise.withResolvers(),
    f = fixture(t, source, {
      result: (location) => done.resolve(location),
      error: (message) => done.reject(new Error(message)),
    })
  f.find('scale-start')
  const location = await done.promise
  assert.equal(location.total, 1)
  assert.equal(location.next.match.from, source.length - 11)
  assert.equal(f.workers.length, 1)
  const worker = f.workers[0],
    request = worker.messages.find((message) => message.type === 'find'),
    progress = worker.replies.filter((reply) => reply.type === 'find-progress')
  assert.ok(
    progress.length > 1,
    'real index work must report progress across slices',
  )
  for (const reply of progress)
    assert.deepEqual(reply, {
      type: 'find-progress',
      epoch: request.epoch,
      id: request.id,
      version: request.version,
    })
  assert.deepEqual(f.errors, [])
  t.diagnostic(
    JSON.stringify({
      units: source.length,
      workers: f.workers.length,
      progress: progress.length,
      total: location.total,
    }),
  )
})

test('only current active find progress renews its deadline', async (t) => {
  const f = fixture(t, 'one', { timeoutMs: 100 })
  f.find('one')
  await wait(() => f.results.length)
  const worker = f.workers[0]
  worker.blocked = true
  t.mock.timers.enable({ apis: ['setTimeout'] })
  f.find('two')
  const request = worker.messages.at(-1),
    progress = {
      type: 'find-progress',
      epoch: request.epoch,
      id: request.id,
      version: request.version,
    }
  // Valid progress keeps actual active work alive beyond its initial deadline.
  for (let n = 0; n < 10; n++) {
    t.mock.timers.tick(60)
    worker.onmessage({ data: progress })
    assert.equal(worker.terminated, false)
  }
  for (const change of [
    { epoch: 'stale' },
    { id: request.id - 1 },
    { version: request.version + 1 },
    { id: String(request.id) },
    { version: String(request.version) },
  ]) {
    t.mock.timers.tick(10)
    worker.onmessage({ data: { ...progress, ...change } })
  }
  t.mock.timers.tick(51)
  assert.equal(
    worker.terminated,
    true,
    'stale or malformed progress cannot extend a deadline',
  )
})

test('canceled find progress cannot renew missing cancellation acknowledgement', async (t) => {
  const f = fixture(t, 'one', { timeoutMs: 100 })
  f.find('one')
  await wait(() => f.results.length)
  const worker = f.workers[0]
  worker.blocked = true
  t.mock.timers.enable({ apis: ['setTimeout'] })
  f.find('two')
  const request = worker.messages.at(-1)
  f.client.cancelFind()
  t.mock.timers.tick(60)
  worker.onmessage({
    data: {
      type: 'find-progress',
      epoch: request.epoch,
      id: request.id,
      version: request.version,
    },
  })
  t.mock.timers.tick(41)
  assert.equal(worker.terminated, true)
})

test('reference lookup shares find replica, cancels find independently and drops stale replies', async (t) => {
  const pages = []
  const f = fixture(t, '[ref]: /one\n\n[ref]', {
    metadataResult: (page, reference) => pages.push({ page, reference }),
  })
  const reference = { label: 'ref', gfm: true, alerts: true, textExtras: true }
  f.client.metadata('gfm', 0, 0, 1, false, reference)
  f.find('ref')
  f.client.cancelFind()
  await wait(() => pages.length)
  assert.equal(f.workers.length, 1)
  assert.equal(f.results.length, 0)
  assert.equal(pages[0].reference.href, '/one')
  const worker = f.workers[0]
  worker.blocked = true
  f.client.metadata('gfm', 0, 0, 1, false, reference)
  const stale = worker.messages.at(-1)
  f.append('\nmore')
  worker.onmessage({
    data: {
      type: 'metadata',
      epoch: stale.epoch,
      id: stale.id,
      version: 0,
      page: pages[0].page,
      reference: { href: '/stale' },
    },
  })
  assert.equal(pages.length, 1)
  assert.equal(f.errors.length, 0)
})

test('find and bounded metadata share one replica and keep source/owner generations coherent', async (t) => {
  const pages = [],
    failures = []
  const f = fixture(t, '# one\r\n\r\nparagraph\r\n\r\n'.repeat(1000), {
    metadataResult: (page) => pages.push(page),
    metadataError: (error) => failures.push(error),
  })
  f.client.metadata('commonmark', 0, 500, 4)
  f.find('one')
  await wait(() => pages.length && f.results.length)
  assert.equal(f.workers.length, 1)
  assert.equal(pages[0].rows.length, 4)
  assert.equal(pages[0].complete, true)
  assert.equal(pages[0].rows[0].from, 0)
  assert.equal(pages[0].rows[0].to, 5)
  assert.equal(f.results.at(-1).location.total, 1000)
  f.append('\r\nlast')
  f.client.metadata('commonmark', 0, 500, 4)
  await wait(() => pages.at(-1).version === 1)
  assert.equal(pages.at(-1).epoch, pages[0].epoch)
  const worker = f.workers[0]
  worker.blocked = true
  f.client.metadata('commonmark', 0, 500, 4)
  for (let n = 0; n < 1000; n++) f.client.metadata('commonmark', n, n + 500, 4)
  const sent = worker.messages
    .filter((message) => message.type === 'metadata')
    .at(-1)
  f.client.releaseMetadata()
  const release = worker.messages.at(-1)
  assert.equal(release.type, 'cancel-metadata')
  assert.equal(release.release, true)
  assert.equal(release.id, sent.id)
  assert.ok(
    worker.messages.filter((message) => message.type === 'metadata').length <=
      3,
  )
  const count = worker.messages.length
  f.client.releaseMetadata()
  assert.equal(worker.messages.length, count)
  assert.deepEqual(failures, [])
  assert.deepEqual(f.errors, [])
})

test('metadata deadlines remain finite while the find lane keeps replying', async (t) => {
  const pages = []
  const f = fixture(t, '# one\n\ntext', {
    timeoutMs: 80,
    metadataResult: (page) => pages.push(page),
  })
  f.find('one')
  await wait(() => f.results.length)
  const first = f.workers[0],
    receive = first.service.receive.bind(first.service)
  first.service.receive = (message) => {
    if (message.type !== 'metadata') receive(message)
  }
  f.client.metadata('commonmark', 0, 5, 2)
  const active = setInterval(() => f.find('one'), 5)
  try {
    await wait(() => f.workers.length === 2 && pages.length)
  } finally {
    clearInterval(active)
  }
  assert.equal(first.terminated, true)
  assert.equal(pages[0].complete, true)
  assert.deepEqual(f.errors, [])
})

test('frontmatter metadata configuration survives derived worker restart', async (t) => {
  const source = '---\ntitle: hello\n---\n\n# body\n',
    pages = []
  const f = fixture(t, source, { metadataResult: (page) => pages.push(page) })
  f.client.metadata('gfm', 0, source.length, 4, true)
  await wait(() => pages.length === 1)
  assert.equal(pages[0].dialect, 'gfm+frontmatter')
  assert.equal(pages[0].rows[0].owner.kind, 'markdown:Frontmatter')
  f.workers[0].onerror({ preventDefault() {} })
  await wait(() => pages.length === 2)
  assert.equal(f.workers.length, 2)
  assert.equal(pages[1].dialect, pages[0].dialect)
  assert.equal(pages[1].rows[0].to, source.indexOf('# body'))
  assert.notEqual(pages[1].epoch, pages[0].epoch)
  assert.deepEqual(f.errors, [])
})

test('find deadlines remain finite while the metadata lane keeps replying', async (t) => {
  const pages = []
  const f = fixture(t, '# one\n\ntext', {
    timeoutMs: 80,
    metadataResult: (page) => pages.push(page),
  })
  f.client.metadata('commonmark', 0, 5, 2)
  await wait(() => pages.length)
  const first = f.workers[0],
    receive = first.service.receive.bind(first.service)
  first.service.receive = (message) => {
    if (message.type !== 'find') receive(message)
  }
  f.find('one')
  const active = setInterval(() => f.client.metadata('commonmark', 0, 5, 2), 5)
  try {
    await wait(() => f.workers.length === 2 && f.results.length)
  } finally {
    clearInterval(active)
  }
  assert.equal(first.terminated, true)
  assert.equal(f.results.at(-1).location.total, 1)
  assert.deepEqual(f.errors, [])
})

test('closing metadata requires cancellation acknowledgement before releasing its deadline', async (t) => {
  const pages = []
  const f = fixture(t, '# one', {
    timeoutMs: 80,
    metadataResult: (page) => pages.push(page),
  })
  f.client.metadata('commonmark', 0, 5, 2)
  await wait(() => pages.length)
  const first = f.workers[0]
  first.blocked = true
  f.client.releaseMetadata()
  await wait(() => f.workers.length === 2)
  assert.equal(first.terminated, true)
  assert.equal(f.session.snapshot().materialize(), '# one')
  assert.deepEqual(f.errors, [])
})

test('supersession acknowledgement cannot stand in for metadata owner release', async (t) => {
  const pages = []
  const f = fixture(t, '# one', {
    timeoutMs: 80,
    metadataResult: (page) => pages.push(page),
  })
  f.client.metadata('commonmark', 0, 5, 2)
  await wait(() => pages.length)
  const first = f.workers[0]
  first.blocked = true
  f.client.metadata('commonmark', 0, 5, 2)
  f.client.metadata('commonmark', 1, 4, 1)
  f.client.releaseMetadata()
  const release = first.messages.at(-1)
  first.onmessage({
    data: {
      type: 'metadata-canceled',
      epoch: release.epoch,
      id: release.id,
      release: false,
    },
  })
  await wait(() => f.workers.length === 2)
  assert.equal(first.terminated, true)
  assert.equal(pages.length, 1)
})

test('a late find result does not retire a missing cancellation acknowledgement', async (t) => {
  const f = fixture(t, 'one two one', { timeoutMs: 80 })
  f.find('one')
  await wait(() => f.results.length)
  const first = f.workers[0]
  first.blocked = true
  f.find('two')
  const pending = first.messages.at(-1)
  f.find('one')
  first.onmessage({
    data: {
      type: 'find',
      epoch: pending.epoch,
      id: pending.id,
      version: 0,
      location: f.results[0].location,
    },
  })
  await wait(() => f.workers.length === 2 && f.results.length === 2)
  assert.equal(first.terminated, true)
  assert.equal(f.results.at(-1).location.total, 2)
  assert.deepEqual(f.errors, [])
})

test('client lazily bootstraps immutable chunks and applies an exact operation suffix without materializing source', async (t) => {
  const f = fixture(t, 'one '.repeat(20000))
  f.session.counters(true)
  assert.equal(f.workers.length, 0)
  f.find('one', 0, 0, 'first')
  f.append('one')
  await wait(() => f.results.length > 0)
  assert.equal(f.results.at(-1).location.total, 20001)
  assert.equal(f.session.counters().materializations, 0)
  const first = f.workers[0].messages[0]
  assert.equal(first.type, 'load-start')
  assert.ok(
    f.workers[0].messages.some((message) => message.type === 'load-finish'),
  )
  f.append(' one')
  await wait(() => f.results.at(-1).location.total === 20002)
  assert.equal(f.workers.length, 1)
  assert.ok(f.workers[0].messages.some((message) => message.type === 'edit'))
  assert.deepEqual(f.errors, [])
})

test('client streams 50 mib and nonascii above 20 mib with bounded append work and task yields', async (t) => {
  const original = SourceStore.loader
  let published
  t.mock.method(SourceStore, 'loader', (...args) => {
    const loader = original(...args)
    return {
      append: loader.append,
      finish() {
        published = loader.finish()
        return published
      },
    }
  })
  for (const [pattern, units] of [
    ['a', 50 * 1024 * 1024],
    ['中😀\r\n', 12 * 1024 * 1024],
  ]) {
    const source =
      '\ufeff' +
      pattern.repeat(Math.ceil(units / pattern.length)).slice(0, units) +
      '\ud800'
    assert.ok(
      Buffer.byteLength(source) > (pattern === 'a' ? 50 : 20) * 1024 * 1024,
    )
    const done = Promise.withResolvers()
    const f = fixture(t, source, {
      result: () => done.resolve(),
      error: (message) => done.reject(new Error(message)),
    })
    f.session.counters(true)
    published = undefined
    f.find('')
    await wait(() => f.workers.length)
    const worker = f.workers[0]
    assert.equal(worker.messages[0].type, 'load-start')
    let turns = 0
    const tick = () => {
      turns++
      if (!published && !worker.terminated) setImmediate(tick)
    }
    setImmediate(tick)
    await done.promise
    assert.deepEqual(f.errors, [])
    assert.ok(published)
    const chunks = worker.messages.filter(
      (message) => message.type === 'load-chunk',
    )
    assert.ok(chunks.length >= Math.ceil(source.length / 65536))
    assert.ok(
      turns >= chunks.length,
      'bootstrap must yield through worker tasks',
    )
    let transferred = 0
    for (const { chunk } of chunks) {
      const size = chunk.chunks.reduce((sum, text) => sum + text.length, 0)
      assert.ok(size <= 65536)
      assert.ok(chunk.chunks.length <= 16)
      transferred += size
    }
    assert.equal(transferred, source.length)
    assert.equal(
      worker.messages.some((message) => message.type === 'load'),
      false,
    )
    assert.equal(
      worker.messages.filter((message) => message.type === 'load-finish')
        .length,
      1,
    )
    assert.equal(f.workers.length, 1)
    const counters = published.counters()
    assert.equal(
      counters.loadAppends,
      chunks.reduce((sum, { chunk }) => sum + chunk.chunks.length, 0),
    )
    assert.ok(counters.maxLoadInputUnits <= 65536)
    assert.ok(counters.maxLoadUnitsScanned <= 67584, JSON.stringify(counters))
    assert.ok(counters.maxLoadTreeWork < 10000, JSON.stringify(counters))
    assert.ok(
      counters.unitsScanned <= source.length + counters.loadAppends * 2048,
    )
    assert.equal(counters.materializations, 0)
    t.diagnostic(
      JSON.stringify({
        bytes: published.snapshot().utf8Bytes,
        messages: chunks.length,
        maxMessageUnits: Math.max(
          ...chunks.map(({ chunk }) =>
            chunk.chunks.reduce((sum, text) => sum + text.length, 0),
          ),
        ),
        appends: counters.loadAppends,
        maxAppendUnits: counters.maxLoadInputUnits,
        maxAppendScanned: counters.maxLoadUnitsScanned,
        maxAppendTreeWork: counters.maxLoadTreeWork,
      }),
    )
    assert.equal(f.session.counters().materializations, 0)
    assert.equal(f.session.counters().sourceUnitsRead, source.length)
    let offset = 0
    for (const part of published.snapshot().chunks()) {
      assert.equal(part, source.slice(offset, offset + part.length))
      offset += part.length
    }
    assert.equal(offset, source.length)
    assert.equal(published.snapshot().utf8Bytes, Buffer.byteLength(source))
    f.append('é')
    await wait(() => published.snapshot().version === 1)
    assert.equal(
      published.snapshot().sliceRaw(source.length, source.length + 1),
      'é',
    )
    f.client.dispose()
    f.session.dispose()
  }
})

test('eighteen bootstrap edits keep one worker and exact source; identity changes restart', async (t) => {
  const original = SourceStore.loader
  let published
  t.mock.method(SourceStore, 'loader', (...args) => {
    const loader = original(...args)
    return {
      append: loader.append,
      finish() {
        published = loader.finish()
        return published
      },
    }
  })
  const f = fixture(t, 'one '.repeat(40000), {
    worker: () => {
      const worker = new TestWorker(),
        block = f.workers.length === 0 || f.workers.length === 1,
        post = worker.postMessage.bind(worker)
      worker.postMessage = (message) => {
        if (
          block &&
          message.type === 'load-chunk' &&
          !worker.messages.some((sent) => sent.type === 'load-chunk')
        )
          worker.blocked = true
        post(message)
      }
      f.workers.push(worker)
      return worker
    },
  })
  f.find('one')
  await wait(() => f.workers.length)
  const first = f.workers[0]
  first.blocked = true
  await wait(() =>
    first.messages.some((message) => message.type === 'load-chunk'),
  )
  const stale = first.messages.at(-1)
  const keys = 'abcdefghijklmnopqr'
  for (const key of keys) f.append(key)
  assert.equal(first.terminated, false)
  // Resume the exact blocked transport message; the frozen prefix stays v0.
  first.blocked = false
  first.service.receive(stale)
  await wait(() => f.results.length)
  assert.equal(f.workers.length, 1)
  assert.equal(first.messages[0].head.contentVersion, 0)
  assert.deepEqual(
    first.messages
      .filter((message) => message.type === 'edit')
      .map((message) => message.operation.contentVersion),
    Array.from({ length: 18 }, (_, n) => n + 1),
  )
  assert.equal(published.snapshot().version, 18)
  assert.equal(published.snapshot().materialize(), 'one '.repeat(40000) + keys)
  assert.equal(f.results.at(-1).location.total, 40000)
  first.onerror({ preventDefault() {} })
  await wait(() => f.workers.length === 2)
  const third = f.workers[1]
  third.blocked = true
  await wait(() =>
    third.messages.some((message) => message.type === 'load-chunk'),
  )
  f.session.reidentify({ tabId: 'saved', revision: 2 })
  await wait(() => f.workers.length === 3 && f.results.length === 2)
  assert.equal(third.terminated, true)
  third.onmessage({ data: { type: 'ack', epoch: stale.epoch, version: 0 } })
  assert.equal(f.workers[2].messages[0].head.tabId, 'saved')
  assert.equal(f.workers[2].messages[0].head.revision, 2)
  assert.equal(f.workers[2].messages[0].head.contentVersion, 18)
  assert.equal(f.session.snapshot().version, 18)
  assert.deepEqual(f.errors, [])
})

test('client requires ordered bootstrap acknowledgements and publication before querying', async (t) => {
  const f = fixture(t, 'one', {
    worker: () => {
      const worker = new TestWorker()
      worker.blocked = true
      f.workers.push(worker)
      return worker
    },
  })
  f.find('one')
  await wait(() => f.workers.length)
  const first = f.workers[0],
    start = first.messages[0]
  first.onmessage({
    data: {
      type: 'load-ack',
      epoch: start.epoch,
      request: { streamId: start.head.streamId, sequence: 1 },
    },
  })
  assert.equal(first.terminated, true)
  await wait(() => f.workers.length === 2)
  const second = f.workers[1],
    next = second.messages[0]
  second.onmessage({
    data: {
      type: 'load-ack',
      epoch: next.epoch,
      request: { streamId: next.head.streamId, sequence: 0 },
    },
  })
  assert.equal(second.messages.at(-1).type, 'load-chunk')
  assert.equal(
    second.messages.some((message) => message.type === 'find'),
    false,
  )
  second.onmessage({ data: { type: 'ack', epoch: next.epoch, version: 0 } })
  assert.equal(second.terminated, true)
  assert.equal(f.errors.length, 1)
})

test('client coalesces superseded queries and ignores late replies and errors from terminated generations', async (t) => {
  const f = fixture(t, 'one two '.repeat(10000), { maximumPendingBytes: 700 })
  f.find('one')
  await wait(() => f.results.length > 0)
  const original = f.workers[0],
    epoch = original.messages[0].epoch
  original.blocked = true
  for (let n = 0; n < 100; n++) f.find(`query-${n}`)
  assert.ok(
    original.messages.filter((message) => message.type === 'find').length <= 2,
  )
  assert.equal(
    original.messages.filter((message) => message.type === 'cancel-find')
      .length,
    1,
  )
  f.find('two')
  for (let n = 0; n < 8; n++) f.append('x')
  await wait(
    () => f.workers.length === 2 && f.results.at(-1).location.total === 10000,
  )
  await wait(() =>
    f.workers[1].messages.some((message) => message.type === 'find'),
  )
  assert.equal(original.terminated, true)
  const before = f.results.length
  original.onmessage({
    data: {
      type: 'find',
      epoch,
      id: 999,
      version: 8,
      location: { total: 999, current: 0, previous: null, next: null },
    },
  })
  original.onerror({ preventDefault() {} })
  assert.equal(f.results.length, before)
  assert.equal(f.workers[1].terminated, false)
  assert.equal(f.session.snapshot().version, 8)
  assert.equal(f.workers[1].messages[0].head.contentVersion, 8)
  await wait(() => f.results.at(-1).location.total === 10000)
  assert.deepEqual(f.errors, [])
})

test('worker restarts are finite and disposal cancels bootstrap, listeners and pending jobs', async (t) => {
  const workers = [],
    f = fixture(t, 'one', {
      timeoutMs: 5,
      worker: () => {
        const worker = new TestWorker()
        worker.blocked = true
        workers.push(worker)
        return worker
      },
    })
  f.find('one')
  await wait(() => f.errors.length === 1)
  assert.equal(workers.length, 2)
  assert.ok(workers.every((worker) => worker.terminated))
  f.client.dispose()
  f.append(' two')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(workers.length, 2)
  const immediate = fixture(t)
  immediate.find('one')
  immediate.client.dispose()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(immediate.workers.length, 0)
})

test('a new document identity gets a fresh worker after a failed generation', async (t) => {
  const workers = []
  let blocked = true
  let findSent
  const freshFind = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Fresh worker did not receive find')),
      3000,
    )
    findSent = (worker) => {
      clearTimeout(timer)
      resolve(worker)
    }
  })
  const f = fixture(t, 'one', {
    timeoutMs: 5,
    worker: () => {
      const worker = new TestWorker()
      worker.blocked = blocked
      if (!blocked) {
        const postMessage = worker.postMessage.bind(worker)
        worker.postMessage = (message) => {
          postMessage(message)
          if (message.type === 'find') findSent(worker)
        }
      }
      workers.push(worker)
      return worker
    },
  })
  f.find('one')
  await wait(() => f.errors.length === 1)
  blocked = false
  f.session.reidentify({ tabId: 'a', revision: 1 })
  const freshWorker = await freshFind
  assert.equal(workers.length, 3)
  assert.equal(freshWorker, workers[2])
  assert.equal(freshWorker.messages[0].head.revision, 1)
})
