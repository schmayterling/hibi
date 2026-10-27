import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  captureEditorSample,
  editorBenchmarkPlan,
  editorFixture,
  ensureFormattedEditor,
  minimumKeysForP95,
  operationPaint,
  pairEditors,
  requireFormattedEditor,
  scrollFrames,
  scrollSeries,
  settle,
  statistics,
  summarizeEditors,
} from '../scripts/benchmark-editors.mjs'

test('editor matrix pairs both engines and reserves 50 mib for codemirror', () => {
  const plan = editorBenchmarkPlan(
    ['blank', '100kb', '575kb', '2mb', '50mib'],
    2,
    ['prose'],
  )
  assert.equal(plan.length, 18)
  const mixed = editorBenchmarkPlan(['blank', '100kb'], 2)
  assert.equal(mixed.length, 12)
  assert.equal(mixed.filter((row) => row.fixture === 'mixed').length, 4)
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

test('matrix rejects unbalanced run counts', () => {
  for (const runs of [0, 1, 3, 2.5])
    assert.throws(() => editorBenchmarkPlan(['blank'], runs), /even/)
})

test('mixed fixture exercises formatting without changing declared size', () => {
  const source = editorFixture('100kb', 'mixed')
  assert.equal(Buffer.byteLength(source), 100000)
  for (const syntax of [
    '# Heading',
    '**bold**',
    '*italic*',
    '[link](https://example.com/)',
    '- first item',
    '```js',
    '| name | value |',
    '$x^2$',
  ])
    assert.ok(source.includes(syntax), `missing mixed syntax: ${syntax}`)
})

test('mixed readiness requires a rendered element', () => {
  assert.throws(
    () =>
      requireFormattedEditor(
        'codemirror',
        {
          mode: 'normal',
          engine: 'codemirror',
          editable: true,
          formatted: false,
        },
        true,
      ),
    /formatted element/,
  )
})

test('fixtures retain exact trace-input-paint prose and declared byte sizes', () => {
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

test('summaries pool measured keys and retain missing paints and launch spread', () => {
  const base = {
    size: 'blank',
    fixture: 'prose',
    engine: 'tiptap',
    status: 'complete',
    open: { readyMs: 4, paintMs: null, method: 'open' },
    find: { first: { paintMs: 5 }, next: { paintMs: 6 } },
    scroll: { frames: [], mainThreadPerFrameMs: null },
  }
  const rows = summarizeEditors([
    {
      ...base,
      keys: Array.from({ length: 20 }, (_, i) => ({
        taskMs: i === 19 ? 100 : 1,
        readyMs: 0.5,
        paintMs: 10,
      })),
      scroll: { frames: [16.7, 16.7], mainThreadPerFrameMs: 6 },
    },
    {
      ...base,
      keys: Array.from({ length: 20 }, () => ({
        taskMs: 2,
        readyMs: 1,
        paintMs: null,
      })),
      scroll: { frames: [16.7, 16.7], mainThreadPerFrameMs: 4 },
    },
    { ...base, status: 'failed', error: 'unavailable' },
  ])
  assert.equal(rows.length, 1)
  const row = rows[0]
  assert.equal(row.runs, 2)
  assert.equal(row.failed, 1)
  assert.deepEqual(row.keyPaintCoverage, { observed: 20, total: 40 })
  assert.equal(row.metrics.keyTaskMs.n, 40)
  assert.equal(row.metrics.keyTaskMs.median, 2)
  assert.equal(
    row.metrics.keyTaskMs.p95,
    2,
    'p95 must pool keys, not launch maxima',
  )
  assert.equal(row.metrics.keyReadyMs.median, 0.75)
  assert.equal(row.metrics.keyPaintMs.median, 10)
  assert.equal(row.metrics.keyPaintMs.missing, 20)
  assert.equal(row.metrics.openReadyMs.median, 4)
  assert.equal(row.metrics.openPaintMs.median, null)
  assert.equal(row.metrics.scrollMainThreadPerFrameMs.median, 5)
  assert.equal(row.metrics.scrollP95Ms.median, 16.7)

  assert.equal(row.keyIndexMedians.taskMs.length, 20)
  assert.equal(row.keyIndexMedians.taskMs[0], 1.5)
  assert.equal(row.keyIndexMedians.taskMs[19], 51)

  const failed = summarizeEditors([{ ...base, status: 'failed' }])[0]
  assert.equal(failed.runs, 0)
  assert.equal(failed.failed, 1)
  assert.equal(failed.metrics.keyTaskMs.median, null)
})

const launch = (engine, run, values = {}) => ({
  size: '100kb',
  fixture: 'prose',
  engine,
  run,
  status: 'complete',
  open: { readyMs: values.open ?? 10, paintMs: null, method: 'open' },
  keys: (values.keys ?? [1, 1, 1]).map((readyMs) => ({
    taskMs: readyMs * 2,
    readyMs,
    paintMs: null,
  })),
  find: { first: { paintMs: 5 }, next: { paintMs: 5 } },
  scroll: {
    frames: [16.7],
    first: { mainThreadPerFrameMs: values.first ?? 4 },
    mainThreadPerFrameMs: values.scroll ?? 2,
  },
})

test('a key paint p95 needs enough observed paints in each launch', () => {
  const sample = launch('tiptap', 0, { keys: Array(20).fill(1) })
  sample.keys[0].paintMs = 9
  const [row] = summarizeEditors([sample])
  assert.equal(row.metrics.keyPaintMs.n, 1)
  assert.equal(row.metrics.keyPaintMs.median, 9)
  assert.equal(row.metrics.keyPaintMs.p95, null)
  assert.equal(row.metrics.keyReadyMs.p95, 1)
})

test('short key series report per-index medians but no p95', () => {
  const [row] = summarizeEditors([
    launch('tiptap', 0, { keys: [9, 6, 5, 5] }),
    launch('tiptap', 1, { keys: [7, 4, 5, 5] }),
  ])
  assert.ok(minimumKeysForP95 >= 20)
  assert.equal(row.metrics.keyReadyMs.p95, null)
  assert.equal(row.metrics.keyTaskMs.p95, null)
  assert.equal(row.metrics.keyReadyMs.max, 9)
  assert.deepEqual(row.keyIndexMedians.readyMs, [8, 5, 5, 5])
})

test('paired center is reciprocal under balanced engine observations', () => {
  const samples = [
    launch('tiptap', 0, { open: 1 }),
    launch('codemirror', 0, { open: 10 }),
    launch('codemirror', 1, { open: 1 }),
    launch('tiptap', 1, { open: 10 }),
  ]
  const forward = pairEditors(samples)[0].ratios.openReadyMs
  const reverse = pairEditors(
    samples.map((sample) => ({
      ...sample,
      engine: sample.engine === 'tiptap' ? 'codemirror' : 'tiptap',
    })),
  )[0].ratios.openReadyMs
  assert.equal(forward.n, 2)
  assert.deepEqual([forward.min, forward.max], [0.1, 10])
  assert.ok(Math.abs(forward.median - 1) < 1e-12)
  assert.ok(Math.abs(forward.median * reverse.median - 1) < 1e-12)
})

test('pairs compare codemirror with tiptap within each run, so load drift cancels', () => {
  // The second pair ran ten times slower; each launch is still compared with its partner.
  const pairs = pairEditors([
    launch('tiptap', 0, { open: 100, keys: [2, 2, 2], scroll: 1, first: 2 }),
    launch('codemirror', 0, { open: 50, keys: [1, 1, 1], scroll: 3, first: 8 }),
    launch('codemirror', 1, {
      open: 500,
      keys: [10, 10, 10],
      scroll: 30,
      first: 80,
    }),
    launch('tiptap', 1, {
      open: 1000,
      keys: [20, 20, 20],
      scroll: 10,
      first: 20,
    }),
    launch('codemirror', 2),
    { ...launch('tiptap', 2), status: 'failed' },
  ])
  assert.equal(pairs.length, 1)
  const [row] = pairs
  assert.equal(row.pairs, 2)
  assert.deepEqual(
    [row.ratios.openReadyMs.median, row.ratios.openReadyMs.min],
    [0.5, 0.5],
  )
  assert.equal(row.ratios.keyReadyMs.median, 0.5)
  assert.equal(row.ratios.keyTaskMs.median, 0.5)
  assert.ok(Math.abs(row.ratios.scrollMainThreadPerFrameMs.median - 3) < 1e-12)
  assert.ok(Math.abs(row.ratios.scrollFirstPerFrameMs.median - 4) < 1e-12)
  assert.equal(row.ratios.openPaintMs.n, 0)
  assert.equal(row.ratios.openPaintMs.missing, 2)
})

/** A page and cdp session whose renderer task time grows by the scripted milliseconds per metrics read. */
function fakeRenderer(taskMs) {
  const log = []
  let total = 1000
  const page = {
    async evaluate(_work, argument) {
      if (!argument?.label) {
        log.push('wait')
        return
      }
      log.push(argument.label)
      return {
        requestedPx: 3600,
        distancePx: 3600,
        actualPx: 3600,
        frames: Array(argument.frameCount).fill(16.7),
      }
    },
  }
  const session = {
    async send(method) {
      assert.equal(method, 'Performance.getMetrics')
      total += taskMs.shift() ?? 0
      log.push('metrics')
      return {
        metrics: [
          'TaskDuration',
          'ScriptDuration',
          'LayoutDuration',
          'RecalcStyleDuration',
        ].map((name) => ({ name, value: total / 1000 })),
      }
    },
  }
  return { page, session, log }
}

test('settling waits for two quiet windows after background work', async () => {
  const { page, session, log } = fakeRenderer([0, 5, 0.2, 3, 0.4, 0.3])
  const result = await settle(page, session)
  assert.equal(result.settled, true)
  assert.equal(log.filter((entry) => entry === 'wait').length, 5)
})

test('unsettled traversals retain raw passes without comparison metrics', async () => {
  const originalNow = performance.now
  let ticks = 0
  performance.now = () => ++ticks * 1000
  try {
    const { page, session } = fakeRenderer(Array(80).fill(5))
    const scroll = await scrollSeries(page, session, 2, 3)
    assert.equal(scroll.first.settled, false)
    assert.ok(scroll.passes.every((pass) => pass.settled === false))
    assert.equal(scroll.first.frames.length, 2)
    assert.equal(scroll.passes.length, 3)
    assert.equal(scroll.frames.length, 0)
    assert.equal(scroll.mainThreadPerFrameMs, null)
    assert.equal(scroll.first.mainThreadPerFrameMs, null)
    const sample = { ...launch('tiptap', 0), scroll }
    assert.equal(summarizeEditors([sample])[0].metrics.scrollMedianMs.n, 0)
    assert.equal(
      pairEditors([sample, { ...launch('codemirror', 0), scroll }])[0].ratios
        .scrollMainThreadPerFrameMs.n,
      0,
    )
  } finally {
    performance.now = originalNow
  }
})

test('scroll series keeps the first traversal apart from settled repeat passes', async () => {
  // Per pass: three quiet settle reads, then the task time before and after scrolling.
  const pass = (scrollMs) => [0, 0.2, 0.2, 0, scrollMs]
  const { page, session, log } = fakeRenderer([
    ...pass(8),
    ...pass(2),
    ...pass(6),
    ...pass(4),
  ])
  const scroll = await scrollSeries(page, session, 2, 3)
  assert.deepEqual(
    log.filter((entry) => entry.startsWith('scroll')),
    ['scroll-first', 'scroll-0', 'scroll-1', 'scroll-2'],
  )
  assert.ok(Math.abs(scroll.first.mainThreadPerFrameMs - 4) < 1e-8)
  assert.deepEqual(
    scroll.passes.map((pass) => Math.round(pass.mainThreadPerFrameMs)),
    [1, 3, 2],
  )
  assert.equal(Math.round(scroll.mainThreadPerFrameMs), 2)
  assert.equal(scroll.frames.length, 6)
  assert.equal(Math.round(scroll.taskMs), 12)
  assert.ok(scroll.passes.every((pass) => pass.settled))
})

test('source-first tiptap requests formatted view, then measures from initial open', async () => {
  let switches = 0
  const source = { mode: 'markdown', editable: false }
  const opened = await ensureFormattedEditor(
    'tiptap',
    source,
    async () => {
      switches++
      return {
        mode: 'normal',
        engine: 'tiptap',
        editable: true,
        formatted: true,
      }
    },
    true,
  )
  assert.equal(switches, 1)
  assert.equal(opened.path, 'source-first')
  assert.equal(opened.method, 'open+switch')
  assert.equal(opened.afterSwitch.editable, true)
  const events = [
    mark('open:start', 1000),
    mark('switch:start', 8000),
    mark('switch:ready', 10000),
    { name: 'Paint', ts: 11000, pid: 1, tid: 2 },
    mark('switch:end', 12000),
  ]
  assert.equal(operationPaint(events, 'switch', 'open').readyMs, 9)
  assert.equal(operationPaint(events, 'switch', 'open').paintMs, 10)
  assert.equal(operationPaint(events, 'switch').paintMs, 3)
  await ensureFormattedEditor(
    'codemirror',
    { mode: 'normal', engine: 'codemirror', editable: true },
    () => assert.fail('formatted open must not switch'),
  )
})

test('source-first read-only preview is unavailable, not editable readiness', async () => {
  const preview = {
    mode: 'side-by-side',
    engine: 'tiptap',
    editable: false,
    preview: true,
    sourceReady: true,
    modelLength: 2,
  }
  const open = await ensureFormattedEditor(
    'tiptap',
    { mode: 'markdown' },
    async () => preview,
  )
  assert.equal(open.method, 'n/a')
  assert.equal(open.path, 'source-first')
  assert.equal(open.afterSwitch, preview)
  assert.match(open.unavailable, /read-only preview/)
  const sample = await captureEditorSample({}, async () => ({
    status: 'unavailable',
    open,
  }))
  assert.equal(sample.status, 'unavailable')
  const row = summarizeEditors([sample])[0]
  assert.equal(row.runs, 0)
  assert.equal(row.failed, 0)
  assert.equal(row.unavailable, 1)
  assert.equal(row.metrics.openReadyMs.n, 0)
  assert.equal(row.metrics.keyTaskMs.n, 0)
})

test('source-first codemirror and other sample failures do not abort later sizes', async () => {
  const samples = []
  const plan = editorBenchmarkPlan(['575kb', '2mb'], 2, ['prose'])
  for (const row of plan) {
    samples.push(
      await captureEditorSample(row, async () => {
        if (row.run === 0 && row.engine === 'tiptap')
          throw new Error('probe failed')
        const open = await ensureFormattedEditor(
          row.engine,
          { mode: 'markdown' },
          async () => ({ mode: 'normal', engine: 'tiptap', editable: true }),
        )
        return { open, status: open.unavailable ? 'unavailable' : 'complete' }
      }),
    )
  }
  assert.equal(samples.length, 8)
  assert.equal(samples.filter((sample) => sample.status === 'failed').length, 2)
  assert.equal(
    samples.filter((sample) => sample.status === 'unavailable').length,
    4,
  )
  assert.equal(samples.at(-1).size, '2mb')
  assert.equal(samples.at(-1).status, 'complete')
  assert.equal(samples.at(-1).open.path, 'source-first')
  for (const sample of samples) {
    assert.equal(sample.loadAverage.length, 3)
    assert.ok(sample.loadAverage.every(Number.isFinite))
    assert.ok(sample.startedAt)
    if (sample.engine === 'codemirror')
      assert.match(sample.open.unavailable, /codemirror source-first.*#450/)
  }
})

test('scroll reports task milliseconds per frame, excluding reset and settle work', async () => {
  const { page, session, log } = fakeRenderer([0, 0.3, 0.3, 0.2, 72])
  const scroll = await scrollFrames(page, session, 12)
  assert.deepEqual(log, [
    'wait',
    'metrics',
    'wait',
    'metrics',
    'wait',
    'metrics',
    'metrics',
    'scroll',
    'metrics',
  ])
  assert.ok(Math.abs(scroll.taskMs - 72) < 1e-8)
  assert.ok(Math.abs(scroll.mainThreadPerFrameMs - 6) < 1e-8)
  assert.equal(scroll.frames.length, 12)
  assert.equal(scroll.settled, true)

  const fitting = await scrollFrames(
    {
      async evaluate() {
        return { frames: [], reason: 'document fits viewport' }
      },
    },
    fakeRenderer([]).session,
    12,
  )
  assert.equal(fitting.mainThreadPerFrameMs, null)
  assert.equal(fitting.taskMs, null)
})
