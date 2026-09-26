import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { DocumentRuntime } from '../src/renderer/src/document-runtime.ts'
import { createDocumentTargetEditScope } from '../src/renderer/src/document-target-edits.ts'

// Node-only target edit path; excludes addon IPC, editor views, disk and paint.
// Run alone with Node 24: node scripts/benchmark-target-edits.mjs --runs=1000
const runs = Number(
  process.argv.find((arg) => arg.startsWith('--runs='))?.slice(7) ?? 1000,
)
if (!Number.isSafeInteger(runs) || runs < 10 || runs > 10000)
  throw new Error('Use --runs=10..10000.')

const warmup = 200
const half = 'sample note line\n'.repeat(5000)
const source = `${half}a${half}`
const offset = half.length
const tabs = ['target', 'foreground'].map((id) => ({
  id,
  name: `${id}.md`,
  dirty: false,
}))
const document = (id, markdown, revision) => ({
  tabId: id,
  tabs,
  tabsEnabled: true,
  id: `file-${id}`,
  ephemeral: false,
  markdown,
  savedMarkdown: markdown,
  name: `${id}.md`,
  dirty: false,
  revision,
  contentVersion: 0,
  canAutosave: true,
})

let enqueued = 0
const runtime = new DocumentRuntime({
  enqueue: () => enqueued++,
  onError: (error) => {
    throw error
  },
})
const scope = createDocumentTargetEditScope(runtime, () => false)
try {
  runtime.activate(document('target', source, 1))
  let target = scope.listOpen()[0].target
  const session = runtime.session('target')
  runtime.activate(document('foreground', 'still active', 2))
  assert.equal(runtime.session(), runtime.session('foreground'))
  assert.equal(runtime.hasMountedView(target), false)

  const timings = []
  for (let index = 0; index < warmup + runs; index++) {
    if (index === warmup) {
      session.counters(true)
      enqueued = 0
    }
    const expectedText = index % 2 ? 'b' : 'a'
    const request = {
      requestId: `target-edit-${index}`,
      target,
      changes: [
        {
          from: offset,
          to: offset + 1,
          expectedText,
          insert: index % 2 ? 'a' : 'b',
        },
      ],
    }
    const start = performance.now()
    const result = scope.applyEdits(request)
    if (index >= warmup) timings.push(performance.now() - start)
    assert.equal(result.status, 'applied')
    assert.equal(result.contentVersion, index + 1)
    target = { ...target, contentVersion: result.contentVersion }
  }

  const counters = session.counters()
  assert.equal(counters.materializations, 0)
  assert.equal(enqueued, runs)
  assert.equal(session.snapshot().version, warmup + runs)
  assert.equal(
    session.snapshot().sliceRaw(offset, offset + 1),
    (warmup + runs) % 2 ? 'b' : 'a',
  )
  assert.equal(runtime.get().tabId, 'foreground')
  assert.equal(
    runtime.session('foreground').snapshot().sliceRaw(0, 12),
    'still active',
  )
  timings.sort((a, b) => a - b)
  const percentile = (fraction) =>
    timings[Math.ceil(timings.length * fraction) - 1]
  console.log(
    JSON.stringify(
      {
        commit: execFileSync('git', ['rev-parse', 'HEAD'], {
          encoding: 'utf8',
        }).trim(),
        node: process.version,
        scope:
          'Node DocumentTargetEditScope.applyEdits on an inactive unmounted tab; excludes addon IPC, editor views, disk and paint',
        sourceBytes: Buffer.byteLength(source),
        warmup,
        runs,
        milliseconds: {
          p50: percentile(0.5),
          p95: percentile(0.95),
          min: timings[0],
          max: timings.at(-1),
        },
        materializations: counters.materializations,
        enqueued,
        finalContentVersion: session.snapshot().version,
      },
      null,
      2,
    ),
  )
} finally {
  scope.dispose()
  runtime.dispose()
}
