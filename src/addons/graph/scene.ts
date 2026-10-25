export type GraphNode = { id: string; label: string; degree: number }
export type View = {
  x: number
  y: number
  scale: number
  centered: string | null
}
// Null is the fitted overview; 'default' applies the saved starting zoom.
export type Camera = View | 'default' | null
export type Size = { width: number; height: number }
export type Palette = {
  edge: string
  node: string
  border: string
  activeNode: string
  activeBorder: string
  label: string
  activeLabel: string
  font: string
}

const nodeRadius = (degree: number) => 5 + Math.min(7, Math.sqrt(degree) * 2)
const nodeLabel = (label: string) => {
  const characters = Array.from(label)
  return characters.length > 32 ? `${characters.slice(0, 31).join('')}…` : label
}

/** Index-based arrays shared by the camera, renderer, hit-testing, and layout worker. */
export function graphTopology(graph: {
  nodes: readonly GraphNode[]
  edges: readonly { source: string; target: string }[]
}) {
  const index = new Map(
    graph.nodes.map((node, position) => [node.id, position]),
  )
  const edges = new Uint32Array(graph.edges.length * 2)
  graph.edges.forEach((edge, position) => {
    edges[position * 2] = index.get(edge.source) ?? 0
    edges[position * 2 + 1] = index.get(edge.target) ?? 0
  })
  return {
    nodes: graph.nodes,
    index,
    edges,
    radii: Float32Array.from(graph.nodes, (node) => nodeRadius(node.degree)),
    labels: graph.nodes.map((node) => nodeLabel(node.label)),
  }
}
export type Topology = ReturnType<typeof graphTopology>

export function cameraPosition(
  view: Camera,
  graph: Topology,
  positions: Float32Array | null,
  size: Size,
  focus: string | null,
  zoom: number,
): View {
  const count = graph.nodes.length
  if (!view || view === 'default') {
    let left = Infinity,
      right = -Infinity,
      top = Infinity,
      bottom = -Infinity
    for (let index = 0; positions && index < count; index++) {
      const x = positions[index * 2]!,
        y = positions[index * 2 + 1]!
      if (Number.isNaN(x)) continue
      const radius = graph.radii[index]!
      const extent =
        count <= 80
          ? Math.max(
              radius,
              Array.from(graph.labels[index]!).reduce(
                (width, character) =>
                  width + (character.charCodeAt(0) > 127 ? 12 : 8),
                0,
              ) / 2,
            )
          : radius
      left = Math.min(left, x - extent)
      right = Math.max(right, x + extent)
      top = Math.min(top, y - (count <= 80 ? 28 : radius))
      bottom = Math.max(bottom, y + radius)
    }
    if (left === Infinity) return { x: 0, y: 0, scale: 1, centered: null }
    const scale = Math.min(
      1,
      Math.max(1, size.width - 64) / Math.max(1, right - left),
      Math.max(1, size.height - 64) / Math.max(1, bottom - top),
    )
    const fitted = {
      scale,
      centered: null,
      x: (-(left + right) / 2) * scale,
      y: (-(top + bottom) / 2) * scale,
    }
    if (view !== 'default') return fitted
    const closeScale = Math.min(4, scale * zoom)
    const node = focus === null ? undefined : graph.index.get(focus)
    const x = node === undefined ? NaN : positions![node * 2]!
    return Number.isNaN(x)
      ? {
          scale: closeScale,
          centered: null,
          x: (fitted.x * closeScale) / scale,
          y: (fitted.y * closeScale) / scale,
        }
      : {
          scale: closeScale,
          centered: focus,
          x: -x * closeScale,
          y: -positions![node! * 2 + 1]! * closeScale,
        }
  }
  const node =
    view.centered === null ? undefined : graph.index.get(view.centered)
  const x = node === undefined || !positions ? NaN : positions[node * 2]!
  return Number.isNaN(x)
    ? view
    : {
        ...view,
        x: -x * view.scale,
        y: -positions![node! * 2 + 1]! * view.scale,
      }
}

/** Labels appear for small graphs or once notes are large enough to read. */
export const showsLabels = (graph: Topology, view: View) =>
  graph.nodes.length <= 80 || view.scale >= 0.8

export type Scene = {
  graph: Topology
  positions: Float32Array
  view: View
  size: Size
  /** Device pixels per CSS pixel of the backing store. */
  ratio: number
  /** Hovered, focused, and current notes. */
  highlighted: readonly number[]
  palette: Palette
}

/**
 * Groups visible dots so that no two touching dots share a path: each dot's
 * border is then painted over its own fill and under the dots stacked above
 * it, as separately painted svg circles were. Separated dots share the first
 * group, so groups follow how many dots overlap in one place, not their total.
 */
