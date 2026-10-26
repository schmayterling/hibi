import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  editorBenchmarkPlan,
  editorFixture,
  operationPaint,
  requireFormattedEditor,
  statistics,
  summarizeEditors,
} from '../scripts/benchmark-editors.mjs'

test('editor matrix pairs both engines and reserves 50 mib for codemirror', () => {
  const plan = editorBenchmarkPlan(
    ['blank', '100kb', '575kb', '2mb', '50mib'],
    2,
  )
  assert.equal(plan.length, 18)
  for (const size of ['blank', '100kb', '575kb', '2mb']) {
    assert.deepEqual(
      plan.filter((row) => row.size === size).map((row) => row.engine),
      ['tiptap', 'codemirror', 'codemirror', 'tiptap'],
    )
  }
  assert.deepEqual(
    plan.filter((row) => row.size === '50mib').map((row) => row.engine),
    ['codemirror', 'codemirror'],
  )
})

test('fixtures retain exact audit prose and declared byte sizes', () => {
  const audit = editorFixture('575kb')
  assert.equal(audit.length, 574998)
  assert.equal(audit.split(/\s+/).length, 100000)
  assert.equal(
    createHash('sha256').update(audit).digest('hex'),
    'd80346db53025313ad804943a9fb8f5f36b96f99a106c8a3d3bb4fa49c8df3af',
  )
  for (const [size, bytes] of [
    ['blank', 0],
    ['100kb', 100000],
    ['2mb', 2000000],
    ['50mib', 50 * 1024 * 1024],
  ])
    assert.equal(Buffer.byteLength(editorFixture(size)), bytes)
  assert.throws(() => editorFixture('other'), /unknown fixture/)
})

test('statistics retain missing evidence and report median, p95 and spread', () => {
  assert.deepEqual(statistics([11, 1, null, 9, 3]), {
    n: 4,
    missing: 1,
    median: 6,
    p95: 11,
    min: 1,
    max: 11,
  })
  assert.deepEqual(statistics([null]), {
    n: 0,
    missing: 1,
    median: null,
    p95: null,
    min: null,
    max: null,
  })
})

const mark = (name, ts, pid = 1, tid = 2) => ({
  name,
  ts,
  pid,
  tid,
  cat: 'blink.user_timing',
  ph: 'I',
})

test('paint correlation uses matching renderer and bounds each operation', () => {
  const events = [
    mark('key-0:start', 1000),
    mark('key-0:ready', 2000),
    { name: 'Paint', ts: 1500, pid: 1, tid: 2 },
    { name: 'Paint', ts: 2100, pid: 9, tid: 2 },
    { name: 'Paint', ts: 2200, pid: 1, tid: 8 },
    { name: 'Paint', ts: 3500, pid: 1, tid: 2 },
    mark('key-0:end', 4000),
  ]
  assert.deepEqual(operationPaint(events, 'key-0'), {
    readyMs: 1,
    paintMs: 2.5,
    tracePaintUs: 3500,
  })
  assert.deepEqual(operationPaint(events, 'absent'), {
    readyMs: null,
    paintMs: null,
    tracePaintUs: null,
  })
  assert.equal(
    operationPaint(
      events.filter((row) => row.ts !== 3500),
      'key-0',
    ).paintMs,
    null,
  )
  assert.equal(
    operationPaint(
      [
        ...events.filter((row) => row.ts !== 3500),
        { name: 'Paint', ts: 4500, pid: 1, tid: 2 },
      ],
      'key-0',
    ).paintMs,
    null,
  )
})

test('formatted checks reject source fallback, read-only input and wrong engine', () => {
  const ready = { mode: 'normal', engine: 'codemirror', editable: true }
  requireFormattedEditor('codemirror', ready)
  for (const state of [
    { ...ready, mode: 'markdown' },
    { ...ready, editable: false },
    { ...ready, engine: 'tiptap' },
  ])
    assert.throws(
      () => requireFormattedEditor('codemirror', state),
      /formatted editor required.*large-note/,
    )
})

test('summaries weight launches equally and never turn unavailable paint into zero', () => {
  const base = {
    size: 'blank',
    engine: 'tiptap',
    open: { paintMs: null },
    find: { first: { paintMs: 5 }, next: { paintMs: 6 } },
    scroll: { frames: [] },
  }
  const rows = summarizeEditors([
    {
      ...base,
      keys: [
        { taskMs: 1, paintMs: 10 },
        { taskMs: 3, paintMs: 20 },
      ],
    },
    { ...base, keys: [{ taskMs: 10, paintMs: null }] },
  ])
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0].keyPaintCoverage, { observed: 2, total: 3 })
  assert.equal(rows[0].metrics.keyTaskMedianMs.median, 6)
  assert.equal(rows[0].metrics.keyPaintMedianMs.median, 15)
  assert.equal(rows[0].metrics.keyPaintMedianMs.missing, 1)
  assert.equal(rows[0].metrics.openPaintMs.median, null)
  assert.equal(rows[0].metrics.scrollP95Ms.median, null)
})
