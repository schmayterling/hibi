import assert from 'node:assert/strict'
import test from 'node:test'
import { SourceStore } from '../src/shared/source-buffer.ts'
import {
  combineMetrics,
  emptyMetrics,
  SourceChunk,
} from '../src/shared/source-metrics.ts'
import {
  mapSourcePosition,
  parseSourceOperation,
} from '../src/shared/source-operations.ts'

const key = { tabId: 'test', revision: 0 }
const operation = (store, changes, origin = 'source') => ({
  document: key,
  operationId: `op-${store.snapshot().version + 1}`,
  baseVersion: store.snapshot().version,
  contentVersion: store.snapshot().version + 1,
  origin,
  historyGroup: 'test',
  changes,
})
const apply = (store, changes, origin) => {
  const prepared = store.prepare(operation(store, changes, origin))
  store.commit(prepared)
  return prepared
}
function oracle(source) {
  const normalized = source.replace(/\r\n?/g, '\n')
  return {
    rawUnits: source.length,
    normalizedUnits: normalized.length,
    utf8Bytes: Buffer.byteLength(source),
    breaks: normalized.split('\n').length - 1,
    nonWhitespaceUnits: source.replace(/\s/g, '').length,
    firstUnit: source.length ? source.charCodeAt(0) : -1,
    lastUnit: source.length ? source.charCodeAt(source.length - 1) : -1,
  }
}
function randomSource(random, count = 20) {
  const alphabet = [
    'a',
    'é',
    '中',
    '😀',
    '\r\n',
    '\r',
    '\n',
    '\uFEFF',
    ' \t\u00a0\u2028\u3000',
    'e\u0301',
    '👩🏽‍💻',
  ]
  return Array.from(
    { length: random(count) },
    () => alphabet[random(alphabet.length)],
  ).join('')
}
function generator(seed) {
  return (maximum) => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return (seed >>> 0) % maximum
  }
}
function checkSnapshot(snapshot, source) {
  assert.equal(snapshot.materialize(), source)
  assert.deepEqual(snapshot.metrics, oracle(source))
  assert.deepEqual(
    Buffer.concat([...snapshot.encodedChunks()]),
    Buffer.from(source),
  )
  assert.equal(snapshot.lineCount, source.split(/\r\n|\r|\n/).length)
  let offset = 0,
    line = 1
  assert.equal(snapshot.lineStart(1), 0)
  for (const match of source.matchAll(/\r\n|\r|\n/g)) {
    offset = match.index + match[0].length
    assert.equal(snapshot.lineStart(++line), offset)
  }
  for (let at = 0; at <= source.length; at++) {
    assert.equal(snapshot.isWhitespace(at), !/\S/.test(source.slice(at)))
    const crlf = source.slice(at - 1, at + 1) === '\r\n'
    const paired =
      /[\uD800-\uDBFF]/.test(source.charAt(at - 1)) &&
      /[\uDC00-\uDFFF]/.test(source.charAt(at))
    const expected = crlf
      ? null
      : source.slice(0, at).replace(/\r\n?/g, '\n').length
    assert.equal(snapshot.rawToEditor(at), expected)
    if (expected !== null) assert.equal(snapshot.editorToRaw(expected), at)
    assert.equal(
      snapshot.rawToByte(at),
      paired ? null : Buffer.byteLength(source.slice(0, at)),
    )
    if (!paired)
      assert.equal(
        snapshot.byteToRaw(Buffer.byteLength(source.slice(0, at))),
        at,
      )
  }
}

