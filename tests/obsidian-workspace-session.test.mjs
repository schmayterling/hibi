import assert from 'node:assert/strict'
import test from 'node:test'
import { DocumentRuntime } from '../src/renderer/src/document-runtime.ts'
import {
  captureWorkspaceUi,
  restoreWorkspaceUi,
} from '../src/renderer/src/workspace-session.ts'

const tabs = ['one', 'two', 'three'].map((id) => ({
  id,
  name: `${id}.md`,
  dirty: true,
}))
const document = (tabId, text = 'saved\r\n😀 unsaved\r\nlast') => ({
  tabId,
  tabs,
  tabsEnabled: true,
  id: `file-${tabId}`,
  name: `${tabId}.md`,
  ephemeral: false,
  markdown: text,
  savedMarkdown: 'saved',
  dirty: true,
  revision: 3,
  contentVersion: 7,
  canAutosave: true,
})
const selection = (anchor, head = anchor) => ({
  ranges: [{ anchor, head, association: 1 }],
  mainIndex: 0,
})
const shell = () => ({
  split: {
    left: 'one',
    right: 'two',
    active: 'right',
    leftMode: 'markdown',
    rightMode: 'side-by-side',
  },
  selectedMode: 'side-by-side',
  settings: { open: true, category: 'addons' },
  sidebar: { left: true, right: false, zen: false },
})
function fixture() {
  const runtime = new DocumentRuntime({
    enqueue() {},
    onError(error) {
      throw error
    },
  })
  for (const { id } of tabs) runtime.activate(document(id))
  runtime.focus(runtime.get('two'))
  return runtime
}
function bookmark(runtime, tab, id, at, margin) {
  const session = runtime.session(tab)
  session.select(selection(at, at + 1), 7, id)
  session.select(selection(at), 7, `${id}\0top`)
  session.keptMargins.set(id, margin)
  session.keptMargins.set(`${id}:workspace-left`, 43)
}

test('capture includes inactive and split raw multi-carets and scroll without reading source', () => {
  const runtime = fixture()
  bookmark(runtime, 'one', 'left:source', 9, -12.5)
  bookmark(runtime, 'two', 'right', 10, 4)
  const primary = runtime.primaryViewId('three')
  bookmark(runtime, 'three', primary, 16, -7)
  runtime.session('three').select(
    {
      ranges: [
        { anchor: 1, head: 3, association: -1 },
        { anchor: 9, head: 10, association: 1 },
      ],
      mainIndex: 1,
    },
    7,
    primary,
  )
  const before = runtime
    .documents()
    .map((doc) => runtime.session(doc.tabId).counters().materializations)
  const ui = captureWorkspaceUi(runtime, shell())
  assert.equal(ui.version, 1)
  assert.equal(ui.activeTab, 'two')
  assert.deepEqual(ui.split, shell().split)
  assert.deepEqual(ui.tabs.map((tab) => tab.tabId).sort(), [
    'one',
    'three',
    'two',
  ])
  const inactive = ui.tabs.find((tab) => tab.tabId === 'three').views[0]
  assert.equal(inactive.id, 'primary')
  assert.equal(inactive.margin, -7)
  assert.equal(inactive.scrollLeft, 43)
  assert.equal(inactive.selection.mainIndex, 1)
  assert.equal(inactive.selection.ranges[1].anchor, 9)
  assert.doesNotMatch(
    JSON.stringify(ui),
    /saved|markdown":|savedMarkdown|contentDOM/,
  )
  assert.deepEqual(
    runtime
      .documents()
      .map((doc) => runtime.session(doc.tabId).counters().materializations),
    before,
  )
  runtime.dispose()
})

