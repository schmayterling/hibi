import assert from 'node:assert/strict'
import test from 'node:test'
import { projectionIdentity } from '../src/renderer/src/document-projection-identity.ts'
import { DocumentRuntime } from '../src/renderer/src/document-runtime.ts'
import { createDocumentTargetEditScope } from '../src/renderer/src/document-target-edits.ts'
import { mountedDocumentEdits } from '../src/renderer/src/mounted-document-edits.ts'

const document = (source, overrides = {}) => ({
  tabId: 'one',
  tabs: [{ id: 'one', name: 'one.md', dirty: false }],
  tabsEnabled: true,
  id: 'file-one',
  ephemeral: false,
  markdown: source,
  savedMarkdown: source,
  name: 'one.md',
  dirty: false,
  revision: 1,
  contentVersion: 0,
  canAutosave: true,
  ...overrides,
})
const fixture = () => {
  const operations = [],
    errors = []
  const runtime = new DocumentRuntime({
    enqueue: (operation) => operations.push(operation),
    onError: (error) => errors.push(error),
  })
  let busy = false
  const scope = createDocumentTargetEditScope(runtime, () => busy)
  return {
    runtime,
    scope,
    operations,
    errors,
    setBusy: (value) => {
      busy = value
    },
  }
}
const request = (target, requestId, changes) => ({
  requestId,
  target,
  changes,
})

test('target edits keep inactive source, history and focus independent', () => {
  const { runtime, scope, operations, errors } = fixture()
  const tabs = ['one', 'two'].map((id) => ({
    id,
    name: `${id}.md`,
    dirty: false,
  }))
  runtime.activate(document('a\r\n😀b', { tabs }))
  const first = runtime.session()
  first.counters(true)
  const [listed] = scope.listOpen()
  assert.equal(first.counters().materializations, 0)
  assert.equal(listed.name, 'one.md')
  const read = scope.readSource(listed.target)
  assert.equal(read.status, 'read')
  assert.equal(read.source, 'a\r\n😀b')
  assert.equal(
    scope.readSource({ documentId: '', documentGeneration: 1 }).status,
    'invalid',
  )
  assert.equal(
    scope.readSource({
      get documentId() {
        throw new Error('hostile getter')
      },
    }).status,
    'invalid',
  )
  runtime.activate(
    document('other', { tabId: 'two', id: 'file-two', revision: 2, tabs }),
  )
  assert.equal(scope.listOpen().length, 2)
  const applied = scope.applyEdits(
    request(listed.target, 'edit-one', [
      { from: 5, to: 6, expectedText: 'b', insert: '🌊b' },
    ]),
  )
  assert.deepEqual(applied, { status: 'applied', contentVersion: 1 })
  assert.equal(runtime.get().markdown, 'other')
  assert.equal(runtime.get('one').markdown, 'a\r\n😀🌊b')
  assert.equal(operations.at(-1).document.tabId, 'one')
  assert.equal(operations.at(-1).origin, 'addon')
  first.undo()
  assert.equal(runtime.get('one').markdown, 'a\r\n😀b')
  assert.equal(runtime.get().markdown, 'other')
  assert.deepEqual(errors, [])
  scope.dispose()
  runtime.dispose()
})

test('metadata and lifecycle events track live sessions without reading source', () => {
  const { runtime, scope } = fixture()
  runtime.activate(document('first'))
  const first = scope.listOpen()[0]
  const session = runtime.session()
  session.counters(true)
  assert.deepEqual(scope.getMetadata(first.target), {
    status: 'read',
    metadata: first,
  })
  assert.equal(session.counters().materializations, 0)
  const events = []
  const stop = scope.subscribe((event) => events.push(event))
  session.edit([{ from: 5, to: 5, insert: '!' }], 'addon', 'change')
  assert.equal(events[0].kind, 'changed')
  assert.equal(events[0].metadata.target.contentVersion, 1)
  assert.equal(events[0].metadata.dirty, true)
  assert.equal(session.counters().materializations, 0)
  runtime.activate(
    document('second', {
      tabId: 'two',
      id: 'file-two',
      name: 'two.md',
      revision: 2,
      tabs: [
        { id: 'one', name: 'one.md', dirty: true },
        { id: 'two', name: 'two.md', dirty: false },
      ],
    }),
  )
  assert.equal(events.at(-1).kind, 'opened')
  const second = scope.listOpen().find((entry) => entry.name === 'two.md')
  assert.equal(second.target.contentVersion, 0)
  runtime.activate(
    document('second', {
      tabId: 'two',
      id: 'file-two',
      name: 'two.md',
      revision: 2,
      tabs: [{ id: 'two', name: 'two.md', dirty: false }],
    }),
  )
  assert.equal(events.at(-1).kind, 'closed')
  assert.equal(events.at(-1).target.documentId, first.target.documentId)
  assert.equal(scope.getMetadata(first.target).status, 'stale')
  stop()
  runtime
    .session()
    .edit([{ from: 6, to: 6, insert: '!' }], 'addon', 'after-stop')
  assert.equal(events.at(-1).kind, 'closed')
  scope.dispose()
  assert.equal(scope.getMetadata(second.target).status, 'disposed')
  runtime.dispose()
})

