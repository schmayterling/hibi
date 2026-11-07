import assert from 'node:assert/strict'
import test from 'node:test'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView, ViewPlugin } from '@codemirror/view'
import { keepRead, keepReading } from '../src/renderer/src/reading-position.ts'
import { isViewDead, viewDied } from '../src/renderer/src/source-session.ts'

/** An element whose scroll stays within what it scrolls, as a page's does. */
function scrolling(scrollTop, scrollHeight) {
  return {
    scrollHeight,
    clientHeight: 600,
    parentElement: null,
    getBoundingClientRect: () => ({ top: 0, bottom: 600 }),
    get scrollTop() {
      return scrollTop
    },
    set scrollTop(top) {
      const end = Math.max(this.scrollHeight - this.clientHeight, 0)
      scrollTop = Math.min(Math.max(top, 0), end)
    },
  }
}

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
  const pane = scrolling(500, 4000)
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

const registered = EditorState.create({ extensions: keepRead })
const listeners = registered.facet(EditorView.updateListener)
const scrollHandlers = registered.facet(EditorView.scrollHandler)
/** What CodeMirror tells the module after a measure with new heights. */
function measured(view, transactions = []) {
  for (const listener of listeners)
    listener({
      view,
      transactions,
      docChanged: false,
      selectionSet: false,
      geometryChanged: false,
      heightChanged: true,
      viewportChanged: false,
    })
}
/** A place kept 3000 px down, then the text above it 1500 px shorter. */
async function shrunk(reading) {
  reading.pane.scrollTop = 3000
  keepReading(reading.view)
  await Promise.resolve()
  clamp(reading)
}
function clamp({ pane, shift }) {
  pane.scrollHeight = 2500
  pane.scrollTop = 1900
  shift(-400)
}

test('a shorter layout that clamps the pane keeps the place', async (t) => {
  const reading = reader(t)
  await shrunk(reading)
  measured(reading.view)
  assert.equal(reading.pane.scrollTop, 1500)
})

test('a scroll command in the update that clamps the pane stands', async (t) => {
  const reading = reader(t)
  await shrunk(reading)
  measured(reading.view, [reading.view.state.update({ scrollIntoView: true })])
  assert.equal(reading.pane.scrollTop, 1900)
})

test('a clamp does not read as a new place at the pane top', async (t) => {
  const reading = topReader(t)
  await shrunk(reading)
  reading.scroll()
  // Room to move, had the scroll held the top of this clamped pane.
  reading.pane.scrollHeight += 40
  reading.shift(40)
  reading.resize()
  assert.equal(reading.pane.scrollTop, 1900)
})

test('after a clamp under new text the pane top is read again', async (t) => {
  const reading = topReader(t)
  await shrunk(reading)
  reading.view.state = EditorState.create({
    doc: reading.view.state.doc.toString(),
  })
  reading.scroll()
  // The text above grows back, so the pane has room to follow it.
  reading.pane.scrollHeight += 40
  reading.shift(40)
  reading.resize()
  assert.equal(reading.pane.scrollTop, 1940)
})

test('a read after a clamp returns to the place held', async (t) => {
  const reading = reader(t)
  await shrunk(reading)
  reading.view.lineBlockAtHeight = () => ({ from: 50, top: 600 })
  keepReading(reading.view)
  await Promise.resolve()
  assert.equal(reading.pane.scrollTop, 1500)
})

for (const [when, react] of [
  ['resize', ({ resize }) => resize()],
  ['update', ({ view }) => measured(view)],
])
  test(`a clamp keeps text held at the pane top through a later ${when}`, (t) => {
    const reading = topReader(t)
    reading.pane.scrollTop = 3000
    reading.scroll()
    clamp(reading)
    react(reading)
    assert.equal(reading.pane.scrollTop, 1500)
  })

test('a clamp of another pane does not hold the place', async (t) => {
  const reading = topReader(t)
  await shrunk(reading)
  const pane = scrolling(100, 4000)
  reading.view.scrollDOM = pane
  reading.scroll()
  reading.shift(40)
  reading.resize()
  assert.equal(pane.scrollTop, 140)
})

