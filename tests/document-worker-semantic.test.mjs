import assert from 'node:assert/strict'
import test from 'node:test'
import { DocumentWorkerClient } from '../src/renderer/src/document-worker-client.ts'
import { DocumentSession } from '../src/shared/document-session.ts'
import { DocumentWorkerService } from '../src/shared/document-worker-service.ts'
import { MarkdownSemanticCache } from '../src/shared/markdown-semantic-cache.ts'
import { loadWorker } from './document-worker-transfer.mjs'

const syntax = { gfm: true, alerts: true, textExtras: true }
const wait = async (predicate) => {
  const end = Date.now() + 4000
  while (!predicate()) {
    if (Date.now() > end) throw new Error('Missing semantic worker reply')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}
function fixture(t, initial) {
  const messages = []
  let source = initial,
    version = 0,
    id = 0
  const worker = new DocumentWorkerService((reply) =>
    messages.push(structuredClone(reply)),
  )
  t.after(() => worker.dispose())
  const load = (body = source) => {
    source = body
    version = 0
    loadWorker(worker, messages, source, 'semantic')
  }
  const send = (extra = {}) => {
    const request = {
      type: 'metadata',
      epoch: 'semantic',
      id: ++id,
      version,
      dialect: 'gfm',
      semantic: syntax,
      from: 0,
      to: source.length,
      limit: 256,
      ...extra,
    }
    worker.receive(request)
    return request.id
  }
  const result = async (requestId) => {
    const match = () =>
      messages.find(
        (reply) =>
          reply.id === requestId && ['metadata', 'error'].includes(reply.type),
      )
    await wait(match)
    return match()
  }
  const request = (extra) => result(send(extra))
  const edit = (from, to, insert) => {
    worker.receive({
      type: 'edit',
      epoch: 'semantic',
      operation: {
        document: { tabId: 'a', revision: 0 },
        operationId: `semantic-${version}`,
        baseVersion: version,
        contentVersion: ++version,
        origin: 'source',
        historyGroup: 'typing',
        changes: [{ from, to, insert }],
      },
    })
    source = source.slice(0, from) + insert + source.slice(to)
  }
  load()
  return { worker, messages, load, send, request, result, edit }
}

test('semantic metadata carries bounded cloneable regions, advancing over trivia and merged blocks', async (t) => {
  const source =
    '[first]: /first\n[second]: /second\n\n[ref]\n\n[ref]: /target\n\nlast\n'
  const f = fixture(t, source),
    rows = []
  let from = 0
  for (;;) {
    const reply = await f.request({ from, limit: 1 })
    assert.equal(reply.type, 'metadata')
    assert.equal(reply.semantic.status, 'available')
    assert.ok(reply.semantic.bytes <= 512 * 1024)
    assert.ok(
      Buffer.byteLength(JSON.stringify(reply.semantic)) <= reply.semantic.bytes,
    )
    rows.push(...reply.semantic.rows)
    if (reply.semantic.next === null) break
    assert.ok(reply.semantic.next > from)
    from = reply.semantic.next
  }
  assert.equal(rows.length, 4)
  assert.deepEqual(
    rows[0].tokens.map((token) => token.type),
    ['def', 'def', 'space'],
  )
  assert.equal(rows[1].tokens[0].tokens[0].href, '/target')
  assert.ok(rows[0].endIndex > 0)
  assert.equal(new Set(rows.map((row) => row.slot)).size, rows.length)
  for (const row of rows)
    assert.deepEqual(Object.keys(row).sort(), [
      'contentFrom',
      'endIndex',
      'from',
      'nonSpace',
      'revision',
      'slot',
      'to',
      'tokens',
    ])
  f.load('---\nname: hibi\n---\n\n# body\n')
  const opaque = (await f.request({ frontmatter: true })).semantic
  assert.equal(opaque.rows.length, 1)
  assert.equal(opaque.rows[0].tokens[0].text, 'body')
  const whitespace = ' \n\n\t\n'
  f.load(whitespace)
  const blank = (await f.request()).semantic.rows
  assert.equal(blank.length, 1)
  assert.equal(blank[0].from, 0)
  assert.equal(blank[0].to, whitespace.length)
  assert.equal(blank[0].nonSpace, false)
  assert.deepEqual(blank[0].tokens, [{ type: 'space', raw: whitespace }])
  const header = '---\nname: hibi\n---\n'
  f.load(header + whitespace)
  assert.deepEqual((await f.request({ frontmatter: true })).semantic.rows, [])
  f.load(header + '\n\n\t')
  const trailing = (await f.request({ frontmatter: true })).semantic.rows
  assert.equal(trailing.length, 1)
  assert.equal(trailing[0].from, header.length + 2)
  assert.equal(trailing[0].to, header.length + 3)
  assert.equal(trailing[0].nonSpace, false)
  assert.deepEqual(trailing[0].tokens, [{ type: 'space', raw: '\t' }])
  f.load('')
  const empty = (await f.request()).semantic
  assert.deepEqual(empty.rows, [])
  assert.equal(empty.next, null)
})

test('semantic requests reject malformed or contradictory grammar and expose markup unavailability', async (t) => {
  const f = fixture(t, '[ref]: /target\n\n[ref]')
  for (const semantic of [
    null,
    {},
    { ...syntax, gfm: false },
    { ...syntax, alerts: 1 },
  ])
    assert.equal((await f.request({ semantic })).stage, 'metadata')
  assert.equal(
    (
      await f.request({
        reference: { ...syntax, label: 'ref', textExtras: false },
      })
    ).stage,
    'metadata',
  )
  const valid = await f.request({ reference: { ...syntax, label: 'ref' } })
  assert.equal(valid.reference.href, '/target')
  assert.equal(valid.semantic.status, 'available')
  f.load('<div>\n[ref]: /hidden\n</div>\n\n[ref]')
  assert.deepEqual((await f.request()).semantic, {
    status: 'unavailable',
    reason: 'syntax-context',
  })
})

test('semantic ranges include containing lazy groups and indentation without repeating paginated regions', async (t) => {
  const source = '# start\n\n> [ref]: /quote\nplain text\n\n  # tail\n\nlast\n',
    f = fixture(t, source),
    full = (await f.request()).semantic.rows,
    quote = full.find((row) => row.tokens[0]?.type === 'blockquote'),
    tail = full.find((row) => row.tokens[0]?.text === 'tail'),
    lazy = source.indexOf('plain') + 2,
    gap = source.indexOf('\n\n  # tail') + 1,
    indent = source.indexOf('  # tail') + 1
  for (const [from, to, expected] of [
    [lazy, lazy + 1, quote],
    [lazy, lazy, quote],
    [gap, gap + 1, quote],
    [indent, indent + 1, tail],
    [quote.to, quote.to, tail],
  ]) {
    const result = (await f.request({ from, to, limit: 1 })).semantic
    assert.deepEqual(result.rows, [expected])
    assert.equal(result.next, null)
  }
  const pages = []
  let from = lazy
  for (;;) {
    const result = (await f.request({ from, limit: 1 })).semantic
    assert.equal(result.rows.length, 1)
    pages.push(...result.rows)
    if (result.next === null) break
    assert.equal(result.next, result.rows[0].to)
    assert.ok(result.next > from)
    from = result.next
  }
  assert.deepEqual(pages, full.slice(1))
  assert.equal(new Set(pages.map((row) => row.slot)).size, pages.length)
  assert.deepEqual(
    (await f.request({ from: source.length, to: source.length })).semantic.rows,
    [],
  )
})

test('semantic cache reuses lexical payloads, rebinds prefix positions and resets on configuration, release and reload', async (t) => {
  const read = MarkdownSemanticCache.prototype.read,
    caches = []
  t.mock.method(MarkdownSemanticCache.prototype, 'read', function (...args) {
    if (!caches.includes(this)) caches.push(this)
    return read.apply(this, args)
  })
  const source =
      '# first\n\nparagraph\n\n# distant\n\n[ref]\n\n[ref]: /target\n',
    f = fixture(t, source),
    first = (await f.request()).semantic,
    cache = caches[0],
    reads = cache.counters().reads
  await f.request()
  assert.equal(cache.counters().reads, reads)
  assert.ok(cache.counters().hits > 0)
  const distant = first.rows.find((row) => row.tokens[0]?.text === 'distant')
  f.edit(0, 0, 'prefix\n\n')
  const after = (await f.request()).semantic.rows.find(
    (row) => row.slot === distant.slot,
  )
  assert.equal(caches.length, 1)
  assert.equal(after.from, distant.from + 8)
  assert.equal(after.revision, distant.revision)
  assert.deepEqual(after.tokens, distant.tokens)
  const changed = await f.request({
    semantic: { ...syntax, textExtras: false },
  })
  assert.equal(caches.length, 2)
  assert.equal(cache.counters().entries, 0)
  f.worker.receive({
    type: 'cancel-metadata',
    epoch: 'semantic',
    id: changed.id,
    release: true,
  })
  assert.equal(caches[1].counters().entries, 0)
  await f.request()
  assert.equal(caches.length, 3)
  await f.request({
    dialect: 'commonmark',
    semantic: { ...syntax, gfm: false },
  })
  assert.equal(caches.length, 4)
  assert.equal(caches[2].counters().entries, 0)
  f.load()
  assert.equal(caches[3].counters().entries, 0)
  await f.request()
  assert.equal(caches.length, 5)
})

test('semantic transport caps region counts and payload size without truncating tokens', async (t) => {
  const f = fixture(t, '# region\n\n'.repeat(80)),
    first = (await f.request()).semantic
  assert.equal(first.rows.length, 32)
  assert.ok(first.next > 0)
  const next = (await f.request({ from: first.next })).semantic
  assert.equal(next.rows.length, 32)
  assert.equal(next.rows[0].slot === first.rows.at(-1).slot, false)
  f.load(`${'word '.repeat(8000)}\n\n`.repeat(5))
  const bounded = (await f.request()).semantic
  assert.equal(bounded.status, 'available')
  assert.ok(bounded.rows.length > 0 && bounded.rows.length < 5)
  assert.ok(bounded.bytes <= 512 * 1024)
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= bounded.bytes)
  f.load('界'.repeat(100000))
  const oversized = (await f.request()).semantic
  assert.equal(oversized.status, 'unavailable')
  assert.equal(oversized.reason, 'too-large')
  assert.equal(typeof oversized.slot, 'number')
  assert.equal(oversized.rows, undefined)
})

