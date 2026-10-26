import { WidgetType } from '@codemirror/view'
import type { FormattedContribution } from '../formatted-contributions.ts'
import { markdownSyntax } from '../markdown-syntax.ts'

/** `<br>` breaks the line, like a hard line break. */
class BreakWidget extends WidgetType {
  override eq() {
    return true
  }
  toDOM() {
    const wrap = document.createElement('span')
    wrap.className = 'hibi-lp-html-break'
    wrap.append(document.createElement('br'))
    return wrap
  }
}
const lineBreak = new BreakWidget()

/** Raw HTML stays editable source, styled like the rich editor's HTML chips. */
export const contributions: readonly FormattedContribution[] = [
  {
    id: 'core.inline-html',
    feature: 'core.inline-html',
    views: [
      {
        nodes: ['HTMLTag', 'Comment', 'ProcessingInstruction'],
        decorate(node, out, { state, revealed }) {
          const breaks =
            node.name === 'HTMLTag' &&
            /^<br\s*\/?>$/i.test(state.sliceDoc(node.from, node.to)) &&
            markdownSyntax.enabled('core.line-breaks')
          // A revealed break shows its tag and keeps breaking the line.
          if (breaks && !revealed) out.replace(node.from, node.to, lineBreak)
          else {
            out.mark(node.from, node.to, { class: 'hibi-lp-code hibi-lp-html' })
            if (breaks) out.widget(node.to, lineBreak, 1)
          }
          return false
        },
      },
    ],
  },
]
