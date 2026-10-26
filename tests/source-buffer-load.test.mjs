import assert from 'node:assert/strict'
import test from 'node:test'
import { SourceStore } from '../src/shared/source-buffer.ts'

const document = { tabId: 'load', revision: 3 }

test('arena reads preserve every utf16 unit without expanding a javascript iterator', async () => {
  const { SourceChunk } = await import('../src/shared/source-metrics.ts')
  const text = Array.from({ length: 65536 }, (_, unit) =>
    String.fromCharCode(unit),
  ).join('')
  const arena = SourceChunk.appendable(text.length, () => {})
  arena.append(text)
  const prototype = Uint16Array.prototype
  const descriptor = Object.getOwnPropertyDescriptor(prototype, Symbol.iterator)
  const iterator = prototype[Symbol.iterator]
  let visits = 0
  Object.defineProperty(prototype, Symbol.iterator, {
    configurable: true,
    value: function* () {
      for (const unit of iterator.call(this)) {
        visits++
        yield unit
      }
    },
  })
  try {
    assert.equal(arena.chunk.slice(0, text.length), text)
    assert.equal(visits, 0)
  } finally {
    if (descriptor)
      Object.defineProperty(prototype, Symbol.iterator, descriptor)
    else delete prototype[Symbol.iterator]
  }
})
test('full arenas reuse exact raw text across repeated reads', async (t) => {
  const { SourceChunk } = await import('../src/shared/source-metrics.ts')
  const text = '\ufeff\r\n\ud800😀\udfff'.repeat(512)
  const arena = SourceChunk.appendable(text.length, () => {})
  const prefix = arena.append(text.slice(0, -1))
  assert.equal(arena.chunk.slice(prefix.from, prefix.to), text.slice(0, -1))
  arena.append(text.slice(-1))
  const copy = t.mock.method(String, 'fromCharCode')
  for (let read = 0; read < 3; read++) {
    assert.equal(arena.chunk.slice(0, text.length), text)
    assert.equal(arena.chunk.slice(prefix.from, prefix.to), text.slice(0, -1))
  }
  assert.equal(copy.mock.calls.length, 0)
})
test('async loading captures document identity and explicit limits before yielding', async () => {
  const key = { tabId: 'captured', revision: 1 }
  const options = { maximumBytes: 2 }
  const loading = SourceStore.load(['ok'], key, 7, options)
  key.tabId = 'changed'
  key.revision = 2
  options.maximumBytes = 0
  const store = await loading
  assert.deepEqual(store.snapshot().document, {
    tabId: 'captured',
    revision: 1,
  })
  assert.equal(store.snapshot().version, 7)
  assert.equal(store.snapshot().materialize(), 'ok')
})
test('cooperative loading yields message tasks without timer clamping', async (t) => {
  t.mock.method(globalThis, 'setTimeout', () => {
    throw new Error('load used a clamped timer')
  })
  const store = await SourceStore.load(['x'.repeat(3 * 65536)], document)
  assert.equal(store.snapshot().utf16Length, 3 * 65536)
  assert.equal(store.counters().loadAppends, 3)
})

const edit = (store, from, to, insert) =>
  store.commit(
    store.prepare({
      document: store.snapshot().document,
      operationId: `load-${store.snapshot().version}`,
      baseVersion: store.snapshot().version,
      contentVersion: store.snapshot().version + 1,
      origin: 'source',
      historyGroup: 'load',
      changes: [{ from, to, insert }],
    }),
  )
const rawEquals = (snapshot, expected) => {
  let offset = 0
  for (const chunk of snapshot.chunks()) {
    assert.equal(chunk, expected.slice(offset, offset + chunk.length))
    offset += chunk.length
  }
  assert.equal(offset, expected.length)
  assert.equal(snapshot.utf8Bytes, Buffer.byteLength(expected))
}
const encodedEquals = (snapshot, expected) => {
  const bytes = Buffer.from(expected)
  let offset = 0
  for (const chunk of snapshot.encodedChunks()) {
    assert.deepEqual(
      Buffer.from(chunk),
      bytes.subarray(offset, offset + chunk.length),
    )
    offset += chunk.length
  }
  assert.equal(offset, bytes.length)
}