test('ENG02/ENG03/ENG04: chunk metrics and coordinates compose across every seam', () => {
  const random = generator(0x1841)
  for (let iteration = 0; iteration < 1000; iteration++) {
    const source = randomSource(random)
    const a = random(source.length + 1),
      b = a + random(source.length - a + 1)
    const chunk = new SourceChunk(source, () => {})
    assert.deepEqual(chunk.metrics(0, source.length), oracle(source))
    const left = chunk.metrics(0, a),
      middle = chunk.metrics(a, b),
      right = chunk.metrics(b, source.length)
    assert.deepEqual(
      combineMetrics(combineMetrics(left, middle), right),
      oracle(source),
    )
    assert.deepEqual(
      combineMetrics(left, combineMetrics(middle, right)),
      oracle(source),
    )
    assert.deepEqual(combineMetrics(emptyMetrics, left), left)
    const store = new SourceStore(source, key, 0, {
      chunkUnits: 4,
      leafCapacity: 4,
      fanout: 4,
    })
    checkSnapshot(store.snapshot(), source)
  }
})

test('ENG01/ENG05/ENG23: persistent B+ edits, deletion rebalance and compaction match an oracle', () => {
  for (const [fanout, leafCapacity, chunkUnits] of [
    [4, 4, 4],
    [4, 8, 8],
    [16, 32, 4096],
    [32, 64, 16384],
    [64, 128, 65536],
  ]) {
    const random = generator(0xa714)
    let source = randomSource(random, 200)
    const store = new SourceStore(source, key, 0, {
      fanout,
      leafCapacity,
      chunkUnits,
    })
    const retained = []
    for (let iteration = 0; iteration < 800; iteration++) {
      const before = store.snapshot()
      const legal = Array.from(
        { length: source.length + 1 },
        (_, n) => n,
      ).filter((n) => before.isEditBoundary(n))
      const a = random(legal.length),
        b = a + random(legal.length - a)
      const from = legal[a],
        to = legal[b],
        insert = randomSource(random, 12)
      if (source.slice(from, to) === insert) continue
      if (iteration % 80 === 0) retained.push([before, source])
      const prepared = apply(store, [{ from, to, insert }])
      const previous = source
      source = source.slice(0, from) + insert + source.slice(to)
      assert.equal(store.snapshot().materialize(), source)
      assert.equal(prepared.before.materialize(), previous)
      assert.deepEqual(store.snapshot().metrics, oracle(source))
      assert.deepEqual(
        store.inspect().problems,
        [],
        `${fanout}/${leafCapacity}/${chunkUnits}, edit ${iteration}`,
      )
      if (iteration % 37 === 0) {
        apply(store, prepared.inverse, 'undo')
        assert.equal(store.snapshot().materialize(), previous)
        apply(store, [{ from, to, insert }], 'redo')
      }
      if (iteration % 50 === 0) {
        const version = store.snapshot().version
        store.compact()
        assert.equal(store.snapshot().version, version)
        assert.equal(store.snapshot().materialize(), source)
        assert.deepEqual(store.inspect().problems, [])
      }
    }
    for (const [snapshot, original] of retained)
      checkSnapshot(snapshot, original)
  }
})

test('S03/ENG06/ENG10: operation validation and preparation reject stale, forged and partial commits', () => {
  const store = new SourceStore('a😀\r\nxyz', key)
  const original = store.snapshot()
  const good = operation(store, [{ from: 0, to: 1, insert: 'b' }])
  for (const changes of [
    [
      { from: 0, to: 1, insert: 'b' },
      { from: 999, to: 1000, insert: 'q' },
    ],
    [{ from: 2, to: 2, insert: 'x' }],
    [{ from: 4, to: 4, insert: 'x' }],
    [{ from: 0, to: 0, insert: '\ud800' }],
    [
      { from: 0, to: 1, insert: 'x' },
      { from: 0, to: 0, insert: 'y' },
    ],
    [{ from: 2 ** 32 + 7, to: 2 ** 32 + 8, insert: 'x' }],
  ]) {
    assert.throws(() => store.prepare({ ...good, changes }))
    assert.equal(store.snapshot(), original)
  }
  assert.throws(() =>
    parseSourceOperation({
      ...good,
      baseVersion: Number.MAX_SAFE_INTEGER,
      contentVersion: Number.MAX_SAFE_INTEGER + 1,
    }),
  )
  const prepared = store.prepare(good),
    stale = store.prepare(good)
  assert.notEqual(prepared.after.rootId, stale.after.rootId)
  assert.throws(() => store.commit({ ...prepared }))
  store.commit(prepared)
  assert.throws(() => store.commit(prepared))
  assert.throws(() => store.commit(stale))
  assert.equal(original.materialize(), 'a😀\r\nxyz')
  const aborted = store.prepare(
    operation(store, [{ from: 0, to: 0, insert: 'x' }]),
  )
  assert.ok(aborted.after.rootId > stale.after.rootId)
  store.abort(aborted)
  assert.throws(() => store.commit(aborted))
  const input = operation(store, [{ from: 0, to: 1, insert: 'q' }])
  const copied = store.prepare(input)
  input.changes[0].insert = 'corrupt'
  assert.equal(store.commit(copied).materialize(), 'q😀\r\nxyz')
})

