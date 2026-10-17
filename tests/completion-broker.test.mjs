import assert from 'node:assert/strict'
import test from 'node:test'
import { EditorState } from '@codemirror/state'
import {
  CompletionBroker,
  lazyCompletionProse,
} from '../src/renderer/src/completion-broker.ts'
import {
  safeCompletionContext,
  sourceProseAllowed,
} from '../src/shared/completions.ts'

test('acceptance uses visible item identity, winning provider, and one receipt per session', async () => {
  const broker = new CompletionBroker()
  const accepted = []
  broker.register(owner('lower'), () => [item('lower', 0, 'same')], 0, {
    onAccepted: () => accepted.push('lower'),
  })
  broker.register(
    owner('winner'),
    () => [
      {
        ...item('winner', 10, 'same'),
        onAccepted: () => accepted.push('item'),
      },
    ],
    0,
    {
      onAccepted: (input, picked) => accepted.push([input, picked]),
    },
  )
  const captured = request()
  const { items, request: bounded } = await collect(broker, captured).final
  const picked = items[0]
  assert.equal('onAccepted' in picked, false)
  assert.equal(broker.prepareAcceptance(bounded, { ...picked }), null)
  assert.equal(
    broker.prepareAcceptance(request({ contentVersion: 2 }), picked),
    null,
  )
  const first = broker.prepareAcceptance(bounded, picked)
  const second = broker.prepareAcceptance(bounded, picked)
  assert.deepEqual(accepted, [])
  first()
  first()
  second()
  assert.equal(accepted.length, 1)
  assert.deepEqual(accepted[0], [bounded, picked])
})

test('reserved acceptance survives menu dismissal but not disposal or a newer request', async () => {
  for (const action of ['dismiss', 'stop', 'supersede', 'dispose']) {
    const broker = new CompletionBroker()
    let calls = 0
    const registered = owner('provider')
    broker.register(registered, () => [item('word')], 0, {
      onAccepted: () => calls++,
    })
    const pending = collect(broker)
    const shown = await pending.final
    const report = broker.prepareAcceptance(shown.request, shown.items[0])
    if (action === 'dismiss') pending.cancel()
    if (action === 'stop') broker.stopOwner(registered)
    if (action === 'supersede')
      await collect(broker, request({ contentVersion: 4 })).final
    if (action === 'dispose') broker.dispose()
    report()
    assert.equal(calls, action === 'dismiss' ? 1 : 0, action)
    assert.equal(broker.prepareAcceptance(shown.request, shown.items[0]), null)
  }
})

test('failed edit without receipt has no feedback; throwing feedback cannot affect another edit', async () => {
  const broker = new CompletionBroker()
  let calls = 0
  broker.register(owner('provider'), () => [item('word')], 0, {
    onAccepted: () => {
      calls++
      throw new Error('feedback failure')
    },
  })
  const first = await collect(broker).final
  assert.ok(broker.prepareAcceptance(first.request, first.items[0]))
  assert.equal(calls, 0)
  const second = await collect(broker).final
  assert.doesNotThrow(broker.prepareAcceptance(second.request, second.items[0]))
  assert.equal(calls, 1)
})

test('typing context is bounded, frozen, isolated from listener failures, and removed on disposal', () => {
  const broker = new CompletionBroker()
  const events = []
  broker.onTypingContext(() => {
    throw new Error('listener failure')
  })
  const remove = broker.onTypingContext((event) => events.push(event))
  const context = {
    ...request({ before: 'a'.repeat(1000), after: 'b'.repeat(1000) }),
    kind: 'input',
    change: { from: 2, to: 2, insertedLength: 1 },
  }
  broker.emitTypingContext(context)
  assert.equal(events.length, 1)
  assert.equal(events[0].before.length, 256)
  assert.equal(events[0].after.length, 256)
  assert.equal('trigger' in events[0], false)
  assert.ok(Object.isFrozen(events[0]))
  assert.ok(Object.isFrozen(events[0].change))
  broker.emitTypingContext({
    ...context,
    change: { from: -1, to: 2, insertedLength: 1 },
  })
  assert.equal(events.length, 1)
  remove()
  broker.emitTypingContext(context)
  assert.equal(events.length, 1)
  broker.dispose()
  assert.equal(broker.hasTypingListeners(), false)
})