test('default source store accepts and edits 50 mib without a content ceiling', () => {
  const source = 'a'.repeat(50 * 1024 * 1024)
  const store = new SourceStore(source, document)
  edit(store, 0, 1, '中')
  assert.equal(store.snapshot().utf8Bytes, source.length + 2)
  assert.equal(store.snapshot().sliceRaw(0, 4), '中aaa')
})

test('incremental loader preserves raw utf16 and coordinates across arbitrary seams', () => {
  const source = '\ufeffa\r\n😀\ud800z\udc00中\r\n\n\r👩🏽‍💻e\u0301'
  for (const options of [{}, { chunkUnits: 4, leafCapacity: 4, fanout: 4 }]) {
    const reference = new SourceStore(source, document, 7, options).snapshot()
    for (let seam = 0; seam <= source.length; seam++) {
      const identity = { ...document }
      const loader = SourceStore.loader(identity, 7, options)
      identity.revision++
      loader.append(source.slice(0, seam))
      loader.append('')
      loader.append(source.slice(seam))
      const store = loader.finish(),
        snapshot = store.snapshot()
      assert.deepEqual(snapshot.document, document)
      assert.equal(snapshot.version, 7)
      assert.equal(store.ownsCurrentSnapshot(snapshot), true)
      assert.equal(snapshot.materialize(), source)
      assert.deepEqual(snapshot.metrics, reference.metrics)
      encodedEquals(snapshot, source)
      assert.deepEqual(store.inspect().problems, [])
      for (let at = 0; at <= source.length; at++) {
        assert.equal(snapshot.rawToEditor(at), reference.rawToEditor(at))
        assert.equal(snapshot.rawToByte(at), reference.rawToByte(at))
        assert.equal(snapshot.isEditBoundary(at), reference.isEditBoundary(at))
      }
      for (let line = 1; line <= snapshot.lineCount; line++)
        assert.equal(snapshot.lineStart(line), reference.lineStart(line))
      assert.throws(() => loader.append('x'), /closed/)
      assert.throws(() => loader.finish(), /closed/)
    }
    const loader = SourceStore.loader(document, 7, options)
    for (let at = 0; at < source.length; at++) loader.append(source[at])
    assert.equal(loader.finish().snapshot().materialize(), source)
  }
})

test('incremental append and finish keep bounded work for 50 mib and nonascii 20 mib', () => {
  for (const [pattern, units] of [
    ['a', 50 * 1024 * 1024],
    ['中😀\r\n', 12 * 1024 * 1024],
  ]) {
    const source = `\ufeff${pattern.repeat(Math.ceil(units / pattern.length)).slice(0, units)}\ud800`
    assert.ok(
      Buffer.byteLength(source) >= (pattern === 'a' ? 50 : 20) * 1024 * 1024,
    )
    const loader = SourceStore.loader(document, 9)
    let appends = 0
    for (let at = 0; at < source.length; at += 65536) {
      loader.append(source.slice(at, at + 65536))
      appends++
    }
    const store = loader.finish(),
      before = store.snapshot(),
      counters = store.counters()
    assert.equal(counters.loadAppends, appends)
    assert.equal(counters.maxLoadInputUnits, 65536)
    assert.ok(counters.maxLoadUnitsScanned <= 67584, JSON.stringify(counters))
    assert.ok(counters.maxLoadTreeWork < 10000, JSON.stringify(counters))
    assert.ok(counters.unitsScanned <= source.length + appends * 2048)
    assert.equal(counters.compactionUnits, 0)
    assert.equal(counters.materializations, 0)
    assert.equal(counters.sourceUnitsRead, 0)
    assert.deepEqual(store.inspect().problems, [])
    rawEquals(before, source)
    encodedEquals(before, source)
    store.counters(true)
    edit(store, 1, 2, 'é')
    const edited = `${source.slice(0, 1)}é${source.slice(2)}`
    assert.equal(store.counters().materializations, 0)
    assert.ok(store.counters().unitsScanned < 2000)
    const after = store.snapshot()
    store.reidentify({ tabId: 'saved', revision: 4 })
    assert.equal(store.snapshot().sharesRoot(after), true)
    assert.equal(store.snapshot().version, 10)
    rawEquals(store.snapshot(), edited)
    encodedEquals(store.snapshot(), edited)
    rawEquals(before, source)
    assert.deepEqual(store.inspect().problems, [])
  }
})

