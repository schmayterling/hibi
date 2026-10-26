import { WidgetType } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import type { FormattedContribution } from '../../renderer/src/formatted-contributions.ts'
import { GithubAlerts } from '../../shared/markdown-extra-syntax.ts'
import { alertMarker, alertType } from './alerts.ts'
import './formatted.css'

export { GithubAlerts } from '../../shared/markdown-extra-syntax.ts'

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
  return { type, text: marker[3]?.trim() || type }
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
  views: [
    {
      // The alerts.css box: a 3px bar in the alert color over a 6% tint, 12px 16px inside.
      nodes: ['Blockquote'],
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
        return false
      },
    },
  ],
}
