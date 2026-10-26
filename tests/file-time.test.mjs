import assert from 'node:assert/strict'
import test from 'node:test'
import { fileTimeMilliseconds } from '../src/shared/file-time.ts'

test('bigint file times preserve numeric stat precision and dates before the epoch', () => {
  const nanoseconds = 1793035872872070213n
  const expected = 1793035872872.0703
  assert.notEqual(Number(nanoseconds) / 1e6, expected)
  assert.equal(fileTimeMilliseconds(nanoseconds), expected)
  assert.equal(fileTimeMilliseconds(0n), 0)
  assert.equal(fileTimeMilliseconds(-1500000000n), -1500)
})
