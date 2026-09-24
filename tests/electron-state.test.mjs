import assert from 'node:assert/strict'
import test from 'node:test'
import { waitForAppState } from './electron.mjs'

test('app state waits for resolved ipc result', async () => {
  let reads = 0
  await waitForAppState({ evaluate: async () => ++reads === 2 }, () => {})
  assert.equal(reads, 2)
})