test('semantic cancellation yields between rows and never publishes partial packets', async (t) => {
  const f = fixture(t, '# heading\n\n'.repeat(50)),
    read = MarkdownSemanticCache.prototype.read
  let canceled = false
  t.mock.method(MarkdownSemanticCache.prototype, 'read', function (...args) {
    const result = read.apply(this, args)
    if (!canceled) {
      canceled = true
      setTimeout(
        () =>
          f.worker.receive({
            type: 'cancel-metadata',
            epoch: 'semantic',
            id: 1,
            release: false,
          }),
        0,
      )
    }
    const end = performance.now() + 1
    while (performance.now() < end) {}
    return result
  })
  f.send()
  await wait(() =>
    f.messages.some((reply) => reply.type === 'metadata-canceled'),
  )
  assert.equal(
    f.messages.some((reply) => reply.type === 'metadata'),
    false,
  )
  assert.equal((await f.request()).semantic.rows.length, 32)
  assert.equal(
    f.messages.some((reply) => reply.type === 'metadata' && reply.id === 1),
    false,
  )
})

test('containing-region backward probes yield and cancel before lexical work', async (t) => {
  const source = '[ref]: /target\n'.repeat(80),
    f = fixture(t, source),
    read = MarkdownSemanticCache.prototype.read
  let cancel = true,
    probes = 0,
    reads = 0,
    cache
  t.mock.method(MarkdownSemanticCache.prototype, 'read', function (...args) {
    cache = this
    reads++
    return read.apply(this, args)
  })
  await f.request({ from: 0, to: 0, limit: 1 })
  reads = 0
  const region = cache.region
  t.mock.method(cache, 'region', function (...args) {
    probes++
    if (cancel) {
      cancel = false
      setTimeout(
        () =>
          f.worker.receive({
            type: 'cancel-metadata',
            epoch: 'semantic',
            id: 2,
            release: false,
          }),
        0,
      )
    }
    const end = performance.now() + 1
    while (performance.now() < end) {}
    return region.apply(this, args)
  })
  const range = { from: source.length - 5, to: source.length - 4, limit: 1 }
  f.send(range)
  await wait(() =>
    f.messages.some((reply) => reply.type === 'metadata-canceled'),
  )
  assert.ok(probes > 0 && probes < 10)
  assert.equal(reads, 0)
  const result = (await f.request(range)).semantic
  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0].from, 0)
  assert.equal(result.rows[0].to, source.length)
  assert.equal(result.next, null)
  assert.ok(probes >= 80)
  assert.equal(reads, 1)
  assert.equal(
    f.messages.some((reply) => reply.type === 'metadata' && reply.id === 2),
    false,
  )
})

