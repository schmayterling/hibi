/** biome-ignore-all lint/a11y/useSemanticElements: SVG graph nodes implement keyboard-accessible buttons within the SVG coordinate system. */
/** biome-ignore-all lint/a11y/noNoninteractiveTabindex: the SVG canvas supports keyboard panning and must be focusable. */
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
  type SimulationNodeDatum,
} from 'd3-force'
import { Focus, Maximize2, Minus, Plus } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { IconButton } from '../../ui/Controls'
import type { noteGraph } from './model'
import { defaultZoom } from './preferences'

type Node = ReturnType<typeof noteGraph>['nodes'][number] & SimulationNodeDatum
type Edge = { source: Node; target: Node }
type View = { x: number; y: number; scale: number; centered: string | null }
type Camera = View | 'default' | null
type Size = { width: number; height: number }
const radius = (node: Node) => 5 + Math.min(7, Math.sqrt(node.degree) * 2)
const label = (node: Node) => {
  const characters = Array.from(node.label)
  return characters.length > 32
    ? `${characters.slice(0, 31).join('')}…`
    : node.label
}

function cameraPosition(
  view: Camera,
  nodes: Node[],
  size: Size,
  focus: string | null,
  zoom: number,
): View {
  if (!view || view === 'default') {
    if (!nodes.length) return { x: 0, y: 0, scale: 1, centered: null }
    let left = Infinity,
      right = -Infinity,
      top = Infinity,
      bottom = -Infinity
    for (const node of nodes) {
      const extent =
        nodes.length <= 80
          ? Math.max(
              radius(node),
              Array.from(label(node)).reduce(
                (width, character) =>
                  width + (character.charCodeAt(0) > 127 ? 12 : 8),
                0,
              ) / 2,
            )
          : radius(node)
      left = Math.min(left, (node.x ?? 0) - extent)
      right = Math.max(right, (node.x ?? 0) + extent)
      top = Math.min(
        top,
        (node.y ?? 0) - (nodes.length <= 80 ? 28 : radius(node)),
      )
      bottom = Math.max(bottom, (node.y ?? 0) + radius(node))
    }
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
    const node = nodes.find((item) => item.id === focus)
    return {
      scale: closeScale,
      centered: node?.id ?? null,
      x: node ? -(node.x ?? 0) * closeScale : (fitted.x * closeScale) / scale,
      y: node ? -(node.y ?? 0) * closeScale : (fitted.y * closeScale) / scale,
    }
  }
  const node = nodes.find((node) => node.id === view.centered)
  return node
    ? {
        ...view,
        x: -(node.x ?? 0) * view.scale,
        y: -(node.y ?? 0) * view.scale,
      }
    : view
}
export function GraphCanvas({
  graph,
  active,
  open,
  expand,
  resetKey,
}: {
  graph: ReturnType<typeof noteGraph>
  active: string | null
  open: (path: string) => void
  expand?: (() => void) | undefined
  resetKey: string
}) {
  const svg = useRef<SVGSVGElement>(null)
  const simulation = useRef<Simulation<Node, undefined> | null>(null)
  const [size, setSize] = useState({ width: 640, height: 400 })
  // Null is the fitted overview; 'default' applies the saved starting zoom.
  const [view, setView] = useState<Camera>('default')
  const [initialZoom] = useState(defaultZoom)
  const initialTarget = useRef(active)
  const currentView = useRef(view)
  currentView.current = view
  const animation = useRef<number | null>(null)
  const previousSelection = useRef(active)
  const previousResetKey = useRef(resetKey)
  const camera = useCallback(
    (value: Camera, nodes: Node[], dimensions: Size) =>
      cameraPosition(
        value,
        nodes,
        dimensions,
        initialTarget.current,
        initialZoom,
      ),
    [initialZoom],
  )
  const stopAnimation = useCallback(() => {
    if (animation.current !== null) cancelAnimationFrame(animation.current)
    animation.current = null
  }, [])
  const [layout, setLayout] = useState<{ nodes: Node[]; edges: Edge[] }>({
    nodes: [],
    edges: [],
  })
  const drag = useRef<{
    pointer: number
    x: number
    y: number
    startX: number
    startY: number
    moved: boolean
    node: Node | undefined
  } | null>(null)
  useEffect(() => {
    const element = svg.current
    if (!element) return
    const resize = new ResizeObserver(() => {
      const width = element.clientWidth,
        height = element.clientHeight
      if (width && height)
        setSize((old) =>
          old.width === width && old.height === height
            ? old
            : { width, height },
        )
    })
    resize.observe(element)
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      stopAnimation()
      const bounds = element.getBoundingClientRect()
      const x = event.clientX - bounds.left - bounds.width / 2
      const y = event.clientY - bounds.top - bounds.height / 2
      setView((old) => {
        const position = camera(old, simulation.current?.nodes() ?? [], {
          width: element.clientWidth,
          height: element.clientHeight,
        })
        const scale = Math.max(
          Math.min(0.01, position.scale),
          Math.min(4, position.scale * Math.exp(-event.deltaY * 0.002)),
        )
        return {
          scale,
          centered: null,
          x: x - ((x - position.x) * scale) / position.scale,
          y: y - ((y - position.y) * scale) / position.scale,
        }
      })
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => {
      resize.disconnect()
      element.removeEventListener('wheel', wheel)
    }
  }, [camera, stopAnimation])
  useEffect(() => {
    const nodes: Node[] = graph.nodes.map((node) => ({ ...node }))
    const links = graph.edges.map((edge) => ({ ...edge }))
    const engine = forceSimulation(nodes)
      .force(
        'links',
        forceLink<Node, { source: string; target: string }>(links)
          .id((node) => node.id)
          .distance(85),
      )
      .force('charge', forceManyBody().strength(-180))
      .force('collide', forceCollide(22))
      .force('center', forceCenter())
    simulation.current = engine
    const publish = () =>
      setLayout({ nodes: [...nodes], edges: links as unknown as Edge[] })
    let frame: number | null = null
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      engine.stop()
      publish()
      if (nodes.length > 80) {
        let ticks = 0
        const settle = () => {
          engine.tick(2)
          ticks += 2
          if (ticks < 160) frame = requestAnimationFrame(settle)
          else publish()
        }
        frame = requestAnimationFrame(settle)
      } else {
        engine.tick(160)
        publish()
      }
    } else {
      let lastPublish = performance.now()
      engine.on('tick', () => {
        const now = performance.now()
        if (nodes.length > 80 && now - lastPublish < 50) return
        lastPublish = now
        publish()
      })
      engine.on('end', publish)
      publish()
    }
    return () => {
      if (frame !== null) cancelAnimationFrame(frame)
      engine.stop()
      simulation.current = null
    }
  }, [graph])
  useEffect(() => {
    if (previousResetKey.current === resetKey) return
    previousResetKey.current = resetKey
    initialTarget.current = active
    stopAnimation()
    setView('default')
  }, [resetKey, active, stopAnimation])
  useEffect(() => {
    if (previousSelection.current === active) return
    previousSelection.current = active
    const nodes = simulation.current?.nodes() ?? []
    if (!active || !nodes.some((node) => node.id === active)) return
    const from = camera(currentView.current, nodes, size)
    const target = () =>
      simulation.current?.nodes().find((node) => node.id === active)
    stopAnimation()
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const node = target()!
      setView({
        ...from,
        x: -(node.x ?? 0) * from.scale,
        y: -(node.y ?? 0) * from.scale,
        centered: active,
      })
      return
    }
    const start = performance.now()
    const step = (now: number) => {
      const node = target()
      if (!node) return
      const progress = Math.min(1, (now - start) / 320)
      const eased = 1 - (1 - progress) ** 3
      setView({
        ...from,
        x: from.x + (-(node.x ?? 0) * from.scale - from.x) * eased,
        y: from.y + (-(node.y ?? 0) * from.scale - from.y) * eased,
        centered: progress === 1 ? active : null,
      })
      animation.current = progress < 1 ? requestAnimationFrame(step) : null
    }
    animation.current = requestAnimationFrame(step)
  }, [active, size, camera, stopAnimation])
  useEffect(() => () => stopAnimation(), [stopAnimation])
  const position = camera(view, layout.nodes, size)
  function activate(node: Node) {
    if (node.id === active) setView({ ...position, centered: node.id })
    open(node.id)
  }
  function zoom(factor: number) {
    stopAnimation()
    setView((old) => {
      const current = camera(old, layout.nodes, size)
      const scale = Math.max(
        Math.min(0.01, current.scale),
        Math.min(4, current.scale * factor),
      )
      return {
        ...current,
        scale,
        x: (current.x * scale) / current.scale,
        y: (current.y * scale) / current.scale,
      }
    })
  }
  const graphItems = useMemo(
    () => (
      <>
        {layout.edges.map((edge) => (
          <line
            key={JSON.stringify([edge.source.id, edge.target.id])}
            x1={edge.source.x}
            y1={edge.source.y}
            x2={edge.target.x}
            y2={edge.target.y}
          />
        ))}
        {layout.nodes.map((node) => (
          <g
            key={node.id}
            data-node={node.id}
            data-tooltip={`${node.id} · ${node.degree} connections`}
            data-verbatim="true"
            data-active={node.id === active}
            transform={`translate(${node.x ?? 0} ${node.y ?? 0})`}
            role="button"
            tabIndex={0}
            aria-label={`Open ${node.id}`}
          >
            <circle r={Math.max(radius(node), 2.5 / position.scale)} />
            <text y={-14} textAnchor="middle">
              {label(node)}
            </text>
          </g>
        ))}
      </>
    ),
    [layout, active, position.scale],
  )
  return (
    <div
      className="graph-canvas"
      data-labels={layout.nodes.length <= 80 || position.scale >= 0.8}
    >
      {expand && (
        <IconButton
          className="graph-expand"
          aria-label="Expand graph"
          onClick={expand}
        >
          <Maximize2 size={14} />
        </IconButton>
      )}
      <svg
        ref={svg}
        role="application"
        aria-label="Workspace graph"
        tabIndex={0}
        viewBox={`${-size.width / 2} ${-size.height / 2} ${size.width} ${size.height}`}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) {
            if (event.key !== 'Enter' && event.key !== ' ') return
            const id =
              event.target instanceof Element
                ? event.target.closest('[data-node]')?.getAttribute('data-node')
                : null
            const node = layout.nodes.find((node) => node.id === id)
            if (node) {
              event.preventDefault()
              event.stopPropagation()
              activate(node)
            }
            return
          }
          const steps: Record<string, [number, number]> = {
            ArrowLeft: [30, 0],
            ArrowRight: [-30, 0],
            ArrowUp: [0, 30],
            ArrowDown: [0, -30],
          }
          const step = steps[event.key]
          if (step) {
            event.preventDefault()
            stopAnimation()
            setView({
              ...position,
              centered: null,
              x: position.x + step[0],
              y: position.y + step[1],
            })
          }
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          event.preventDefault()
          stopAnimation()
          setView({ ...position, centered: null })
          const id =
            event.target instanceof Element
              ? event.target.closest('[data-node]')?.getAttribute('data-node')
              : null
          const node = layout.nodes.find((node) => node.id === id)
          drag.current = {
            pointer: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            startX: event.clientX,
            startY: event.clientY,
            moved: false,
            node,
          }
          if (node) {
            node.fx = node.x
            node.fy = node.y
          }
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => {
          const current = drag.current
          if (!current || current.pointer !== event.pointerId) return
          const dx = event.clientX - current.x,
            dy = event.clientY - current.y
          if (
            Math.hypot(
              event.clientX - current.startX,
              event.clientY - current.startY,
            ) > 4
          )
            current.moved = true
          current.x = event.clientX
          current.y = event.clientY
          if (current.node) {
            current.node.fx = (current.node.fx ?? 0) + dx / position.scale
            current.node.fy = (current.node.fy ?? 0) + dy / position.scale
            current.node.x = current.node.fx
            current.node.y = current.node.fy
            if (matchMedia('(prefers-reduced-motion: reduce)').matches)
              simulation.current?.tick(layout.nodes.length > 80 ? 2 : 30)
            else simulation.current?.alpha(0.15).restart()
            setLayout((old) => ({ ...old }))
          } else
            setView((old) => {
              const current = camera(old, layout.nodes, size)
              return { ...current, x: current.x + dx, y: current.y + dy }
            })
        }}
        onPointerUp={(event) => {
          const current = drag.current
          if (!current || current.pointer !== event.pointerId) return
          drag.current = null
          event.currentTarget.releasePointerCapture(event.pointerId)
          if (current.node && !current.moved) activate(current.node)
        }}
        onPointerCancel={() => {
          drag.current = null
        }}
      >
        <g
          transform={`translate(${position.x} ${position.y}) scale(${position.scale})`}
        >
          {graphItems}
        </g>
      </svg>
      <div className="graph-zoom">
        <IconButton aria-label="Zoom in" onClick={() => zoom(1.25)}>
          <Plus size={16} />
        </IconButton>
        <IconButton aria-label="Zoom out" onClick={() => zoom(1 / 1.25)}>
          <Minus size={16} />
        </IconButton>
        <IconButton
          aria-label="Fit graph"
          onClick={() => {
            stopAnimation()
            setView(null)
          }}
        >
          <Focus size={16} />
        </IconButton>
      </div>
    </div>
  )
}