test('a new pane at the same scroll reads its own top', (t) => {
  const { view, pane, scroll, resize, shift } = topReader(t)
  scroll()
  const next = scrolling(500, 4000)
  view.scrollDOM = next
  scroll()
  shift(40)
  resize()
  assert.equal(next.scrollTop, 540)
  assert.equal(pane.scrollTop, 500)
})

test('new text at the same scroll reads the pane top again', (t) => {
  const { view, pane, scroll, resize, shift } = topReader(t)
  scroll()
  view.state = EditorState.create({ doc: view.state.doc.toString() })
  scroll()
  shift(40)
  resize()
  assert.equal(pane.scrollTop, 540)
})

for (const [kind, spec] of [
  ['flag', { scrollIntoView: true }],
  ['effect', { effects: EditorView.scrollIntoView(0) }],
]) {
  test(`a finished scroll command by ${kind} that moves nothing keeps the place held`, (t) => {
    const { view, pane, scroll, resize, shift } = topReader(t)
    scroll()
    measured(view, [view.state.update(spec)])
    for (const handler of scrollHandlers)
      handler(view, EditorSelection.cursor(50), {})
    shift(40)
    resize()
    assert.equal(pane.scrollTop, 540)
  })

  test(`a scroll command by ${kind} in a clamping update ends the place held`, (t) => {
    const reading = topReader(t)
    reading.pane.scrollTop = 3000
    reading.scroll()
    clamp(reading)
    measured(reading.view, [reading.view.state.update(spec)])
    reading.resize()
    assert.equal(reading.pane.scrollTop, 1900)
  })
}

for (const [where, top] of [
  ['up', 300],
  ['down to the end', 3400],
])
  test(`a reader's scroll ${where} ends the place held`, (t) => {
    const { view, pane, scroll, resize, shift } = topReader(t)
    scroll()
    pane.scrollTop = top
    measured(view)
    shift(-40)
    resize()
    assert.equal(pane.scrollTop, top)
  })

test('a pane that hides is not read as clamped', (t) => {
  const { view, pane, scroll, resize } = topReader(t)
  scroll()
  pane.clientHeight = 0
  pane.scrollHeight = 0
  pane.scrollTop = 0
  view.inView = false
  let reads = 0
  for (const read of ['coordsAtPos', 'domAtPos']) {
    const original = view[read]
    view[read] = (...args) => {
      reads++
      return original(...args)
    }
  }
  resize()
  assert.equal(reads, 0)
  assert.equal(pane.scrollTop, 0)
})

test('a place given up stays given up once the pane is at the end', (t) => {
  const { view, pane, scroll, resize, shift } = topReader(t)
  scroll()
  pane.scrollTop = 300
  measured(view)
  pane.scrollHeight = 700
  pane.scrollTop = 100
  shift(-40)
  resize()
  assert.equal(pane.scrollTop, 100)
})

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

for (const [queued, throws] of [
  [false, false],
  [true, false],
  [false, true],
])
  test(`a view that dies in its ${queued ? 'queued' : 'resize'} restore measure${throws ? ' and throws' : ''} is not read or scrolled`, async (t) => {
    const { view, pane, box, scroll, resize, shift } = queued
      ? reader(t)
      : topReader(t)
    if (queued) keepReading(view)
    else scroll()
    shift(40)
    const coords = view.coordsAtPos
    view.coordsAtPos = () => {
      view.coordsAtPos = coords
      viewDied(view, new Error('widget boom'))
      if (throws) throw new Error('discarded tiles')
      return box()
    }
    if (queued) await Promise.resolve()
    else resize()
    assert.equal(view.deadReads, 0)
    assert.equal(pane.scrollTop, 500)
  })

test('a live view still reports an error from its resize restore measure', (t) => {
  const { view, scroll, resize } = topReader(t)
  scroll()
  const error = new Error('layout boom')
  view.coordsAtPos = () => {
    throw error
  }
  assert.throws(resize, (thrown) => thrown === error)
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