test('client forwards semantic syntax and discards stale epoch, request and source versions', async (t) => {
  const sent = [],
    results = [],
    session = new DocumentSession('# first', { tabId: 'a', revision: 0 }, 0, {
      enqueue: () => {},
      onError: (error) => {
        throw error
      },
    }),
    worker = {
      onmessage: null,
      onerror: null,
      onmessageerror: null,
      terminate: () => {},
      postMessage(message) {
        sent.push(message)
        if (message.type === 'load-start' || message.type === 'load-chunk')
          setImmediate(() =>
            worker.onmessage({
              data: {
                type: 'load-ack',
                epoch: message.epoch,
                request:
                  message.type === 'load-start'
                    ? { streamId: message.head.streamId, sequence: 0 }
                    : {
                        streamId: message.chunk.streamId,
                        sequence: message.chunk.sequence + 1,
                      },
              },
            }),
          )
        else if (message.type === 'load-finish' || message.type === 'edit')
          setImmediate(() =>
            worker.onmessage({
              data: {
                type: 'ack',
                epoch: message.epoch,
                version:
                  message.type === 'edit'
                    ? message.operation.contentVersion
                    : 0,
              },
            }),
          )
      },
    },
    client = new DocumentWorkerClient(session, {
      worker: () => worker,
      changed: () => {},
      pending: () => {},
      result: () => {},
      error: (message) => assert.fail(message),
      metadataResult: (page, reference, semantic) =>
        results.push({ page, reference, semantic }),
    })
  t.after(() => {
    client.dispose()
    session.dispose()
  })
  client.metadata('gfm', 0, 7, 32, false, undefined, syntax)
  await wait(() => sent.some((message) => message.type === 'metadata'))
  const request = sent.at(-1),
    semantic = { status: 'available', rows: [], next: null, bytes: 128 },
    reply = {
      type: 'metadata',
      epoch: request.epoch,
      version: request.version,
      id: request.id,
      page: {
        version: 0,
        dialect: 'gfm',
        epoch: 'owners',
        complete: true,
        rows: [],
        next: null,
      },
      semantic,
    }
  assert.deepEqual(request.semantic, syntax)
  worker.onmessage({ data: { ...reply, epoch: 'old' } })
  worker.onmessage({ data: { ...reply, id: request.id + 1 } })
  worker.onmessage({ data: { ...reply, version: 1 } })
  assert.equal(results.length, 0)
  worker.onmessage({ data: reply })
  assert.deepEqual(results[0].semantic, semantic)
  session.edit([{ from: 7, to: 7, insert: '!' }], 'source', 'typing')
  client.metadata('gfm', 0, 8, 32, false, undefined, syntax)
  await wait(
    () => sent.filter((message) => message.type === 'metadata').length === 2,
  )
  worker.onmessage({ data: reply })
  assert.equal(results.length, 1)
  const current = sent.at(-1)
  worker.onmessage({ data: { ...reply, id: current.id, version: 0 } })
  assert.equal(results.length, 1)
  worker.onmessage({ data: { ...reply, id: current.id, version: 1 } })
  assert.equal(results.length, 2)
  client.releaseMetadata()
  worker.onmessage({ data: { ...reply, id: current.id, version: 1 } })
  assert.equal(results.length, 2)
})
