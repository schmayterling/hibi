import assert from 'node:assert/strict'
import test from 'node:test'
import { CompletionBroker } from '../src/renderer/src/completion-broker.ts'

const owner = (addonId, activationGeneration = 1) => ({
  addonId,
  activationGeneration,
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
  selection: { anchor: 3, head: 3 },
  before: 'abc',
  after: 'def',
  trigger: { kind: 'explicit' },
  ...overrides,
})
const item = (label, rank = 0, insertText = label) => ({
  label,
  insertText,
  from: 0,
  to: 3,
  rank,
})
const deferred = () => {
  let resolve
  const promise = new Promise((finish) => {
    resolve = finish
  })
  return { promise, resolve }
}
const tick = () => new Promise((resolve) => setImmediate(resolve))
const collect = (broker, captured = request(), getCurrent = () => captured) => {
  const updates = []
  let resolveFinal
  const final = new Promise((resolve) => {
    resolveFinal = resolve
  })
  const cancel = broker.request(
    () => captured,
    getCurrent,
    (update) => {
      updates.push(update)
      if (update.done) resolveFinal(update)
    },
  )
  return { updates, final, cancel }
}

test('no providers skips capture and emits nothing', () => {
  const broker = new CompletionBroker()
  let captures = 0
  let updates = 0
  const cancel = broker.request(
    () => {
      captures++
      return request()
    },
    () => request(),
    () => updates++,
  )
  assert.equal(cancel, null)
  assert.equal(captures, 0)
  assert.equal(updates, 0)
})

test('ready results arrive before slow providers and final merge is ranked and deduplicated', async () => {
  const broker = new CompletionBroker()
  const slow = deferred()
  broker.register(owner('fast'), () => [item('high', 10), item('low', 2)])
  broker.register(owner('slow'), () => slow.promise)
  broker.register(owner('failed'), () =>
    Promise.reject(new Error('provider failed')),
  )
  const result = collect(broker)
  await tick()
  assert.equal(
    result.updates.some(
      ({ done, items }) => !done && items.some(({ label }) => label === 'high'),
    ),
    true,
  )
  assert.equal(
    result.updates.some(({ done }) => done),
    false,
  )
  slow.resolve([item('middle', 5), item('duplicate', -1, 'high')])
  const final = await result.final
  assert.deepEqual(
    final.items.map(({ label }) => label),
    ['high', 'middle', 'low'],
  )
})

test('changed view, content version, or selection discards late results', async () => {
  const changes = [
    (initial) => ({
      ...initial,
      view: { ...initial.view, viewGeneration: 2 },
    }),
    (initial) => ({ ...initial, contentVersion: 4 }),
    (initial) => ({ ...initial, selection: { anchor: 4, head: 4 } }),
  ]
  for (const change of changes) {
    const broker = new CompletionBroker()
    const late = deferred()
    broker.register(owner('late'), () => late.promise)
    const captured = request()
    let current = captured
    const result = collect(broker, captured, () => current)
    await tick()
    current = change(captured)
    late.resolve([item('stale')])
    const final = await result.final
    assert.deepEqual(final.items, [])
    assert.equal(
      result.updates.some(({ items }) =>
        items.some(({ label }) => label === 'stale'),
      ),
      false,
    )
  }
})

test('superseding request aborts old provider and ignores its response', async () => {
  const broker = new CompletionBroker()
  const pending = []
  broker.register(owner('one'), (_request, signal) => {
    const work = deferred()
    pending.push({ ...work, signal })
    return work.promise
  })
  const first = collect(broker)
  await tick()
  const next = request({ contentVersion: 4 })
  const second = collect(broker, next)
  assert.equal(pending.length, 1)
  assert.equal(pending[0].signal.aborted, true)
  pending[0].resolve([item('obsolete')])
  await tick()
  assert.equal(pending.length, 2)
  pending[1].resolve([item('current')])
  const final = await second.final
  assert.deepEqual(
    final.items.map(({ label }) => label),
    ['current'],
  )
  assert.equal(
    first.updates.some(({ items }) =>
      items.some(({ label }) => label === 'obsolete'),
    ),
    false,
  )
})

test('stopping owner aborts pending work and retracts its ready items', async () => {
  const broker = new CompletionBroker()
  const late = deferred()
  let pendingSignal
  const stopped = owner('stopped')
  broker.register(stopped, () => [item('ready')])
  broker.register(stopped, (_request, signal) => {
    pendingSignal = signal
    return late.promise
  })
  broker.register(owner('other'), () => [])
  const result = collect(broker)
  await tick()
  assert.equal(
    result.updates.some(({ items }) => items.length > 0),
    true,
  )
  broker.stopOwner(stopped)
  assert.equal(pendingSignal.aborted, true)
  late.resolve([item('revoked')])
  const final = await result.final
  assert.deepEqual(final.items, [])
})

