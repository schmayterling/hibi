import DOMPurify from 'dompurify'
import type { Mounted, RenderOptions } from 'pele'
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

/** Draws now when this diagram type is loaded, otherwise after it loads. The cleanup cancels both. */
export function mountDiagram(
  element: HTMLElement,
  source: string,
  events: { onRender: () => void; onError: (error: unknown) => void },
) {
  let active = true
  let diagram: Mounted | undefined
  const draw = (engine: Engine) => {
    if (active)
      diagram = engine.mount(element, source, {
        ...options,
        ...events,
        sanitize,
        zoom: false,
      })
  }
  const ready = readyEngine(source)
  if (ready) draw(ready)
  else
    loadEngine(source).then(draw, (error) => {
      if (active) events.onError(error)
    })
  return () => {
    active = false
    diagram?.destroy()
    element.replaceChildren()
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
    'series-1': color('accent'),
    'series-2': color('status-info'),
    'series-3': color('status-success'),
    'series-4': color('status-warning'),
    'series-5': color('status-danger'),
    'series-6': mix('status-info', 'status-danger'),
    'series-7': mix('status-success', 'status-warning'),
    'series-8': color('muted'),
  })
    .map(([name, value]) => `--pele-${name}:${value}`)
    .join(';')
}

/** Exports keep the active colorscheme in a self-contained image. */
export async function renderDiagram(source: string, scheme: Colorscheme) {
  if (!source.trim()) return ''
  const engine = await loadEngine(source)
  const svg = sanitize(
    engine.render(source, {
      ...options,
      fontFamily: 'sans-serif',
      fontFamilyMono: 'monospace',
    }).svg,
  ).firstElementChild
  if (!svg) return ''
  svg.setAttribute(
    'style',
    `${svg.getAttribute('style') ?? ''};${diagramTheme((role) => scheme.colors[role])}`,
  )
  return `<img class="mermaid-diagram" alt="Mermaid diagram" src="data:image/svg+xml,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}">`
}