test('targeted save acknowledges one snapshot while focus and source advance', async () => {
  const runtime = new DocumentRuntime({
    enqueue() {},
    onError(error) {
      throw error
    },
  })
  const tabs = ['one', 'two'].map((id) => ({
    id,
    name: `${id}.md`,
    dirty: false,
  }))
  runtime.activate(document('base', { tabs }))
  runtime
    .session()
    .edit([{ from: 4, to: 4, insert: ' saved' }], 'source', 'first')
  const saved = {
    ...runtime.get(),
    savedMarkdown: 'base saved',
  }
  let reply
  const calls = []
  const scope = createDocumentTargetEditScope(
    runtime,
    () => false,
    (...args) => {
      calls.push(args)
      return new Promise((resolve) => {
        reply = resolve
      })
    },
  )
  const target = scope.listOpen()[0].target
  const pending = scope.save(target)
  assert.deepEqual(calls, [['one', 1, 1]])
  assert.equal((await scope.save(target)).status, 'busy')
  runtime.activate(
    document('other', {
      tabId: 'two',
      id: 'file-two',
      name: 'two.md',
      revision: 2,
      tabs,
    }),
  )
  runtime
    .session('one')
    .edit([{ from: 10, to: 10, insert: ' more' }], 'source', 'later')
  reply({ status: 'saved', document: saved })
  assert.deepEqual(await pending, { status: 'saved', savedVersion: 1 })
  assert.equal(runtime.get().name, 'two.md')
  assert.equal(runtime.get('one').markdown, 'base saved more')
  assert.equal(runtime.get('one').savedMarkdown, 'base saved')
  assert.equal(runtime.get('one').dirty, true)
  assert.equal((await scope.save(target)).status, 'stale')
  scope.dispose()
  runtime.dispose()
})

test('target edits validate source boundaries, expected text, version and generation', () => {
  const { runtime, scope, operations } = fixture()
  runtime.activate(document('a\r\n😀b'))
  const target = scope.listOpen()[0].target
  assert.equal(
    scope.applyEdits(
      request(target, 'crlf', [
        { from: 2, to: 2, expectedText: '', insert: 'x' },
      ]),
    ).status,
    'invalid',
  )
  assert.equal(
    scope.applyEdits(
      request(target, 'emoji', [
        { from: 4, to: 4, expectedText: '', insert: 'x' },
      ]),
    ).status,
    'invalid',
  )
  assert.equal(
    scope.applyEdits(
      request(target, 'expected', [
        { from: 0, to: 1, expectedText: 'a', insert: 'A' },
        { from: 5, to: 6, expectedText: 'c', insert: 'x' },
      ]),
    ).status,
    'conflict',
  )
  assert.equal(
    scope.applyEdits(
      request(target, 'unpaired', [
        { from: 5, to: 5, expectedText: '', insert: '\ud800' },
      ]),
    ).status,
    'invalid',
  )
  assert.equal(operations.length, 0)
  runtime.replace('changed')
  assert.equal(
    scope.applyEdits(
      request(target, 'stale-version', [
        { from: 0, to: 1, expectedText: 'a', insert: 'A' },
      ]),
    ).status,
    'stale',
  )
  const reopened = document('reopened', { revision: 3 })
  assert.throws(() => runtime.activate(reopened), /local edits waiting/)
  assert.equal(runtime.get().markdown, 'changed')
  runtime.activate(reopened, true)
  assert.equal(scope.readSource(target).status, 'stale')
  assert.equal(
    scope.applyEdits(
      request(target, 'stale-generation', [
        { from: 0, to: 1, expectedText: 'a', insert: 'A' },
      ]),
    ).status,
    'stale',
  )
  scope.dispose()
  runtime.dispose()
})

