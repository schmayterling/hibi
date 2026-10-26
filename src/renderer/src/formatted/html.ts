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

/** Raw HTML stays editable source, styled like the rich editor's HTML chips and boxes. */
export const contributions: readonly FormattedContribution[] = [
  {
    id: 'core.html-blocks',
    feature: 'core.html-blocks',
    views: [
      {
        nodes: ['HTMLBlock', 'CommentBlock', 'ProcessingInstructionBlock'],
        // A box like a code block, with the rich editor's 1em margins.
        space: { top: 16, bottom: 16 },
        decorate(node, out, { state, visible }) {
          if (!visible) return false
          const doc = state.doc
          const first = doc.lineAt(node.from).number,
            last = doc.lineAt(node.to).number
          const to = Math.min(last, doc.lineAt(visible.to).number)
          for (
            let number = Math.max(first, doc.lineAt(visible.from).number);
            number <= to;
            number++
          ) {
            const line = doc.line(number)
            out.line(line.from, {
              class: [
                'hibi-lp-codeblock',
                ...(number === first ? ['hibi-lp-codeblock-first'] : []),
                ...(number === last ? ['hibi-lp-codeblock-last'] : []),
              ].join(' '),
            })
            const start = Math.max(line.from, node.from)
            if (line.to > start)
              out.mark(start, line.to, { class: 'hibi-lp-codetext' })
          }
          return false
        },
      },
    ],
  },
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
