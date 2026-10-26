import assert from 'node:assert/strict'
import test from 'node:test'
import { DocumentWorkerClient } from '../src/renderer/src/document-worker-client.ts'
import { BoundaryTree } from '../src/shared/chunked-markdown.ts'
import { DocumentSession } from '../src/shared/document-session.ts'
import { DocumentWorkerService } from '../src/shared/document-worker-service.ts'
import { MarkdownBoundaryIndex } from '../src/shared/markdown-boundary-index.ts'
import { boundaryKey } from '../src/shared/markdown-boundary-syntax.ts'

const config = {
  schema: 1,
  syntax: ['table@1', 'tasks@1', 'math-block@1'],
  flavors: ['markdown.github', 'math.latex'],
  literal: [],
  opaque: ['FencedCode', 'BlockMath'],
  prefix: 0,
  chunkSize: 1024,
  groupSize: 64,
  giantBlock: 16384,
}

class Transport {
  messages = []
  replies = []
  terminated = false
  onmessage = null
  onerror = null
  onmessageerror = null
  service = new DocumentWorkerService((reply) => {
    this.replies.push(reply)
    setImmediate(() => {
      if (!this.terminated) this.onmessage?.({ data: structuredClone(reply) })
    })
  })
  postMessage(message) {
    this.messages.push(message)
    setImmediate(() => {
      if (!this.terminated) this.service.receive(structuredClone(message))
    })
  }
  terminate() {
    this.terminated = true
    this.service.dispose()
  }
}
let debug = () => ({})
const until = (predicate) =>
  new Promise((resolve, reject) => {
    const end = Date.now() + 10000
    const poll = () => {
      if (predicate()) return resolve()
      if (Date.now() > end)
        return reject(
          new Error(
            `Boundary worker did not settle: ${JSON.stringify(debug())}`,
          ),
        )
      setTimeout(poll, 5)
    }
    poll()
  })
function fixture(t, source = '# title\n\ntext\n\n'.repeat(20000)) {
  const transports = [],
    pages = [],
    declined = [],
    errors = []
  const session = new DocumentSession(
    source,
    { tabId: 'boundary', revision: 0 },
    0,
    { enqueue: () => {}, onError: (error) => errors.push(error) },
  )
  const client = new DocumentWorkerClient(session, {
    changed: () => {},
    pending: () => {},
    result: () => {},
    error: (error) => errors.push(error),
    worker: () => {
      const worker = new Transport()
      transports.push(worker)
      return worker
    },
  })
  debug = () => ({
    errors,
    declined,
    pages: pages.length,
    recent: transports
      .at(-1)
      ?.replies.slice(-4)
      .map(({ type, version, stage, message }) => ({
        type,
        version,
        stage,
        message,
      })),
    requests: transports
      .at(-1)
      ?.messages.slice(-4)
      .map(({ type, version }) => ({ type, version })),
  })
  t.after(() => {
    client.dispose()
    session.dispose()
  })
  const request = (
    configuration = config,
    receive = (page, ack) => {
      pages.push(page)
      ack()
    },
  ) =>
    client.boundaries(configuration, receive, (reason) => declined.push(reason))
  return { transports, pages, declined, errors, session, client, request }
}

test('index pages are bounded and acknowledged one at a time on the existing replica', async (t) => {
  const advance = MarkdownBoundaryIndex.prototype.advance
  const progress = { advances: 0 }
  t.mock.method(MarkdownBoundaryIndex.prototype, 'advance', function () {
    progress.advances++
    return advance.call(this)
  })
  const f = fixture(t),
    releases = []
  const state = debug
  debug = () => ({ ...state(), ...progress })
  f.request(config, (page, ack) => {
    f.pages.push(page)
    releases.push(ack)
  })
  await until(() => f.pages.length === 1)
  // A channel turn cannot send another page until the receiver has adopted this one.
  await new Promise(setImmediate)
  assert.equal(f.pages.length, 1)
  let page = 0
  while (!f.pages.at(-1).done) {
    releases[page++]()
    await until(() => f.pages.length > page)
  }
  releases.at(-1)()
  assert.ok(f.pages.length > 1)
  const model = new MarkdownBoundaryIndex(f.session.snapshot(), config)
  while (!model.advance()) {}
  const builder = new BoundaryTree(model.parser, model.length)
  for (const result of f.pages) {
    assert.ok(result.records.length <= 128)
    assert.ok(JSON.stringify(result.records).length < 17000)
    assert.equal(result.key, boundaryKey(config))
    builder.append(result.records)
  }
  assert.equal(builder.finish().length, f.session.snapshot().normalizedLength)
  assert.equal(f.transports.length, 1)
  assert.ok(
    f.transports[0].messages.some((message) => message.type === 'load-chunk'),
  )
  assert.equal(f.session.counters().materializations, 0)
  assert.deepEqual(f.errors, [])
})

