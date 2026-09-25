import assert from 'node:assert/strict'
import test from 'node:test'
import { DocumentRuntime } from '../src/renderer/src/document-runtime.ts'
import {
  createEditorViewScope,
  EditorViewRegistry,
} from '../src/renderer/src/editor-view-api.ts'

const document = (text, overrides = {}) => ({
  tabId: 'one',
  tabs: [{ id: 'one', name: 'one.md', dirty: false }],
  tabsEnabled: true,
  id: 'file-one',
  ephemeral: false,
  markdown: text,
  savedMarkdown: text,
  name: 'one.md',
  dirty: false,
  revision: 1,
  contentVersion: 0,
  canAutosave: true,
  ...overrides,
})

function fixture() {
  const errors = []
  const runtime = new DocumentRuntime({
    enqueue: () => {},
    onError: (error) => errors.push(error),
  })
  runtime.activate(document('abc'))
  const registry = new EditorViewRegistry(runtime)
  const scope = createEditorViewScope(runtime, registry)
  const viewId = runtime.primaryViewId('one')
  return { runtime, registry, scope, viewId, errors }
}

function adapter(version = 0, length = 3) {
  let anchor = 0
  let head = 0
  const revealed = []
  return {
    revealed,
    read: () => ({ contentVersion: version, anchor, head, length }),
    setSelection(nextAnchor, nextHead) {
      anchor = nextAnchor
      head = nextHead
      return true
    },
    reveal(position) {
      revealed.push(position)
      return true
    },
  }
}

test('view api lists mounted identities and tracks active and primary selection', () => {
  const { runtime, registry, scope, viewId, errors } = fixture()
  const active = []
  const selections = []
  const stopActive = scope.onDidChangeActive((view) => active.push(view))
  const stopSelection = scope.onDidChangeSelection((value) =>
    selections.push(value),
  )
  const source = adapter()
  const unregisterAdapter = registry.register('one', viewId, 'source', source)
  registry.setActive(viewId, 'source')
  const unmount = runtime.registerView('one', viewId)
  const view = scope.getActive()
  assert.equal(scope.list().length, 1)
  assert.equal(view.viewId, viewId)
  assert.deepEqual(active, [view])
  assert.equal(scope.getSelection(view).value.editor, 'source')
  assert.equal(selections.length, 1)
  assert.equal(selections[0].anchor, 0)

  const moved = { ...selections[0], anchor: 1, head: 3 }
  assert.deepEqual(scope.setSelection(moved), { ok: true, value: undefined })
  registry.changed(viewId, 'source')
  assert.equal(selections.length, 2)
  assert.equal(selections[1].anchor, 1)
  assert.equal(selections[1].head, 3)
  assert.deepEqual(
    scope.reveal({ view, editor: 'source', contentVersion: 0, position: 2 }),
    { ok: true, value: undefined },
  )
  assert.deepEqual(source.revealed, [2])

  unmount()
  assert.deepEqual(scope.list(), [])
  assert.equal(scope.getActive(), null)
  assert.equal(active.at(-1), null)
  assert.equal(selections.at(-1), null)
  assert.equal(scope.getSelection(view).code, 'stale')
  unregisterAdapter()
  stopActive()
  stopSelection()
  assert.deepEqual(errors, [])
  runtime.dispose()
})

test('view api rejects stale generations, versions, and pane switches', () => {
  const { runtime, registry, scope, viewId } = fixture()
  const source = adapter()
  const rich = adapter()
  const stopSource = registry.register('one', viewId, 'source', source)
  const stopRich = registry.register('one', viewId, 'rich', rich)
  registry.setActive(viewId, 'source')
  const unmount = runtime.registerView('one', viewId)
  const original = scope.getSelection(scope.getActive()).value
  assert.equal(
    scope.setSelection({ ...original, anchor: 4, head: 4 }).code,
    'conflict',
  )
  assert.equal(scope.getSelection({ ...original.view, viewGeneration: 99 }).code, 'stale')
  assert.equal(scope.getSelection({ viewId }).code, 'conflict')
  registry.setActive(viewId, 'rich')
  assert.equal(scope.setSelection(original).code, 'stale')
  assert.equal(scope.getSelection(original.view).value.editor, 'rich')
  runtime.replace('abcd')
  assert.equal(scope.getSelection(original.view).code, 'stale')
  assert.equal(scope.reveal({ ...original, position: 1 }).code, 'stale')
  unmount()
  stopSource()
  stopRich()
  const remount = runtime.registerView('one', viewId)
  assert.equal(scope.getSelection(original.view).code, 'stale')
  remount()
  runtime.dispose()
})

test('view subscriptions and operations stop with addon activation', () => {
  const { runtime, registry, scope, viewId } = fixture()
  const source = adapter()
  registry.register('one', viewId, 'source', source)
  registry.setActive(viewId, 'source')
  const unmount = runtime.registerView('one', viewId)
  let changes = 0
  scope.onDidChangeSelection(() => changes++)
  const selection = scope.getSelection(scope.getActive()).value
  scope.dispose()
  assert.deepEqual(scope.list(), [])
  assert.equal(scope.getActive(), null)
  assert.equal(scope.setSelection(selection).code, 'disposed')
  assert.equal(scope.reveal({ ...selection, position: 1 }).code, 'disposed')
  registry.changed(viewId, 'source')
  unmount()
  assert.equal(changes, 0)
  runtime.dispose()
})

test('active-view subscription follows focus between live views', () => {
  const { runtime, registry, scope, viewId } = fixture()
  const first = runtime.registerView('one', viewId)
  const events = []
  scope.onDidChangeActive((view) => events.push(view?.viewId ?? null))
  const tabs = [
    { id: 'one', name: 'one.md', dirty: false },
    { id: 'two', name: 'two.md', dirty: false },
  ]
  runtime.activate(
    document('two', {
      tabId: 'two',
      id: 'file-two',
      name: 'two.md',
      revision: 2,
      tabs,
    }),
  )
  const secondId = runtime.primaryViewId('two')
  registry.setActive(secondId, 'source')
  const second = runtime.registerView('two', secondId)
  assert.equal(scope.getActive().viewId, viewId)
  runtime.focusView(secondId)
  assert.equal(scope.getActive().viewId, secondId)
  assert.deepEqual(events, [secondId])
  second()
  assert.equal(scope.getActive(), null)
  assert.deepEqual(events, [secondId, null])
  first()
  runtime.dispose()
})
