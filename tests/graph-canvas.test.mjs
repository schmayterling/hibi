import assert from 'node:assert/strict'
import test from 'node:test'
import { createLayout } from '../src/addons/graph/layout.ts'
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

test('5,000 notes and 20,000 links draw with a constant number of calls', () => {
  const graph = graphTopology(denseGraph(5000, 20000))
  const positions = new Float32Array(10000)
  // A square grid 40 units apart, like a settled layout.
  for (let index = 0; index < 5000; index++) {
    positions[index * 2] = (index % 71) * 40 - 1400
    positions[index * 2 + 1] = Math.floor(index / 71) * 40 - 1400
  }
  const size = { width: 400, height: 400 }
  const view = cameraPosition(null, graph, positions, size, null, 8)
  const fitted = countingContext(800, 800)
  drawGraph(fitted.context, {
    graph,
    positions,
    view,
    size,
    ratio: 2,
    highlighted: [3, 3, 9],
    palette,
  })
  // One edge path, then one path for plain and one for highlighted notes.
  assert.deepEqual(
    {
      fill: fitted.counts.fill,
      stroke: fitted.counts.stroke,
      fillText: fitted.counts.fillText,
    },
    { fill: 2, stroke: 3, fillText: 0 },
  )
  assert.ok(fitted.counts.path > 20000)
  // Zoomed in, labels appear only for notes near the view.
  const zoomed = countingContext(800, 800)
  drawGraph(zoomed.context, {
    graph,
    positions,
    view: { x: 0, y: 0, scale: 1, centered: null },
    size,
    ratio: 2,
    highlighted: [],
    palette,
  })
  assert.ok(zoomed.counts.fillText > 0)
  assert.ok(zoomed.counts.fillText < 300, `${zoomed.counts.fillText} labels`)
  assert.equal(zoomed.counts.fill, zoomed.counts.fillText)
  assert.ok(zoomed.counts.path < fitted.counts.path)
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