test('request IDs deduplicate accepted edits and allow busy retries within one activation', () => {
  const { runtime, scope, operations, setBusy } = fixture()
  runtime.activate(document('a'))
  const target = scope.listOpen()[0].target
  const edit = request(target, 'same-id', [
    { from: 0, to: 1, expectedText: 'a', insert: 'A' },
  ])
  assert.deepEqual(scope.applyEdits(edit), {
    status: 'applied',
    contentVersion: 1,
  })
  assert.deepEqual(scope.applyEdits(edit), {
    status: 'applied',
    contentVersion: 1,
  })
  assert.equal(operations.length, 1)
  assert.equal(
    scope.applyEdits(
      request(target, 'same-id', [
        { from: 0, to: 1, expectedText: 'a', insert: 'B' },
      ]),
    ).status,
    'invalid',
  )
  const next = scope.listOpen()[0].target
  const later = request(next, 'retry-id', [
    { from: 1, to: 1, expectedText: '', insert: '!' },
  ])
  setBusy(true)
  assert.equal(scope.applyEdits(later).status, 'busy')
  assert.equal(
    scope.applyEdits(
      request(next, 'retry-id', [
        { from: 1, to: 1, expectedText: '', insert: '?' },
      ]),
    ).status,
    'invalid',
  )
  setBusy(false)
  assert.equal(scope.applyEdits(later).status, 'applied')
  scope.dispose()
  assert.equal(scope.applyEdits(later).status, 'disposed')
  runtime.dispose()
})

test('accepted source edit keeps its receipt if recovery reporting throws', () => {
  const runtime = new DocumentRuntime({
    enqueue() {
      throw new Error('lost transport')
    },
    onError() {
      throw new Error('observer failed')
    },
  })
  runtime.activate(document('a'))
  const scope = createDocumentTargetEditScope(runtime, () => false)
  const edit = request(scope.listOpen()[0].target, 'accepted-with-error', [
    { from: 0, to: 1, expectedText: 'a', insert: 'A' },
  ])
  assert.deepEqual(scope.applyEdits(edit), {
    status: 'applied',
    contentVersion: 1,
  })
  assert.deepEqual(scope.applyEdits(edit), {
    status: 'applied',
    contentVersion: 1,
  })
  assert.equal(runtime.get().markdown, 'A')
  scope.dispose()
  runtime.dispose()
})

test('mounted views wait for an adapter before editing behind another focused view', () => {
  const { runtime, scope } = fixture()
  const tabs = ['one', 'two'].map((id) => ({
    id,
    name: `${id}.md`,
    dirty: false,
  }))
  runtime.activate(document('first', { tabs }))
  const firstTarget = scope.listOpen()[0].target
  const unmountFirst = runtime.registerView('one', runtime.primaryViewId('one'))
  const firstView = runtime.captureView(runtime.primaryViewId('one'))
  let mounted = () => ({ status: 'unsupported-view', message: 'No adapter.' })
  const setMounted = (handler) => {
    mounted = handler
  }
  const removeAdapter = mountedDocumentEdits.register(
    'one',
    firstView,
    'source',
    (_view, input) => mounted(input),
  )
  setMounted(() => ({ status: 'applied', contentVersion: 0 }))
  assert.equal(
    scope.applyEdits({
      ...request(firstTarget, 'projection-noop', [
        { from: 0, to: 5, expectedText: 'first', insert: 'first' },
      ]),
      projectionId: projectionIdentity('source', runtime.get('one')),
    }).status,
    'applied',
  )
  const firstEdit = request(firstTarget, 'mounted-one', [
    { from: 0, to: 5, expectedText: 'first', insert: 'FIRST' },
  ])
  const forwardedIds = []
  setMounted((input) => {
    forwardedIds.push(input.requestId)
    return { status: 'applied', contentVersion: 1 }
  })
  assert.equal(scope.applyEdits(firstEdit).status, 'busy')
  let received = 0
  setMounted((input) => {
    received++
    forwardedIds.push(input.requestId)
    runtime.session('one').edit(
      input.changes.map(({ from, to, insert }) => ({ from, to, insert })),
      'addon',
      'mounted-edit',
    )
    return {
      status: 'applied',
      contentVersion: runtime.session('one').snapshot().version,
    }
  })
  assert.equal(scope.applyEdits(firstEdit).status, 'applied')
  assert.equal(received, 1)
  assert.notEqual(forwardedIds[0], forwardedIds[1])
  removeAdapter()
  runtime.activate(
    document('second', { tabId: 'two', id: 'file-two', revision: 2, tabs }),
  )
  const unmountSecond = runtime.registerView(
    'two',
    runtime.primaryViewId('two'),
  )
  runtime.focusView(runtime.primaryViewId('two'))
  const current = scope.listOpen().find((entry) => entry.name === 'one.md')
  assert.equal(
    scope.applyEdits(
      request(current.target, 'mounted-inactive', [
        { from: 0, to: 5, expectedText: 'FIRST', insert: 'First' },
      ]),
    ).status,
    'busy',
  )
  assert.equal(runtime.get('one').markdown, 'FIRST')
  assert.equal(received, 1)
  unmountFirst()
  assert.equal(
    scope.applyEdits({
      ...request(current.target, 'projection-noop-unmounted', [
        { from: 0, to: 5, expectedText: 'FIRST', insert: 'FIRST' },
      ]),
      projectionId: 'old-proof',
    }).status,
    'unsupported-view',
  )
  assert.equal(
    scope.applyEdits({
      ...request(current.target, 'projection-unmounted', [
        { from: 0, to: 5, expectedText: 'FIRST', insert: 'First' },
      ]),
      projectionId: 'from-mounted-editor',
    }).status,
    'unsupported-view',
  )
  assert.equal(runtime.get('one').markdown, 'FIRST')
  assert.equal(
    scope.applyEdits(
      request(current.target, 'mounted-inactive', [
        { from: 0, to: 5, expectedText: 'FIRST', insert: 'First' },
      ]),
    ).status,
    'applied',
  )
  unmountSecond()
  scope.dispose()
  runtime.dispose()
})

