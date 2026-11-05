import assert from 'node:assert/strict'
import test from 'node:test'
import { waitForAsync } from './poll.mjs'

test('async polling awaits false results and retries until true with the same argument', async () => {
  let calls = 0
  const arg = { readyAfter: 2 }
  const page = {
    evaluate: (predicate, value) => {
      assert.equal(value, arg)
      return predicate(value)
    },
  }
  await waitForAsync(
    page,
    async ({ readyAfter }) => {
      await Promise.resolve()
      return ++calls === readyAfter
    },
    arg,
    { polling: 1 },
  )
  assert.equal(calls, 2)
})

test('async polling times out pending evaluations without polling after a late result', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let release
  let calls = 0
  const page = {
    evaluate: () => {
      calls++
      return new Promise((resolve) => {
        release = resolve
      })
    },
  }
  const pending = waitForAsync(page, async () => false, undefined, {
    timeout: 10,
    polling: 1,
  })
  const rejected = assert.rejects(
    pending,
    /async condition did not settle.*1 checks/,
  )
  t.mock.timers.tick(10)
  await rejected
  release(false)
  await Promise.resolve()
  t.mock.timers.tick(100)
  await Promise.resolve()
  assert.equal(calls, 1)
})

test('async polling checks the deadline before retrying after an event loop stall', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let now = 0
  t.mock.method(performance, 'now', () => now)
  let calls = 0
  const pending = waitForAsync(
    { evaluate: async () => ++calls > 1 },
    async () => true,
    undefined,
    { timeout: 25, polling: 5 },
  )
  const rejected = assert.rejects(pending, /async condition did not settle/)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls, 1)
  now = 60
  t.mock.timers.tick(5)
  await rejected
  assert.equal(calls, 1)
})

test('async polling rejects a successful result that arrives after its deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let now = 0
  t.mock.method(performance, 'now', () => now)
  await assert.rejects(
    waitForAsync(
      {
        evaluate: async () => {
          now = 60
          return true
        },
      },
      async () => true,
      undefined,
      { timeout: 25 },
    ),
    /async condition did not settle/,
  )
})

test('async polling rejects exhausted budgets and preserves evaluation errors', async () => {
  await assert.rejects(
    waitForAsync(
      { evaluate: async () => false },
      async () => false,
      undefined,
      { timeout: 0, polling: 1 },
    ),
    /async condition did not settle.*0 checks/,
  )
  const error = new Error('page closed')
  await assert.rejects(
    waitForAsync(
      {
        evaluate: async () => {
          throw error
        },
      },
      async () => true,
    ),
    (result) => result === error,
  )
})
