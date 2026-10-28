import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import katex from 'katex'
import { mathContributions } from '../../src/addons/math/formatted'
import { mathStyles } from '../../src/addons/math/styles'
import {
  formattedMarkdown,
  formattedViews,
  showMarkdownMarkers,
} from '../../src/renderer/src/formatted-contributions'
import { formattedSyntax } from '../../src/renderer/src/formatted-syntax'
import { livePreview } from '../../src/renderer/src/live-preview'
import '../../src/renderer/src/styles.css'
import '../../src/ui/controls.css'

// The formatted view's math in a scrolled pane, with formulas that render
// only when the test fills them.
document.body.innerHTML =
  '<main class="editor-panes mode-normal" style="position:fixed;inset:0"><div class="editor-content"><section class="rich-pane" style="height:100%;overflow-y:auto"><div class="host"></div></section></div></main>'
const style = document.createElement('style')
style.textContent = mathStyles
document.head.append(style)
const host = document.querySelector<HTMLElement>('.host')!
const pane = document.querySelector<HTMLElement>('.rich-pane')!
const pending = new Map<
  HTMLElement,
  { latex: string; display: boolean; done: (html: string) => void }
>()
const frame = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  )
const contributions = mathContributions({
  formulas: {
    render: () => '',
    height: () => undefined,
    schedule(dom, latex, display, done) {
      pending.set(dom, { latex, display, done })
      return () => pending.delete(dom)
    },
  } as never,
  prompt: async () => null,
  focus: () => {},
  close: () => {},
})
let view: EditorView | null = null
let anchor = 0

Object.assign(window, {
  formulaReading: {
    /** A note of formulas, its reading line `anchor <index>` 180px below the pane's top; display matrices have `rows` rows. */
    async mount(
      type: 'display' | 'inline',
      focused = false,
      rows = 8,
      index = 60,
    ) {
      view?.destroy()
      pending.clear()
      let doc = ''
      for (let i = 0; i < 120; i++)
        doc +=
          type === 'display'
            ? `anchor ${i} text\n\n$$\n\\begin{pmatrix} ${[i, ...Array(rows - 1).fill('b')].join('\\\\')} \\end{pmatrix}\n$$\n\n`
            : `anchor ${i} text $\\dfrac{${i}}{\\dfrac{1}{2}}$ suffix\n\n`
      anchor = doc.indexOf(`anchor ${index} text`)
      view = new EditorView({
        parent: host,
        state: EditorState.create({
          doc,
          selection: { anchor },
          extensions: [
            livePreview(formattedSyntax()),
            ...[contributions.inline, contributions.block].flatMap(
              (contribution) => [
                formattedMarkdown.of(contribution.syntax),
                ...contribution.views.map((nodeView) =>
                  formattedViews.of(nodeView),
                ),
              ],
            ),
            contributions.editing.extension,
            showMarkdownMarkers.of(false),
          ],
        }),
      })
      await document.fonts.ready
      if (focused) view.focus()
      for (let attempt = 0; attempt < 20; attempt++) {
        view.dispatch({
          effects: EditorView.scrollIntoView(anchor, {
            y: 'start',
            yMargin: 180,
          }),
        })
        await frame()
        const top = view.coordsAtPos(anchor, 1)?.top
        if (
          top !== undefined &&
          Math.abs(top - pane.getBoundingClientRect().top - 180) < 1
        )
          return
      }
      throw new Error('the reading line did not settle')
    },
    /**
     * Renders the pending formulas `where` the reading line is, in one slice:
     * above the pane, on the reading line, or the one just before it.
     * Optionally scrolls by `scroll` in the next frame. Reports how far the
     * reading line moved after `frames` frames and where the pane ended up.
     */
    async fill(where: 'above' | 'line' | 'previous', scroll = 0, frames = 2) {
      const paneTop = pane.getBoundingClientRect().top
      const before = view!.coordsAtPos(anchor, 1)!.top
      const line = view!.state.doc.lineAt(anchor)
      let chosen = [...pending].filter(([dom]) => {
        if (!dom.isConnected) return false
        const at = view!.posAtDOM(dom)
        if (where === 'line') return at > anchor && at <= line.to
        if (where === 'previous')
          return at < anchor && dom.getBoundingClientRect().bottom <= before
        return dom.getBoundingClientRect().bottom <= paneTop
      })
      if (where === 'previous')
        chosen = chosen
          .sort(
            ([a], [b]) =>
              b.getBoundingClientRect().bottom -
              a.getBoundingClientRect().bottom,
          )
          .slice(0, 1)
      let target: number | null = null
      if (scroll)
        requestAnimationFrame(() => {
          pane.scrollTop += scroll
          target = pane.scrollTop
        })
      for (const [dom, { latex, display, done }] of chosen) {
        pending.delete(dom)
        done(katex.renderToString(latex, { displayMode: display }))
      }
      for (let count = 0; count < frames; count++) await frame()
      return {
        filled: chosen.length,
        moved: view!.coordsAtPos(anchor, 1)!.top - before,
        scrolled: target === null ? null : pane.scrollTop - target,
      }
    },
  },
})