test('S03/ENG20: multi-range operations invert atomically with monotonic versions', () => {
  const store = new SourceStore('abcdefghi', key)
  const edit = apply(store, [
    { from: 1, to: 3, insert: '' },
    { from: 3, to: 4, insert: '' },
    { from: 6, to: 7, insert: '🌱' },
  ])
  assert.equal(store.snapshot().materialize(), 'aef🌱hi')
  apply(store, edit.inverse, 'undo')
  assert.equal(store.snapshot().materialize(), 'abcdefghi')
  assert.equal(store.snapshot().version, 2)
  assert.equal(mapSourcePosition(9, edit.operation.changes), 7)
})

test('inverse operations restore newly formed CRLF seams without splitting their post-state', () => {
  for (const [source, changes] of [
    ['\rX\n', [{ from: 1, to: 2, insert: '' }]],
    ['\n', [{ from: 0, to: 0, insert: '\r' }]],
    ['\r', [{ from: 1, to: 1, insert: '\n' }]],
    [
      '\rX\n\rY\n',
      [
        { from: 1, to: 2, insert: '' },
        { from: 4, to: 5, insert: '' },
      ],
    ],
  ]) {
    const store = new SourceStore(source, key)
    const edit = apply(store, changes)
    apply(store, edit.inverse, 'undo')
    assert.equal(store.snapshot().materialize(), source)
  }
})

test('tree fragmentation and bulk deletion retain balanced height and old snapshots', () => {
  const store = new SourceStore('abcdefgh'.repeat(2000), key, 0, {
    fanout: 4,
    leafCapacity: 4,
    chunkUnits: 16,
  })
  const retained = [],
    random = generator(772)
  let source = store.snapshot().materialize()
  for (let iteration = 0; iteration < 1200; iteration++) {
    const position = random(source.length + 1)
    if (iteration % 120 === 0) retained.push([store.snapshot(), source])
    apply(store, [{ from: position, to: position, insert: 'Z' }])
    source = source.slice(0, position) + 'Z' + source.slice(position)
    assert.deepEqual(store.inspect().problems, [], `insertion ${iteration}`)
  }
  for (let iteration = 0; iteration < 120 && source.length > 1; iteration++) {
    const from = random(source.length),
      to = from + 1 + random(source.length - from)
    apply(store, [{ from, to, insert: '' }])
    source = source.slice(0, from) + source.slice(to)
    assert.equal(store.snapshot().materialize(), source)
    assert.deepEqual(store.inspect().problems, [], `deletion ${iteration}`)
  }
  for (const [snapshot, previous] of retained)
    assert.equal(snapshot.materialize(), previous)
})

test('ENG05/ENG07: append-only arenas preserve published extents and sparse prefix seams', () => {
  for (const first of ['a'.repeat(31) + '\r', 'a'.repeat(31) + '\ud83d']) {
    const arena = SourceChunk.appendable(64, () => {})
    const original = arena.append(first)
    const metrics = arena.chunk.metrics(original.from, original.to)
    const next = first.endsWith('\r') ? '\nsecond' : '\ude00second'
    arena.append(next)
    assert.equal(arena.chunk.slice(original.from, original.to), first)
    assert.deepEqual(arena.chunk.metrics(original.from, original.to), metrics)
    assert.deepEqual(
      arena.chunk.metrics(0, first.length + next.length),
      new SourceChunk(first + next, () => {}).metrics(
        0,
        first.length + next.length,
      ),
    )
    assert.equal(Object.isFrozen(original), true)
    assert.equal(
      Object.values(arena.chunk).some((value) => ArrayBuffer.isView(value)),
      false,
    )
    assert.throws(() => arena.append('x'.repeat(65)), /capacity/)
    assert.equal(arena.chunk.slice(0, original.to), first)
  }
})