test('restore retains bootstrap buffer, hydrates every dirty tab, remaps primary view and accepts active last', () => {
  const old = fixture()
  bookmark(old, 'one', 'left:source', 9, -12.5)
  bookmark(old, 'two', 'right', 10, 4)
  bookmark(old, 'three', old.primaryViewId('three'), 16, -7)
  const ui = JSON.parse(
    JSON.stringify(captureWorkspaceUi(old, shell(), 'source')),
  )
  assert.equal(ui.activeEditor, 'source')
  const next = new DocumentRuntime({ enqueue() {}, onError: assert.fail })
  next.activate(document('two'))
  const bootstrap = next.session('two')
  const accepted = []
  const state = restoreWorkspaceUi(
    next,
    ui,
    tabs.map(({ id }) => document(id)),
    (doc) => {
      assert.equal(next.documents().length, 3)
      assert.equal(
        next.session('one').selection('left:source').ranges[0].anchor,
        9,
      )
      assert.equal(
        next.session('three').keptMargins.get(next.primaryViewId('three')),
        -7,
      )
      accepted.push(doc.tabId)
    },
  )
  assert.equal(next.session('two'), bootstrap)
  assert.equal(
    next.session('one').selection('left:source\0top').ranges[0].head,
    9,
  )
  assert.equal(
    next.session('three').selection(`${next.primaryViewId('three')}\0top`)
      .ranges[0].head,
    16,
  )
  assert.equal(
    next.session('one').keptMargins.get('left:source:workspace-left'),
    43,
  )
  assert.equal(next.get().tabId, 'two')
  assert.deepEqual(accepted, ['two'])
  assert.deepEqual(state, shell())
  for (const { id } of tabs) {
    assert.equal(next.get(id).markdown, document(id).markdown)
    assert.equal(next.get(id).savedMarkdown, 'saved')
    assert.equal(next.get(id).dirty, true)
  }
  old.dispose()
  next.dispose()
})

test('same document split keeps independent carets and scroll for each editor', () => {
  const runtime = fixture()
  runtime.focus(runtime.get('one'))
  const state = shell()
  state.split.right = 'one'
  bookmark(runtime, 'one', 'left', 1, -3)
  bookmark(runtime, 'one', 'left:source', 9, -5)
  bookmark(runtime, 'one', 'right', 10, -11)
  bookmark(runtime, 'one', 'right:source', 16, -19)
  const ui = captureWorkspaceUi(runtime, state)
  const next = fixture()
  restoreWorkspaceUi(
    next,
    ui,
    tabs.map(({ id }) => document(id)),
    () => {},
  )
  for (const id of ['left', 'left:source', 'right', 'right:source']) {
    assert.deepEqual(
      next.session('one').selection(id),
      runtime.session('one').selection(id),
    )
    assert.equal(
      next.session('one').keptMargins.get(id),
      runtime.session('one').keptMargins.get(id),
    )
  }
  runtime.dispose()
  next.dispose()
})

test('inactive scroll bookmark maps through another pane edit before capture', () => {
  const runtime = fixture()
  const primary = runtime.primaryViewId('three')
  bookmark(runtime, 'three', primary, 16, -7)
  runtime
    .session('three')
    .edit([{ from: 0, to: 0, insert: 'new ' }], 'addon', 'typing')
  const ui = captureWorkspaceUi(runtime, shell())
  const view = ui.tabs.find((tab) => tab.tabId === 'three').views[0]
  assert.equal(view.top.ranges[0].head, 20)
  assert.equal(view.selection.ranges[0].head, 21)
  runtime.dispose()
})

test('scroll bookmarks follow primary view renames when split opens or closes', () => {
  const runtime = fixture()
  const session = runtime.session('one')
  const primary = runtime.primaryViewId('one')
  bookmark(runtime, 'one', primary, 1, -9)
  session.select(selection(1), 7, `${primary}:workspace-top`)
  session.renameView(primary, 'left')
  let ui = captureWorkspaceUi(runtime, shell())
  let view = ui.tabs.find((tab) => tab.tabId === 'one').views[0]
  assert.equal(view.id, 'left')
  assert.equal(view.top.ranges[0].head, 1)
  assert.equal(view.margin, -9)
  session.renameView('left', primary)
  ui = captureWorkspaceUi(runtime, { ...shell(), split: null })
  view = ui.tabs.find((tab) => tab.tabId === 'one').views[0]
  assert.equal(view.id, 'primary')
  assert.equal(view.top.ranges[0].head, 1)
  assert.equal(view.scrollLeft, 43)
  runtime.dispose()
})

test('capture refuses oversized caret metadata without copying note text', () => {
  const runtime = fixture()
  const many = {
    ranges: Array.from({ length: 10_000 }, () => ({
      anchor: 1,
      head: 1,
      association: 1,
    })),
    mainIndex: 0,
  }
  for (const [tab, base] of [
    ['one', 'left'],
    ['two', 'right'],
    ['three', runtime.primaryViewId('three')],
  ])
    for (const key of [base, `${base}:source`])
      runtime.session(tab).select(many, 7, key)
  assert.throws(
    () => captureWorkspaceUi(runtime, shell()),
    /workspace session/i,
  )
  runtime.dispose()
})

