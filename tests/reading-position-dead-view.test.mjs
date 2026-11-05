import assert from 'node:assert/strict'
import test from 'node:test'
import { EditorState } from '@codemirror/state'
import { keepReading } from '../src/renderer/src/reading-position.ts'
import { isViewDead, viewDied } from '../src/renderer/src/source-session.ts'

/**
 * A view stand-in with its caret on screen in a scrolled pane. A real view
 * whose redraw failed throws on layout reads, its tiles discarded; this one
 * counts them. `shift` moves the caret's line down, as new heights above do.
 */
function reader(t) {
  globalThis.getComputedStyle = () => ({ overflowY: 'auto' })
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
  return { view, pane, shift: (by) => (top += by) }
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
