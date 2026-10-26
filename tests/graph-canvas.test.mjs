import assert from 'node:assert/strict'
import test from 'node:test'
import { createLayout } from '../src/addons/graph/layout.ts'
import { pageSteps, piece } from '../src/addons/graph/page-step.ts'
import {
  cameraPosition,
  drawGraph,
  graphTopology,
  nodeAt,
  spatialIndex,
} from '../src/addons/graph/scene.ts'

const palette = {
  edge: 'edge',
  node: 'node',
  border: 'border',
  activeNode: 'active',
  activeBorder: 'active-border',
  label: 'label',
  activeLabel: 'active-label',
  font: '11px Geist',
}

function denseGraph(notes, links) {
  const nodes = Array.from({ length: notes }, (_, index) => ({
    id: `n${index}.md`,
    label: `n${index}`,
    degree: 0,
  }))
  const edges = []
  for (let index = 0; edges.length < links; index++)
    edges.push({
      source: nodes[index % notes].id,
      target: nodes[(index * 7 + 1) % notes].id,
    })
  return { nodes, edges }
}

/** Counts the calls that put pixels on the canvas. */
function countingContext(width, height) {
  const counts = { fill: 0, stroke: 0, fillText: 0, clearRect: 0, path: 0 }
  const context = {
    canvas: { width, height },
    setTransform() {},
    beginPath() {},
    moveTo() {
      counts.path++
    },
    lineTo() {
      counts.path++
    },
    arc() {},
    fill() {
      counts.fill++
    },
    stroke() {
      counts.stroke++
    },
    fillText() {
      counts.fillText++
    },
    clearRect() {
      counts.clearRect++
    },
  }
  return { context, counts }
}

test('5,000 notes and 20,000 links draw in a few paths', () => {
  const graph = graphTopology(denseGraph(5000, 20000))
  const positions = new Float32Array(10000)
  // A square grid 40 units apart, like a settled layout.
  for (let index = 0; index < 5000; index++) {
    positions[index * 2] = (index % 71) * 40 - 1400
    positions[index * 2 + 1] = Math.floor(index / 71) * 40 - 1400
  }
  const draw = (view, size) => {
    const { context, counts } = countingContext(size.width * 2, size.height * 2)
    drawGraph(context, {
      graph,
      positions,
      view,
      size,
      ratio: 2,
      highlighted: [3, 3, 9],
      palette,
    })
    return counts
  }
  // Every note in view and none touching: one edge path and two dot paths.
  const spread = draw(
    { x: 0, y: 0, scale: 0.2, centered: null },
    { width: 600, height: 600 },
  )
  assert.deepEqual(
    { fill: spread.fill, stroke: spread.stroke, fillText: spread.fillText },
    { fill: 2, stroke: 3, fillText: 0 },
  )
  assert.ok(spread.path > 20000)
  // Fitted into 400 px every dot touches its row and column neighbors; two
  // alternating groups keep touching dots apart, so paths stay few.
  const size = { width: 400, height: 400 }
  const packed = draw(
    cameraPosition(null, graph, positions, size, null, 8),
    size,
  )
  assert.equal(packed.fillText, 0)
  assert.equal(packed.fill, 3)
  assert.equal(packed.stroke, 4)
  // Zoomed in, labels appear only for notes near the view.
  const zoomed = draw({ x: 0, y: 0, scale: 1, centered: null }, size)
  assert.ok(zoomed.fillText > 0)
  assert.ok(zoomed.fillText < 300, `${zoomed.fillText} labels`)
  assert.equal(zoomed.fill, zoomed.fillText)
  assert.ok(zoomed.path < spread.path)
})