test('focused rich target keeps its own adapter after another view registers', () => {
  const { runtime, scope } = fixture()
  const tabs = ['one', 'two'].map((id) => ({
    id,
    name: `${id}.md`,
    dirty: false,
  }))
  runtime.activate(document('first', { tabs }))
  const firstViewId = runtime.primaryViewId('one')
  const unmountFirst = runtime.registerView('one', firstViewId)
  const firstView = runtime.captureView(firstViewId)
  const removeInactiveSource = mountedDocumentEdits.register(
    'one',
    firstView,
    'source',
    () => ({ status: 'unsupported-view', message: 'Source pane is inactive.' }),
  )
  let firstCalls = 0
  const removeFirst = mountedDocumentEdits.register(
    'one',
    firstView,
    'rich',
    (_view, input) => {
      firstCalls++
      const operation = runtime.session('one').edit(
        input.changes.map(({ from, to, insert }) => ({ from, to, insert })),
        'addon',
        'first-view',
      )
      return { status: 'applied', contentVersion: operation.after.version }
    },
  )
  runtime.activate(
    document('second', { tabId: 'two', id: 'file-two', revision: 2, tabs }),
  )
  const secondViewId = runtime.primaryViewId('two')
  const unmountSecond = runtime.registerView('two', secondViewId)
  const removeSecond = mountedDocumentEdits.register(
    'two',
    runtime.captureView(secondViewId),
    'source',
    () => {
      throw new Error('The other editor received this edit.')
    },
  )
  runtime.activate(runtime.get('one'))
  runtime.focusView(firstViewId)
  const target = scope.listOpen().find(({ name }) => name === 'one.md').target
  assert.deepEqual(
    scope.applyEdits(
      request(target, 'focused-owner', [
        { from: 0, to: 5, expectedText: 'first', insert: 'FIRST' },
      ]),
    ),
    { status: 'applied', contentVersion: 1 },
  )
  assert.equal(firstCalls, 1)
  assert.equal(runtime.get().markdown, 'FIRST')
  assert.equal(runtime.captureActiveView().viewId, firstViewId)
  removeSecond()
  removeFirst()
  removeInactiveSource()
  unmountSecond()
  unmountFirst()
  scope.dispose()
  runtime.dispose()
})

