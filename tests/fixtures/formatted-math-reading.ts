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
      const syntax = formattedSyntax()
      view = new EditorView({
        parent: host,
        state: EditorState.create({
          doc,
          selection: { anchor },
          extensions: [
            livePreview(syntax),
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
      let last = ''
      for (let attempt = 0; attempt < 50; attempt++) {
        view.dispatch({
          effects: EditorView.scrollIntoView(anchor, {
            y: 'start',
            yMargin: 180,
          }),
        })
        await frame()
        const paneTop = pane.getBoundingClientRect().top
        const top = view.coordsAtPos(anchor, 1)?.top ?? Number.NaN
        // The jump lands before the view parses and draws the formulas around it.
        const drawn = [...pending.keys()]
          .filter((dom) => dom.isConnected)
          .map((dom) => dom.getBoundingClientRect())
        const above = drawn.filter((box) => box.bottom <= top).length
        const below = drawn.filter((box) => box.top > top).length
        if (Math.abs(top - paneTop - 180) < 1 && above && below) return
        last = JSON.stringify({ offset: top - paneTop, above, below })
      }
      throw new Error(`the reading line did not settle: ${last}`)
    },
    /** Idle parsing and height estimates must not move an already placed reader. */
    async idle() {
      const before = view!.coordsAtPos(anchor, 1)!.top
      let moved = 0
      for (let sample = 0; sample < 10; sample++) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        await frame()
        moved = Math.max(
          moved,
          Math.abs(view!.coordsAtPos(anchor, 1)!.top - before),
        )
      }
      return moved
    },
    /**
     * Renders the pending formulas `where` the reading line is, in one slice:
     * above the pane, on the reading line, or the one just before it.
     * Optionally scrolls by `scroll` in the next frame, or `jump`s to the
     * note's end with a scroll command in the same task. Reports how far the
     * reading line moved after `frames` frames and where the pane ended up.
     */
    async fill(
      where: 'above' | 'below' | 'line' | 'previous',
      scroll = 0,
      frames = 2,
      typing = false,
      jump = false,
    ) {
      const paneTop = pane.getBoundingClientRect().top
      const before = view!.coordsAtPos(anchor, 1)!.top
      const line = view!.state.doc.lineAt(anchor)
      let chosen = [...pending].filter(([dom]) => {
        if (!dom.isConnected) return false
        const at = view!.posAtDOM(dom)
        if (where === 'line') return at > anchor && at <= line.to
        if (where === 'below') return at > line.to
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
      if (typing)
        requestAnimationFrame(() => {
          view!.dispatch({
            changes: { from: anchor, insert: 'typed ' },
            selection: { anchor: anchor + 6 },
            userEvent: 'input.type',
          })
          anchor += 6
        })
      for (const [dom, { latex, display, done }] of chosen) {
        pending.delete(dom)
        done(katex.renderToString(latex, { displayMode: display }))
      }
      const end = view!.state.doc.length
      if (jump)
        view!.dispatch({
          effects: EditorView.scrollIntoView(end, { y: 'end' }),
        })
      for (let count = 0; count < frames; count++) await frame()
      const last = jump ? view!.coordsAtPos(end, -1) : null
      const { bottom } = pane.getBoundingClientRect()
      return {
        filled: chosen.length,
        moved: view!.coordsAtPos(anchor, 1)!.top - before,
        scrolled: target === null ? null : pane.scrollTop - target,
        // The note's last line is on screen after the jump.
        landed: last ? last.top >= paneTop && last.bottom <= bottom + 1 : null,
      }
    },
  },
})