test('paste replacement emits only range data for an immediate overlapping accepted edit', async () => {
  const broker = new CompletionBroker()
  const events = []
  broker.onTypingContext((event) => events.push(event))
  broker.register(owner('provider'), () => [item('word')])
  const context = {
    ...request({ contentVersion: 6, before: 'private pasted text' }),
    kind: 'replace',
    change: { from: 0, to: 4, insertedLength: 19 },
  }
  broker.emitTypingContext(context)
  assert.deepEqual(events, [])
  const shown = await collect(broker).final
  broker.prepareAcceptance(shown.request, shown.items[0])()
  broker.emitTypingContext({
    ...context,
    contentVersion: 5,
    change: { from: 5, to: 6, insertedLength: 1 },
  })
  assert.deepEqual(events, [])
  broker.emitTypingContext(context)
  assert.equal(events.length, 1)
  assert.equal(events[0].before, '')
  assert.equal(events[0].after, '')
  broker.emitTypingContext(context)
  assert.equal(events.length, 1)
})

test('space after acceptance keeps range-only feedback for a subsequent unsafe overwrite', async () => {
  const broker = new CompletionBroker()
  const events = []
  broker.onTypingContext((event) => events.push(event))
  broker.register(owner('provider'), () => [item('word')])
  const shown = await collect(broker).final
  broker.prepareAcceptance(shown.request, shown.items[0])()
  broker.emitTypingContext({
    ...request({
      contentVersion: 5,
      documentLength: 8,
      selection: { anchor: 5, head: 5 },
      before: 'word ',
    }),
    kind: 'input',
    change: { from: 4, to: 4, insertedLength: 1 },
  })
  broker.emitTypingContext({
    ...request({
      contentVersion: 6,
      documentLength: 23,
      before: 'private pasted text',
    }),
    kind: 'replace',
    change: { from: 0, to: 4, insertedLength: 19 },
  })
  assert.deepEqual(
    events.map((event) => event.kind),
    ['input', 'replace'],
  )
  assert.equal(events[1].before, '')
  assert.equal(events[1].after, '')
})

test('unsafe composition keeps range-only correction through intermediate versions', async () => {
  for (const origin of ['replace', 'composition']) {
    const broker = new CompletionBroker()
    const events = []
    broker.onTypingContext((event) => events.push(event))
    broker.register(owner('provider'), () => [item('word')])
    const shown = await collect(broker).final
    broker.prepareAcceptance(shown.request, shown.items[0])()
    broker.emitTypingContext({
      ...request({ contentVersion: 5, before: 'word ' }),
      kind: 'input',
      change: { from: 4, to: 4, insertedLength: 1 },
    })
    const context = {
      ...request({
        contentVersion: 8,
        before: 'private composition',
        prose: null,
      }),
      kind: 'replace',
      change: { from: 0, to: 4, insertedLength: 19 },
    }
    broker.emitTypingContext(context, origin)
    assert.equal(events.length, origin === 'composition' ? 2 : 1, origin)
    if (origin === 'composition') {
      assert.equal(events[1].kind, 'replace')
      assert.equal(events[1].before, '')
      assert.equal(events[1].after, '')
      assert.equal('prose' in events[1], false)
    }
    broker.emitTypingContext(context, origin)
    assert.equal(events.length, origin === 'composition' ? 2 : 1)
  }
})

