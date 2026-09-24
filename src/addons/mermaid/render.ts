import DOMPurify from 'dompurify'
import type { Colorscheme } from '../../shared/colorschemes'

let sequence = 0
let initialized: Promise<typeof import('mermaid')['default']> | undefined
let renderQueue = Promise.resolve()
export async function renderDiagram(source: string, scheme: Colorscheme) {
  if (source.length > 50000)
    throw new Error('This diagram exceeds the 50,000 character limit.')
  if (!source.trim()) return ''
  initialized ??= import('mermaid')
    .then(({ default: engine }) => engine)
    .catch((error) => {
      initialized = undefined
      throw error
    })
  const mermaid = await initialized
  const render = renderQueue.then(async () => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      maxTextSize: 50000,
      maxEdges: 500,
      htmlLabels: false,
      theme: 'base',
      themeVariables: {
        darkMode: scheme.appearance === 'dark',
        background: scheme.colors.background,
        primaryColor: scheme.colors.surface,
        primaryTextColor: scheme.colors.ink,
        primaryBorderColor: scheme.colors.border,
        secondaryColor: scheme.colors.background,
        secondaryTextColor: scheme.colors.ink,
        secondaryBorderColor: scheme.colors.border,
        tertiaryColor: scheme.colors.surface,
        tertiaryTextColor: scheme.colors.ink,
        tertiaryBorderColor: scheme.colors.border,
        lineColor: scheme.colors.accent,
        textColor: scheme.colors.ink,
        mainBkg: scheme.colors.surface,
        noteBkgColor: scheme.colors.surface,
        noteTextColor: scheme.colors.ink,
        noteBorderColor: scheme.colors.border,
      },
      secure: [
        'secure',
        'securityLevel',
        'startOnLoad',
        'maxTextSize',
        'maxEdges',
        'suppressErrorRendering',
        'htmlLabels',
        'theme',
        'themeVariables',
        'themeCSS',
      ],
    })
    return mermaid.render(`hibi-diagram-${++sequence}`, source)
  })
  renderQueue = render.then(
    () => {},
    () => {},
  )
  const { svg } = await render
  const clean = DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ['foreignObject', 'a', 'image'],
  })
  return `<img class="mermaid-diagram" alt="Mermaid diagram" src="data:image/svg+xml,${encodeURIComponent(clean)}">`
}
