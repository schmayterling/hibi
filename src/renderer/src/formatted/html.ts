import type { EditorState } from '@codemirror/state'
import { WidgetType } from '@codemirror/view'
import type { SyntaxNodeRef } from '@lezer/common'
import { decodeHTMLAttribute } from 'entities'
import type { FormattedContribution } from '../formatted-contributions.ts'
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

const attribute =
  /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
/** A width or height in pixels, digits only as in an embed's `|200x100`; 0 for none. */
const pixels = (value = '') => (/^\d{1,4}$/.test(value) ? Number(value) : 0)

/** The image of an `HTMLImage` node, an `<img>` tag, when it has a source. */
export function htmlImageOf(state: EditorState, node: SyntaxNodeRef) {
  const values = new Map<string, string>()
  // The first of repeated attributes wins, as in HTML.
  for (const [, name = '', ...value] of state
    .sliceDoc(node.from + 4, node.to)
    .matchAll(attribute))
    if (!values.has(name.toLowerCase()))
      values.set(name.toLowerCase(), decodeHTMLAttribute(value.join('')))
  const source = values.get('src')?.trim()
  return source
    ? new MediaWidget(
        source,
        values.get('alt') ?? '',
        values.get('title') ?? '',
        pixels(values.get('width')),
        pixels(values.get('height')),
      )
    : null
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
      {
        // Only image tags are laid out, so other HTML adds no layout work.
        nodes: ['HTMLImage'],
        // Like a Markdown image, the tag shows its image, with its source
        // beside it while revealed.
        layout(node, out, { state, revealed }) {
          const image = htmlImageOf(state, node)
          if (image && revealed) out.widget(node.to, image, { side: 1 })
          else if (image) out.replace(node.from, node.to, image)
          return false
        },
        // Unrevealed, the image stands in for the tag's chip.
        decorate(node, _out, { state, revealed }) {
          return !revealed && htmlImageOf(state, node) ? false : undefined
        },
      },
    ],
  },
]
