import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { setImmediate } from 'node:timers/promises'
import { CompletionBroker } from '../src/renderer/src/completion-broker.ts'

// Node broker latency only: no renderer, popup, IPC, or paint.
// Run alone with Node 24: node scripts/benchmark-completion-broker.mjs --runs=200
const runs = Number(
  process.argv.find((arg) => arg.startsWith('--runs='))?.slice(7) ?? 200,
)
if (!Number.isSafeInteger(runs) || runs < 20 || runs > 1000)
  throw new Error('Use --runs=20..1000.')

const warmup = 20
const captured = {
  view: {
    documentId: 'document-one',
    documentGeneration: 1,
    viewId: 'view-one',
    viewGeneration: 1,
  },
  contentVersion: 3,
  editor: 'source',
  documentLength: 6,
  selection: { anchor: 3, head: 3 },
  before: 'abc',
  after: 'def',
  trigger: { kind: 'explicit' },
}
const item = (label, rank) => ({
  label,
  insertText: label,
  from: 0,
  to: 3,
  rank,
})
const percentile = (sorted, fraction) =>
  sorted[Math.ceil(sorted.length * fraction) - 1]
const summary = (samples) => {
  const sorted = samples.toSorted((a, b) => a - b)
  return {
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    minMs: sorted[0],
    maxMs: sorted.at(-1),
  }
}

async function measure(name, asynchronous) {
  const broker = new CompletionBroker()
  const firstItem = item('first', 2)
  const secondItem = item('second', 1)
  broker.register({ addonId: `${name}-first`, activationGeneration: 1 }, () =>
    asynchronous ? setImmediate().then(() => [firstItem]) : [firstItem],
  )
  broker.register(
    { addonId: `${name}-second`, activationGeneration: 1 },
    asynchronous
      ? async () => {
          await setImmediate()
          await setImmediate()
          return [secondItem]
        }
      : () => [secondItem],
  )
  const first = []
  const done = []
  try {
    for (let run = -warmup; run < runs; run++) {
      const start = performance.now()
      let firstResult = null
      const final = await new Promise((resolve) => {
        const cancel = broker.request(
          () => captured,
          () => captured,
          (update) => {
            const elapsed = performance.now() - start
            if (firstResult === null && update.items.length)
              firstResult = elapsed
            if (update.done) resolve({ update, elapsed })
          },
        )
        assert.ok(cancel, 'provider request was rejected')
      })
      assert.deepEqual(
        final.update.items.map(({ label }) => label),
        ['first', 'second'],
      )
      assert.ok(firstResult !== null && firstResult <= final.elapsed)
      if (run >= 0) {
        first.push(firstResult)
        done.push(final.elapsed)
      }
    }
  } finally {
    broker.dispose()
  }
  return {
    scenario: name,
    providers: asynchronous
      ? 'two providers; first yields one event-loop turn, second yields two'
      : 'two immediately returning providers',
    requestToFirstResult: summary(first),
    requestToDone: summary(done),
  }
}

const scenarios = [await measure('sync', false), await measure('async', true)]
console.log(
  JSON.stringify(
    {
      scope:
        'Node CompletionBroker request, provider scheduling, validation, merge, and callback; excludes renderer, popup, IPC, and paint',
      node: process.version,
      platform: process.platform,
      warmupRequests: warmup,
      measuredRequests: runs,
      scenarios,
    },
    null,
    2,
  ),
)
