import {
  type EditorState,
  MapMode,
  StateEffect,
  StateField,
} from '@codemirror/state'
import { type EditorView, WidgetType } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import {
  type FormattedContribution,
  formattedRenderInputs,
} from '../../renderer/src/formatted-contributions.ts'
import { formattedAlertText } from '../../shared/formatted-text-rules.ts'
import { GithubAlerts } from '../../shared/markdown-extra-syntax.ts'
import { alertMarker, alertType } from './alerts.ts'
import { calloutToggle, updateCalloutToggle } from './callout-toggle.ts'
import './formatted.css'

export { GithubAlerts } from '../../shared/markdown-extra-syntax.ts'

type Fold = { fold: string; expanded: boolean }
const setFold = StateEffect.define<Fold & { from: number }>()
const folds = StateField.define<ReadonlyMap<number, Fold>>({
  create: () => new Map(),
  update(value, transaction) {
    if (
      !transaction.docChanged &&
      !transaction.effects.some((effect) => effect.is(setFold))
    )
      return value
    let next: Map<number, Fold> | undefined
    if (transaction.docChanged && value.size) {
      const mapped = new Map<number, Fold>()
      let moved = false
      for (const [from, fold] of value) {
        const at = transaction.changes.mapPos(from, 1, MapMode.TrackDel)
        if (at !== null) mapped.set(at, fold)
        if (at !== from) moved = true
      }
      if (moved) next = mapped
    }
    for (const effect of transaction.effects)
      if (effect.is(setFold)) {
        next ??= new Map(value)
        next.set(effect.value.from, effect.value)
      }
    return next ?? value
  },
  provide: (field) => formattedRenderInputs.from(field),
})

function expandedAt(state: EditorState, from: number, fold: string) {
  const saved = state.field(folds, false)?.get(from)
  return saved?.fold === fold ? saved.expanded : fold !== '-'
}

class FoldToggleWidget extends WidgetType {
  readonly from: number
  readonly title: string
  readonly fold: string
  readonly expanded: boolean
  constructor(from: number, title: string, fold: string, expanded: boolean) {
    super()
    this.from = from
    this.title = title
    this.fold = fold
    this.expanded = expanded
  }
  override eq(other: FoldToggleWidget) {
    return (
      this.from === other.from &&
      this.title === other.title &&
      this.fold === other.fold &&
      this.expanded === other.expanded
    )
  }
  private toggle(view: EditorView) {
    view.dispatch({
      effects: setFold.of({
        from: this.from,
        fold: this.fold,
        expanded: !this.expanded,
      }),
    })
  }
  toDOM(view: EditorView) {
    return calloutToggle(this.title, this.expanded, () => this.toggle(view))
  }
  override updateDOM(dom: HTMLElement, view: EditorView) {
    updateCalloutToggle(
      dom as HTMLButtonElement,
      this.title,
      this.expanded,
      () => this.toggle(view),
    )
    return true
  }
}

/** The alert's type, or its own title, as the rich editor shows it. */
export class AlertTitleWidget extends WidgetType {
  readonly text: string
  constructor(text: string) {
    super()
    this.text = text
  }
  override eq(other: AlertTitleWidget) {
    return other.text === this.text
  }
  toDOM() {
    const title = document.createElement('span')
    title.className = 'hibi-lp-alert-title-text'
    title.textContent = this.text
    return title
  }
}

/** The alert type of a title line's source. */
export function titleOf(source: string) {
  const marker = alertMarker(source)
  if (!marker) return null
  const type = alertType(marker[1]) ?? 'note'
  return { type, text: formattedAlertText(source), fold: marker[2] ?? '' }
}

/** The quote's first block. */
function firstBlock(quote: SyntaxNode) {
  // A lookup after the first quote marker, not a walk over the quote's children.
  const mark = quote.firstChild
  return mark ? quote.childAfter(mark.to) : null
}

export const contribution: FormattedContribution = {
  id: 'markdown.alerts',
  feature: 'markdown.alerts',
  flavor: 'markdown.github',
  syntax: GithubAlerts,
  extension: folds,
  views: [
    {
      // The alerts.css box: a 3px bar in the alert color over a 6% tint, 12px 16px inside.
      nodes: ['Blockquote'],
      layout(node, out, { state }) {
        const title = firstBlock(node.node)
        if (title?.name !== 'AlertTitle') return
        const fold = titleOf(state.sliceDoc(title.from, title.to))?.fold
        if (!fold || expandedAt(state, node.from, fold)) return
        const from = state.doc.lineAt(title.to).to
        if (from < node.to)
          out.replace(from, node.to, undefined, { block: true })
        return false
      },
      container(node, { state }) {
        const title = firstBlock(node.node)
        if (title?.name !== 'AlertTitle') return undefined
        const type = titleOf(state.sliceDoc(title.from, title.to))?.type
        return {
          width: '19px',
          class: `hibi-lp-alert hibi-lp-alert-${type ?? 'note'}`,
          paint: (left, top) =>
            [
              `linear-gradient(var(--alert-color), var(--alert-color)) ${left} ${top} / 3px calc(100% - ${top}) no-repeat`,
              `linear-gradient(var(--alert-tint), var(--alert-tint)) ${left} ${top} / calc(100% - ${left}) calc(100% - ${top}) no-repeat`,
            ].join(', '),
          padding: { top: 12, bottom: 12, right: 16 },
        }
      },
    },
    {
      nodes: ['AlertTitle'],
      // The title's margin below it, var(--space-2).
      space: { top: 0, bottom: 8 },
      decorate(node, out, { state, revealed }) {
        const title = titleOf(state.sliceDoc(node.from, node.to))
        if (!title) return false
        out.line(state.doc.lineAt(node.from).from, {
          class: 'hibi-lp-alert-title',
        })
        const mark = node.node.getChild('AlertMark')
        if (revealed) {
          if (mark) out.mark(mark.from, mark.to, { class: 'hibi-lp-marker' })
        } else out.replace(node.from, node.to, new AlertTitleWidget(title.text))
        const quote = node.node.parent
        if (title.fold && quote?.name === 'Blockquote')
          out.widget(
            node.from,
            new FoldToggleWidget(
              quote.from,
              title.text,
              title.fold,
              expandedAt(state, quote.from, title.fold),
            ),
            -1,
          )
        return false
      },
    },
  ],
}