test('receipt follows preceding typing and allows replacement inside the accepted range', async () => {
  const broker = new CompletionBroker()
  const events = []
  broker.onTypingContext((event) => events.push(event))
  broker.register(owner('provider'), () => [
    { ...item('word'), from: 2, to: 3 },
  ])
  const shown = await collect(broker).final
  broker.prepareAcceptance(shown.request, shown.items[0])()
  broker.emitTypingContext({
    ...request({ contentVersion: 5, documentLength: 10, before: 'x' }),
    kind: 'input',
    change: { from: 0, to: 0, insertedLength: 1 },
  })
  broker.emitTypingContext({
    ...request({ contentVersion: 6, documentLength: 11, before: 'private' }),
    kind: 'replace',
    change: { from: 4, to: 4, insertedLength: 1 },
  })
  assert.deepEqual(
    events.map((event) => event.kind),
    ['input', 'replace'],
  )
  assert.equal(events[1].before, '')
})

test('range feedback discards changed views, unseen content versions, and stopped owners', async () => {
  for (const action of ['view', 'version', 'stop']) {
    const broker = new CompletionBroker()
    const events = []
    const registered = owner('provider')
    broker.onTypingContext((event) => events.push(event))
    broker.register(registered, () => [item('word')])
    const shown = await collect(broker).final
    broker.prepareAcceptance(shown.request, shown.items[0])()
    const context = {
      ...request({ contentVersion: 5, before: 'private' }),
      kind: 'replace',
      change: { from: 0, to: 4, insertedLength: 7 },
    }
    if (action === 'view') context.view = { ...context.view, viewGeneration: 2 }
    if (action === 'version') context.contentVersion = 6
    if (action === 'stop') broker.stopOwner(registered)
    broker.emitTypingContext(context)
    assert.deepEqual(events, [], action)
  }
})

test('no subscribers leave prose getters unread', () => {
  const broker = new CompletionBroker()
  let reads = 0
  const captured = request()
  Object.defineProperty(captured, 'prose', {
    enumerable: true,
    get() {
      reads++
      throw new Error('unexpected prose scan')
    },
  })
  broker.request(
    () => captured,
    () => captured,
    () => {},
  )
  broker.emitTypingContext(
    Object.assign(captured, {
      kind: 'input',
      change: { from: 2, to: 2, insertedLength: 1 },
    }),
  )
  assert.equal(reads, 0)
})

test('providers ignoring prose do not scan during publication or acceptance', async () => {
  const broker = new CompletionBroker()
  let reads = 0
  const captured = request()
  Object.defineProperty(captured, 'prose', {
    enumerable: true,
    get() {
      reads++
      throw new Error('unexpected prose scan')
    },
  })
  broker.register(owner('legacy'), (input) => {
    assert.equal(input.before, 'abc')
    return [item('word')]
  })
  const shown = await collect(broker, captured).final
  assert.equal(shown.items.length, 1)
  broker.prepareAcceptance(shown.request, shown.items[0])()
  assert.equal(reads, 0)
  assert.ok(Object.isFrozen(shown.request))
})

test('safe prose scan uses captured editor state once across providers', async () => {
  let state = EditorState.create({
    doc: 'original words',
    selection: { anchor: 14 },
  })
  const capturedState = state
  let scans = 0
  const prose = lazyCompletionProse(() => {
    scans++
    return safeCompletionContext(
      capturedState.doc.toString(),
      capturedState.selection.main.head,
    )
  })
  const captured = request()
  Object.defineProperty(captured, 'prose', { enumerable: true, get: prose })
  const broker = new CompletionBroker()
  const seen = []
  for (const id of ['one', 'two'])
    broker.register(owner(id), (input) => {
      seen.push(input.prose, input.prose)
      return []
    })
  state = state.update({
    changes: { from: 0, to: 14, insert: 'changed words' },
  }).state
  await collect(broker, captured).final
  assert.equal(state.doc.toString(), 'changed words')
  assert.equal(scans, 1)
  assert.equal(seen[0].before, 'original words')
  assert.ok(seen.every((value) => value === seen[0]))
  assert.ok(Object.isFrozen(seen[0]))
})

