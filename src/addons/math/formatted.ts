import { EditorView, ViewPlugin, WidgetType } from '@codemirror/view'
import type { SyntaxNodeRef } from '@lezer/common'
import {
  type FormattedContribution,
  type FormattedNodeView,
  showMarkdownMarkers,
} from '../../renderer/src/formatted-contributions'
import { keepReading } from '../../renderer/src/reading-position.ts'
import { formattedMathBlock } from '../../shared/formatted-text-rules.ts'
import { blockMathSyntax, inlineMathSyntax } from './formatted-syntax'
import type { formulaScheduler } from './rendering'

/** What the formatted view's math shares with the addon's other views. */
export type MathHost = {
  /** The rich view's scheduler: KaTeX options, output cache and frame budget. */
  formulas: ReturnType<typeof formulaScheduler>
  /** Ask for a changed formula, as clicking an equation does in the rich view. */
  prompt: (latex: string) => Promise<string | null>
  /** A formatted view gained focus, so the insert commands edit it. */
  focus: (view: EditorView) => void
  /** A formatted view closed. */
  close: (view: EditorView) => void
}

const cancels = new WeakMap<HTMLElement, () => void>()
const widgets = new WeakMap<HTMLElement, FormulaWidget>()
const editControl = {
  type: 'button',
  class: 'hibi-lp-formula-edit',
  'aria-label': 'Edit equation',
}

/**
 * A rendered formula over its source. The formula text shows until KaTeX
 * output arrives: on screen before the next paint, the rest when visible or
 * idle, as in the rich view. Clicking places the caret, which reveals the
 * source while Markdown markers show. With markers hidden, an edit control
 * covers the formula: a click, or Enter or Space once the arrow keys reach
 * it, opens the formula prompt, as clicking an equation does in the rich view.
 */
class FormulaWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly latex: string,
    readonly display: boolean,
    /** The formula text inside `source`, which the prompt replaces. */
    readonly body: { from: number; to: number },
    readonly host: MathHost,
  ) {
    super()
  }
  override eq(other: FormulaWidget) {
    return (
      other.source === this.source &&
      other.display === this.display &&
      other.host === this.host
    )
  }
  toDOM(view: EditorView) {
    const { latex, display, host } = this
    // The rich view's math node markup, so the addon's styles apply alike.
    const dom = document.createElement(display ? 'div' : 'span')
    dom.className = 'tiptap-mathematics-render'
    if (view.state.facet(EditorView.editable))
      dom.classList.add('tiptap-mathematics-render--editable')
    dom.dataset.type = display ? 'block-math' : 'inline-math'
    dom.setAttribute('data-latex', latex)
    const target = display ? document.createElement('div') : dom
    if (display) {
      target.className = 'block-math-inner'
      dom.append(target)
    }
    const pending = display ? document.createElement('span') : target
    if (display) {
      pending.className = 'katex-display'
      target.append(pending)
    }
    pending.textContent = latex
    // An empty element on an inline formula's baseline, where the caret
    // beside the formula is drawn as tall as the text.
    const baseline = display ? null : document.createElement('span')
    if (baseline) {
      baseline.className = 'hibi-lp-formula-baseline'
      dom.append(baseline)
    }
    const control = document.createElement('button')
    for (const [name, value] of Object.entries(editControl))
      control.setAttribute(name, value)
    control.addEventListener('click', (event) => {
      event.preventDefault()
      void this.edit(view, dom)
    })
    control.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Escape'].includes(event.key)) return
      event.preventDefault()
      // The caret returns beside the formula, on the side the key points to.
      const from = view.posAtDOM(dom)
      view.focus()
      view.dispatch({
        selection: {
          anchor: event.key === 'ArrowLeft' ? from : from + this.source.length,
        },
      })
    })
    dom.append(control)
    /** Replace the formula's content, keeping the control and its focus. */
    const fill = (content: (into: HTMLElement) => void) => {
      const into = display && content !== error ? target : dom
      for (const child of [...into.childNodes])
        if (child !== control && child !== baseline) child.remove()
      content(into)
    }
    const error = (into: HTMLElement) => {
      into.prepend(latex)
      dom.classList.add(display ? 'block-math-error' : 'inline-math-error')
    }
    const reserved = display ? host.formulas.height(latex) : undefined
    if (reserved) dom.style.minHeight = `${reserved}px`
    const cancel = host.formulas.schedule(dom, latex, display, (html) => {
      keepReading(view, view.posAtDOM(dom))
      if (reserved) dom.style.removeProperty('min-height')
      // KaTeX builds this markup itself; trust: false admits no author HTML.
      if (html !== null)
        fill((into) => into.insertAdjacentHTML('afterbegin', html))
      else fill(error)
      view.requestMeasure()
    })
    cancels.set(dom, cancel)
    widgets.set(dom, this)
    return dom
  }
  /** Replace the formula from the prompt, while the source is still what this widget shows. */
  async edit(view: EditorView, dom: HTMLElement) {
    if (!view.state.facet(EditorView.editable)) return
    const at = view.posAtDOM(dom)
    const latex = await this.host.prompt(this.latex)
    if (latex === null) return
    const from = dom.isConnected ? view.posAtDOM(dom) : at
    if (view.state.sliceDoc(from, from + this.source.length) !== this.source)
      return
    const trailing = /\n$/.test(this.source.slice(this.body.from, this.body.to))
    view.dispatch({
      changes: {
        from: from + this.body.from,
        to: from + this.body.to,
        insert: `${latex.trim()}${trailing ? '\n' : ''}`,
      },
      userEvent: 'input.format',
    })
    view.focus()
  }
  /** The caret beside an inline formula is text sized, as in the rich view. */
  override coordsAt(dom: HTMLElement, pos: number) {
    const baseline = dom.querySelector(':scope > .hibi-lp-formula-baseline')
    if (!baseline) return null
    const { top, bottom } = baseline.getBoundingClientRect()
    const box = dom.getBoundingClientRect()
    const x = pos > 0 ? box.right : box.left
    return { left: x, right: x, top, bottom }
  }
  override destroy(dom: HTMLElement) {
    cancels.get(dom)?.()
    cancels.delete(dom)
  }
  override ignoreEvent(event: Event) {
    // The edit control handles its own clicks and keys; elsewhere, a click places the caret.
    return (
      event.target instanceof Element &&
      !!event.target.closest('.hibi-lp-formula-edit')
    )
  }
}

/** With markers hidden, an arrow key toward a formula beside the caret focuses its edit control. */
function enterFormula(view: EditorView, forward: boolean) {
  const { main, ranges } = view.state.selection
  if (view.state.facet(showMarkdownMarkers) || ranges.length > 1 || !main.empty)
    return false
  for (const control of view.contentDOM.querySelectorAll<HTMLElement>(
    '.hibi-lp-formula-edit',
  )) {
    const dom = control.parentElement
    const widget = dom && widgets.get(dom)
    if (!dom || !widget) continue
    const from = view.posAtDOM(dom)
    if ((forward ? from : from + widget.source.length) !== main.head) continue
    control.focus()
    return true
  }
  return false
}

const contributions = new WeakMap<
  MathHost,
  Record<'inline' | 'block' | 'editing', FormattedContribution>
>()

