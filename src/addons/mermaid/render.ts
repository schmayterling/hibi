import DOMPurify from 'dompurify'
import type { ParsedDiagramModel, RenderOptions, RenderResult } from 'pele'
import type { Colorscheme, ColorToken } from '../../shared/colorschemes'

type Engine = typeof import('pele/lazy')
let pending: Promise<Engine> | undefined
let loaded: Engine | undefined

// Pele's layout scales with the diagram, so source length and edges stay unbounded.
// Its default 4,000,000-character output bound remains: a short source such as a
// packet bit range can expand into a far larger SVG.
const options = {
  limit: Number.POSITIVE_INFINITY,
  maxEdges: Number.POSITIVE_INFINITY,
  links: false,
  images: false,
} satisfies RenderOptions

const sanitize = (svg: string) =>
  DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ['foreignObject', 'a', 'image'],
    RETURN_DOM_FRAGMENT: true,
  })

function diagramType(engine: Engine, source: string) {
  try {
    return engine.detectType(source)
  } catch {
    return null
  }
}

/** Loads Pele and the renderer for this diagram's type. */
async function loadEngine(source: string) {
  pending ??= import('pele/lazy').then(
    (engine) => (loaded = engine),
    (error) => {
      pending = undefined
      throw error
    },
  )
  const engine = await pending
  await engine.load(diagramType(engine, source))
  return engine
}

function readyEngine(source: string) {
  if (!loaded) return
  const type = diagramType(loaded, source)
  return type === null || loaded.registered(type) ? loaded : undefined
}

type Diagram = {
  element: HTMLElement
  source: string
  onError: (error: unknown) => void
  idPrefix: string
  ready: boolean
  queued: boolean
  model?: ParsedDiagramModel
  natural?: RenderResult
  adapts?: boolean
  width?: number
}
type Fonts = { fontFamily: string; fontFamilyMono: string }
const diagrams = new Map<Element, Diagram>()
let resizes: ResizeObserver | undefined
let sequence = 0
let soon = false
let frame = 0
let idle = 0
// Each pass stays short so typing, scrolling, closing the note, or disabling
// diagrams never waits long behind a note full of diagrams.
const budget = 8

function request(when: 'now' | 'frame' | 'idle') {
  if (when === 'now') {
    if (soon) return
    soon = true
    queueMicrotask(() => {
      soon = false
      drain()
    })
  } else if (when === 'frame') {
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      drain()
    })
  } else {
    if (idle) return
    idle = requestIdleCallback(
      () => {
        idle = 0
        drain(true)
      },
      { timeout: 1000 },
    )
  }
}

// Matches Pele's mount(): fit narrower containers when the layout can adapt.
function layout(
  engine: Engine,
  diagram: Diagram,
  width: number,
  fonts: Fonts,
): { svg?: DocumentFragment; error?: unknown } {
  try {
    diagram.model ??= engine.parse(diagram.source, options)
    const model = diagram.model
    const render = (maxWidth?: number) =>
      engine.render(model, {
        ...options,
        ...fonts,
        idPrefix: diagram.idPrefix,
        ...(maxWidth ? { maxWidth } : {}),
      })
    diagram.natural ??= render()
    const natural = diagram.natural
    let result = natural
    if (width < natural.width) {
      diagram.adapts ??= render(1).svg !== natural.svg
      if (diagram.adapts) result = render(width)
    }
    diagram.width = width
    return { svg: sanitize(result.svg) }
  } catch (error) {
    return { error }
  }
}

