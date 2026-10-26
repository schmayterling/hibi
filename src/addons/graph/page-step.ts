import type { Simulation, SimulationNodeDatum } from 'd3-force'

type Node = SimulationNodeDatum

/** Elementary operations (a link, a note, a tree cell) run between yields. */
export const piece = 4096

/**
 * One step of the layout's d3-force simulation (see `layout.ts`: links 85
 * apart, many-body -180, collision radius 22, centering) in resumable pieces,
 * for pages that cannot start a worker, where a single `simulation.tick()`
 * cannot pause. It repeats d3's arithmetic in d3's order, so notes land where
 * the worker puts them. Each yield reports the operations run since the last.
 */
export function pageSteps(
  nodes: Node[],
  edges: Uint32Array,
  simulation: Simulation<Node, undefined>,
) {
  const n = nodes.length
  const links = edges.length / 2
  const degree = new Float64Array(n)
  for (const index of edges) degree[index] = degree[index]! + 1
  const strength = new Float64Array(links)
  const bias = new Float64Array(links)
  for (let k = 0; k < links; k++) {
    const source = degree[edges[k * 2]!]!
    const target = degree[edges[k * 2 + 1]!]!
    strength[k] = 1 / Math.min(source, target)
    bias[k] = source / (source + target)
  }
  // The simulation's own random source, which d3's forces nudge notes with.
  const random = simulation.randomSource()
  const jiggle = () => (random() - 0.5) * 1e-6
  const xs = new Float64Array(n)
  const ys = new Float64Array(n)
  const stack: number[] = []
  let work = 0
  // d3-quadtree cells, reused by every tree: bounds, children, and each leaf's
  // newest note (`head`, -2 once split) with `next` chaining notes at one point.
  let cells = 0
  let bounds = new Float64Array(8 * n + 4)
  let kids = new Int32Array(8 * n + 4)
  let head = new Int32Array(2 * n + 1)
  const next = new Int32Array(n)
  let charge = new Float64Array(0)
  let cx = new Float64Array(0)
  let cy = new Float64Array(0)
  function cell(x0: number, y0: number, x1: number, y1: number) {
    if (cells === head.length) {
      const grownBounds = new Float64Array(bounds.length * 2)
      grownBounds.set(bounds)
      bounds = grownBounds
      const grownKids = new Int32Array(kids.length * 2)
      grownKids.set(kids)
      kids = grownKids
      const grownHead = new Int32Array(head.length * 2)
      grownHead.set(head)
      head = grownHead
    }
    const b = cells * 4
    bounds[b] = x0
    bounds[b + 1] = y0
    bounds[b + 2] = x1
    bounds[b + 3] = y1
    kids.fill(-1, b, b + 4)
    head[cells] = -1
    return cells++
  }
  function child(c: number, x: number, y: number) {
    const b = c * 4
    const xm = (bounds[b]! + bounds[b + 2]!) / 2
    const ym = (bounds[b + 1]! + bounds[b + 3]!) / 2
    const right = x >= xm
    const bottom = y >= ym
    const slot = b + (bottom ? 2 : 0) + (right ? 1 : 0)
    if (kids[slot]! < 0) {
      const made = cell(
        right ? xm : bounds[b]!,
        bottom ? ym : bounds[b + 1]!,
        right ? bounds[b + 2]! : xm,
        bottom ? bounds[b + 3]! : ym,
      )
      kids[slot] = made
    }
    return kids[slot]!
  }
  /** d3-quadtree's tree of `xs`/`ys`: the same cells, built in the same order. */
  function* tree(): Generator<number, void> {
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity
    for (let i = 0; i < n; i++) {
      const x = xs[i]!,
        y = ys[i]!
      if (!Number.isNaN(x) && !Number.isNaN(y)) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
      if (++work % piece === 0) yield piece
    }
    // A square from the integer corner, doubled until it covers every note.
    const left = Math.floor(x0),
      top = Math.floor(y0)
    let size = 1
    while (x1 >= left + size || y1 >= top + size) size *= 2
    cells = 0
    cell(left, top, left + size, top + size)
    for (let i = 0; i < n; i++) {
      const x = xs[i]!,
        y = ys[i]!
      if (Number.isNaN(x) || Number.isNaN(y)) continue
      let c = 0
      for (;;) {
        if (++work % piece === 0) yield piece
        const j = head[c]!
        if (j === -2) c = child(c, x, y)
        else if (j >= 0 && (xs[j] !== x || ys[j] !== y)) {
          // Split the leaf; its notes move down until the new one parts from them.
          head[c] = -2
          const below = child(c, xs[j]!, ys[j]!)
          head[below] = j
        } else {
          next[i] = j
          head[c] = i
          break
        }
      }
    }
  }
  return function* step(): Generator<number, void> {
    work = 0
    const alpha =
      simulation.alpha() +
      (simulation.alphaTarget() - simulation.alpha()) * simulation.alphaDecay()
    simulation.alpha(alpha)
    // Links pull their notes toward 85 apart; the less connected end moves more.
    for (let k = 0; k < links; k++) {
      const source = nodes[edges[k * 2]!]!,
        target = nodes[edges[k * 2 + 1]!]!
      let x = target.x! + target.vx! - source.x! - source.vx! || jiggle()
      let y = target.y! + target.vy! - source.y! - source.vy! || jiggle()
      let l = Math.sqrt(x * x + y * y)
      l = ((l - 85) / l) * alpha * strength[k]!
      x *= l
      y *= l
      target.vx = target.vx! - x * bias[k]!
      target.vy = target.vy! - y * bias[k]!
      source.vx = source.vx! + x * (1 - bias[k]!)
      source.vy = source.vy! + y * (1 - bias[k]!)
      if (++work % piece === 0) yield piece
    }
    // Many-body: every note repels the others, distant cells through their centroid.
    for (let i = 0; i < n; i++) {
      xs[i] = nodes[i]!.x!
      ys[i] = nodes[i]!.y!
      if (++work % piece === 0) yield piece
    }
    yield* tree()
    if (charge.length < cells) {
      charge = new Float64Array(head.length)
      cx = new Float64Array(head.length)
      cy = new Float64Array(head.length)
    }
    // Children come after their parent, so walking back sums them first.
    for (let c = cells - 1; c >= 0; c--) {
      let total = 0,
        weight = 0,
        x = 0,
        y = 0
      if (head[c] === -2) {
        for (let q = c * 4; q < c * 4 + 4; q++) {
          const kid = kids[q]!
          if (kid < 0 || !charge[kid]) continue
          const amount = Math.abs(charge[kid]!)
          total += charge[kid]!
          weight += amount
          x += amount * cx[kid]!
          y += amount * cy[kid]!
        }
        x /= weight
        y /= weight
      } else {
        x = xs[head[c]!]!
        y = ys[head[c]!]!
        for (let j = head[c]!; j >= 0; j = next[j]!) total -= 180
      }
      charge[c] = total
      cx[c] = x
      cy[c] = y
      if (++work % piece === 0) yield piece
    }
    for (let i = 0; i < n; i++) {
      const node = nodes[i]!
      const nx = xs[i]!,
        ny = ys[i]!
      stack.push(0)
      while (stack.length) {
        const c = stack.pop()!
        if (++work % piece === 0) yield piece
        if (!charge[c]) continue
        let x = cx[c]! - nx,
          y = cy[c]! - ny,
          l = x * x + y * y
        const width = bounds[c * 4 + 2]! - bounds[c * 4]!
        // Barnes–Hut with theta 0.9: a cell this far away acts as one charge.
        const far = (width * width) / 0.81 < l
        if (!far && head[c] === -2) {
          for (let q = c * 4 + 3; q >= c * 4; q--)
            if (kids[q]! >= 0) stack.push(kids[q]!)
          continue
        }
        // A leaf holding only this note exerts nothing on it.
        if (far || head[c] !== i || next[i]! >= 0) {
          if (x === 0) {
            x = jiggle()
            l += x * x
          }
          if (y === 0) {
            y = jiggle()
            l += y * y
          }
          if (l < 1) l = Math.sqrt(l)
        }
        if (far) {
          node.vx = node.vx! + (x * charge[c]! * alpha) / l
          node.vy = node.vy! + (y * charge[c]! * alpha) / l
          continue
        }
        for (let j = head[c]!; j >= 0; j = next[j]!) {
          if (++work % piece === 0) yield piece
          if (j === i) continue
          const push = (-180 * alpha) / l
          node.vx = node.vx! + x * push
          node.vy = node.vy! + y * push
        }
      }
    }
    // Collision: notes about to come within 44 (two radii) push each other apart.
    for (let i = 0; i < n; i++) {
      xs[i] = nodes[i]!.x! + nodes[i]!.vx!
      ys[i] = nodes[i]!.y! + nodes[i]!.vy!
      if (++work % piece === 0) yield piece
    }
    yield* tree()
    for (let i = 0; i < n; i++) {
      const node = nodes[i]!
      const xi = node.x! + node.vx!,
        yi = node.y! + node.vy!
      stack.push(0)
      while (stack.length) {
        const c = stack.pop()!
        if (++work % piece === 0) yield piece
        const j = head[c]!
        if (j === -2) {
          const b = c * 4
          if (
            bounds[b]! > xi + 44 ||
            bounds[b + 2]! < xi - 44 ||
            bounds[b + 1]! > yi + 44 ||
            bounds[b + 3]! < yi - 44
          )
            continue
          for (let q = b + 3; q >= b; q--)
            if (kids[q]! >= 0) stack.push(kids[q]!)
          continue
        }
        // As in d3, a leaf collides through its newest note only.
        if (j <= i) continue
        const other = nodes[j]!
        let x = xi - other.x! - other.vx!,
          y = yi - other.y! - other.vy!,
          l = x * x + y * y
        if (l >= 44 * 44) continue
        if (x === 0) {
          x = jiggle()
          l += x * x
        }
        if (y === 0) {
          y = jiggle()
          l += y * y
        }
        l = Math.sqrt(l)
        l = (44 - l) / l
        x *= l
        y *= l
        // Equal radii split the push evenly.
        node.vx = node.vx! + x * 0.5
        node.vy = node.vy! + y * 0.5
        other.vx = other.vx! - x * 0.5
        other.vy = other.vy! - y * 0.5
      }
    }
    // Centering, then each note moves by its damped velocity.
    let sx = 0,
      sy = 0
    for (let i = 0; i < n; i++) {
      sx += nodes[i]!.x!
      sy += nodes[i]!.y!
      if (++work % piece === 0) yield piece
    }
    sx /= n
    sy /= n
    const decay = 1 - simulation.velocityDecay()
    for (let i = 0; i < n; i++) {
      const node = nodes[i]!
      if (node.fx == null) {
        node.vx = node.vx! * decay
        node.x = node.x! - sx + node.vx
      } else {
        node.x = node.fx
        node.vx = 0
      }
      if (node.fy == null) {
        node.vy = node.vy! * decay
        node.y = node.y! - sy + node.vy
      } else {
        node.y = node.fy
        node.vy = 0
      }
      if (++work % piece === 0) yield piece
    }
    if (work % piece) yield work % piece
  }
}
