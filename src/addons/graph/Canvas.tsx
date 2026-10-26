/** biome-ignore-all lint/a11y/noNoninteractiveTabindex: the graph view supports keyboard panning and must be focusable. */
import { Focus, Maximize2, Minus, Plus } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { IconButton } from '../../ui/Controls'
import type { LayoutFrame, LayoutMessage } from './layout'
import type { noteGraph } from './model'
import { defaultZoom } from './preferences'
import {
  type Camera,
  cameraPosition,
  drawGraph,
  graphTopology,
  nodeAt,
  type Palette,
  type Size,
  showsLabels,
  spatialIndex,
  type View,
} from './scene'

const reducedMotion = () =>
  matchMedia('(prefers-reduced-motion: reduce)').matches

/** Canvas colors and label font come from the stylesheet's graph tokens. */
function readPalette(probe: HTMLElement): Palette {
  const style = getComputedStyle(probe)
  const color = (name: string) => {
    probe.style.color = `var(${name})`
    return style.color
  }
  const palette = {
    edge: color('--graph-edge'),
    node: color('--graph-node'),
    border: color('--graph-node-border'),
    activeNode: color('--graph-node-active'),
    activeBorder: color('--graph-node-active-border'),
    label: color('--graph-label'),
    activeLabel: color('--graph-label-active'),
    font: `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`,
  }
  probe.style.color = ''
  return palette
}

