import { WidgetType } from '@codemirror/view'
import type { FormattedContribution } from '../formatted-contributions.ts'

class RuleWidget extends WidgetType {
  override eq() {
    return true
  }
  toDOM() {
    const rule = document.createElement('span')
    rule.className = 'hibi-lp-rule'
    rule.setAttribute('aria-hidden', 'true')
    return rule
  }
}
const widget = new RuleWidget()

/**
 * Thematic breaks render as a rule across the text column, inline on a line
 * as tall as the rule, so the line keeps the indent, quote bars and spacing
 * of the blocks around it.
 */
export const contribution: FormattedContribution = {
  id: 'core.rule',
  feature: 'core.dividers',
  views: [
    {
      nodes: ['HorizontalRule'],
      decorate(node, out, { state }) {
        out.line(state.doc.lineAt(node.from).from, {
          class: 'hibi-lp-rule-line',
        })
        out.replace(node.from, node.to, widget)
        return false
      },
    },
  ],
}
