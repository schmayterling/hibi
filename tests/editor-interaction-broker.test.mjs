import assert from 'node:assert/strict'
import test from 'node:test'
import {
  contextActionBroker,
  EditorInteractionBroker,
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

for (const transition of ['replace', 'timeout']) {
  test(`abort listener keeps newest request during ${transition}`, {
    timeout: 3000,
  }, async (t) => {
    const broker = new EditorInteractionBroker((value) => value, 3)
    t.after(() => broker.dispose())
    const started = deferred()
    let nested
    let calls = 0
    let newerStarted = false
    let staleCurrentCalls = 0
    broker.register(owner(), (_input, signal) => {
      if (++calls !== 1) return []
      return new Promise((resolve) =>
        signal.addEventListener(
          'abort',
          () => {
            nested = collect(broker, request({ contentVersion: 4 }))
            newerStarted = true
            started.resolve()
            resolve([])
          },
          { once: true },
        ),
      )
    })
    broker.register(owner(), (input) => [
      {
        label: input.contentVersion === 4 ? 'nested-newest' : 'outer-older',
      },
    ])
    const captured = request()
    const initial = collect(broker, captured, () => {
      if (newerStarted) staleCurrentCalls++
      return captured
    })
    await tick()
    assert.deepEqual(initial.updates, [
      {
        items: [{ label: 'outer-older' }],
        finished: false,
      },
    ])
    if (transition === 'replace') {
      let captures = 0
      const updates = []
      const cancel = broker.request(
        () => {
          captures++
          return request()
        },
        () => request(),
        (...update) => updates.push(update),
      )
      assert.equal(cancel, null)
      assert.equal(captures, 0)
      assert.deepEqual(updates, [])
    }
    await started.promise
    assert.deepEqual(await nested.final, [{ label: 'nested-newest' }])
    assert.equal(calls, 2)
    assert.equal(staleCurrentCalls, 0)
    assert.equal(
      initial.updates.some(({ finished }) => finished),
      false,
    )
  })
}

test('capture callback cannot replace a newer request', {
  timeout: 3000,
}, async (t) => {
  const broker = new EditorInteractionBroker((value) => value, 3)
  t.after(() => broker.dispose())
  broker.register(owner(), () => [{ label: 'newest' }])
  let nested
  const updates = []
  const cancel = broker.request(
    () => {
      nested = collect(broker, request({ contentVersion: 4 }))
      return request()
    },
    () => request(),
    (...update) => updates.push(update),
  )
  assert.equal(cancel, null)
  assert.deepEqual(await nested.final, [{ label: 'newest' }])
  assert.deepEqual(updates, [])
})

for (const survivor of [false, true]) {
  test(`completed owner retracts before abort reentry with survivor ${survivor}`, {
    timeout: 3000,
  }, async (t) => {
    const broker = new EditorInteractionBroker((value) => value, 3)
    t.after(() => broker.dispose())
    const retired = owner()
    let result
    let updateAtAbort
    let nestedReturn
    let nestedCaptures = 0
    let nestedCurrents = 0
    broker.register(retired, (_input, signal) => {
      signal.addEventListener(
        'abort',
        () => {
          updateAtAbort = result.updates.at(-1)
          nestedReturn = broker.request(
            () => {
              nestedCaptures++
              return request()
            },
            () => {
              nestedCurrents++
              return request()
            },
            () => {},
          )
        },
        { once: true },
      )
      return [{ label: 'retired-action' }]
    })
    if (survivor) broker.register(owner(), () => [{ label: 'survivor' }])
    result = collect(broker, request())
    assert.deepEqual(await result.final, [
      { label: 'retired-action' },
      ...(survivor ? [{ label: 'survivor' }] : []),
    ])
    const count = result.updates.length
    broker.stopOwner(retired)
    assert.deepEqual(updateAtAbort, {
      items: survivor ? [{ label: 'survivor' }] : [],
      finished: true,
    })
    assert.deepEqual(result.updates.at(-1), updateAtAbort)
    assert.equal(result.updates.length, count + 1)
    assert.equal(nestedCaptures, survivor ? 1 : 0)
    assert.equal(nestedCurrents, survivor ? 1 : 0)
    assert.equal(typeof nestedReturn, survivor ? 'function' : 'object')
    if (!survivor) assert.equal(nestedReturn, null)
  })
}

for (const transition of ['publish', 'finish', 'retract']) {
  test(`current callback reentry suppresses older ${transition}`, {
    timeout: 3000,
  }, async (t) => {
    const broker = new EditorInteractionBroker((value) => value, 3)
    t.after(() => broker.dispose())
    const ready = deferred()
    const firstOwner = owner()
    const captured = request()
    let nested
    let reenter = false
    broker.register(firstOwner, (input) =>
      input.contentVersion === 4 ? [{ label: 'newest' }] : ready.promise,
    )
    if (transition === 'publish')
      broker.register(owner(), (input) =>
        input.contentVersion === 4 ? [] : new Promise(() => {}),
      )
    if (transition === 'retract')
      broker.register(owner(), () => [{ label: 'survivor' }])
    const result = collect(broker, captured, () => {
      if (reenter) {
        reenter = false
        nested = collect(broker, request({ contentVersion: 4 }))
      }
      return captured
    })
    await tick()
    if (transition === 'retract') {
      ready.resolve([{ label: 'retired' }])
      await result.final
      reenter = true
      const count = result.updates.length
      broker.stopOwner(firstOwner)
      assert.equal(result.updates.length, count)
      assert.deepEqual(await nested.final, [{ label: 'survivor' }])
    } else {
      reenter = true
      ready.resolve([{ label: 'outer-older' }])
      await tick()
      assert.deepEqual(await nested.final, [{ label: 'newest' }])
      assert.deepEqual(result.updates, [])
    }
  })
}

test('dispose inside a timeout abort prevents further current reads and publication', {
  timeout: 3000,
}, async (t) => {
  const broker = new EditorInteractionBroker((value) => value, 3)
  t.after(() => broker.dispose())
  const disposed = deferred()
  let stopped = false
  let staleCurrentCalls = 0
  broker.register(
    owner(),
    (_input, signal) =>
      new Promise((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            broker.dispose()
            stopped = true
            disposed.resolve()
            resolve([])
          },
          { once: true },
        )
      }),
  )
  broker.register(owner(), () => [{ label: 'outer-older' }])
  const captured = request()
  const result = collect(broker, captured, () => {
    if (stopped) staleCurrentCalls++
    return captured
  })
  await disposed.promise
  await tick()
  assert.equal(staleCurrentCalls, 0)
  assert.deepEqual(result.updates, [
    {
      items: [{ label: 'outer-older' }],
      finished: false,
    },
  ])
  let captures = 0
  assert.equal(
    broker.request(
      () => {
        captures++
        return request()
      },
      () => request(),
      () => assert.fail('disposed broker published'),
    ),
    null,
  )
  assert.equal(captures, 0)
})

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