test('ENG07/ENG23: typing coalesces arena ranges while aborted preparations and compaction preserve history roots', () => {
  const store = new SourceStore('left|right', key)
  const retained = []
  store.counters(true)
  for (let index = 0; index < 2000; index++) {
    if (index % 100 === 0)
      retained.push([store.snapshot(), `left${'x'.repeat(index)}|right`])
    apply(store, [{ from: 4 + index, to: 4 + index, insert: 'x' }])
  }
  assert.equal(store.inspect().pieceCount, 3)
  assert.equal(store.counters().arenaWrittenUnits, 2000)
  assert.equal(store.counters().arenaAllocatedUnits, 4096)
  assert.equal(store.counters().materializations, 0)
  const aborted = store.prepare(
    operation(store, [{ from: 0, to: 0, insert: 'unused' }]),
  )
  const abortedSource = aborted.after.materialize()
  store.abort(aborted)
  apply(store, [{ from: 0, to: 0, insert: 'kept' }])
  const beforeCompact = store.snapshot()
  store.compact()
  apply(store, [{ from: 0, to: 0, insert: 'later' }])
  assert.equal(aborted.after.materialize(), abortedSource)
  assert.equal(beforeCompact.materialize(), `keptleft${'x'.repeat(2000)}|right`)
  for (const [snapshot, text] of retained)
    assert.equal(snapshot.materialize(), text)
  assert.deepEqual(store.inspect().problems, [])
})

test('ENG24: one prefix edit visits bounded tree paths without source materialization', () => {
  const source = 'a paragraph with words and unicode 中 😀.\r\n'.repeat(100_000)
  const store = new SourceStore(source, key, 0, {
    maximumBytes: 32 * 1024 * 1024,
  })
  const old = store.snapshot()
  store.counters(true)
  apply(store, [{ from: 0, to: 0, insert: 'x' }])
  const counters = store.counters()
  assert.equal(counters.materializations, 0)
  assert.ok(counters.unitsScanned < 2000, JSON.stringify(counters))
  assert.ok(counters.nodeVisits < 200, JSON.stringify(counters))
  assert.ok(counters.metricSlotsCopied < 1000, JSON.stringify(counters))
  assert.equal(store.snapshot().utf16Length, old.utf16Length + 1)
  assert.deepEqual(store.inspect().problems, [])
  assert.equal(old.sliceRaw(0, 20), source.slice(0, 20))
})

test('an edit at every line of a megabyte rebuilds the tree once, and so does its undo', () => {
  const lines = 16384
  const source = Array.from({ length: lines }, (_, n) =>
    `${n}`.padEnd(63, 'x'),
  ).join('\n')
  const store = new SourceStore(source, key)
  let scanned = 0
  const copied = () => {
    const counters = store.counters(true)
    scanned = counters.unitsScanned
    return counters.pieceDescriptorsCopied + counters.metricSlotsCopied
  }
  copied()
  const indent = apply(
    store,
    Array.from({ length: lines }, (_, n) => ({
      from: n * 64,
      to: n * 64,
      insert: '\t',
    })),
  )
  // An edit at a time copied about 7 million pieces and metric slots.
  assert.ok(copied() < 4 * lines)
  // Each one-unit tab piece read two stride prefixes, 32 units a line.
  assert.ok(scanned < 3 * lines, `${scanned} units scanned`)
  assert.equal(store.snapshot().materialize(), source.replace(/^/gm, '\t'))
  apply(store, indent.inverse, 'undo')
  assert.ok(copied() < 4 * lines)
  assert.equal(store.snapshot().materialize(), source)
  assert.deepEqual(store.inspect().problems, [])
  // ASCII text needs no reads to find edit boundaries, but CRLF still has one.
  assert.equal(
    new SourceStore('a\r\nb', key).snapshot().isEditBoundary(2),
    false,
  )
})

