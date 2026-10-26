import assert from 'node:assert/strict'
import test from 'node:test'
import { createScanCoordinator } from '../src/main/workspace-refresh.ts'

const turn = () => new Promise((resolve) => setImmediate(resolve))

test('steady requests release each request within two scan completions', async (t) => {
  const scans = []
  const published = []
  const settled = []
  let active = 0
  let maximumActive = 0
  const coordinator = createScanCoordinator(
    async (signal) => {
      active++
      maximumActive = Math.max(maximumActive, active)
      try {
        return await new Promise((resolve) => scans.push({ signal, resolve }))
      } finally {
        active--
      }
    },
    (value) => published.push(value),
  )
  t.after(() => coordinator.close())
  const request = (index) =>
    coordinator.request().then((value) => {
      settled[index] = value
    })
  const requests = [request(0)]
  for (let scan = 0; scan < 8; scan++) {
    // These callers arrived after the current scan started: only its successor qualifies.
    requests.push(request(scan + 1))
    requests.push(request(scan + 1))
    for (let event = 0; event < 128; event++) requests.push(request(scan + 1))
    assert.equal(scans.length, scan + 1)
    scans[scan].resolve(scan)
    await turn()
    assert.equal(
      settled[scan],
      scan,
      `request ${scan} must finish with its own scan`,
    )
    assert.equal(settled[scan + 1], undefined)
    assert.deepEqual(
      published,
      Array.from({ length: scan + 1 }, (_, i) => i),
    )
    assert.equal(scans[scan].signal.aborted, false)
    assert.equal(scans.length, scan + 2, 'events coalesce into one follow-up')
  }
  scans[8].resolve(8)
  await Promise.all(requests)
  await turn()
  assert.equal(settled[8], 8)
  assert.equal(scans.length, 9, 'no scan after the last clean completion')
  assert.equal(maximumActive, 1)
})

test('idle requests start fresh scans', async () => {
  let scans = 0
  const coordinator = createScanCoordinator(
    async () => ++scans,
    () => {},
  )
  assert.equal(scans, 0)
  assert.equal(await coordinator.request(), 1)
  await turn()
  assert.equal(await coordinator.request(), 2)
  coordinator.close()
})

test('failed scans reject their own cohort without discarding queued callers', async () => {
  const scans = []
  const published = []
  const coordinator = createScanCoordinator(
    (signal) =>
      new Promise((resolve, reject) => scans.push({ signal, resolve, reject })),
    (value) => published.push(value),
  )
  const error = new Error('scan failed')
  const failed = assert.rejects(coordinator.request(), error)
  const next = coordinator.request()
  scans[0].reject(error)
  await failed
  assert.equal(scans[1].signal.aborted, false)
  scans[1].resolve('recovered')
  assert.equal(await next, 'recovered')
  assert.deepEqual(published, ['recovered'])
  coordinator.close()
})

test('queued request cohorts still receive scan failures', async () => {
  const scans = []
  const coordinator = createScanCoordinator(
    () => new Promise((resolve, reject) => scans.push({ resolve, reject })),
    () => {},
  )
  const first = coordinator.request()
  const error = new Error('follow-up failed')
  const failed = assert.rejects(coordinator.request(), error)
  scans[0].resolve('first')
  assert.equal(await first, 'first')
  scans[1].reject(error)
  await failed
  coordinator.close()
})

test('root replacement retires old results and queued callers', async () => {
  const scans = []
  const published = []
  const old = createScanCoordinator(
    (signal) => new Promise((resolve) => scans.push({ signal, resolve })),
    (value) => published.push(value),
  )
  const current = old.request()
  const queued = old.request()
  old.close()
  const replacement = createScanCoordinator(
    async () => 'new root',
    (value) => published.push(value),
  )
  assert.equal(scans[0].signal.aborted, true)
  assert.equal(await queued, null)
  assert.equal(await replacement.request(), 'new root')
  scans[0].resolve('old root')
  assert.equal(await current, null)
  assert.deepEqual(published, ['new root'])
  assert.equal(scans.length, 1)
  replacement.close()
})

test('closing an abort-aware scan settles active and queued requests', async () => {
  const published = []
  const coordinator = createScanCoordinator(
    (signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        })
      }),
    (value) => published.push(value),
  )
  const current = coordinator.request()
  const queued = coordinator.request()
  coordinator.close()
  assert.deepEqual(await Promise.all([current, queued]), [null, null])
  assert.deepEqual(published, [])
})