test('touching dots never share a path, so each border sits under the dots above it', () => {
  const graph = graphTopology({
    nodes: Array.from({ length: 100 }, (_, index) => ({
      id: `${index}.md`,
      label: String(index),
      degree: 0,
    })),
    edges: [],
  })
  // At half scale 0 and 2 each touch 1 but not each other; the rest are apart.
  const positions = new Float32Array(200)
  positions.set([0, 0, 8, 0, 16, 0])
  for (let index = 3; index < 100; index++) {
    positions[index * 2] = -350 + (index % 18) * 40
    positions[index * 2 + 1] = 100 + Math.floor(index / 18) * 40
  }
  const paths = []
  let current = []
  const context = {
    ...countingContext(400, 400).context,
    beginPath() {
      current = []
    },
    arc(x) {
      current.push(x)
    },
    fill() {
      paths.push(current)
    },
  }
  drawGraph(context, {
    graph,
    positions,
    view: { x: 0, y: 0, scale: 0.5, centered: null },
    size: { width: 400, height: 400 },
    ratio: 1,
    highlighted: [],
    palette,
  })
  // 0 and 2 do not touch and share the first path with the separate dots.
  assert.deepEqual(
    paths.map((path) => path.length),
    [99, 1],
  )
  assert.deepEqual(paths[0].slice(0, 2), [0, 16])
  assert.deepEqual(paths[1], [8])
})

test('hit-testing finds the closest dot or its label through the grid', () => {
  const graph = graphTopology({
    nodes: [
      { id: 'a.md', label: 'a', degree: 1 },
      { id: 'b.md', label: 'b', degree: 1 },
      { id: 'far.md', label: 'far', degree: 0 },
    ],
    edges: [{ source: 'a.md', target: 'b.md' }],
  })
  const positions = Float32Array.of(0, 0, 30, 0, 5000, 5000)
  const index = spatialIndex(positions)
  const view = { x: 0, y: 0, scale: 1, centered: null }
  const label = () => ({ width: 20, ascent: 9, descent: 3 })
  const at = (x, y, scale = 1) =>
    nodeAt(graph, positions, index, { ...view, scale }, x, y, label)
  assert.equal(at(1, 1), 0)
  assert.equal(at(29, -2), 1)
  assert.equal(at(4999, 5003), 2)
  assert.equal(at(15, 20), -1)
  // Small graphs show labels 14 units above each dot.
  assert.equal(at(25, -16), 1)
  // Zoomed far out, dots keep a 2.5 px target.
  assert.equal(at(5000 + 200, 5000, 0.01), 2)
})

function run(graph, reduced, returnBuffers = true) {
  return new Promise((resolve) => {
    const frames = []
    const layout = createLayout((frame) => {
      frames.push(frame)
      if (frame.settled) resolve({ frames, layout })
      else if (returnBuffers)
        setImmediate(() =>
          layout.receive({ type: 'buffer', buffer: frame.positions.buffer }),
        )
    })
    const topology = graphTopology(graph)
    layout.receive({
      type: 'graph',
      version: 1,
      edges: topology.edges,
      positions: new Float32Array(topology.nodes.length * 2).fill(Number.NaN),
      reduced,
    })
    if (!returnBuffers) setTimeout(() => resolve({ frames, layout }), 400)
  })
}

test('layout steps off the page, settles, and never queues unreturned frames', async () => {
  const graph = denseGraph(300, 600)
  const reduced = await run(graph, true)
  const last = reduced.frames.at(-1)
  // Reduced motion keeps the existing 160-step settle and publishes only its result.
  assert.equal(last.ticks, 160)
  assert.ok(reduced.frames.length <= 2)
  assert.ok(last.positions.every(Number.isFinite))
  const moving = await run(graph, false)
  assert.ok(moving.frames.at(-1).ticks >= 290)
  assert.ok(moving.frames.length > 50)
  // Two buffers in flight: an unresponsive page receives two frames, not hundreds.
  const busy = await run(graph, false, false)
  busy.layout.stop()
  assert.equal(busy.frames.length, 2)
})