test('multi-range operations match an oracle in every tree shape', () => {
  for (const [fanout, leafCapacity, chunkUnits] of [
    [4, 4, 4],
    [4, 8, 8],
    [16, 32, 4096],
  ]) {
    const random = generator(0x7ab1)
    let source = randomSource(random, 200)
    const store = new SourceStore(source, key, 0, {
      fanout,
      leafCapacity,
      chunkUnits,
    })
    for (let iteration = 0; iteration < 300; iteration++) {
      const before = store.snapshot()
      const legal = Array.from(
        { length: source.length + 1 },
        (_, n) => n,
      ).filter((n) => before.isEditBoundary(n))
      const ends = [
        ...new Set(
          Array.from(
            { length: 2 + random(40) },
            () => legal[random(legal.length)],
          ),
        ),
      ].sort((a, b) => a - b)
      const changes = []
      for (let index = 0; index + 1 < ends.length; index += 2)
        changes.push({
          from: ends[index],
          to: random(3) ? ends[index + 1] : ends[index],
          insert: randomSource(random, 4),
        })
      if (
        changes.every(
          ({ from, to, insert }) => source.slice(from, to) === insert,
        )
      )
        continue
      const previous = source
      for (const { from, to, insert } of changes.toReversed())
        source = source.slice(0, from) + insert + source.slice(to)
      const prepared = apply(store, changes)
      const where = `${fanout}/${leafCapacity}/${chunkUnits}, edit ${iteration}`
      assert.equal(store.snapshot().materialize(), source, where)
      assert.deepEqual(store.snapshot().metrics, oracle(source), where)
      assert.deepEqual(store.inspect().problems, [], where)
      if (iteration % 7 === 0) {
        apply(store, prepared.inverse, 'undo')
        assert.equal(store.snapshot().materialize(), previous, where)
        apply(store, changes, 'redo')
        assert.equal(store.snapshot().materialize(), source, where)
      }
    }
    checkSnapshot(store.snapshot(), source)
  }
})

test('exact equality skips shared regions and survives different piece partitions', () => {
  const source = 'abcdefgh\n'.repeat(100_000)
  const store = new SourceStore(source, key)
  const original = store.snapshot()
  const run = (iterator) => {
    let result
    do {
      result = iterator.next()
    } while (!result.done)
    return result.value
  }
  assert.equal(
    run(
      new SourceStore('', key)
        .snapshot()
        .compare(new SourceStore('', key).snapshot()),
    ),
    true,
  )
  assert.throws(
    () =>
      run(
        original.compare({
          utf16Length: source.length,
          utf8Bytes: original.utf8Bytes,
        }),
      ),
    /snapshot/,
  )
  apply(store, [
    { from: source.length - 2, to: source.length - 1, insert: 'X' },
  ])
  store.counters(true)
  assert.equal(run(store.snapshot().compare(original)), false)
  assert.ok(store.counters().sourceUnitsRead < 100)
  apply(store, [
    { from: source.length - 2, to: source.length - 1, insert: 'h' },
  ])
  store.counters(true)
  assert.equal(run(store.snapshot().compare(original)), true)
  assert.ok(store.counters().sourceUnitsRead < 100)
  assert.equal(store.counters().materializations, 0)
  store.compact()
  assert.equal(run(store.snapshot().compare(original)), true)
  const prepared = store.prepare(
    operation(store, [{ from: 0, to: 0, insert: 'x' }]),
  )
  const before = store.snapshot()
  store.reidentify({ tabId: 'test', revision: 1 })
  assert.equal(store.snapshot().version, before.version)
  assert.equal(store.snapshot().sharesRoot(before), true)
  assert.throws(() => store.commit(prepared), /stale/)
})