function paintLayers(
  graph: Topology,
  positions: Float32Array,
  view: View,
  size: Size,
  visible: (index: number) => boolean,
) {
  const nodes: number[] = []
  let largest = 0
  for (let index = 0; index < graph.nodes.length; index++)
    if (visible(index)) {
      nodes.push(index)
      largest = Math.max(largest, graph.radii[index]!)
    }
  // Screen pixels; strokes and edge smoothing reach about a pixel past a dot.
  const reach = Math.max(largest * view.scale, 2.5) * 2 + 2
  const columns = Math.ceil(size.width / reach) + 2
  const rows = Math.ceil(size.height / reach) + 2
  const heads = new Int32Array(columns * rows).fill(-1)
  const next = new Int32Array(nodes.length)
  const depth = new Int32Array(nodes.length)
  const placed = new Float32Array(nodes.length * 3)
  const layers: number[][] = []
  const taken: number[] = []
  nodes.forEach((index, position) => {
    const x = size.width / 2 + view.x + positions[index * 2]! * view.scale
    const y = size.height / 2 + view.y + positions[index * 2 + 1]! * view.scale
    const radius = Math.max(graph.radii[index]!, 2.5 / view.scale) * view.scale
    const column = Math.max(0, Math.min(columns - 1, Math.floor(x / reach) + 1))
    const row = Math.max(0, Math.min(rows - 1, Math.floor(y / reach) + 1))
    for (let r = Math.max(0, row - 1); r <= Math.min(rows - 1, row + 1); r++)
      for (
        let c = Math.max(0, column - 1);
        c <= Math.min(columns - 1, column + 1);
        c++
      ) {
        let other = heads[c + r * columns]!
        while (other >= 0) {
          const dx = placed[other * 3]! - x,
            dy = placed[other * 3 + 1]! - y,
            touch = placed[other * 3 + 2]! + radius + 1
          if (dx * dx + dy * dy < touch * touch)
            taken[depth[other]!] = position + 1
          other = next[other]!
        }
      }
    // The lowest group none of its touching neighbors use.
    let level = 0
    while (taken[level] === position + 1) level++
    depth[position] = level
    placed[position * 3] = x
    placed[position * 3 + 1] = y
    placed[position * 3 + 2] = radius
    next[position] = heads[column + row * columns]!
    heads[column + row * columns] = position
    if (level === layers.length) layers.push([])
    layers[level]!.push(index)
  })
  return layers
}

/**
 * One frame: edges share one path and dots one path per paint layer, so draw
 * calls follow how deeply dots overlap, not how many notes there are. Labeled
 * frames keep the svg order (each label after its own dot) and only exist
 * while zoomed in or small.
 */
export function drawGraph(context: CanvasRenderingContext2D, scene: Scene) {
  const { graph, positions, view, size, ratio, highlighted, palette } = scene
  const { scale } = view
  const minimum = 2.5 / scale
  const labels = showsLabels(graph, view)
  const left = (-size.width / 2 - view.x) / scale,
    right = (size.width / 2 - view.x) / scale,
    top = (-size.height / 2 - view.y) / scale,
    bottom = (size.height / 2 - view.y) / scale
  context.setTransform(1, 0, 0, 1, 0, 0)
  context.clearRect(0, 0, context.canvas.width, context.canvas.height)
  context.setTransform(
    ratio * scale,
    0,
    0,
    ratio * scale,
    ratio * (size.width / 2 + view.x),
    ratio * (size.height / 2 + view.y),
  )
  context.lineWidth = 1 / scale
  context.beginPath()
  for (let index = 0; index < graph.edges.length; index += 2) {
    const source = graph.edges[index]! * 2,
      target = graph.edges[index + 1]! * 2
    const x1 = positions[source]!,
      y1 = positions[source + 1]!,
      x2 = positions[target]!,
      y2 = positions[target + 1]!
    if (
      Number.isNaN(x1) ||
      Number.isNaN(x2) ||
      (x1 < left && x2 < left) ||
      (x1 > right && x2 > right) ||
      (y1 < top && y2 < top) ||
      (y1 > bottom && y2 > bottom)
    )
      continue
    context.moveTo(x1, y1)
    context.lineTo(x2, y2)
  }
  context.strokeStyle = palette.edge
  context.stroke()
  // Labels extend above and beside their dot.
  const margin = labels ? 200 : 0
  const visible = (index: number) => {
    const x = positions[index * 2]!,
      y = positions[index * 2 + 1]!,
      radius = Math.max(graph.radii[index]!, minimum)
    return (
      !Number.isNaN(x) &&
      x + radius + margin >= left &&
      x - radius - margin <= right &&
      y + radius >= top &&
      y - Math.max(radius, labels ? 30 : 0) <= bottom
    )
  }
  const dot = (index: number) => {
    const x = positions[index * 2]!,
      radius = Math.max(graph.radii[index]!, minimum)
    context.moveTo(x + radius, positions[index * 2 + 1]!)
    context.arc(x, positions[index * 2 + 1]!, radius, 0, Math.PI * 2)
  }
  if (labels) {
    context.font = palette.font
    context.textAlign = 'center'
    for (let index = 0; index < graph.nodes.length; index++) {
      if (!visible(index)) continue
      const active = highlighted.includes(index)
      context.beginPath()
      dot(index)
      context.fillStyle = active ? palette.activeNode : palette.node
      context.fill()
      context.strokeStyle = active ? palette.activeBorder : palette.border
      context.stroke()
      context.fillStyle = active ? palette.activeLabel : palette.label
      context.fillText(
        graph.labels[index]!,
        positions[index * 2]!,
        positions[index * 2 + 1]! - 14,
      )
    }
    return
  }
  for (const layer of paintLayers(graph, positions, view, size, visible)) {
    for (const active of [false, true]) {
      const dots = layer.filter(
        (index) => highlighted.includes(index) === active,
      )
      if (!dots.length) continue
      context.beginPath()
      for (const index of dots) dot(index)
      context.fillStyle = active ? palette.activeNode : palette.node
      context.fill()
      context.strokeStyle = active ? palette.activeBorder : palette.border
      context.stroke()
    }
  }
}