// Layouts on a task queue whose clock moves only with the page steps' own
// work (1 ms per 1,000 operations), so slices are counted rather than timed.
function pacedTasks(t) {
  let clock = 0,
    work = 0,
    roots = 0,
    last = 0
  const tasks = new Map()
  const layouts = []
  t.mock.method(performance, 'now', () => clock)
  t.mock.method(globalThis, 'setTimeout', (task) => {
    tasks.set(++last, task)
    return last
  })
  t.mock.method(globalThis, 'clearTimeout', (key) => tasks.delete(key))
  // Every link and every collision takes one square root, worker or page.
  const sqrt = Math.sqrt
  Math.sqrt = (value) => {
    roots++
    return sqrt(value)
  }
  t.after(() => {
    Math.sqrt = sqrt
    // What stopped layouts leave queued is d3's timer check, which releases
    // d3's interval; skipping it would keep the process alive.
    for (const layout of layouts) layout.stop()
    for (const task of [...tasks.values()]) task()
  })
  return {
    counted(...graph) {
      const step = pageSteps(...graph)
      return function* () {
        for (const done of step()) {
          work += done
          clock += done / 1000
          yield done
        }
      }
    },
    layout(pieces) {
      const frames = []
      const layout = createLayout(
        (frame) => {
          frames.push({ ...frame, positions: frame.positions.slice() })
          layout.receive({ type: 'buffer', buffer: frame.positions.buffer })
        },
        pieces ? 8 : undefined,
        pieces,
      )
      layouts.push(layout)
      return { layout, frames }
    },
    /** Runs queued tasks one at a time until `done()`; returns each one's work. */
    until(done) {
      const slices = []
      while (!done()) {
        const [key, task] = tasks.entries().next().value
        tasks.delete(key)
        work = 0
        roots = 0
        task()
        slices.push({ work, roots })
      }
      return slices
    },
  }
}

test('a page laying out in pieces puts every note where the worker does, drags included', (t) => {
  const tasks = pacedTasks(t)
  const { edges } = graphTopology(denseGraph(300, 600))
  const settle = (pieces) => {
    const { layout, frames } = tasks.layout(pieces)
    layout.receive({
      type: 'graph',
      version: 1,
      edges,
      positions: new Float32Array(600).fill(Number.NaN),
      reduced: true,
    })
    tasks.until(() => frames.at(-1)?.settled)
    const first = frames.at(-1)
    // A reduced-motion drag settles the neighbors; a page does so between tasks.
    layout.receive({
      type: 'pin',
      version: 1,
      index: 5,
      x: 40,
      y: -30,
      drag: 1,
      moved: true,
      reduced: true,
    })
    tasks.until(() => frames.at(-1).settled)
    return [first, frames.at(-1)]
  }
  const worker = settle()
  const page = settle(tasks.counted)
  assert.deepEqual(
    page.map((frame) => frame.ticks),
    [160, 162],
  )
  assert.deepEqual(page, worker)
})

test('drags after a motion preference change lay out the same on a page as in the worker', (t) => {
  const tasks = pacedTasks(t)
  const { edges } = graphTopology(denseGraph(300, 600))
  // Settles in one motion mode, then drags a note once per later preference.
  const settle = (pieces, reduced, ...drags) => {
    const { layout, frames } = tasks.layout(pieces)
    layout.receive({
      type: 'graph',
      version: 1,
      edges,
      positions: new Float32Array(600).fill(Number.NaN),
      reduced,
    })
    tasks.until(() => frames.at(-1)?.settled)
    const settled = [frames.at(-1)]
    for (const [index, reduced] of drags.entries()) {
      layout.receive({
        type: 'pin',
        version: 1,
        index: 5,
        x: 40 * (index + 1),
        y: -30,
        drag: index + 1,
        moved: true,
        reduced,
      })
      tasks.until(() => frames.at(-1).settled)
      settled.push(frames.at(-1))
    }
    return settled
  }
  // Reduced motion turned on after a normal settle, then off again.
  const worker = settle(undefined, false, true, false)
  const page = settle(tasks.counted, false, true, false)
  assert.equal(page[1].ticks, page[0].ticks + 2)
  assert.ok(page[2].ticks > page[1].ticks + 100, `${page[2].ticks} steps`)
  assert.deepEqual(page, worker)
  // Turned off after a reduced settle: the drag sets the layout moving again.
  const workerAfter = settle(undefined, true, false)
  const pageAfter = settle(tasks.counted, true, false)
  assert.ok(workerAfter[1].ticks > 260, `${workerAfter[1].ticks} steps`)
  assert.deepEqual(pageAfter, workerAfter)
})

