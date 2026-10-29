import katex from 'katex'

/** KaTeX markup by LaTeX; null when KaTeX cannot render it. */
const formulas = new Map<string, string | null>()

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
    // ponytail: a whole-cache reset bounds memory; an LRU if outlines thrash it.
    if (formulas.size >= 1000) formulas.clear()
    formulas.set(latex, html)
  }
  return html ? (
    // KaTeX builds this markup itself; trust: false admits no author HTML.
    // biome-ignore lint/security/noDangerouslySetInnerHtml: KaTeX output
    <span className="outline-math" dangerouslySetInnerHTML={{ __html: html }} />
  ) : (
    <span className="outline-math">{latex}</span>
  )
}
