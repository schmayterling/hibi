import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
  type SimulationNodeDatum,
} from 'd3-force'
import type { pageSteps } from './page-step'

/** Renderer-to-layout messages. Node indices follow the graph's node order. */
export type LayoutMessage =
  | {
      type: 'graph'
      version: number
      /** Index pairs, one undirected edge per pair. */
      edges: Uint32Array
      /** x/y pairs; NaN places the node near a laid-out neighbor. */
      positions: Float32Array
      reduced: boolean
    }
  | {
      type: 'pin'
      version: number
      index: number
      x: number
      y: number
      /** Increasing sequence number echoed by later frames. */
      drag: number
      /** False only fixes the node where it is, as pressing it does. */
      moved: boolean
      reduced: boolean
    }
  | { type: 'buffer'; buffer: ArrayBuffer }

export type LayoutFrame = {
  version: number
  positions: Float32Array
  /** Last pin applied to these positions. */
  drag: number
  /** Simulation steps run by this layout so far. */
  ticks: number
  settled: boolean
}

/**
 * Posts frames only while the renderer has returned a buffer, so a busy page
 * never queues them. `slice` bounds each run of reduced-motion steps; a page
 * running the layout itself uses a short one and passes `pieces`, which splits
 * each step so input stays responsive however large the graph.
 */
export function createLayout(
  post: (frame: LayoutFrame, transfer: Transferable[]) => void,
  slice = 50,
  pieces?: typeof pageSteps,
) {
  let simulation: Simulation<SimulationNodeDatum, undefined> | null = null
  let nodes: SimulationNodeDatum[] = []
  let version = -1
  let reduced = false
  let remaining = 0
  let drag = 0
  let ticks = 0
  let dirty = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let spare: ArrayBuffer[] = []
  let stepper: ReturnType<typeof pageSteps> | null = null
  // A step begun in pieces, and when it began.
  let partial: Generator<number, void> | null = null
  let begun = 0
  const settled = () =>
    !simulation ||
    !nodes.length ||
    (reduced
      ? remaining <= 0
      : !partial && simulation.alpha() < simulation.alphaMin())
  function publish() {
    const buffer = spare.pop()
    dirty = !buffer
    if (!buffer) return
    const positions = new Float32Array(buffer)
    for (let index = 0; index < nodes.length; index++) {
      positions[index * 2] = nodes[index]!.x!
      positions[index * 2 + 1] = nodes[index]!.y!
    }
    post({ version, positions, drag, ticks, settled: settled() }, [buffer])
  }
  function step(count: number) {
    simulation!.tick(count)
    ticks += count
  }
  /** Runs one step, or as much of it as fits before `deadline` in pieces. */
  function advance(deadline: number) {
    if (!stepper) {
      step(1)
      return true
    }
    partial ??= stepper()
    while (!partial.next().done) if (performance.now() >= deadline) return false
    partial = null
    ticks++
    return true
  }
  function run() {
    timer = undefined
    if (!simulation || settled()) return
    const started = performance.now()
    if (reduced) {
      // Reduced motion shows only the first and final arrangements.
      while (remaining > 0 && performance.now() - started < slice)
        if (advance(started + slice)) remaining--
      if (remaining <= 0) publish()
      else timer = setTimeout(run, 0)
      return
    }
    // Pace motion near the display rate; heavier graphs step back to back.
    if (!partial) begun = started
    if (advance(started + slice)) publish()
    if (!settled())
      timer = setTimeout(
        run,
        partial ? 0 : Math.max(0, 16 - (performance.now() - begun)),
      )
  }
  function start() {
    if (timer === undefined && !settled()) timer = setTimeout(run, 0)
  }
  return {
    receive(message: LayoutMessage) {
      if (message.type === 'buffer') {
        if (spare.length < 2 && message.buffer.byteLength === nodes.length * 8)
          spare.push(message.buffer)
        if (dirty) publish()
        return
      }
      if (message.type === 'pin') {
        const node = nodes[message.index]
        if (message.version !== version || !node) return
        node.fx = node.x = message.x
        node.fy = node.y = message.y
        drag = message.drag
        // The motion preference may have changed since the graph arrived; steps
        // left from the other preference no longer apply.
        if (message.reduced !== reduced) remaining = 0
        reduced = message.reduced
        if (message.moved) {
          const count = nodes.length > 80 ? 2 : 30
          if (!reduced) {
            simulation!.alpha(0.15)
            start()
          } else if (stepper) {
            // Pieces finish these steps between tasks; a drag adds no backlog.
            remaining = Math.max(remaining, count)
            start()
          } else step(count)
        }
        publish()
        return
      }
      clearTimeout(timer)
      timer = undefined
      partial = null
      simulation?.stop()
      const { edges, positions } = message
      const count = positions.length / 2
      version = message.version
      reduced = message.reduced
      nodes = Array.from({ length: count }, (_, index) => ({
        x: positions[index * 2]!,
        y: positions[index * 2 + 1]!,
      }))
      // Warm start: keep known positions and seed new notes beside a neighbor.
      let known = 0
      for (const node of nodes) if (!Number.isNaN(node.x)) known++
      if (known)
        for (let index = 0; index < edges.length; index += 2) {
          const a = nodes[edges[index]!]!,
            b = nodes[edges[index + 1]!]!
          const [from, to] = Number.isNaN(a.x) ? [b, a] : [a, b]
          if (Number.isNaN(from.x) || !Number.isNaN(to.x)) continue
          const angle = (edges[index]! + edges[index + 1]!) * 2.399963
          to.x = from.x! + Math.cos(angle) * 30
          to.y = from.y! + Math.sin(angle) * 30
        }
      simulation = forceSimulation(nodes)
        .stop()
        .alpha(Math.max(0.3, 1 - known / Math.max(1, count)))
        .force(
          'links',
          forceLink(
            Array.from({ length: edges.length / 2 }, (_, index) => ({
              source: edges[index * 2]!,
              target: edges[index * 2 + 1]!,
            })),
          ).distance(85),
        )
        .force('charge', forceManyBody().strength(-180))
        .force('collide', forceCollide(22))
        .force('center', forceCenter())
      stepper = pieces?.(nodes, edges, simulation) ?? null
      remaining = reduced ? 160 : 0
      spare = [new ArrayBuffer(count * 8), new ArrayBuffer(count * 8)]
      if (reduced) {
        run()
        if (!settled()) publish()
      } else {
        publish()
        start()
      }
    },
    stop() {
      clearTimeout(timer)
      partial = null
      simulation?.stop()
      simulation = null
    },
  }
}