test('lazy prose caches excluded and missing context as well', () => {
  for (const value of [null, undefined]) {
    let scans = 0
    const prose = lazyCompletionProse(() => {
      scans++
      return value
    })
    assert.equal(prose(), value)
    assert.equal(prose(), value)
    assert.equal(scans, 1)
  }
})

test('typing listeners do not read the unused completion prose property', () => {
  const broker = new CompletionBroker()
  const captured = request()
  Object.defineProperty(captured, 'prose', {
    enumerable: true,
    get() {
      throw new Error('unused prose getter')
    },
  })
  const events = []
  broker.onTypingContext((event) => events.push(event))
  broker.emitTypingContext(
    Object.assign(captured, {
      kind: 'input',
      change: { from: 2, to: 2, insertedLength: 1 },
    }),
  )
  assert.equal(events.length, 1)
  assert.equal(events[0].before, 'abc')
  assert.equal('prose' in events[0], false)
})

test('ordinary prose data keeps immutable snapshot semantics', async () => {
  const broker = new CompletionBroker()
  broker.register(owner('one'), () => [])
  const original = { before: 'original', after: 'words' }
  const shown = await collect(broker, request({ prose: original })).final
  original.before = 'changed'
  assert.deepEqual(shown.request.prose, { before: 'original', after: 'words' })
  assert.ok(Object.isFrozen(shown.request.prose))
})

test('safe prose is bounded separately from legacy completion context', async () => {
  const broker = new CompletionBroker()
  let input
  broker.register(owner('provider'), (request) => {
    input = request
    return []
  })
  await collect(
    broker,
    request({
      before: 'legacy [[prefix',
      prose: { before: 'x'.repeat(600), after: 'y'.repeat(600) },
    }),
  ).final
  assert.equal(input.before, 'legacy [[prefix')
  assert.equal(input.prose.before.length, 256)
  assert.equal(input.prose.after.length, 256)
  assert.ok(Object.isFrozen(input.prose))
  await collect(broker, request({ prose: null })).final
  assert.equal(input.prose, null)
})

test('plain prose clips excluded neighboring spans and keeps punctuation', () => {
  for (const excluded of [
    '`hidden`',
    '$hidden$',
    '$$hidden$$',
    '<span>hidden</span>',
    'https://private.example/value',
    'qwerty1234567890_secret',
  ]) {
    const text = `${excluded} bro, wild! `
    const safe = safeCompletionContext(text, text.length)
    assert.deepEqual(safe, { before: ' bro, wild! ', after: '' }, excluded)
  }
  for (const text of [
    '`secret',
    '$secret',
    'password: shortsecret',
    'api_key=privatevalue',
    'https://private.example/sec',
  ]) {
    assert.equal(safeCompletionContext(text, text.length), null, text)
  }
  assert.equal(
    safeCompletionContext('mixed 中文 slang. ', 16)?.before,
    'mixed 中文 slang. ',
  )
})

test('prose clips whole CommonMark code spans and preserves escaped backticks', () => {
  for (const code of ['``a`b``', '```a``b```', '`a\\`', '``a`$$b``']) {
    const text = `${code} hap`
    assert.deepEqual(safeCompletionContext(text, text.length), {
      before: ' hap',
      after: '',
    })
    assert.equal(safeCompletionContext(text, 2), null)
    assert.deepEqual(safeCompletionContext(`hap ${code}`, 3), {
      before: 'hap',
      after: ' ',
    })
  }
  for (const text of ['hap \\` word', 'hap \\`\\` word']) {
    assert.deepEqual(safeCompletionContext(text, text.length), {
      before: text,
      after: '',
    })
  }
  for (const text of ['``a``` hap', '``a``` more ` hap', '\\\\`a hap']) {
    assert.equal(safeCompletionContext(text, text.length), null, text)
  }
})