test('view registration binds pending adapter before notifying addons', () => {
  const { runtime, scope } = fixture()
  runtime.activate(document('first'))
  const viewId = runtime.primaryViewId('one')
  const target = { ...runtime.captureDocument('one'), viewId }
  const removeAdapter = mountedDocumentEdits.register(
    'one',
    target,
    'source',
    (_view, input) => {
      const operation = runtime.session('one').edit(
        input.changes.map(({ from, to, insert }) => ({ from, to, insert })),
        'addon',
        'view-opened',
      )
      return { status: 'applied', contentVersion: operation.after.version }
    },
  )
  let result
  const stop = runtime.subscribeViews(() => {
    if (result) return
    result = scope.applyEdits(
      request(scope.listOpen()[0].target, 'on-view-opened', [
        { from: 0, to: 5, expectedText: 'first', insert: 'FIRST' },
      ]),
    )
  })
  const unmount = runtime.registerView(
    'one',
    viewId,
    mountedDocumentEdits.bindView,
  )
  assert.deepEqual(result, { status: 'applied', contentVersion: 1 })
  assert.equal(runtime.get('one').markdown, 'FIRST')
  stop()
  removeAdapter()
  unmount()
  scope.dispose()
  runtime.dispose()
})

test('inactive mounted target routes through live view adapter without changing focus', () => {
  const { runtime, scope, operations } = fixture()
  const tabs = ['one', 'two'].map((id) => ({
    id,
    name: `${id}.md`,
    dirty: false,
  }))
  runtime.activate(document('first', { tabs }))
  const firstViewId = runtime.primaryViewId('one')
  const unmountFirst = runtime.registerView('one', firstViewId)
  const firstView = runtime.captureView(firstViewId)
  const calls = []
  const apply = (kind) => (view, input) => {
    calls.push({ kind, view, input })
    const operation = runtime.session('one').edit(
      input.changes.map(({ from, to, insert }) => ({ from, to, insert })),
      'addon',
      kind,
    )
    return { status: 'applied', contentVersion: operation.after.version }
  }
  const removeSource = mountedDocumentEdits.register(
    'one',
    firstView,
    'source',
    apply('source'),
  )
  runtime.activate(
    document('second', { tabId: 'two', id: 'file-two', revision: 2, tabs }),
  )
  const secondViewId = runtime.primaryViewId('two')
  const unmountSecond = runtime.registerView('two', secondViewId)
  runtime.focusView(secondViewId)
  const target = scope.listOpen().find(({ name }) => name === 'one.md').target
  const firstEdit = {
    ...request(target, 'inactive-source', [
      { from: 0, to: 5, expectedText: 'first', insert: 'FIRST' },
    ]),
    projectionId: projectionIdentity('source', runtime.get('one')),
  }
  assert.equal(
    scope.applyEdits({
      ...firstEdit,
      requestId: 'wrong-proof',
      projectionId: 'old',
    }).status,
    'stale',
  )
  assert.deepEqual(scope.applyEdits(firstEdit), {
    status: 'applied',
    contentVersion: 1,
  })
  assert.deepEqual(scope.applyEdits(firstEdit), {
    status: 'applied',
    contentVersion: 1,
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].view, firstView)
  assert.notEqual(calls[0].input.requestId, firstEdit.requestId)
  assert.equal(runtime.captureActiveView().viewId, secondViewId)
  assert.equal(runtime.get().markdown, 'second')
  assert.equal(runtime.get('one').markdown, 'FIRST')
  assert.equal(operations.at(-1).document.tabId, 'one')

  unmountFirst()
  const unmountReplacement = runtime.registerView('one', firstViewId)
  const replacement = runtime.captureView(firstViewId)
  assert.notEqual(replacement.viewGeneration, firstView.viewGeneration)
  const nextTarget = scope
    .listOpen()
    .find(({ name }) => name === 'one.md').target
  const nextEdit = request(nextTarget, 'replacement-rich', [
    { from: 0, to: 5, expectedText: 'FIRST', insert: 'First' },
  ])
  assert.equal(scope.applyEdits(nextEdit).status, 'busy')
  assert.equal(calls.length, 1)
  assert.equal(runtime.get('one').markdown, 'FIRST')
  const removeRich = mountedDocumentEdits.register(
    'one',
    replacement,
    'rich',
    apply('rich'),
  )
  assert.deepEqual(scope.applyEdits(nextEdit), {
    status: 'applied',
    contentVersion: 2,
  })
  assert.equal(calls[1].kind, 'rich')
  assert.equal(calls[1].view, replacement)
  assert.equal(runtime.captureActiveView().viewId, secondViewId)
  assert.equal(runtime.get().markdown, 'second')
  assert.equal(runtime.get('one').markdown, 'First')
  removeRich()
  removeSource()
  unmountReplacement()
  unmountSecond()
  scope.dispose()
  runtime.dispose()
})