test('provider receives bounded context and result caps apply per provider and overall', async () => {
  const broker = new CompletionBroker()
  const before = `${'a'.repeat(644)}needle`
  const after = `needle${'b'.repeat(644)}`
  let observed
  for (let provider = 0; provider < 4; provider++) {
    broker.register(owner(`provider-${provider}`), (input) => {
      observed = input
      return Array.from({ length: 30 }, (_, index) =>
        item(`${provider}-${index}`, 30 - index),
      )
    })
  }
  const captured = request({
    documentLength: 1300,
    selection: { anchor: 650, head: 650 },
    before,
    after,
  })
  const result = collect(broker, captured)
  const final = await result.final
  assert.ok(observed.before.length <= 256)
  assert.ok(observed.after.length <= 256)
  assert.ok(observed.before.endsWith('needle'))
  assert.ok(observed.after.startsWith('needle'))
  assert.ok(final.items.length <= 50)
  for (let provider = 0; provider < 4; provider++) {
    assert.ok(
      final.items.filter(({ label }) => label.startsWith(`${provider}-`))
        .length <= 20,
    )
  }
})

test('at most three providers run concurrently', async () => {
  const broker = new CompletionBroker()
  let active = 0
  let maximum = 0
  let started = 0
  for (let index = 0; index < 10; index++) {
    broker.register(owner(`provider-${index}`), async () => {
      started++
      active++
      maximum = Math.max(maximum, active)
      await new Promise((resolve) => setTimeout(resolve, 10))
      active--
      return []
    })
  }
  const result = collect(broker)
  await result.final
  assert.equal(started, 10)
  assert.ok(maximum <= 3)
})

test('timed-out provider is aborted and finishes request', {
  timeout: 3000,
}, async () => {
  const broker = new CompletionBroker()
  let signal
  broker.register(owner('hung'), (_request, providerSignal) => {
    signal = providerSignal
    return new Promise(() => {})
  })
  const result = collect(broker)
  let watchdog
  const final = await Promise.race([
    result.final,
    new Promise((_, reject) => {
      watchdog = setTimeout(
        () => reject(new Error('request did not finish')),
        1200,
      )
    }),
  ]).finally(() => clearTimeout(watchdog))
  assert.equal(signal.aborted, true)
  assert.deepEqual(final.items, [])
})

test('hung providers do not starve later requests', {
  timeout: 3000,
}, async () => {
  const broker = new CompletionBroker()
  for (let index = 0; index < 3; index++)
    broker.register(owner(`hung-${index}`), () => new Promise(() => {}))
  const first = collect(broker)
  assert.deepEqual((await first.final).items, [])

  broker.register(owner('healthy'), () => [item('healthy')], 1)
  const second = collect(broker)
  const final = await second.final
  assert.deepEqual(
    final.items.map(({ label }) => label),
    ['healthy'],
  )
})

test('stopped generations cannot register again and disposal is terminal', async () => {
  const broker = new CompletionBroker()
  const stopped = owner('restarted', 1)
  broker.register(stopped, () => [item('old')])
  broker.stopOwner(stopped)
  assert.throws(() => broker.register(stopped, () => []), /stopped/)
  assert.throws(
    () => broker.register(owner('restarted', 0), () => []),
    /stopped/,
  )
  broker.register(owner('restarted', 2), () => [item('new')])
  const active = collect(broker)
  assert.deepEqual(
    (await active.final).items.map(({ label }) => label),
    ['new'],
  )

  broker.dispose()
  assert.throws(
    () => broker.register(owner('restarted', 3), () => []),
    /disposed/,
  )
  let captures = 0
  assert.equal(
    broker.request(
      () => {
        captures++
        return request()
      },
      () => request(),
      () => {},
    ),
    null,
  )
  assert.equal(captures, 0)
})

test('priority provider publishes before slow default providers', async () => {
  const broker = new CompletionBroker()
  for (let index = 0; index < 3; index++)
    broker.register(owner(`slow-${index}`), () => new Promise(() => {}))
  broker.register(owner('fast'), () => [item('fast')], 1)
  const result = collect(broker)
  await tick()
  assert.equal(
    result.updates.some(
      ({ done, items }) => !done && items.some(({ label }) => label === 'fast'),
    ),
    true,
  )
  result.cancel()
})