test('loader rejects malformed or oversized chunks and retains explicit byte overrides', async () => {
  for (const chunk of [null, 1, {}, ['x'], 'x'.repeat(65537)]) {
    const loader = SourceStore.loader(document)
    loader.append('safe')
    assert.throws(() => loader.append(chunk), /chunks|chunk/)
    assert.throws(() => loader.finish(), /closed/)
  }
  for (const maximumBytes of [-1, NaN, Infinity, 1.5])
    assert.throws(
      () => SourceStore.loader(document, 0, { maximumBytes }),
      /configuration/,
    )
  for (const identity of [
    null,
    { tabId: '', revision: 0 },
    { tabId: 'x', revision: -1 },
  ])
    assert.throws(() => SourceStore.loader(identity), /identity/)
  const loader = SourceStore.loader(document, 0, { maximumBytes: 4 })
  loader.append('\ud83d')
  loader.append('\ude00')
  const store = loader.finish()
  assert.equal(store.snapshot().utf8Bytes, 4)
  assert.throws(() => edit(store, 2, 2, 'x'), /size limit/)
  assert.equal(store.snapshot().materialize(), '😀')
  const overflow = SourceStore.loader(document, 0, { maximumBytes: 4 })
  overflow.append('😀')
  assert.throws(() => overflow.append('x'), /size limit/)
  assert.throws(() => overflow.finish(), /closed/)
  assert.throws(
    () => new SourceStore('中中', document, 0, { maximumBytes: 4 }),
    /size limit/,
  )
  assert.equal(
    SourceStore.loader(document, 0, { maximumBytes: 0 }).finish().snapshot()
      .utf16Length,
    0,
  )
  await assert.rejects(SourceStore.load(['ok', null], document), /strings/)
  await assert.rejects(
    SourceStore.load(['x'], document, 0, { maximumBytes: 0 }),
    /size limit/,
  )
})

test('async load yields bounded slices for sync, async and fragmented iterables', async () => {
  const source = '\ufeff中😀\r\n'.repeat(40000)
  let yielded = false
  setTimeout(() => {
    yielded = true
  }, 0)
  const store = await SourceStore.load([source], document, 12)
  assert.equal(yielded, true)
  rawEquals(store.snapshot(), source)
  assert.equal(store.snapshot().version, 12)
  assert.ok(store.counters().maxLoadInputUnits <= 65536)
  const asyncStore = await SourceStore.load(
    (async function* () {
      yield '\ufeff\r'
      yield '\n\ud83d'
      yield '\ude00'
    })(),
    document,
  )
  assert.equal(asyncStore.snapshot().materialize(), '\ufeff\r\n😀')
  let read = 0,
    maxReads = 0,
    previous = 0,
    ticks = 0
  const tick = () => {
    maxReads = Math.max(maxReads, read - previous)
    previous = read
    ticks++
    task = setImmediate(tick)
  }
  let task = setImmediate(tick)
  try {
    const fragmented = await SourceStore.load(
      (function* () {
        for (; read < 256; read++) yield read % 2 ? 'x' : ''
      })(),
      document,
    )
    maxReads = Math.max(maxReads, read - previous)
    assert.ok(ticks > 0)
    assert.ok(maxReads <= 64, `reads per slice: ${maxReads}`)
    assert.equal(fragmented.snapshot().materialize(), 'x'.repeat(128))
  } finally {
    clearImmediate(task)
  }
  let closed = false
  await assert.rejects(
    SourceStore.load(
      (async function* () {
        try {
          yield 'ok'
          yield null
          assert.fail('must stop after invalid input')
        } finally {
          closed = true
        }
      })(),
      document,
    ),
    /strings/,
  )
  assert.equal(closed, true)
  assert.equal((await SourceStore.load([], document)).snapshot().utf16Length, 0)
})
