import katex from 'katex'

/** KaTeX markup by LaTeX; null when KaTeX cannot render it. */
const formulas = new Map<string, string | null>()
const cachedCharacters = 8_000_000
let characters = 0

/** A heading formula in the outline; its LaTeX stays as text if KaTeX cannot render it. */
export default function OutlineFormula({ latex }: { latex: string }) {
  let html = formulas.get(latex)
  if (html === undefined) {
    try {
      html = katex.renderToString(latex, {
        throwOnError: true,
        trust: false,
        maxExpand: 500,
        maxSize: 20,
      })
    } catch {
      html = null
    }
    const size = latex.length + (html?.length ?? 0)
    // Match the editor's math cache budget; oversized formulas still render.
    if (size <= cachedCharacters / 16) {
      // ponytail: reset the bounded cache; use an LRU if outlines thrash it.
      if (formulas.size >= 1000 || characters + size > cachedCharacters) {
        formulas.clear()
        characters = 0
      }
      formulas.set(latex, html)
      characters += size
    }
  }
  return html ? (
    // KaTeX builds this markup itself; trust: false admits no author HTML.
    // biome-ignore lint/security/noDangerouslySetInnerHtml: KaTeX output
    <span className="outline-math" dangerouslySetInnerHTML={{ __html: html }} />
  ) : (
    <span className="outline-math">{latex}</span>
  )
}