export function GraphCanvas({
  graph,
  active,
  open,
  expand,
  resetKey,
  worker,
}: {
  graph: ReturnType<typeof noteGraph>
  active: string | null
  open: (path: string) => void
  expand?: (() => void) | undefined
  resetKey: string
  /** Starts a layout worker; the app and exported sites bundle it differently. */
  worker: () => Worker
}) {
  const root = useRef<HTMLDivElement>(null)
  const host = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const hover = useRef<HTMLDivElement>(null)
  const option = useRef<HTMLDivElement>(null)
  const probe = useRef<HTMLSpanElement>(null)
  const [view, setView] = useState<Camera>('default')
  const [initialZoom] = useState(defaultZoom)
  const [hovered, setHovered] = useState<string | null>(null)
  const [focused, setFocused] = useState<string | null>(null)
  const [focusVisible, setFocusVisible] = useState(false)
  const topology = useMemo(() => graphTopology(graph), [graph])
  const nodes = topology.nodes
  const activeIndex = active === null ? undefined : topology.index.get(active)
  const current =
    (focused === null ? undefined : topology.index.get(focused)) ??
    activeIndex ??
    0
  const currentNode = nodes[current]
  const hoveredNode =
    hovered === null ? undefined : nodes[topology.index.get(hovered) ?? -1]
  // Worker frames, pointer input, and drawing share this without rendering.
  const [state] = useState(() => ({
    graph: topology,
    positions: null as Float32Array | null,
    returnable: null as ArrayBuffer | null,
    version: 0,
    revision: 0,
    grid: null as {
      revision: number
      index: ReturnType<typeof spatialIndex>
    } | null,
    port: null as Pick<Worker, 'postMessage' | 'terminate'> | null,
    frame: 0,
    palette: null as Palette | null,
    metrics: new Map<
      string,
      { width: number; ascent: number; descent: number }
    >(),
    placed: new WeakMap<HTMLElement, string>(),
    sequence: 0,
    drag: null as { index: number; x: number; y: number; seq: number } | null,
    pointer: null as {
      id: number
      x: number
      y: number
      startX: number
      startY: number
      moved: boolean
      node: number
    } | null,
    view: view as Camera,
    // CSS pixels of the canvas, kept by its resize observer.
    size: { width: 640, height: 400 } as Size,
    drawn: null as View | null,
    hovered,
    focused: null as string | null,
    option: null as string | null,
    focusVisible,
    active,
  }))
  const initialTarget = useRef(active)
  const animation = useRef<number | null>(null)
  const previousSelection = useRef(active)
  const previousResetKey = useRef(resetKey)
  const focusOption = useRef(false)
  const typed = useRef({ text: '', at: 0 })
  // One layout worker serves this view for its whole lifetime.
  const createWorker = useRef(worker)
  const camera = useCallback(
    (value: Camera) =>
      cameraPosition(
        value,
        state.graph,
        state.positions,
        state.size,
        initialTarget.current,
        initialZoom,
      ),
    [state, initialZoom],
  )
  const stopAnimation = useCallback(() => {
    if (animation.current !== null) cancelAnimationFrame(animation.current)
    animation.current = null
  }, [])
  /** A label's size in graph units, measured once per font. */
  const measure = useCallback(
    (index: number) => {
      const text = state.graph.labels[index]!
      let value = state.metrics.get(text)
      const context = canvas.current?.getContext('2d')
      if (!value && context && state.palette) {
        context.font = state.palette.font
        const metrics = context.measureText(text)
        value = {
          width: metrics.width,
          ascent: metrics.fontBoundingBoxAscent,
          descent: metrics.fontBoundingBoxDescent,
        }
        state.metrics.set(text, value)
      }
      return value ?? { width: 0, ascent: 0, descent: 0 }
    },
    [state],
  )
  const place = useCallback(
    (
      element: HTMLElement | null,
      id: string | null,
      position: View,
      label = false,
    ) => {
      if (!element) return
      const index = id === null ? undefined : state.graph.index.get(id)
      const x = index === undefined ? NaN : state.positions?.[index * 2]
      let box = [-100, -100, 0, 0]
      if (x !== undefined && !Number.isNaN(x)) {
        const { scale } = position
        const centerX = state.size.width / 2 + position.x + x * scale
        const centerY =
          state.size.height / 2 +
          position.y +
          state.positions![index! * 2 + 1]! * scale
        const radius = Math.max(state.graph.radii[index!]!, 2.5 / scale) * scale
        let left = centerX - radius,
          top = centerY - radius,
          right = centerX + radius,
          bottom = centerY + radius
        // A hint also covers its shown label, as the svg note group did.
        if (label && showsLabels(state.graph, position)) {
          const text = measure(index!)
          const baseline = centerY - 14 * scale
          left = Math.min(left, centerX - (text.width / 2) * scale)
          right = Math.max(right, centerX + (text.width / 2) * scale)
          top = Math.min(top, baseline - text.ascent * scale)
          bottom = Math.max(bottom, baseline + text.descent * scale)
        }
        box = [left, top, right - left, bottom - top]
      }
      const key = box.join(' ')
      if (state.placed.get(element) === key) return
      state.placed.set(element, key)
      element.style.transform = `translate(${box[0]}px, ${box[1]}px)`
      element.style.width = `${box[2]}px`
      element.style.height = `${box[3]}px`
    },
    [state, measure],
  )
  const draw = useCallback(() => {
    state.frame = 0
    const element = canvas.current
    const context = element?.getContext('2d')
    if (!element || !context || !probe.current) return
    state.palette ??= readPalette(probe.current)
    const positions = state.positions
    if (!positions) return
    const position = camera(state.view)
    state.drawn = position
    const labels = String(showsLabels(state.graph, position))
    if (root.current && root.current.dataset.labels !== labels)
      root.current.dataset.labels = labels
    const highlighted = [
      state.hovered,
      state.focusVisible ? state.focused : null,
      state.active,
    ].flatMap((id) => {
      const index = id === null ? undefined : state.graph.index.get(id)
      return index === undefined ? [] : [index]
    })
    drawGraph(context, {
      graph: state.graph,
      positions,
      view: position,
      size: state.size,
      ratio: element.width / Math.max(1, state.size.width),
      highlighted,
      palette: state.palette,
    })
    place(hover.current, state.hovered, position, true)
    place(option.current, state.option, position)
  }, [state, camera, place])
  const requestDraw = useCallback(() => {
    if (!state.frame) state.frame = requestAnimationFrame(draw)
  }, [state, draw])
  /** Graph coordinates of a pointer, or null before the first frame. */
  const pick = (clientX: number, clientY: number) => {
    const element = host.current,
      positions = state.positions,
      position = state.drawn
    if (!element || !positions || !position) return -1
    const bounds = element.getBoundingClientRect()
    if (state.grid?.revision !== state.revision)
      state.grid = { revision: state.revision, index: spatialIndex(positions) }
    return nodeAt(
      state.graph,
      positions,
      state.grid.index,
      position,
      (clientX - bounds.left - bounds.width / 2 - position.x) / position.scale,
      (clientY - bounds.top - bounds.height / 2 - position.y) / position.scale,
      measure,
    )
  }
  const pin = (index: number, x: number, y: number, moved: boolean) => {
    state.drag = { index, x, y, seq: ++state.sequence }
    state.port?.postMessage({
      type: 'pin',
      version: state.version,
      index,
      x,
      y,
      drag: state.sequence,
      moved,
      reduced: reducedMotion(),
    } satisfies LayoutMessage)
  }
  useLayoutEffect(() => {
    state.view = view
    state.hovered = hovered
    state.focused = focused
    state.focusVisible = focusVisible
    state.active = active
    state.option = currentNode?.id ?? null
    if (state.drawn) {
      place(hover.current, hovered, state.drawn, true)
      place(option.current, state.option, state.drawn)
    }
    requestDraw()
  })
  useLayoutEffect(() => {
    const element = canvas.current
    if (!element) return
    const resize = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width,
        height = entry?.contentRect.height
      if (!entry || !width || !height) return
      const device = entry.devicePixelContentBoxSize?.[0]
      const deviceWidth =
        device?.inlineSize ?? Math.round(width * devicePixelRatio)
      const deviceHeight =
        device?.blockSize ?? Math.round(height * devicePixelRatio)
      if (element.width !== deviceWidth) element.width = deviceWidth
      if (element.height !== deviceHeight) element.height = deviceHeight
      state.size = { width, height }
      // Resizing clears the backing store; repaint before this frame shows.
      draw()
    })
    try {
      resize.observe(element, { box: 'device-pixel-content-box' })
    } catch {
      resize.observe(element)
    }
    return () => resize.disconnect()
  }, [state, draw])
  useEffect(() => {
    const element = host.current
    if (!element) return
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      stopAnimation()
      const bounds = element.getBoundingClientRect()
      const x = event.clientX - bounds.left - bounds.width / 2
      const y = event.clientY - bounds.top - bounds.height / 2
      setView((old) => {
        const position = camera(old)
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
    return () => element.removeEventListener('wheel', wheel)
  }, [camera, stopAnimation])
  useEffect(() => {
    const refresh = () => {
      state.palette = null
      state.metrics.clear()
      requestDraw()
    }
    let alive = true
    const theme = new MutationObserver(refresh)
    theme.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-appearance', 'data-colorscheme'],
    })
    // Canvas text does not repaint itself when a web font finishes loading.
    void document.fonts.ready.then(() => {
      if (alive) refresh()
    })
    return () => {
      alive = false
      theme.disconnect()
      cancelAnimationFrame(state.frame)
      state.frame = 0
    }
  }, [state, requestDraw])
  /** Lays out the current graph, starting from the positions shown so far. */
  const startLayout = useCallback(() => {
    const port = state.port
    if (!port) return
    const count = state.graph.nodes.length * 2
    const positions =
      state.positions?.length === count
        ? state.positions.slice()
        : new Float32Array(count).fill(Number.NaN)
    const edges = state.graph.edges.slice()
    state.version++
    state.returnable = null
    state.drag = null
    port.postMessage(
      {
        type: 'graph',
        version: state.version,
        edges,
        positions,
        reduced: reducedMotion(),
      } satisfies LayoutMessage,
      [edges.buffer, positions.buffer],
    )
  }, [state])
  useEffect(() => {
    let port: typeof state.port = null
    let alive = true
    const receive = (frame: LayoutFrame) => {
      if (frame.version !== state.version) return
      if (state.returnable)
        state.port?.postMessage(
          { type: 'buffer', buffer: state.returnable } satisfies LayoutMessage,
          [state.returnable],
        )
      state.returnable = frame.positions.buffer as ArrayBuffer
      // Keep a dragged note under the pointer until the layout catches up.
      const drag = state.drag
      if (
        drag &&
        (state.pointer?.node === drag.index || frame.drag < drag.seq)
      ) {
        frame.positions[drag.index * 2] = drag.x
        frame.positions[drag.index * 2 + 1] = drag.y
      } else state.drag = null
      state.positions = frame.positions
      state.revision++
      requestDraw()
    }
    // A page that cannot start workers (a strict host policy, some file
    // viewers) runs the same layout itself, in short slices between tasks.
    const layOutHere = () => {
      void Promise.all([import('./layout'), import('./page-step')]).then(
        ([{ createLayout }, { pageSteps }]) => {
          if (!alive) return
          const layout = createLayout(
            (frame) => queueMicrotask(() => receive(frame)),
            8,
            pageSteps,
          )
          port = state.port = {
            postMessage: (message: LayoutMessage) => layout.receive(message),
            terminate: layout.stop,
          }
          startLayout()
        },
      )
    }
    try {
      const started = createWorker.current()
      started.onmessage = (event: MessageEvent<LayoutFrame>) =>
        receive(event.data)
      started.onerror = (event) => {
        event.preventDefault()
        started.terminate()
        if (port !== started) return
        port = state.port = null
        layOutHere()
      }
      port = state.port = started
    } catch {
      layOutHere()
    }
    return () => {
      alive = false
      port?.terminate()
      state.port = null
    }
  }, [state, requestDraw, startLayout])
  useEffect(() => {
    const previous = state.graph,
      old = state.positions
    // Warm start: notes that stay keep their place.
    const positions = new Float32Array(topology.nodes.length * 2).fill(
      Number.NaN,
    )
    if (old)
      topology.nodes.forEach((node, index) => {
        const from = previous.index.get(node.id)
        if (from === undefined) return
        positions[index * 2] = old[from * 2]!
        positions[index * 2 + 1] = old[from * 2 + 1]!
      })
    state.graph = topology
    state.positions = positions
    state.revision++
    startLayout()
    requestDraw()
  }, [topology, state, startLayout, requestDraw])
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
    const target = () => {
      const index = active === null ? undefined : state.graph.index.get(active)
      const x = index === undefined ? NaN : state.positions?.[index * 2]
      return x === undefined || Number.isNaN(x)
        ? null
        : { x, y: state.positions![index! * 2 + 1]! }
    }
    const node = target()
    if (!node) return
    const from = camera(state.view)
    stopAnimation()
    if (reducedMotion()) {
      setView({
        ...from,
        x: -node.x * from.scale,
        y: -node.y * from.scale,
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
        x: from.x + (-node.x * from.scale - from.x) * eased,
        y: from.y + (-node.y * from.scale - from.y) * eased,
        centered: progress === 1 ? active : null,
      })
      animation.current = progress < 1 ? requestAnimationFrame(step) : null
    }
    animation.current = requestAnimationFrame(step)
  }, [active, state, camera, stopAnimation])
  useEffect(() => () => stopAnimation(), [stopAnimation])
  useLayoutEffect(() => {
    if (!focusOption.current) return
    focusOption.current = false
    option.current?.focus({ preventScroll: true })
  })
  function activate(id: string) {
    if (id === active) setView({ ...camera(state.view), centered: id })
    open(id)
  }
  /** Centers a note reached from the keyboard when it is out of view. */
  function reveal(id: string) {
    const index = state.graph.index.get(id)
    const position = state.drawn
    const x = index === undefined ? NaN : state.positions?.[index * 2]
    if (!position || x === undefined || Number.isNaN(x)) return
    const left = state.size.width / 2 + position.x + x * position.scale
    const top =
      state.size.height / 2 +
      position.y +
      state.positions![index! * 2 + 1]! * position.scale
    if (
      left < 0 ||
      top < 0 ||
      left > state.size.width ||
      top > state.size.height
    ) {
      stopAnimation()
      setView({ ...position, centered: id })
    }
  }
  function zoom(factor: number) {
    stopAnimation()
    setView((old) => {
      const current = camera(old)
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
  return (
    <div ref={root} className="graph-canvas">
      {expand && (
        <IconButton
          className="graph-expand"
          aria-label="Expand graph"
          onClick={expand}
        >
          <Maximize2 size={14} />
        </IconButton>
      )}
      <div
        ref={host}
        className="graph-view"
        role="application"
        aria-label="Workspace graph"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return
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
            const position = camera(state.view)
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
          setView({ ...camera(state.view), centered: null })
          const node = pick(event.clientX, event.clientY)
          state.pointer = {
            id: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            startX: event.clientX,
            startY: event.clientY,
            moved: false,
            node,
          }
          if (node >= 0 && state.positions)
            pin(
              node,
              state.positions[node * 2]!,
              state.positions[node * 2 + 1]!,
              false,
            )
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => {
          const current = state.pointer
          if (!current) {
            const node = pick(event.clientX, event.clientY)
            setHovered(node < 0 ? null : (state.graph.nodes[node]?.id ?? null))
            return
          }
          if (current.id !== event.pointerId) return
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
          const drag = state.drag
          if (current.node >= 0 && drag && state.positions) {
            const scale = camera(state.view).scale
            pin(drag.index, drag.x + dx / scale, drag.y + dy / scale, true)
            state.positions[drag.index * 2] = state.drag!.x
            state.positions[drag.index * 2 + 1] = state.drag!.y
            state.revision++
            requestDraw()
          } else if (current.node < 0)
            setView((old) => {
              const position = camera(old)
              return { ...position, x: position.x + dx, y: position.y + dy }
            })
        }}
        onPointerUp={(event) => {
          const current = state.pointer
          if (!current || current.id !== event.pointerId) return
          state.pointer = null
          event.currentTarget.releasePointerCapture(event.pointerId)
          const id = state.graph.nodes[current.node]?.id
          if (id !== undefined && !current.moved) activate(id)
        }}
        onPointerCancel={() => {
          state.pointer = null
        }}
        onPointerLeave={() => {
          if (!state.pointer) setHovered(null)
        }}
      >
        <canvas ref={canvas} />
        {hoveredNode && (
          <div
            ref={hover}
            className="graph-node"
            data-node={hoveredNode.id}
            data-tooltip={`${hoveredNode.id} · ${hoveredNode.degree} connections`}
            data-verbatim="true"
          />
        )}
      </div>
      {currentNode && (
        <div className="graph-nodes" role="listbox" aria-label="Notes">
          <div
            key={currentNode.id}
            ref={option}
            role="option"
            className="graph-node"
            tabIndex={0}
            data-node={currentNode.id}
            data-tooltip={`${currentNode.id} · ${currentNode.degree} connections`}
            data-verbatim="true"
            aria-label={`Open ${currentNode.id}`}
            aria-selected={currentNode.id === active}
            aria-setsize={nodes.length}
            aria-posinset={current + 1}
            onFocus={(event) => {
              setFocused(currentNode.id)
              setFocusVisible(event.currentTarget.matches(':focus-visible'))
              reveal(currentNode.id)
            }}
            onBlur={() => {
              // Coming back starts from the current note again.
              setFocused(null)
              setFocusVisible(false)
              typed.current = { text: '', at: 0 }
            }}
            onKeyDown={(event) => {
              let next = -1
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                event.stopPropagation()
                activate(currentNode.id)
                return
              }
              if (event.key === 'ArrowDown' || event.key === 'ArrowRight')
                next = Math.min(nodes.length - 1, current + 1)
              else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft')
                next = Math.max(0, current - 1)
              else if (event.key === 'Home') next = 0
              else if (event.key === 'End') next = nodes.length - 1
              else if (
                event.key.length === 1 &&
                !event.ctrlKey &&
                !event.metaKey &&
                !event.altKey
              ) {
                // Type a name to jump to it, like other lists.
                const now = performance.now()
                const text =
                  (now - typed.current.at < 500 ? typed.current.text : '') +
                  event.key.toLowerCase()
                typed.current = { text, at: now }
                for (
                  let step = text.length === 1 ? 1 : 0;
                  step <= nodes.length;
                  step++
                ) {
                  const index = (current + step) % nodes.length
                  if (nodes[index]!.label.toLowerCase().startsWith(text)) {
                    next = index
                    break
                  }
                }
              }
              if (next < 0) return
              event.preventDefault()
              if (next === current) return
              focusOption.current = true
              setFocused(nodes[next]!.id)
            }}
          />
        </div>
      )}
      <span ref={probe} className="graph-label" hidden />
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