test('image mode survives without treating source metadata as image bytes', () => {
  const runtime = fixture()
  const state = shell()
  state.selectedMode = 'image'
  state.split.rightMode = 'image'
  const ui = captureWorkspaceUi(runtime, state)
  assert.deepEqual(
    restoreWorkspaceUi(
      runtime,
      ui,
      tabs.map(({ id }) => document(id)),
      () => {},
    ),
    state,
  )
  runtime.dispose()
})

test('zero-tab start draft survives without manufacturing an open tab', () => {
  const runtime = new DocumentRuntime({ enqueue() {}, onError: assert.fail })
  const start = {
    ...document('start', ''),
    tabs: [],
    savedMarkdown: '',
    dirty: false,
  }
  runtime.activate(start)
  const state = { ...shell(), split: null }
  const ui = captureWorkspaceUi(runtime, state)
  const next = new DocumentRuntime({ enqueue() {}, onError: assert.fail })
  restoreWorkspaceUi(next, ui, [start], () => {})
  assert.equal(next.get().tabId, 'start')
  assert.deepEqual(next.get().tabs, [])
  runtime.dispose()
  next.dispose()
})

for (const [name, mutate] of [
  [
    'unknown version',
    (ui) => {
      ui.version = 2
    },
  ],
  [
    'missing active tab',
    (ui) => {
      ui.activeTab = 'gone'
    },
  ],
  [
    'missing split tab',
    (ui) => {
      ui.split.left = 'gone'
    },
  ],
  [
    'wrong active split',
    (ui) => {
      ui.split.active = 'left'
    },
  ],
  [
    'unknown mode',
    (ui) => {
      ui.selectedMode = 'unknown'
    },
  ],
  [
    'unknown editor',
    (ui) => {
      ui.activeEditor = 'unknown'
    },
  ],
  [
    'wrong view owner',
    (ui) => {
      ui.tabs[0].views[0].id = 'right'
    },
  ],
  [
    'nonfinite horizontal scroll',
    (ui) => {
      ui.tabs[0].views[0].scrollLeft = NaN
    },
  ],
  [
    'repeated view',
    (ui) => {
      ui.tabs[0].views.push(ui.tabs[0].views[0])
    },
  ],
  [
    'stale source version',
    (ui) => {
      ui.tabs[0].contentVersion++
    },
  ],
  [
    'repeated tab',
    (ui) => {
      ui.tabs.push(ui.tabs[0])
    },
  ],
  [
    'character-splitting caret',
    (ui) => {
      ui.tabs[0].views[0].selection = selection(8)
    },
  ],
  [
    'nonfinite margin',
    (ui) => {
      ui.tabs[0].views[0].margin = Infinity
    },
  ],
  [
    'oversized UI',
    (ui) => {
      ui.untrusted = 'x'.repeat(2 * 1024 * 1024)
    },
  ],
]) {
  test(`restore rejects ${name} before accepting a document`, () => {
    const runtime = fixture()
    bookmark(runtime, 'one', 'left', 1, -3)
    const ui = captureWorkspaceUi(runtime, shell())
    mutate(ui)
    const next = fixture()
    let accepted = false
    assert.throws(
      () =>
        restoreWorkspaceUi(
          next,
          ui,
          tabs.map(({ id }) => document(id)),
          () => {
            accepted = true
          },
        ),
      /workspace session/i,
    )
    assert.equal(accepted, false)
    runtime.dispose()
    next.dispose()
  })
}

test('restore refuses inconsistent duplicate transfers and missing retained buffers', () => {
  const runtime = fixture()
  const ui = captureWorkspaceUi(runtime, shell())
  assert.throws(
    () => restoreWorkspaceUi(runtime, ui, [document('one')], () => {}),
    /workspace session/i,
  )
  assert.throws(
    () =>
      restoreWorkspaceUi(
        runtime,
        ui,
        [...tabs.map(({ id }) => document(id)), document('one')],
        () => {},
      ),
    /workspace session/i,
  )
  runtime.dispose()
})
