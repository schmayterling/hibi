import type { EditorState } from '@codemirror/state'
import { WidgetType } from '@codemirror/view'
import type { SyntaxNodeRef } from '@lezer/common'
import { decodeHTMLAttribute } from 'entities'
import type {
  FormattedContribution,
  FormattedNodeView,
} from '../formatted-contributions.ts'
import { markdownSyntax } from '../markdown-syntax.ts'
import { MediaWidget } from './media.ts'

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

const imageTag =
  /^(\s*)(<img(?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>)\s*$/i
const attribute =
  /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g

/** A lone `<img>` tag with a source: its range and widget. */
export function htmlImageOf(state: EditorState, node: SyntaxNodeRef) {
  const [, space = '', tag = ''] =
    imageTag.exec(state.sliceDoc(node.from, node.to)) ?? []
  const values = new Map<string, string>()
  // The first of repeated attributes wins, as in HTML.
  for (const [, name = '', ...value] of tag.slice(4).matchAll(attribute))
    if (!values.has(name.toLowerCase()))
      values.set(name.toLowerCase(), decodeHTMLAttribute(value.join('')))
  const source = values.get('src')?.trim()
  if (!source) return null
  const from = node.from + space.length
  return {
    from,
    to: from + tag.length,
    widget: new MediaWidget(
      source,
      values.get('alt') ?? '',
      values.get('title') ?? '',
    ),
  }
}

/** Like a Markdown image, `<img>` shows its image, with its source beside it while revealed. */
const imageLayout: FormattedNodeView['layout'] = (node, out, context) => {
  const image = htmlImageOf(context.state, node)
  if (!image) return
  if (context.revealed) out.widget(image.to, image.widget, { side: 1 })
  else out.replace(image.from, image.to, image.widget)
  return false
}

/** Raw HTML stays editable source, styled like the rich editor's HTML chips and boxes; `<img>` shows its image. */
export const contributions: readonly FormattedContribution[] = [
  {
    id: 'core.html-blocks',
    feature: 'core.html-blocks',
    views: [
      {
        nodes: ['HTMLBlock', 'CommentBlock', 'ProcessingInstructionBlock'],
        // A box like a code block, with the rich editor's 1em margins.
        space: { top: 16, bottom: 16 },
        layout: imageLayout,
        decorate(node, out, { state, visible, revealed }) {
          if (!visible || (!revealed && htmlImageOf(state, node))) return false
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
        layout: imageLayout,
        decorate(node, out, { state, revealed }) {
          if (!revealed && htmlImageOf(state, node)) return false
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
