import assert from 'node:assert/strict'
import test from 'node:test'
import { wrapWithRootFrameSync } from '@codspeed/core'
import { AsyncBench } from '../../bench/desktop/async-bench.mjs'

test('desktop benchmark registration does not run CodSpeed callbacks before profile setup', async () => {
  const bench = new AsyncBench({
    time: 0,
    iterations: 1,
    warmup: false,
    throws: true,
  })
  const phases = []
  let profile
  bench.add(
    'startup',
    wrapWithRootFrameSync(async () => {
      assert.equal(profile, 'isolated-profile')
      phases.push('run')
    }),
    {
      beforeEach() {
        profile = 'isolated-profile'
        phases.push('setup')
      },
      afterEach() {
        profile = undefined
        phases.push('cleanup')
      },
    },
  )
  assert.deepEqual(phases, [])
  await bench.run()
  assert.deepEqual(phases, ['setup', 'run', 'cleanup'])
  assert.equal(profile, undefined)
})

test('desktop benchmarks retain asynchronous failures', async () => {
  const bench = new AsyncBench({
    time: 0,
    iterations: 1,
    warmup: false,
    throws: true,
  })
  const failure = new Error('readiness failed')
  let calls = 0
  bench.add(
    'failure',
    wrapWithRootFrameSync(async () => {
      calls++
      throw failure
    }),
  )
  assert.equal(calls, 0)
  await assert.rejects(bench.run(), (error) => error === failure)
  assert.equal(calls, 1)
})
