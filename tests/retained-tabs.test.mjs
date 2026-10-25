import assert from 'node:assert/strict'
import test from 'node:test'
import { retainClosingTabs } from '../src/renderer/src/retained-tabs.ts'

test('closing tabs keep their positions with linear membership checks', () => {
  let reads = 0
  const tabs = Array.from({ length: 500 }, (_, index) => {
    const id = `tab-${index}`
    return {
      get id() {
        reads++
        return id
      },
      name: `note-${index}.md`,
      dirty: false,
    }
  })
  const retain = (previous, current) => {
    const ids = new Set(current.map((tab) => tab.id))
    reads = 0
    const next = retainClosingTabs(previous, current, ids)
    return { next, reads }
  }
  const ids = (list) => list.map((tab) => tab.id)

  // Every other tab closes; closing tabs stay where they were.
  const closing = retain(
    tabs,
    tabs.filter((_, index) => index % 2),
  )
  assert.deepEqual(ids(closing.next), ids(tabs))
  assert.notEqual(closing.next, tabs)
  assert.ok(closing.reads <= tabs.length, `${closing.reads} id reads`)

  // A reply with equal tabs keeps the rendered list, so geometry is not measured again.
  const equal = retain(
    tabs,
    tabs.map(({ id, name, dirty }) => ({ id, name, dirty })),
  )
  assert.equal(equal.next, tabs)
  assert.ok(equal.reads <= 2 * tabs.length, `${equal.reads} id reads`)

  const [a, b, c] = tabs
  const x = { id: 'x', name: 'x.md', dirty: false }
  assert.deepEqual(ids(retain([a, b, c], [a, x, c]).next), [
    'tab-0',
    'tab-1',
    'x',
    'tab-2',
  ])
  assert.deepEqual(ids(retain([a, b, c], [c]).next), [
    'tab-0',
    'tab-1',
    'tab-2',
  ])
  assert.deepEqual(ids(retain([a, b, c], [c, a, x]).next), [
    'tab-2',
    'tab-1',
    'tab-0',
    'x',
  ])
  const renamed = { id: c.id, name: 'renamed.md', dirty: false }
  assert.equal(retain([a, b, c], [a, b, renamed]).next[2], renamed)
})