test('ready lower-priority provider publishes while higher-priority providers hang', {
  timeout: 3000,
}, async () => {
  const broker = new CompletionBroker()
  for (let index = 0; index < 3; index++)
    broker.register(owner(`slow-${index}`), () => new Promise(() => {}), 1)
  broker.register(owner('fast'), () => [item('fast')], 0)
  const captured = request()
  let resolveUpdate
  const firstUsefulUpdate = new Promise((resolve) => {
    resolveUpdate = resolve
  })
  const cancel = broker.request(
    () => captured,
    () => captured,
    (update) => {
      if (update.done || update.items.some(({ label }) => label === 'fast'))
        resolveUpdate(update)
    },
  )
  const update = await firstUsefulUpdate
  assert.equal(update.done, false)
  assert.deepEqual(
    update.items.map(({ label }) => label),
    ['fast'],
  )
  cancel()
})

test('stopping owner retracts its already completed results', async () => {
  const broker = new CompletionBroker()
  const completed = owner('completed')
  broker.register(completed, () => [item('ready')])
  const result = collect(broker)
  assert.deepEqual(
    (await result.final).items.map(({ label }) => label),
    ['ready'],
  )

  broker.stopOwner(completed)
  assert.deepEqual(result.updates.at(-1), {
    request: result.updates[0].request,
    items: [],
    done: true,
  })
  assert.equal(result.updates.length, 2)
})

test('timeout abort listener can start a newer request without old final overwriting it', {
  timeout: 3000,
}, async () => {
  const broker = new CompletionBroker()
  const old = request()
  const fresh = request({ contentVersion: 4 })
  const nestedCreated = deferred()
  let nested
  broker.register(owner('hung'), (_input, signal) => {
    signal.addEventListener(
      'abort',
      () => {
        broker.register(owner('fresh'), () => [item('fresh')], 1)
        nested = collect(broker, fresh)
        nestedCreated.resolve()
      },
      { once: true },
    )
    return new Promise(() => {})
  })
  const oldUpdates = []
  broker.request(
    () => old,
    () => old,
    (update) => oldUpdates.push(update),
  )
  await nestedCreated.promise
  const final = await nested.final
  assert.deepEqual(
    final.items.map(({ label }) => label),
    ['fresh'],
  )
  assert.deepEqual(oldUpdates, [])
})

test('stop-owner abort listener cannot run another provider from stopped owner', {
  timeout: 3000,
}, async () => {
  const broker = new CompletionBroker()
  const stopped = owner('stopped')
  const nestedCreated = deferred()
  let nested
  let queuedCalls = 0
  broker.register(stopped, (_input, signal) => {
    signal.addEventListener(
      'abort',
      () => {
        broker.register(owner('survivor'), () => [item('survivor')], 1)
        nested = collect(broker, request({ contentVersion: 4 }))
        nestedCreated.resolve()
      },
      { once: true },
    )
    return new Promise(() => {})
  })
  for (let index = 0; index < 2; index++)
    broker.register(stopped, () => new Promise(() => {}))
  broker.register(stopped, () => {
    queuedCalls++
    return [item('wrong')]
  })
  const first = collect(broker)
  await tick()
  broker.stopOwner(stopped)
  await nestedCreated.promise
  const final = await nested.final
  assert.deepEqual(
    final.items.map(({ label }) => label),
    ['survivor'],
  )
  assert.equal(queuedCalls, 0)
  assert.equal(
    first.updates.some(({ items }) => items.length > 0),
    false,
  )
})

test('owner stopped by timeout abort listener is excluded from final results', {
  timeout: 3000,
}, async () => {
  const broker = new CompletionBroker()
  const fast = owner('fast')
  broker.register(fast, () => [item('fast')])
  broker.register(owner('hung'), (_input, signal) => {
    signal.addEventListener('abort', () => broker.stopOwner(fast), {
      once: true,
    })
    return new Promise(() => {})
  })
  const result = collect(broker)
  await tick()
  assert.equal(
    result.updates.some(({ items }) =>
      items.some(({ label }) => label === 'fast'),
    ),
    true,
  )
  const final = await result.final
  assert.deepEqual(final.items, [])
})

test('completed owner result retracts before abort listener starts nested request', async () => {
  const broker = new CompletionBroker()
  const completed = owner('completed')
  let result
  let updateAtAbort
  let nestedReturn
  let nestedCaptures = 0
  broker.register(completed, (_input, signal) => {
    signal.addEventListener(
      'abort',
      () => {
        updateAtAbort = result.updates.at(-1)
        nestedReturn = broker.request(
          () => {
            nestedCaptures++
            return request()
          },
          () => request(),
          () => {},
        )
      },
      { once: true },
    )
    return [item('ready')]
  })
  result = collect(broker)
  assert.deepEqual(
    (await result.final).items.map(({ label }) => label),
    ['ready'],
  )

  broker.stopOwner(completed)
  assert.deepEqual(updateAtAbort, {
    request: result.updates[0].request,
    items: [],
    done: true,
  })
  assert.equal(nestedReturn, null)
  assert.equal(nestedCaptures, 0)
  assert.equal(result.updates.length, 2)
})