/** Draws within one budget: reads, then layouts, then DOM writes. Off-screen diagrams wait for idle time. */
function drain(idleTime = false) {
  const engine = loaded
  if (!engine) return
  if (document.fonts.status === 'loading') {
    void document.fonts.ready.then(() => request('frame'))
    return
  }
  const start = performance.now()
  const queue: { diagram: Diagram; box: DOMRect }[] = []
  for (const diagram of diagrams.values()) {
    if (!diagram.queued || !diagram.ready) continue
    const box = diagram.element.getBoundingClientRect()
    // Hidden diagrams wait for the resize observer to report a width.
    if (box.width > 0) queue.push({ diagram, box })
  }
  const first = queue[0]
  if (!first) return
  const style = getComputedStyle(first.diagram.element)
  const fonts = {
    fontFamily:
      style.getPropertyValue('--pele-font').trim() || style.fontFamily,
    fontFamilyMono:
      style.getPropertyValue('--pele-font-mono').trim() || 'monospace',
  }
  const distance = ({ box }: { box: DOMRect }) =>
    Math.max(0, box.top - innerHeight, -box.bottom)
  queue.sort((a, b) => distance(a) - distance(b))
  const drawn: ({ diagram: Diagram } & ReturnType<typeof layout>)[] = []
  let visible = false
  for (const entry of queue) {
    if (!idleTime && distance(entry)) break
    if (drawn.length && performance.now() - start > budget) break
    visible ||= !distance(entry)
    drawn.push({
      diagram: entry.diagram,
      ...layout(engine, entry.diagram, Math.floor(entry.box.width), fonts),
    })
  }
  for (const { diagram, svg, error } of drawn) {
    diagram.queued = false
    diagram.element.replaceChildren(...(svg ? [svg] : []))
    if (!svg) diagram.onError(error)
  }
  const next = queue[drawn.length]
  // New heights can move more diagrams into view, so look again next frame.
  if (next) request(visible || !distance(next) ? 'frame' : 'idle')
}

function resized(entries: ResizeObserverEntry[]) {
  let queued = false
  for (const { target, contentRect } of entries) {
    const diagram = diagrams.get(target)
    const width = Math.floor(contentRect.width)
    if (!diagram?.ready || !width) continue
    if (diagram.queued) queued = true
    else if (
      diagram.natural &&
      diagram.adapts !== false &&
      width !== diagram.width &&
      Math.min(width, diagram.width ?? 0) < diagram.natural.width
    ) {
      diagram.queued = true
      queued = true
    }
  }
  if (queued) request('frame')
}

/** Queues a diagram that fits its container's width; the cleanup cancels it and every later redraw. */
export function mountDiagram(
  element: HTMLElement,
  source: string,
  onError: (error: unknown) => void,
) {
  const diagram: Diagram = {
    element,
    source,
    onError,
    idPrefix: `mermaid-${++sequence}`,
    ready: !!readyEngine(source),
    queued: true,
  }
  diagrams.set(element, diagram)
  resizes ??= new ResizeObserver(resized)
  resizes.observe(element)
  if (diagram.ready) request('now')
  else
    loadEngine(source).then(
      () => {
        diagram.ready = true
        if (diagrams.get(element) === diagram) request('now')
      },
      (error) => {
        if (diagrams.get(element) !== diagram) return
        diagram.queued = false
        element.replaceChildren()
        onError(error)
      },
    )
  return () => {
    if (diagrams.get(element) !== diagram) return
    diagrams.delete(element)
    resizes?.unobserve(element)
  }
}

/** Pele colors in Hibi roles. Rendered diagrams follow colorscheme changes without redrawing. */
export function diagramTheme(color: (role: ColorToken) => string) {
  const mix = (a: ColorToken, b: ColorToken) =>
    `color-mix(in oklch, ${color(a)}, ${color(b)})`
  return Object.entries({
    bg: color('background'),
    fg: color('ink'),
    muted: color('muted'),
    line: color('muted'),
    surface: color('surface'),
    'surface-alt': mix('surface', 'border'),
    border: mix('border', 'muted'),
    accent: color('accent'),
    critical: color('status-danger'),
    error: color('status-danger'),
    // Status colors stay distinct from each other in every scheme; accents may not.
    'series-1': color('status-info'),
    'series-2': color('status-success'),
    'series-3': color('status-warning'),
    'series-4': color('status-danger'),
    'series-5': mix('status-info', 'status-danger'),
    'series-6': mix('status-success', 'status-info'),
    'series-7': mix('status-success', 'status-warning'),
    'series-8': color('muted'),
  })
    .map(([name, value]) => `--pele-${name}:${value}`)
    .join(';')
}

/** Exports keep the active colorscheme in a self-contained image with its own background. */
export async function renderDiagram(source: string, scheme: Colorscheme) {
  if (!source.trim()) return ''
  const engine = await loadEngine(source)
  const svg = sanitize(
    engine.render(source, {
      ...options,
      fontFamily: 'sans-serif',
      fontFamilyMono: 'monospace',
      padding: 16,
    }).svg,
  ).firstElementChild
  if (!svg) return ''
  svg.setAttribute(
    'style',
    `${svg.getAttribute('style') ?? ''};background:${scheme.colors.background};${diagramTheme((role) => scheme.colors[role])}`,
  )
  return `<img class="mermaid-diagram" alt="Mermaid diagram" src="data:image/svg+xml,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}">`
}
