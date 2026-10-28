import assert from 'node:assert/strict'
import test from 'node:test'
import { waitForProgress, workerBusyProgress } from './worker-progress.mjs'

function clock(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  return {
    setTimeout(callback, delay) {
      const timer = {
        id: setTimeout(callback, delay),
        refresh() {
          clearTimeout(this.id)
          this.id = setTimeout(callback, delay)
        },
      }
      return timer
    },
    clearTimeout(timer) {
      clearTimeout(timer.id)
    },
  }
}

test('completion can outlive many silence intervals while sequence numbers advance', async (t) => {
  const timers = clock(t)
  let sequence = 0,
    reply
  const pending = waitForProgress(
    () => reply,
    () => sequence,
    1000,
    undefined,
    { timers },
  )
  for (let n = 0; n < 8; n++) {
    t.mock.timers.tick(900)
    sequence++
    t.mock.timers.tick(5)
  }
  reply = { sequence, done: true }
  t.mock.timers.tick(5)
  assert.equal(await pending, reply)
})

test('reply subscriptions settle at the handshake and release their listener', async (t) => {
  const timers = clock(t)
  let reply,
    receive,
    detached = false
  const pending = waitForProgress(
    () => reply,
    () => 0,
    1000,
    undefined,
    {
      timers,
      subscribe: (check) => {
        receive = check
        return () => {
          detached = true
        }
      },
    },
  )
  reply = { sequence: 1 }
  receive()
  assert.equal(detached, true)
  assert.equal(await pending, reply)
  t.mock.timers.tick(2000)
})

test('synchronous worker activity keeps the guard alive and idle silence rejects', async (t) => {
  const timers = clock(t)
  let active = 0,
    reply
  const worker = { performance: { eventLoopUtilization: () => ({ active }) } }
  const pending = waitForProgress(
    () => reply,
    () => workerBusyProgress(worker),
    1000,
    undefined,
    { timers },
  )
  for (let n = 0; n < 8; n++) {
    t.mock.timers.tick(900)
    active += 100
    t.mock.timers.tick(5)
  }
  reply = { done: true }
  t.mock.timers.tick(5)
  assert.equal(await pending, reply)
  const idle = waitForProgress(
    () => false,
    () => workerBusyProgress(worker),
    1000,
    undefined,
    { timers },
  )
  const rejected = assert.rejects(idle, /Worker made no progress/)
  t.mock.timers.tick(1000)
  await rejected
})

test('a worker that never replies exhausts one silence interval', async (t) => {
  const timers = clock(t),
    pending = waitForProgress(
      () => false,
      () => 0,
      1000,
      'No worker reply',
      { timers },
    ),
    rejected = assert.rejects(pending, /No worker reply/)
  t.mock.timers.tick(1000)
  await rejected
})

test('progress followed by silence still rejects and predicate failures propagate', async (t) => {
  const timers = clock(t)
  let advances = 0
  const pending = waitForProgress(
      () => false,
      () => advances,
      1000,
      undefined,
      { timers },
    ),
    rejected = assert.rejects(pending, /Worker made no progress/)
  t.mock.timers.tick(900)
  advances++
  t.mock.timers.tick(5)
  t.mock.timers.tick(1000)
  await rejected
  const error = new Error('Invalid worker reply')
  await assert.rejects(
    waitForProgress(
      () => {
        throw error
      },
      () => 0,
      1000,
      undefined,
      { timers },
    ),
    (caught) => caught === error,
  )
})
