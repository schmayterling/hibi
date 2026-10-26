import { WidgetType } from '@codemirror/view'
import type { FormattedContribution } from '../formatted-contributions.ts'

class RuleWidget extends WidgetType {
  override eq() {
    return true
  }
  toDOM() {
    const rule = document.createElement('div')
    rule.className = 'hibi-lp-rule'
    rule.setAttribute('aria-hidden', 'true')
    return rule
  }
}
const widget = new RuleWidget()

/** Thematic breaks render as a rule across the text column. */
export const contribution: FormattedContribution = {
  id: 'core.rule',
  feature: 'core.dividers',
  views: [
    {
      nodes: ['HorizontalRule'],
      layout(node, out, { state }) {
        const line = state.doc.lineAt(node.from)
        out.replace(line.from, line.to, widget, { block: true })
        return false
      },
    },
  ],
}