test('a reduced-motion settle cut short by a motion change leaves no steps for later drags', (t) => {
  const tasks = pacedTasks(t)
  const { edges } = graphTopology(denseGraph(300, 600))
  const { layout, frames } = tasks.layout(tasks.counted)
  layout.receive({
    type: 'graph',
    version: 1,
    edges,
    positions: new Float32Array(600).fill(Number.NaN),
    reduced: true,
  })
  const drag = (index, reduced) =>
    layout.receive({
      type: 'pin',
      version: 1,
      index: 5,
      x: 40 * index,
      y: -30,
      drag: index,
      moved: true,
      reduced,
    })
  // Reduced motion turned off before the first arrangement settles...
  assert.equal(frames.at(-1).settled, false)
  drag(1, false)
  tasks.until(() => frames.at(-1).settled)
  const cooled = frames.at(-1).ticks
  // ...and on again: the next drag runs its own two steps, not the leftovers.
  drag(2, true)
  tasks.until(() => frames.at(-1).settled)
  assert.equal(frames.at(-1).ticks, cooled + 2)
})

test('a page laying out 20,000 notes and 60,000 links runs one slice of work per task', (t) => {
  const tasks = pacedTasks(t)
  const message = {
    type: 'graph',
    version: 1,
    edges: graphTopology(denseGraph(20000, 60000)).edges,
    positions: new Float32Array(40000).fill(Number.NaN),
    reduced: false,
  }
  const page = tasks.layout(tasks.counted)
  page.layout.receive(message)
  const slices = tasks.until(() => page.frames.at(-1).ticks === 2)
  page.layout.stop()
  // Each task stops within one piece of its 8 ms slice, 8,000 operations here,
  const most = (key) => Math.max(...slices.map((slice) => slice[key]))
  assert.ok(most('work') <= 8000 + piece, `${most('work')} operations`)
  // as the square roots confirm: one whole step takes over 60,000.
  assert.ok(most('roots') <= 8000 + piece, `${most('roots')} square roots`)
  assert.ok(slices.length > 500, `${slices.length} tasks`)
  // The steps are the worker's own.
  const worker = tasks.layout()
  worker.layout.receive(message)
  tasks.until(() => worker.frames.at(-1).ticks === 2)
  assert.deepEqual(page.frames.at(-1), worker.frames.at(-1))
})

test('topology changes keep laid-out notes and seed new ones beside a neighbor', async () => {
  const graph = denseGraph(60, 90)
  const { frames, layout } = await run(graph, true)
  const before = frames.at(-1).positions
  const next = graphTopology({
    nodes: [...graph.nodes, { id: 'new.md', label: 'new', degree: 1 }],
    edges: [...graph.edges, { source: 'n5.md', target: 'new.md' }],
  })
  const positions = new Float32Array(next.nodes.length * 2).fill(Number.NaN)
  positions.set(before)
  const seeded = await new Promise((resolve) => {
    const warm = createLayout((frame) => resolve(frame))
    warm.receive({
      type: 'graph',
      version: 2,
      edges: next.edges,
      positions,
      reduced: false,
    })
    warm.stop()
  })
  layout.stop()
  const moved = (index) =>
    Math.hypot(
      seeded.positions[index * 2] - before[index * 2],
      seeded.positions[index * 2 + 1] - before[index * 2 + 1],
    )
  assert.ok(moved(0) < 1, `kept note moved ${moved(0)}`)
  const added = next.nodes.length - 1
  assert.ok(
    Math.abs(
      Math.hypot(
        seeded.positions[added * 2] - before[5 * 2],
        seeded.positions[added * 2 + 1] - before[5 * 2 + 1],
      ) - 30,
    ) < 1,
  )
})