/** The formatted view's inline math, display math, and math commands. */
export function mathContributions(host: MathHost) {
  const existing = contributions.get(host)
  if (existing) return existing
  const inline: FormattedNodeView = {
    nodes: ['InlineMath'],
    decorate(node, out, { state, revealed }) {
      // `$$…$$` inside a line is display math there, as Obsidian draws it.
      const mark = (node.node.firstChild?.to ?? node.from + 1) - node.from
      if (revealed) {
        out.syntax(node.from, node.from + mark)
        out.syntax(node.to - mark, node.to)
        out.mark(node.from + mark, node.to - mark, {
          class: 'hibi-lp-math-source',
        })
      } else {
        const source = state.sliceDoc(node.from, node.to)
        const body = source.slice(mark, -mark)
        out.replace(
          node.from,
          node.to,
          new FormulaWidget(
            source,
            mark > 1 ? body.trim() : body,
            mark > 1,
            { from: mark, to: source.length - mark },
            host,
          ),
        )
      }
      return false
    },
  }
  /** A display block's formula, when it is closed. */
  const display = (node: SyntaxNodeRef, source: string) => {
    if (!formattedMathBlock(node.node)) return null
    const texts = node.node.getChildren('MathText')
    const first = texts[0],
      last = texts.at(-1)
    if (!first || !last) return null
    const latex = texts
      .map((text) => source.slice(text.from - node.from, text.to - node.from))
      .join('')
      .trim()
    return new FormulaWidget(
      source,
      latex,
      true,
      { from: first.from - node.from, to: last.to - node.from },
      host,
    )
  }
  const block: FormattedNodeView = {
    nodes: ['BlockMath'],
    // The rich view's block math has no margins: its padding and KaTeX's
    // display margins are inside the widget.
    space: { top: 0, bottom: 0 },
    layout(node, out, { state, revealed }) {
      const widget = display(node, state.sliceDoc(node.from, node.to))
      if (!widget) return false
      // Inside quotes and lists the line keeps its container layout, so the
      // formula replaces the block's text instead of its lines. While the
      // source shows, the formula follows it on the closing line.
      if (revealed) out.widget(node.to, widget, { side: 1 })
      else out.replace(node.from, node.to, widget)
      return false
    },
    decorate(node, out, { revealed }) {
      if (!revealed) return false
      for (let child = node.node.firstChild; child; child = child.nextSibling)
        if (child.name === 'MathMark') out.syntax(child.from, child.to)
        else if (child.name === 'MathText')
          out.mark(child.from, child.to, { class: 'hibi-lp-math-source' })
      return false
    },
  }
  const created = {
    inline: {
      id: 'math.inline',
      feature: 'math.inline',
      flavor: 'math.latex',
      syntax: inlineMathSyntax,
      inlineStops: true,
      views: [inline],
    },
    block: {
      id: 'math.block',
      feature: 'math.block',
      flavor: 'math.latex',
      syntax: blockMathSyntax,
      views: [block],
    },
    editing: {
      id: 'math.editing',
      flavor: 'math.latex',
      keys: [
        { key: 'ArrowRight', run: (view) => enterFormula(view, true) },
        { key: 'ArrowLeft', run: (view) => enterFormula(view, false) },
      ],
      extension: [
        EditorView.editorAttributes.compute([showMarkdownMarkers], (state) =>
          state.facet(showMarkdownMarkers)
            ? {}
            : { class: 'hibi-lp-markers-hidden' },
        ),
        ViewPlugin.define((view) => {
          if (view.hasFocus) host.focus(view)
          return { destroy: () => host.close(view) }
        }),
        EditorView.domEventHandlers({
          focus(_, view) {
            host.focus(view)
          },
        }),
        EditorView.baseTheme({
          // Display formulas fill the line that held their source, from its top.
          '.tiptap-mathematics-render[data-type="block-math"]': {
            display: 'inline-block',
            width: '100%',
            verticalAlign: 'top',
          },
          '.hibi-lp-math-source': {
            fontFamily: 'var(--font-mono)',
            fontSize: '0.85em',
          },
          '.tiptap-mathematics-render': { position: 'relative' },
          // The edit control covers its formula and takes the usual focus ring.
          '.hibi-lp-formula-edit': {
            position: 'absolute',
            inset: '0',
            margin: '0',
            padding: '0',
            border: 'none',
            background: 'none',
            cursor: 'pointer',
          },
          '&:not(.hibi-lp-markers-hidden) .hibi-lp-formula-edit': {
            display: 'none',
          },
        }),
      ],
    },
  } satisfies Record<'inline' | 'block' | 'editing', FormattedContribution>
  contributions.set(host, created)
  return created
}
