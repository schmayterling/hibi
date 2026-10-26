import assert from 'node:assert/strict'
import test from 'node:test'
import { sortSteps } from '../src/shared/cooperative-sort.ts'

test('cooperative sort keeps stable order and yields within an elapsed work budget', (t) => {
  let clock = 0
  t.mock.method(performance, 'now', () => clock)
  const values = Array.from({ length: 20000 }, (_, order) => ({
    key: order % 17,
    order,
  }))
  let comparisons = 0
  const sorting = sortSteps(values, (a, b) => {
    comparisons++
    clock += 0.05
    return a.key - b.key
  })
  let turns = 0
  let previous = 0
  let result = sorting.next()
  while (!result.done) {
    assert.ok(comparisons - previous <= 81)
    previous = comparisons
    turns++
    result = sorting.next()
  }
  assert.ok(turns > 0)
  assert.ok(comparisons <= values.length * Math.ceil(Math.log2(values.length)))
  assert.deepEqual(
    result.value,
    values.toSorted((a, b) => a.key - b.key),
  )
  assert.deepEqual(
    values.slice(0, 3).map((item) => item.order),
    [0, 1, 2],
  )
})
