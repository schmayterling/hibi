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
  holdCode = false
  holdLoad = false
  onmessage = null
  onerror = null
  onmessageerror = null
  service = new DocumentWorkerService((reply) => {
    this.replies.push(reply)
    setImmediate(() => {
      if (
        !this.terminated &&
        !(this.holdCode && reply.type === 'boundaries' && reply.code) &&
        !(this.holdLoad && reply.type === 'load-ack')
      )
        this.onmessage?.({ data: structuredClone(reply) })
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
function codeDone(f, version = f.session.snapshot().version) {
  const transport = f.transports[0]
  const request = transport?.messages
    .filter(
      (message) =>
        message.type === 'boundaries' &&
        message.codeOnly &&
        message.version === version,
    )
    .at(-1)
  const final =
    request &&
    transport.replies.find(
      (reply) =>
        reply.type === 'boundaries' && reply.id === request.id && reply.done,
    )
  return (
    final &&
    transport.messages.some(
      (message) =>
        message.type === 'boundary-ack' &&
        message.id === request.id &&
        message.sequence === final.sequence,
    )
  )
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
function fixture(
  t,
  source = '# title\n\ntext\n\n'.repeat(20000),
  beforeClient,
  holdCode = false,
  holdLoad = false,
) {
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
  beforeClient?.(session)
  const client = new DocumentWorkerClient(session, {
    changed: () => {},
    pending: () => {},
    result: () => {},
    error: (error) => errors.push(error),
    worker: () => {
      const worker = new Transport()
      worker.holdCode = holdCode
      worker.holdLoad = holdLoad
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

test('a prefix change without an edit replaces a held boundary request', async (t) => {
  const prefix = '---\ntitle: exact\n---\n\n'
  const f = fixture(t, prefix + '# heading\n\nbody\n\n'.repeat(100))
  f.request(config, (page) => f.pages.push(page))
  await until(() => f.pages.length === 1)
  const firstId = f.pages[0].id
  f.request({ ...config, prefix: prefix.length })
  await new Promise(setImmediate)
  assert.equal(
    f.transports[0].messages.filter((message) => message.type === 'boundaries')
      .length,
    2,
  )
  await until(() => f.pages.some((page) => page.id !== firstId && page.done))
  const page = f.pages.find((page) => page.id !== firstId)
  assert.equal(page.records[0].length, prefix.length)
  assert.deepEqual(f.errors, [])
})

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
  const declines = f.declined.length
  worker.onmessage({ data: old })
  assert.equal(f.declined.length, declines)
  worker.onmessage({ data: { ...f.pages.at(-1), key: 'wrong' } })
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

test('invalid or inconsistent unchanged-suffix markers cannot publish another page', async (t) => {
  for (const [to, baseVersion] of [
    [-1, 0],
    [0.5, 0],
    [Number.MAX_SAFE_INTEGER, 0],
    [0, 0],
    [0, undefined],
  ]) {
    const f = fixture(t)
    f.client.boundaries(
      config,
      (page) => f.pages.push(page),
      (reason) => f.declined.push(reason),
      0,
      baseVersion,
    )
    await until(() => f.pages.length === 1)
    f.transports[0].onmessage({
      data: { ...f.pages[0], sequence: 1, to },
    })
    assert.deepEqual(f.declined, ['mismatch'])
    assert.equal(f.pages.length, 1)
    assert.deepEqual(f.errors, [])
  }
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

test('code coverage streams complete ranges, replays to late listeners without source reads, and repairs only touched ranges', async (t) => {
  const unit = '~~~\r\none\tline\r\n~~~\r\n\r\n    indented\r\n\r\n'
  const f = fixture(t, unit.repeat(200)),
    first = [],
    late = []
  const detach = f.client.subscribeCodeExtents((page) => first.push(page))
  f.request()
  await until(() => codeDone(f))
  assert.ok(first.length > 1)
  assert.equal(first[0].from, 0)
  assert.equal(first.at(-1).to, f.session.snapshot().normalizedLength)
  for (let i = 1; i < first.length; i++)
    assert.equal(first[i].from, first[i - 1].to)
  const initial = first.flatMap((page) => page.records)
  assert.equal(initial.length, 400)
  assert.equal(initial[0].contentColumns, 8)
  assert.equal(initial[0].contentLines, 1)
  assert.ok(first.every((page) => page.version === 0))
  const before = f.pages.length
  f.session.counters(true)
  const stopLate = f.client.subscribeCodeExtents((page) => late.push(page))
  await until(
    () =>
      codeDone(f) &&
      late.flatMap((page) => page.records).length === initial.length,
  )
  assert.equal(f.pages.length, before)
  assert.deepEqual(
    late.flatMap((page) => page.records),
    initial,
  )
  assert.equal(f.session.counters().sourceUnitsRead, 0)
  assert.equal(f.session.counters().materializations, 0)
  stopLate()
  const lateCount = late.length,
    firstCount = first.length,
    pageCount = f.pages.length
  f.client.releaseBoundaries(true)
  const from = unit.length * 100 + unit.indexOf('one')
  const normalized = f.session.snapshot().rawToEditor(from)
  f.session.edit(
    [{ from, to: from + 3, insert: 'very' }],
    'source',
    'code-width',
  )
  f.client.boundaries(
    config,
    (page, ack) => {
      f.pages.push(page)
      ack()
    },
    (reason) => f.declined.push(reason),
    normalized,
    0,
  )
  await until(
    () =>
      f.pages.length > pageCount &&
      f.pages.at(-1)?.done &&
      f.pages.at(-1)?.version === 1 &&
      codeDone(f),
  )
  const repair = first.slice(firstCount)
  assert.ok(repair.length > 0)
  assert.ok(
    repair.every(
      (page) =>
        page.version === 1 &&
        page.from > 0 &&
        page.to < f.session.snapshot().normalizedLength,
    ),
  )
  t.diagnostic(
    JSON.stringify({
      denseRepair: repair.map(({ from, to, records }) => ({
        from,
        to,
        records: records.length,
      })),
    }),
  )
  assert.equal(repair.flatMap((page) => page.records).length, 1)
  assert.ok(
    repair.some((page) =>
      page.records.some((record) => record.contentColumns === 12),
    ),
  )
  assert.equal(late.length, lateCount)
  const secondCount = first.length,
    boundaryCount = f.pages.length
  f.client.releaseBoundaries(true)
  const other = unit.length * 150 + 1 + unit.indexOf('one')
  const otherNormalized = f.session.snapshot().rawToEditor(other)
  f.session.edit(
    [{ from: other, to: other + 3, insert: 'two' }],
    'source',
    'same-width',
  )
  f.client.boundaries(
    config,
    (page, ack) => {
      f.pages.push(page)
      ack()
    },
    (reason) => f.declined.push(reason),
    otherNormalized,
  )
  await until(
    () =>
      f.pages.length > boundaryCount &&
      f.pages.at(-1)?.done &&
      f.pages.at(-1)?.version === 2 &&
      codeDone(f),
  )
  assert.equal(
    first.slice(secondCount).flatMap((page) => page.records).length,
    1,
  )
  const request = f.transports[0].messages
    .filter((message) => message.type === 'boundaries')
    .at(-1)
  assert.equal(request.baseVersion, undefined)
  assert.equal(request.codeVersion, 1)
  detach()
  assert.deepEqual(f.declined, [])
  assert.deepEqual(f.errors, [])
})

test('code coverage rejects stale and malformed messages before notifying listeners', async (t) => {
  const mutations = [
    (page) => ({ ...page, from: -1 }),
    (page) => ({
      ...page,
      from: page.records[0].to,
      records: [page.records[0]],
    }),
    (page) => ({ ...page, to: Number.MAX_SAFE_INTEGER }),
    (page) => ({ ...page, records: Array(129).fill(page.records[0]) }),
    (page) => ({
      ...page,
      records: [{ ...page.records[0], contentColumns: -1 }],
    }),
    (page) => ({
      ...page,
      records: [{ ...page.records[0], contentLines: 0.5 }],
    }),
    (page) => ({
      ...page,
      records: [{ ...page.records[0], contentTo: Number.MAX_SAFE_INTEGER }],
    }),
    (page) => ({ ...page, records: [{ ...page.records[0], closed: 'yes' }] }),
    (page) => ({ ...page, records: [page.records[1], page.records[0]] }),
  ]
  for (const mutate of mutations) {
    const f = fixture(t, '~~~\nbody\n~~~\n\n'.repeat(100), undefined, true),
      code = []
    f.client.subscribeCodeExtents((page) => code.push(page))
    f.request()
    await until(() =>
      f.transports[0]?.replies.some(
        (reply) => reply.type === 'boundaries' && reply.code,
      ),
    )
    const first = f.transports[0].replies.find(
      (reply) => reply.type === 'boundaries' && reply.code,
    )
    assert.ok(first.code.records.length >= 2)
    const count = code.length,
      syntaxCount = f.pages.length
    f.transports[0].onmessage({ data: { ...first, epoch: 'old' } })
    assert.equal(code.length, count)
    assert.deepEqual(f.declined, [])
    f.transports[0].onmessage({
      data: { ...first, code: mutate(first.code) },
    })
    assert.equal(code.length, count)
    assert.equal(f.pages.length, syntaxCount)
    assert.deepEqual(f.declined, [])
    assert.equal(f.transports[0].messages.at(-1).type, 'cancel-boundaries')
    assert.deepEqual(f.errors, [])
  }
})

test('release stops code coverage after syntax adoption', async (t) => {
  const f = fixture(t, '~~~\nbody\n~~~\n\n'.repeat(100), undefined, true),
    code = []
  f.client.subscribeCodeExtents((page) => code.push(page))
  f.request()
  await until(() =>
    f.transports[0]?.replies.some(
      (reply) => reply.type === 'boundaries' && reply.code,
    ),
  )
  const syntaxCount = f.pages.length
  const held = f.transports[0].replies.find(
    (reply) => reply.type === 'boundaries' && reply.code,
  )
  assert.ok(f.pages.at(-1).done)
  f.client.releaseBoundaries()
  f.transports[0].onmessage({ data: held })
  await new Promise(setImmediate)
  assert.equal(f.pages.length, syntaxCount)
  assert.equal(code.length, 0)
  assert.deepEqual(f.errors, [])
})

test('a code listener can edit without delivering an old page to another listener or view', async (t) => {
  const f = fixture(t, '~~~\nbody\n~~~\n'),
    second = []
  let edited = false
  f.client.subscribeCodeExtents((page) => {
    if (page.version !== 0 || edited) return
    edited = true
    f.session.edit([{ from: 4, to: 5, insert: 'x' }], 'source', 'reentrant')
  })
  f.client.subscribeCodeExtents((page) => second.push(page))
  f.request()
  await until(() => edited)
  assert.ok(second.every((page) => page.version === 1))
  assert.ok(f.pages.every((page) => page.version === 0))
  const adoptedBeforeEdit = f.pages.length
  f.client.releaseBoundaries(true)
  await until(() =>
    f.transports[0].replies.some(
      (reply) => reply.type === 'ack' && reply.version === 1,
    ),
  )
  f.request()
  await until(() => f.pages.at(-1)?.done && f.pages.at(-1)?.version === 1)
  await until(() => second.length > 0)
  assert.ok(second.length > 0)
  assert.ok(second.every((page) => page.version === 1))
  assert.ok(
    f.pages.slice(adoptedBeforeEdit).every((page) => page.version === 1),
  )
  assert.deepEqual(f.errors, [])
})

test('retained code coverage repairs after syntax release and stops work with the last listener', async (t) => {
  const original = MarkdownBoundaryIndex.prototype.advance
  let advances = 0,
    model
  MarkdownBoundaryIndex.prototype.advance = function () {
    model = this
    advances++
    return original.call(this)
  }
  t.after(() => {
    MarkdownBoundaryIndex.prototype.advance = original
  })
  const unit = '~~~\nbody\n~~~\n\n'
  const f = fixture(t, unit.repeat(200)),
    code = []
  const detach = f.client.subscribeCodeExtents((page) => code.push(page))
  f.request()
  await until(() => codeDone(f))
  const initial = code.flatMap((page) => page.records)
  f.client.releaseBoundaries(true)
  const watch = f.transports[0].messages
    .filter((message) => message.type === 'boundaries')
    .at(-1)
  assert.equal(watch.codeOnly, true)
  await until(() =>
    f.transports[0].replies.some(
      (reply) =>
        reply.type === 'boundaries' && reply.id === watch.id && reply.done,
    ),
  )
  const before = code.length
  const from = unit.length * 100 + 4
  f.session.counters(true)
  f.session.edit(
    [{ from, to: from + 4, insert: 'wide\tbody' }],
    'source',
    'retained-code',
  )
  await until(() => code.some((page) => page.version === 1))
  const request = f.transports[0].messages
    .filter((message) => message.type === 'boundaries' && message.version === 1)
    .at(-1)
  await until(() =>
    f.transports[0].replies.some(
      (reply) =>
        reply.type === 'boundaries' && reply.id === request.id && reply.done,
    ),
  )
  const repair = code.slice(before)
  assert.equal(repair.length, 1)
  assert.equal(repair[0].records.length, 1)
  assert.equal(repair[0].from, initial[100].from)
  assert.equal(repair[0].to, initial[100].to + 5)
  assert.equal(repair[0].records[0].contentColumns, 12)
  assert.equal(request.codeOnly, true)
  const replies = f.transports[0].replies.filter(
    (reply) => reply.type === 'boundaries' && reply.id === request.id,
  )
  assert.ok(replies.every((reply) => reply.records.length === 0))
  assert.ok(f.session.counters().sourceUnitsRead < 256)
  assert.equal(f.session.counters().materializations, 0)
  detach()
  assert.equal(f.transports[0].messages.at(-1).type, 'cancel-boundaries')
  assert.equal(f.transports[0].messages.at(-1).retain, true)
  await new Promise(setImmediate)
  assert.equal(model.codeWork.widthRuns, 0)
  const stopped = advances,
    count = code.length
  f.session.edit([{ from: 4, to: 5, insert: 'z' }], 'source', 'stopped-code')
  await until(() =>
    f.transports[0].replies.some(
      (reply) => reply.type === 'ack' && reply.version === 2,
    ),
  )
  await new Promise(setImmediate)
  const stoppedWork = advances - stopped
  assert.equal(stoppedWork, 0)
  assert.equal(code.length, count)
  const restarted = []
  const stopRestarted = f.client.subscribeCodeExtents((page) =>
    restarted.push(page),
  )
  await until(() => restarted.flatMap((page) => page.records).length === 200)
  assert.ok(restarted.every((page) => page.version === 2))
  assert.equal(code.length, count)
  stopRestarted()
  assert.deepEqual(f.declined, [])
  assert.deepEqual(f.errors, [])
  t.diagnostic(
    JSON.stringify({
      retainedWatch: {
        messages: repair.length,
        codeRecords: repair[0].records.length,
        syntaxRecords: 0,
        advancesAfterStop: stoppedWork,
      },
    }),
  )
})

test('the code watch preserves a syntax request made earlier in the edit notification', async (t) => {
  const prefix = '---\r\ntitle: a\r\n---\r\n\r\n'
  const configured = {
    ...config,
    prefix: prefix.replaceAll('\r\n', '\n').length,
  }
  let f
  f = fixture(
    t,
    prefix + '~~~\r\nbody\r\n~~~\r\n\r\n'.repeat(100),
    (session) => {
      t.after(
        session.subscribeOperations(() => {
          f.request({ ...configured, prefix: configured.prefix + 7 })
        }),
      )
    },
  )
  const detach = f.client.subscribeCodeExtents(() => {})
  f.request(configured)
  await until(() => f.pages.at(-1)?.done)
  f.client.releaseBoundaries(true)
  const from = prefix.indexOf('a\r')
  f.session.edit(
    [{ from, to: from + 1, insert: 'longword' }],
    'source',
    'early-syntax',
  )
  await until(() =>
    f.transports[0].messages.some(
      (message) => message.type === 'boundaries' && message.version === 1,
    ),
  )
  const request = f.transports[0].messages.find(
    (message) => message.type === 'boundaries' && message.version === 1,
  )
  assert.equal(request.codeOnly, undefined)
  await until(() => f.pages.at(-1)?.done && f.pages.at(-1)?.version === 1)
  f.client.releaseBoundaries(true)
  const watch = f.transports[0].messages
    .filter((message) => message.type === 'boundaries')
    .at(-1)
  assert.equal(watch.codeOnly, true)
  assert.equal(watch.config.prefix, configured.prefix + 7)
  assert.deepEqual(f.declined, [])
  assert.deepEqual(f.errors, [])
  detach()
})

test('a late code-only watch indexes extents and maps a crlf frontmatter prefix', async (t) => {
  const prefix = '---\r\ntitle: a\r\n---\r\n\r\n',
    unit = '~~~\r\nbody\r\n~~~\r\n\r\n'
  const f = fixture(t, prefix + unit.repeat(100)),
    code = []
  const configWithPrefix = {
    ...config,
    prefix: prefix.replaceAll('\r\n', '\n').length,
  }
  f.request(configWithPrefix)
  await until(() => f.pages.at(-1)?.done)
  f.client.releaseBoundaries(true)
  const originalPages = f.pages.length
  f.session.counters(true)
  const detach = f.client.subscribeCodeExtents((page) => code.push(page))
  await until(() => code.flatMap((page) => page.records).length === 100)
  const watch = f.transports[0].messages
    .filter((message) => message.type === 'boundaries')
    .at(-1)
  await until(() =>
    f.transports[0].messages.some(
      (message) =>
        message.type === 'boundary-ack' &&
        message.id === watch.id &&
        message.version === 0,
    ),
  )
  assert.equal(watch.codeOnly, true)
  assert.equal(f.pages.length, originalPages)
  assert.ok(f.session.counters().sourceUnitsRead < 16384)
  assert.equal(f.session.counters().materializations, 0)
  f.session.edit(
    [
      {
        from: prefix.indexOf('a\r'),
        to: prefix.indexOf('a\r') + 1,
        insert: 'longword',
      },
    ],
    'source',
    'watch-prefix',
  )
  await until(() =>
    f.transports[0].messages.some(
      (message) => message.type === 'boundary-ack' && message.version === 1,
    ),
  )
  const mapped = f.transports[0].messages
    .filter((message) => message.type === 'boundaries' && message.version === 1)
    .at(-1)
  assert.equal(mapped.config.prefix, configWithPrefix.prefix + 7)
  const before = code.length,
    from = prefix.length + 7 + 5
  f.session.edit(
    [{ from, to: from + 4, insert: 'wide\tbody' }],
    'source',
    'watch-body',
  )
  await until(() => code.some((page) => page.version === 2))
  assert.equal(code.slice(before).flatMap((page) => page.records).length, 1)
  assert.equal(code.at(-1).records[0].contentColumns, 12)
  assert.deepEqual(f.errors, [])
  detach()
})

test('a suffix syntax request still pushes code coverage for the whole note', async (t) => {
  const f = fixture(t, '~~~\nbody\n~~~\n\n'.repeat(100)),
    code = []
  f.client.subscribeCodeExtents((page) => code.push(page))
  const from = f.session.snapshot().normalizedLength - 20
  f.client.boundaries(
    config,
    (page, ack) => {
      f.pages.push(page)
      ack()
    },
    (reason) => f.declined.push(reason),
    from,
  )
  await until(() => f.pages.at(-1)?.done && codeDone(f))
  assert.ok(f.pages[0].from > 0)
  assert.equal(code[0].from, 0)
  assert.equal(code.at(-1).to, f.session.snapshot().normalizedLength)
  assert.equal(code.flatMap((page) => page.records).length, 100)
  assert.equal(
    f.transports[0].messages.find((message) => message.type === 'boundaries')
      .codeVersion,
    null,
  )
  assert.deepEqual(f.declined, [])
  assert.deepEqual(f.errors, [])
})

test('no code listeners preserve syntax-only message volume and rope lookup counts', async (t) => {
  const unit =
    '# part\n\n' +
    'paragraph words\n\n'.repeat(32) +
    '~~~js\nsmall\tbody\n~~~\n\n    indented\n\n> ~~~\n> quote\n> ~~~\n\n- ~~~\n  list\n  ~~~\n\n'
  const text = unit.repeat(Math.ceil(1048576 / unit.length))
  const settings = {
    ...config,
    chunkSize: 4096,
    giantBlock: 65536,
    opaque: ['Table'],
  }
  const f = fixture(t, text)
  const prototype = Object.getPrototypeOf(f.session.snapshot())
  let active = false
  const counts = {
    lineAt: 0,
    lineStart: 0,
    editorToRaw: 0,
    rawToEditor: 0,
    sliceRaw: 0,
  }
  for (const name of Object.keys(counts)) {
    const original = prototype[name]
    t.mock.method(prototype, name, function (...args) {
      if (active) counts[name]++
      return original.apply(this, args)
    })
  }
  const baseline = new MarkdownBoundaryIndex(f.session.snapshot(), settings)
  active = true
  while (!baseline.advance()) {}
  active = false
  const expectedSeeks = { ...counts }
  for (const name of Object.keys(counts)) counts[name] = 0
  const expected = [...baseline.records()]
  const advance = MarkdownBoundaryIndex.prototype.advance
  let codeRead = 0
  t.mock.method(MarkdownBoundaryIndex.prototype, 'advance', function () {
    active = true
    try {
      return advance.call(this)
    } finally {
      active = false
      codeRead = this.codeWork.readUnits
    }
  })
  f.request(settings)
  await until(() =>
    f.transports[0]?.messages.some((message) => message.type === 'boundaries'),
  )
  assert.equal(
    f.transports[0].messages.find((message) => message.type === 'boundaries')
      .codeVersion,
    undefined,
  )
  await until(() => f.pages.at(-1)?.done)
  assert.ok(f.pages.every((page) => page.code === undefined))
  assert.deepEqual(
    f.pages.flatMap((page) => page.records),
    expected,
  )
  assert.equal(codeRead, 0)
  assert.deepEqual(counts, expectedSeeks)
  let messages = 0,
    units = 0,
    records = 0
  for (const record of expected) {
    const size = JSON.stringify(record).length
    if (records && (records === 128 || units + size > 16384)) {
      messages++
      records = units = 0
    }
    records++
    units += size
  }
  assert.equal(f.pages.length, messages + 1)
  t.diagnostic(
    JSON.stringify({
      noListeners: { messages: f.pages.length, codeRead, ...counts },
    }),
  )
})

test('superseded code-only replies do not decline the current syntax request', async (t) => {
  const f = fixture(t, '~~~\nbody\n~~~\n\n'.repeat(100))
  const detach = f.client.subscribeCodeExtents(() => {})
  f.request()
  await until(() => f.pages.at(-1)?.done)
  f.client.releaseBoundaries(true)
  const watch = f.transports[0].messages
    .filter((message) => message.type === 'boundaries')
    .at(-1)
  await until(() =>
    f.transports[0].replies.some(
      (reply) =>
        reply.type === 'boundaries' && reply.id === watch.id && reply.done,
    ),
  )
  const old = f.transports[0].replies.find(
    (reply) => reply.type === 'boundaries' && reply.id === watch.id,
  )
  f.request(config, (page) => f.pages.push(page))
  f.transports[0].onmessage({ data: old })
  assert.deepEqual(f.declined, [])
  detach()
})

test('code-only pages start after syntax done is acknowledged and never gate adoption', async (t) => {
  const f = fixture(t, '~~~\na\n~~~\n'.repeat(1000)),
    code = []
  f.client.subscribeCodeExtents((page) => code.push(page))
  let release
  f.request(config, (page, ack) => {
    f.pages.push(page)
    if (page.done) release = ack
    else ack()
  })
  await until(() => release)
  assert.equal(code.length, 0)
  assert.ok(f.pages.every((page) => page.code === undefined))
  assert.equal(
    f.transports[0].messages.filter((message) => message.type === 'boundaries')
      .length,
    1,
  )
  release()
  await until(() => codeDone(f))
  assert.equal(code.flatMap((page) => page.records).length, 1000)
  assert.equal(
    f.transports[0].messages
      .filter((message) => message.type === 'boundaries')
      .at(-1).codeOnly,
    true,
  )
  assert.deepEqual(f.declined, [])
})

test('last unsubscribe retains the syntax model for the next suffix repair', async (t) => {
  const original = MarkdownBoundaryIndex.prototype.advance
  let advances = 0
  t.mock.method(MarkdownBoundaryIndex.prototype, 'advance', function () {
    advances++
    return original.call(this)
  })
  const repairs = []
  for (const listener of [false, true]) {
    const f = fixture(
      t,
      '# h\n\npara words\n\n~~~\ncode\n~~~\n\n'.repeat(40000),
    )
    const syntax = (from = 0, base) =>
      f.client.boundaries(
        config,
        (page, ack) => {
          f.pages.push(page)
          ack()
          if (page.done) f.client.releaseBoundaries(true)
        },
        (reason) => f.declined.push(reason),
        from,
        base,
      )
    syntax()
    await until(() => f.pages.at(-1)?.done)
    if (listener) {
      const stop = f.client.subscribeCodeExtents(() => {})
      await until(() => codeDone(f))
      stop()
      assert.equal(f.transports[0].messages.at(-1).retain, true)
    }
    const prior = f.pages.length,
      at = f.session.snapshot().utf16Length - 30
    f.session.edit(
      [{ from: at, to: at, insert: 'x' }],
      'source',
      'retained-syntax',
    )
    await until(() =>
      f.transports[0].replies.some(
        (reply) => reply.type === 'ack' && reply.version === 1,
      ),
    )
    const before = advances
    syntax(f.session.snapshot().normalizedLength - 40, 0)
    await until(
      () =>
        f.pages.length > prior &&
        f.pages.at(-1)?.done &&
        f.pages.at(-1).version === 1,
    )
    repairs.push(advances - before)
    assert.deepEqual(f.declined, [])
    assert.deepEqual(f.errors, [])
    f.client.dispose()
    f.session.dispose()
  }
  assert.deepEqual(repairs, [repairs[0], repairs[0]])
  assert.ok(repairs[0] < 10, JSON.stringify(repairs))
  t.diagnostic(JSON.stringify({ retainedSyntaxRepairAdvances: repairs }))
})

test('subscribing after the first syntax request does not parse the note twice', async (t) => {
  const advance = MarkdownBoundaryIndex.prototype.advance
  let advances = 0
  t.mock.method(MarkdownBoundaryIndex.prototype, 'advance', function () {
    advances++
    return advance.call(this)
  })
  const unit = '# h\n\npara words here\n\n~~~js\nx = 1\n~~~\n\n'
  const blocks = Math.ceil((2 * 1048576) / unit.length)
  const settings = {
    ...config,
    syntax: ['table@1', 'tasks@1'],
    flavors: [],
    opaque: ['Table'],
    chunkSize: 4096,
    giantBlock: 65536,
  }
  const work = []
  for (const subscribeFirst of [true, false]) {
    advances = 0
    const f = fixture(t, unit.repeat(blocks)),
      code = []
    const listen = () =>
      f.client.subscribeCodeExtents((page) => code.push(page))
    if (subscribeFirst) listen()
    f.request(settings)
    if (!subscribeFirst) listen()
    await until(() => codeDone(f))
    assert.equal(code.flatMap((page) => page.records).length, blocks)
    assert.ok(f.pages.at(-1).done)
    assert.deepEqual(f.declined, [])
    assert.deepEqual(f.errors, [])
    work.push(advances)
    f.client.dispose()
    f.session.dispose()
  }
  t.diagnostic(
    JSON.stringify({
      mountOrderAdvances: { subscribeFirst: work[0], requestFirst: work[1] },
    }),
  )
  assert.equal(work[1], work[0])
})

test('last unsubscribe removes geometry from an in-flight syntax request', async (t) => {
  const f = fixture(t),
    code = [],
    held = []
  const detach = f.client.subscribeCodeExtents((page) => code.push(page))
  f.request(config, (page, ack) => {
    f.pages.push(page)
    held.push(ack)
  })
  await until(() => f.pages.length === 1)
  const first = f.pages[0]
  assert.equal(first.done, false)
  detach()
  const requests = f.transports[0].messages.filter(
    (message) => message.type === 'boundaries',
  )
  assert.equal(requests.length, 2)
  assert.equal(requests[0].codeVersion, null)
  assert.equal(requests[1].codeVersion, undefined)
  assert.equal(requests[1].codeOnly, undefined)
  held[0]()
  f.transports[0].onmessage({ data: { ...first, epoch: 'old' } })
  assert.deepEqual(f.declined, [])
  let next = 1
  await until(() => f.pages.length > next)
  while (!f.pages.at(-1).done) {
    held[next++]()
    await until(() => f.pages.length > next)
  }
  held.at(-1)()
  assert.equal(code.length, 0)
  assert.ok(f.pages.every((page) => page.code === undefined))
  assert.equal(
    f.transports[0].messages.filter((message) => message.type === 'boundaries')
      .length,
    2,
  )
})

test('an early last unsubscribe does not attach an old view receiver to the edited version', async (t) => {
  let detach
  const f = fixture(t, undefined, (session) => {
    t.after(session.subscribeOperations(() => detach()))
  })
  detach = f.client.subscribeCodeExtents(() => {})
  const held = []
  f.request(config, (page, ack) => {
    f.pages.push(page)
    held.push(ack)
  })
  await until(() => f.pages.length === 1)
  f.session.edit([{ from: 0, to: 1, insert: '>' }], 'source', 'early-detach')
  await until(() =>
    f.transports[0].replies.some(
      (reply) => reply.type === 'ack' && reply.version === 1,
    ),
  )
  await new Promise(setImmediate)
  assert.equal(
    f.transports[0].messages.filter(
      (message) => message.type === 'boundaries' && message.version === 1,
    ).length,
    0,
  )
  held[0]()
  assert.equal(f.pages.length, 1)
  f.request()
  await until(() => f.pages.at(-1).done && f.pages.at(-1).version === 1)
  assert.deepEqual(f.errors, [])
})

test('a code watch can unsubscribe during bootstrap without canceling the document transfer', async (t) => {
  const f = fixture(t, '~~~\nbody\n~~~\n', undefined, false, true),
    code = []
  const detach = f.client.subscribeCodeExtents((page) => code.push(page))
  f.request()
  await until(() =>
    f.transports[0]?.replies.some((reply) => reply.type === 'load-ack'),
  )
  const worker = f.transports[0]
  const first = worker.replies.find((reply) => reply.type === 'load-ack')
  f.session.edit(
    [{ from: 4, to: 8, insert: 'wide\tbody' }],
    'source',
    'bootstrap-code',
  )
  detach()
  assert.equal(
    worker.messages.filter((message) => message.type === 'cancel-boundaries')
      .length,
    0,
  )
  f.request()
  worker.holdLoad = false
  worker.onmessage({ data: first })
  await until(() => f.pages.at(-1)?.done && f.pages.at(-1).version === 1)
  assert.equal(f.transports.length, 1)
  assert.equal(code.length, 0)
  const renewed = []
  const stop = f.client.subscribeCodeExtents((page) => renewed.push(page))
  await until(() => codeDone(f))
  assert.equal(renewed.flatMap((page) => page.records)[0].contentColumns, 12)
  stop()
  assert.ok(worker.replies.every((reply) => reply.type !== 'error'))
  assert.deepEqual(f.errors, [])
})
