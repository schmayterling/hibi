import assert from 'node:assert/strict'
import test from 'node:test'
import {
  contextActionBroker,
  hoverBroker,
  registerContextActionProvider,
  registerHoverProvider,
} from '../src/renderer/src/editor-interaction-broker.ts'

let nextOwner = 0
const owner = () => ({
  addonId: `editor-provider-${++nextOwner}`,
  activationGeneration: 1,
})
const request = (overrides = {}) => ({
  view: {
    documentId: 'document-one',
    documentGeneration: 1,
    viewId: 'view-one',
    viewGeneration: 1,
  },
  contentVersion: 3,
  editor: 'source',
  documentLength: 6,
  position: 3,
  selection: { anchor: 3, head: 3 },
  before: 'abc',
  after: 'def',
  selectedText: '',
  ...overrides,
})
const deferred = () => {
  let resolve
  const promise = new Promise((finish) => {
    resolve = finish
  })
  return { promise, resolve }
}
const tick = () => new Promise((resolve) => setImmediate(resolve))
const collect = (broker, captured, current = () => captured) => {
  const updates = []
  let done
  const final = new Promise((resolve) => {
    done = resolve
  })
  const cancel = broker.request(
    () => captured,
    current,
    (items, finished) => {
      updates.push({ items, finished })
      if (finished) done(items)
    },
  )
  return { updates, final, cancel }
}

test('hover follows one target and aborts superseded work', async () => {
  const id = owner()
  const old = deferred()
  const signals = []
  const remove = registerHoverProvider(id, (input, signal) => {
    signals.push(signal)
    return input.position === 3 ? old.promise : { label: 'new target' }
  })
  const first = collect(hoverBroker, request())
  await tick()
  const second = collect(hoverBroker, request({ position: 4 }))
  assert.equal(signals[0].aborted, true)
  assert.deepEqual(await second.final, [{ label: 'new target' }])
  old.resolve({ label: 'old target' })
  await tick()
  assert.equal(first.updates.length, 0)
  remove()
})

test('unresponsive owner cannot consume new slots across requests', async () => {
  const stuck = owner()
  const healthy = owner()
  let stuckCalls = 0
  let healthyCalls = 0
  const removeStuck = registerHoverProvider(stuck, () => {
    stuckCalls++
    return new Promise(() => {})
  })
  const removeHealthy = registerHoverProvider(healthy, (input) => {
    healthyCalls++
    return { label: `fresh ${input.contentVersion}` }
  })

  for (let version = 0; version < 20; version++) {
    const result = collect(hoverBroker, request({ contentVersion: version }))
    assert.deepEqual(await result.final, [{ label: `fresh ${version}` }])
  }

  assert.equal(stuckCalls, 2)
  assert.equal(healthyCalls, 20)
  removeStuck()
  removeHealthy()
})

test('context actions validate edits and retract on owner stop after publication', async () => {
  const id = owner()
  const remove = registerContextActionProvider(id, () => [
    { label: 'replace', edit: { from: 1, to: 3, insertText: 'x' } },
    { label: 'outside', edit: { from: -1, to: 3, insertText: 'x' } },
  ])
  const result = collect(contextActionBroker, request())
  const final = await result.final
  assert.equal(final.length, 1)
  assert.deepEqual(final[0].edit, { from: 1, to: 3, insertText: 'x' })
  assert.equal(Object.isFrozen(final[0].edit), true)
  contextActionBroker.stopOwner(id)
  assert.deepEqual(result.updates.at(-1), { items: [], finished: true })
  assert.throws(() => registerContextActionProvider(id, () => []))
  remove()
})

test('changed selection and version discard late results', async () => {
  const id = owner()
  const slow = deferred()
  const remove = registerContextActionProvider(id, () => slow.promise)
  const captured = request()
  let current = captured
  const result = collect(contextActionBroker, captured, () => current)
  await tick()
  current = request({ contentVersion: 4, selection: { anchor: 4, head: 4 } })
  slow.resolve([{ label: 'stale', edit: { from: 0, to: 0, insertText: 'x' } }])
  assert.deepEqual(await result.final, [])
  remove()
})
