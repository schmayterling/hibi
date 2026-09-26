import assert from 'node:assert/strict'
import test from 'node:test'
import { addonDefaultEnabled } from '../src/shared/addon-defaults.ts'
import { startupSpan } from '../src/shared/startup.ts'
import {
  initializationTimings,
  performanceDiagnostics,
} from '../src/ui/diagnostics.ts'

test('inspection addons default to development while core formats remain available', () => {
  assert.equal(addonDefaultEnabled('diagnostics', false, true), true)
  assert.equal(addonDefaultEnabled('diagnostics', true, false), false)
  assert.equal(addonDefaultEnabled('ui-preview', false, true), true)
  assert.equal(addonDefaultEnabled('ui-preview', true, false), false)
  assert.equal(addonDefaultEnabled('markdown', false, false), true)
  assert.equal(addonDefaultEnabled('vim', false, true), false)
})

test('startup spans retain results and failures with bounded per-addon history', async () => {
  assert.equal(
    await startupSpan(
      'addon:test',
      async () => {
        await startupSpan('addon-load:test', async () => {})
        await startupSpan('addon-start:test', async () => {})
        return 42
      },
      { addonName: 'Test addon' },
    ),
    42,
  )
  const successful = initializationTimings().find(
    (entry) => entry.id === 'test',
  )
  assert.ok(successful.load !== null && successful.start !== null)
  const error = new Error('startup failed')
  await assert.rejects(
    startupSpan(
      'addon:test',
      async () => {
        throw error
      },
      { addonName: 'Test addon' },
    ),
    (value) => value === error,
  )
  assert.equal(performance.getEntriesByName('hibi:addon:test').length, 1)
  const entry = initializationTimings().find((entry) => entry.id === 'test')
  assert.equal(entry.name, 'Test addon')
  assert.equal(entry.status, 'failed')
  assert.equal(entry.load, null)
  assert.equal(entry.start, null)
  let finish
  const oldAttempt = startupSpan(
    'addon:overlap',
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  await startupSpan('addon:overlap', async () => {}, { status: 'cancelled' })
  finish()
  await oldAttempt
  assert.equal(
    initializationTimings().find((entry) => entry.id === 'overlap').status,
    'cancelled',
  )
})

test('frame recording skips hidden-window gaps and removes its visibility listener', (t) => {
  const document = new EventTarget()
  document.hidden = false
  let nextFrame
  const oldRequestFrame = globalThis.requestAnimationFrame
  const oldCancelFrame = globalThis.cancelAnimationFrame
  globalThis.requestAnimationFrame = (callback) => {
    nextFrame = callback
    return 1
  }
  globalThis.cancelAnimationFrame = () => {}
  t.mock.method(document, 'removeEventListener')
  const oldDocument = globalThis.document
  globalThis.document = document
  const stop = performanceDiagnostics.start()
  try {
    performanceDiagnostics.clear()
    const now = performance.now() + 10
    nextFrame(now)
    document.hidden = true
    document.dispatchEvent(new Event('visibilitychange'))
    document.hidden = false
    document.dispatchEvent(new Event('visibilitychange'))
    nextFrame(now + 10000)
    nextFrame(now + 10100)
    stop()
    assert.equal(performanceDiagnostics.snapshot().frameGaps, 1)
    assert.equal(document.removeEventListener.mock.callCount(), 1)
  } finally {
    stop()
    globalThis.document = oldDocument
    globalThis.requestAnimationFrame = oldRequestFrame
    globalThis.cancelAnimationFrame = oldCancelFrame
  }
})

test('runtime capture is opt-in, bounded, and preserves callbacks and promise identity', async () => {
  performanceDiagnostics.clear()
  const measure = (run, operation = 'callback') =>
    performanceDiagnostics.measure('fixture', operation, run)
  assert.equal(
    measure(() => 7),
    7,
  )
  assert.equal(performanceDiagnostics.snapshot().activity.length, 0)
  const stop = performanceDiagnostics.start()
  try {
    assert.equal(
      measure(() => 9),
      9,
    )
    const error = new Error('callback failed')
    assert.throws(
      () =>
        measure(() => {
          throw error
        }),
      (value) => value === error,
    )
    const promise = Promise.resolve('done')
    assert.equal(
      measure(() => promise),
      promise,
    )
    await promise
    const failure = Promise.reject(error)
    assert.equal(
      measure(() => failure),
      failure,
    )
    await assert.rejects(failure, (value) => value === error)
    for (let i = 0; i < 400; i++) measure(() => i)
    stop()
    const activity = performanceDiagnostics.snapshot().activity
    assert.equal(activity.find((entry) => entry.kind === 'sync').count, 402)
    assert.equal(activity.find((entry) => entry.kind === 'sync').failures, 1)
    assert.equal(activity.find((entry) => entry.kind === 'async').failures, 1)
    const before = JSON.stringify(activity)
    measure(() => 'off')
    assert.equal(
      JSON.stringify(performanceDiagnostics.snapshot().activity),
      before,
    )
  } finally {
    stop()
  }
})

test('clear and stop discard pending async measurements and old cleanup cannot stop a new session', async () => {
  performanceDiagnostics.clear()
  let resolve
  const stop = performanceDiagnostics.start()
  const pending = new Promise((done) => {
    resolve = done
  })
  performanceDiagnostics.measure('fixture', 'late', () => pending)
  performanceDiagnostics.clear()
  resolve()
  await pending
  stop()
  assert.equal(performanceDiagnostics.snapshot().activity.length, 0)
  const stopNext = performanceDiagnostics.start()
  try {
    stop()
    assert.equal(performanceDiagnostics.snapshot().enabled, true)
    for (let i = 0; i < 200; i++)
      performanceDiagnostics.measure('fixture', `callback-${i}`, () => {})
    stopNext()
    assert.equal(performanceDiagnostics.snapshot().activity.length, 128)
  } finally {
    stopNext()
  }
})