test('edits cancel stale pages, keep the replica, and deliver the exact latest index', async (t) => {
  const f = fixture(t),
    held = []
  f.request(config, (page, ack) => {
    f.pages.push(page)
    held.push(ack)
  })
  await until(() => f.pages.length === 1)
  const old = f.pages[0]
  f.session.edit(
    [
      {
        from: f.session.snapshot().utf16Length - 6,
        to: f.session.snapshot().utf16Length - 6,
        insert: '\n# latest\n',
      },
    ],
    'source',
    'test',
  )
  f.request()
  held[0]()
  await until(() => f.pages.some((page) => page.done && page.version === 1))
  assert.equal(f.transports.length, 1)
  assert.equal(f.pages.at(-1).version, 1)
  assert.equal(
    f.pages.at(-1).sequence,
    f.pages.filter((page) => page.version === 1).length - 1,
  )
  const worker = f.transports[0]
  worker.onmessage({ data: old })
  worker.onmessage({ data: { ...f.pages.at(-1), key: 'wrong' } })
  assert.ok(f.declined.includes('stale'))
  assert.ok(f.declined.includes('mismatch'))
  assert.deepEqual(f.errors, [])
})

test('canonical edits cannot send newer boundaries to a view that has not caught up', async (t) => {
  const f = fixture(t, '# old\n\ntext\n\n'.repeat(600)),
    held = []
  f.request(config, (page, ack) => {
    f.pages.push(page)
    held.push(ack)
  })
  await until(() => f.pages.length === 1)
  f.session.edit([{ from: 0, to: 1, insert: '>' }], 'source', 'test')
  held[0]()
  const worker = f.transports[0]
  await until(() =>
    worker.replies.some(
      (reply) => reply.type === 'boundaries' && reply.version === 1,
    ),
  )
  await new Promise(setImmediate)
  assert.equal(f.pages.length, 1)
  assert.ok(f.declined.includes('stale'))
  f.request()
  await until(() => f.pages.at(-1).done && f.pages.at(-1).version === 1)
  assert.deepEqual(f.errors, [])
})

test('configuration changes supersede in-flight pages and unknown versions decline safely', async (t) => {
  const f = fixture(t),
    held = []
  f.request(config, (page, ack) => {
    f.pages.push(page)
    held.push(ack)
  })
  await until(() => f.pages.length === 1)
  f.request({ ...config, syntax: [] })
  held[0]()
  await until(() =>
    f.pages.some(
      (page) =>
        page.done && page.key === boundaryKey({ ...config, syntax: [] }),
    ),
  )
  const count = f.pages.length
  f.request({ ...config, schema: 2 })
  await until(() => f.declined.includes('mismatch'))
  assert.equal(f.pages.length, count)
  assert.deepEqual(f.errors, [])
})

test('close cancels scan, transfer ownership and further replies while another note opens', async (t) => {
  const f = fixture(t),
    g = fixture(t, '# other note\n\nready\n')
  f.request(config, (page) => f.pages.push(page))
  await until(() => f.pages.length === 1)
  f.client.dispose()
  const count = f.pages.length
  g.request()
  await until(() => g.pages.at(-1)?.done)
  assert.equal(f.transports[0].terminated, true)
  assert.equal(f.pages.length, count)
  assert.deepEqual(g.errors, [])
  assert.equal(g.pages[0].length, g.session.snapshot().normalizedLength)
})

test('release cancels a scan without cancelling find or changing canonical source', async (t) => {
  const f = fixture(t)
  f.request(config, (page) => f.pages.push(page))
  await until(() => f.pages.length === 1)
  f.client.releaseBoundaries()
  const worker = f.transports[0]
  await until(() =>
    worker.messages.some((message) => message.type === 'cancel-boundaries'),
  )
  f.client.find('title', 0, 0)
  await until(() => worker.replies.some((message) => message.type === 'find'))
  assert.equal(f.session.snapshot().version, 0)
  assert.deepEqual(f.errors, [])
})

test('completed indexes stay idle through edits and stream only a requested suffix', async (t) => {
  const f = fixture(t)
  f.request()
  await until(() => f.pages.at(-1)?.done)
  f.client.releaseBoundaries(true)
  const firstPages = f.pages.length
  const source = f.session.snapshot()
  f.session.edit(
    [{ from: source.utf16Length - 4, to: source.utf16Length - 4, insert: 'x' }],
    'source',
    'test',
  )
  await until(() =>
    f.transports[0].replies.some(
      (reply) => reply.type === 'ack' && reply.version === 1,
    ),
  )
  assert.equal(f.pages.length, firstPages)
  const from = f.session.snapshot().normalizedLength - 150
  f.client.boundaries(
    config,
    (page, ack) => {
      f.pages.push(page)
      ack()
    },
    (reason) => f.declined.push(reason),
    from,
  )
  await until(() => f.pages.at(-1)?.done && f.pages.at(-1)?.version === 1)
  const suffix = f.pages.slice(firstPages)
  assert.ok(suffix.length < firstPages)
  assert.ok(suffix.every((page) => page.from > 0 && page.from <= from))
  assert.deepEqual(f.declined, [])
  assert.deepEqual(f.errors, [])
})

test('invalid suffix offsets cannot publish another boundary page', async (t) => {
  for (const from of [-1, 0.5, Number.MAX_SAFE_INTEGER]) {
    const f = fixture(t)
    f.request(config, (page) => f.pages.push(page))
    await until(() => f.pages.length === 1)
    f.transports[0].onmessage({
      data: { ...f.pages[0], sequence: 1, from },
    })
    assert.deepEqual(f.declined, ['mismatch'])
    assert.equal(f.pages.length, 1)
    assert.deepEqual(f.errors, [])
  }
})