/** Uniform grid over node positions; rebuilt only when positions change. */
export function spatialIndex(positions: Float32Array) {
  const count = positions.length / 2
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity
  for (let index = 0; index < count; index++) {
    const x = positions[index * 2]!,
      y = positions[index * 2 + 1]!
    if (Number.isNaN(x)) continue
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
  }
  // About one cell per note keeps both building and searching linear.
  const cell = Math.max(
    32,
    Math.sqrt(((maxX - minX + 1) * (maxY - minY + 1)) / Math.max(1, count)),
  )
  const columns = minX === Infinity ? 0 : Math.floor((maxX - minX) / cell) + 1
  const rows = minX === Infinity ? 0 : Math.floor((maxY - minY) / cell) + 1
  const heads = new Int32Array(columns * rows).fill(-1)
  const next = new Int32Array(count)
  for (let index = 0; index < count; index++) {
    const x = positions[index * 2]!
    if (Number.isNaN(x)) continue
    const at =
      Math.floor((x - minX) / cell) +
      Math.floor((positions[index * 2 + 1]! - minY) / cell) * columns
    next[index] = heads[at]!
    heads[at] = index
  }
  const column = (x: number) =>
    Math.max(0, Math.min(columns - 1, Math.floor((x - minX) / cell)))
  const row = (y: number) =>
    Math.max(0, Math.min(rows - 1, Math.floor((y - minY) / cell)))
  return {
    /** Visit notes whose centers fall inside the box. */
    search(
      x0: number,
      y0: number,
      x1: number,
      y1: number,
      visit: (index: number) => void,
    ) {
      if (!columns || x1 < minX || x0 > maxX || y1 < minY || y0 > maxY) return
      for (let r = row(y0); r <= row(y1); r++)
        for (let c = column(x0); c <= column(x1); c++) {
          let index = heads[c + r * columns]!
          while (index >= 0) {
            visit(index)
            index = next[index]!
          }
        }
    },
  }
}

/** The note under a point in graph coordinates, including its visible label. */
export function nodeAt(
  graph: Topology,
  positions: Float32Array,
  index: ReturnType<typeof spatialIndex>,
  view: View,
  x: number,
  y: number,
  label: (index: number) => { width: number; ascent: number; descent: number },
) {
  const minimum = 2.5 / view.scale
  const reach = Math.max(12, minimum)
  let found = -1,
    closest = Infinity
  index.search(x - reach, y - reach, x + reach, y + reach, (node) => {
    const dx = positions[node * 2]! - x,
      dy = positions[node * 2 + 1]! - y
    const distance = dx * dx + dy * dy
    const radius = Math.max(graph.radii[node]!, minimum)
    if (distance <= radius * radius && distance <= closest) {
      found = node
      closest = distance
    }
  })
  if (found >= 0 || !showsLabels(graph, view)) return found
  // Labels sit 14 units above their dot and are at most a few hundred wide.
  index.search(x - 200, y, x + 200, y + 40, (node) => {
    const box = label(node)
    const baseline = positions[node * 2 + 1]! - 14
    if (
      Math.abs(positions[node * 2]! - x) <= box.width / 2 &&
      y >= baseline - box.ascent &&
      y <= baseline + box.descent
    )
      found = node
  })
  return found
}
