import source from 'katex/dist/katex.min.css?raw'

const fonts = import.meta.glob<string>(
  '../../../node_modules/katex/dist/fonts/*.woff2',
  { query: '?inline', import: 'default', eager: true },
)
const byName = new Map(
  Object.entries(fonts).map(([path, data]) => [path.split('/').at(-1), data]),
)
export const mathStyles =
  source.replace(/src:[^;}]+/g, (declaration) => {
    const name = /url\(fonts\/([^()]+\.woff2)\)/.exec(declaration)?.[1]
    const data = name && byName.get(name)
    return data ? `src:url(${data}) format("woff2")` : declaration
  }) +
  // Equations are not scroll anchors: text around them stays put while they render.
  // Accent marks and the overlays of laps (`\not`, `\neq`) paint after the glyph
  // under them, so their own opaque selection background would hide it
  // (`\bar x` selected read as `¯`).
  '\n.tiptap-mathematics-render{cursor:pointer;overflow-anchor:none}.tiptap-mathematics-render[data-type="inline-math"]{display:inline-block}.tiptap-mathematics-render[data-type="block-math"]{overflow-x:auto;padding:8px 0}.katex-display{overflow-x:auto;overflow-y:hidden}.katex{color:inherit}.katex :is(.accent-body,.katex-inner) ::selection{background:transparent}'
