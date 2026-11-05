import assert from 'node:assert/strict'
import test from 'node:test'
import { EditorState } from '@codemirror/state'
import { ViewPlugin } from '@codemirror/view'
import { keepRead, keepReading } from '../src/renderer/src/reading-position.ts'
import { isViewDead, viewDied } from '../src/renderer/src/source-session.ts'

/**
 * A view stand-in with its caret on screen in a scrolled pane. A real view
 * whose redraw failed throws on layout reads, its tiles discarded; this one
 * counts them. `shift` moves the caret's line down, as new heights above do.
 */
function reader(t) {
  globalThis.getComputedStyle = () => ({ overflowY: 'auto', paddingLeft: '0' })
  globalThis.document = { scrollingElement: null }
  t.after(() => {
    delete globalThis.getComputedStyle
    delete globalThis.document
  })
  const pane = {
    scrollTop: 500,
    scrollHeight: 4000,
    clientHeight: 600,
    parentElement: null,
    getBoundingClientRect: () => ({ top: 0, bottom: 600 }),
  }
  let top = 100
  const doc = 'line\n'.repeat(100)
  const view = {
    state: EditorState.create({ doc, selection: { anchor: 50 } }),
    viewport: { from: 0, to: doc.length },
    visibleRanges: [{ from: 0, to: 10 }],
    inView: true,
    composing: false,
    documentTop: -500,
    scrollDOM: pane,
    dom: { isConnected: true },
    deadReads: 0,
    coordsAtPos() {
      if (isViewDead(view)) view.deadReads++
      return { top, bottom: top + 16 }
    },
    lineBlockAt: () => ({ from: 50, top: 600 }),
  }
  return {
    view,
    pane,
    box: () => ({ top, bottom: top + 16 }),
    shift: (by) => (top += by),
  }
}

/** Drive the registered callbacks while React has not yet destroyed the dead view. */
function topReader(t) {
  const reading = reader(t)
  const { view, box } = reading
  const node = { nodeType: 3, nodeValue: 'x', parentNode: null }
  globalThis.Node = { TEXT_NODE: 3 }
  let resized
  globalThis.ResizeObserver = class {
    constructor(callback) {
      resized = callback
    }
    observe() {}
    disconnect() {}
  }
  t.after(() => {
    delete globalThis.Node
    delete globalThis.ResizeObserver
  })
  view.visibleRanges = [{ from: 0, to: view.state.doc.length }]
  view.contentDOM = {
    contains: (other) => other === node,
    getBoundingClientRect: () => ({ left: 0 }),
  }
  view.dom.ownerDocument = {
    elementFromPoint: () => null,
    caretPositionFromPoint: () => ({ offsetNode: node, offset: 0 }),
    createRange: () => ({
      setStart() {},
      setEnd() {},
      getClientRects: () => [box()],
    }),
  }
  view.posAtDOM = () => 50
  view.domAtPos = () => {
    if (isViewDead(view)) view.deadReads++
    return { node, offset: 0 }
  }
  view.lineBlockAt = () => ({ from: 50, top: 600, height: 4000 })
  // CodeMirror has no public way to invoke these on a stand-in view.
  const plugins = keepRead.filter(
    (extension) => extension instanceof ViewPlugin,
  )
  for (const plugin of plugins) {
    const value = plugin.create(view)
    t.after(() => value.destroy?.())
  }
  return {
    ...reading,
    scroll: () =>
      plugins
        .find((plugin) => plugin.domEventObservers?.scroll)
        .domEventObservers.scroll(null, view),
    resize: () => resized(),
  }
}

test('a live view scrolls back to the place read before its layout moved', async (t) => {
  const { view, pane, shift } = reader(t)
  keepReading(view)
  shift(40)
  await Promise.resolve()
  assert.equal(pane.scrollTop, 540)
})

test('a view that dies before its queued restore is neither read nor scrolled', async (t) => {
  const { view, pane, shift } = reader(t)
  keepReading(view)
  shift(40)
  viewDied(view, new Error('decorations boom'))
  await Promise.resolve()
  assert.equal(view.deadReads, 0)
  assert.equal(pane.scrollTop, 500)
})

test('a dead view is not read for a reading place', async (t) => {
  const { view, pane } = reader(t)
  viewDied(view, new Error('decorations boom'))
  keepReading(view)
  await Promise.resolve()
  assert.equal(view.deadReads, 0)
  assert.equal(pane.scrollTop, 500)
})

test('a live view holds text at the pane top through a resize', (t) => {
  const { pane, scroll, resize, shift } = topReader(t)
  scroll()
  shift(40)
  resize()
  assert.equal(pane.scrollTop, 540)
})

test('a dead view is not read by its scroll observer', (t) => {
  const { view, pane, scroll } = topReader(t)
  viewDied(view, new Error('decorations boom'))
  scroll()
  assert.equal(view.deadReads, 0)
  assert.equal(pane.scrollTop, 500)
})

test('a view that dies with text held at the top is not read or scrolled on resize', (t) => {
  const { view, pane, scroll, resize, shift } = topReader(t)
  scroll()
  shift(40)
  viewDied(view, new Error('decorations boom'))
  resize()
  assert.equal(view.deadReads, 0)
  assert.equal(pane.scrollTop, 500)
})