test('source math proof ignores delimiters strictly inside CommonMark code', () => {
  for (const text of ['``a`$$b`` hap', '`a\\` $$ hidden', '\\` $$ hidden']) {
    assert.equal(sourceProseAllowed(text), text === '``a`$$b`` hap', text)
  }
  assert.equal(sourceProseAllowed('``$$ hap'), true)
  assert.equal(sourceProseAllowed('\\` $$ hidden\n$$\nhap'), true)
})

test('source proof distinguishes inline triple backticks and valid fence closers', () => {
  assert.equal(sourceProseAllowed('```code``` and hap'), true)
  assert.equal(sourceProseAllowed('```code```\nhap'), true)
  assert.equal(sourceProseAllowed('~~~ ``` x\nhap'), false)
  assert.equal(sourceProseAllowed('```\ncode\n```not-closed\nhap'), false)
  assert.equal(sourceProseAllowed('```\ncode\n``` \nhap'), true)
})

test('source proof excludes frontmatter and code/math fences within bounded work', () => {
  for (const text of [
    '---\nsecret: value',
    '```js\nsecret',
    '~~~\nsecret',
    '$$\nsecret\n\ntext',
    '---\nsecret: value\n---',
    '---\nvalue: |\n  > ---\n  confidential words',
  ]) {
    assert.equal(sourceProseAllowed(text), false, text)
  }
  for (const text of [
    'plain words',
    '---\nsecret: value\n---\n\nsafe',
    '```\n$$\n```\nsafe',
    '$$\nsecret\n$$\nsafe',
    '$$inline$$\nsafe',
  ]) {
    assert.equal(sourceProseAllowed(text), true, text)
  }
  assert.equal(sourceProseAllowed('x'.repeat(16385)), false)
})

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

test('keyboard metadata survives validation and invalid flags are rejected', async () => {
  const broker = new CompletionBroker()
  broker.register(owner('flags'), () => [
    {
      ...item('next'),
      preselect: false,
      acceptOnEnter: false,
      acceptOnTab: false,
      captureArrowKeys: false,
    },
    { ...item('word'), preselect: false, acceptOnEnter: 'selected' },
    { ...item('disabled-tab'), acceptOnTab: false },
    { ...item('invalid-preselect'), preselect: 'false' },
    { ...item('invalid-enter'), acceptOnEnter: 'always' },
    { ...item('invalid-arrows'), captureArrowKeys: 'false' },
    item('generic'),
  ])
  const { items } = await collect(broker).final
  assert.deepEqual(
    items.map(({ label }) => label),
    ['next', 'word', 'disabled-tab', 'generic'],
  )
  assert.equal(items[0].preselect, false)
  assert.equal(items[0].acceptOnEnter, false)
  assert.equal(items[0].acceptOnTab, false)
  assert.equal(items[0].captureArrowKeys, false)
  assert.equal(items[1].acceptOnEnter, 'selected')
  assert.equal(items[2].acceptOnTab, false)
  assert.equal('captureArrowKeys' in items[3], false)
  assert.equal('preselect' in items[3], false)
  assert.equal('acceptOnEnter' in items[3], false)
  assert.ok(Object.isFrozen(items[0]))
})

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
    (initial) => ({
      ...initial,
      view: { ...initial.view, documentId: 'document-two' },
    }),
    (initial) => ({
      ...initial,
      view: { ...initial.view, documentGeneration: 2 },
    }),
    (initial) => ({
      ...initial,
      view: { ...initial.view, viewId: 'view-two' },
    }),
    (initial) => ({ ...initial, editor: 'rich' }),
    (initial) => ({ ...initial, contentVersion: 4 }),
    (initial) => ({ ...initial, documentLength: 7 }),
    (initial) => ({ ...initial, selection: { anchor: 4, head: 4 } }),
    (initial) => ({ ...initial, selection: { anchor: 2, head: 3 } }),
    (initial) => ({ ...initial, selection: { anchor: 3, head: 4 } }),
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
