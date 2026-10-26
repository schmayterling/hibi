import type { MarkdownConfig } from '@lezer/markdown'
import {
  type FormattedContribution,
  formattedRenderInputs,
} from '../formatted-contributions.ts'
import {
  defined,
  definitionReader,
  footnoteDefinitions,
} from './footnote-definitions.ts'
import './footnotes.css'

/** Where a `[^label]` that starts at `pos` ends, or -1. Labels have no spaces or `]`. */
function labelEnd(char: (pos: number) => number, pos: number, end: number) {
  let at = pos + 2
  while (at < end) {
    const next = char(at)
    if (next === 93 /* ] */) return at > pos + 2 ? at + 1 : -1
    if (next === 32 || next === 9 || next === 10 || next === 13) return -1
    at++
  }
  return -1
}

/**
 * GitHub footnotes: `[^label]` references and `[^label]:` definitions, whose
 * later lines continue when indented by four columns, as with
 * marked-github-footnote.
 */
export const Footnotes: MarkdownConfig = {
  defineNodes: [
    {
      name: 'FootnoteDefinition',
      block: true,
      composite(_cx, line, value) {
        if (line.next > -1 && line.indent < line.baseIndent + value)
          return false
        line.moveBaseColumn(line.baseIndent + value)
        return true
      },
    },
    { name: 'FootnoteReference' },
    { name: 'FootnoteMark' },
    { name: 'FootnoteLabel' },
  ],
  parseBlock: [
    {
      name: 'FootnoteDefinition',
      parse(cx, line) {
        if (line.next !== 91 /* [ */ || line.indent >= line.baseIndent + 4)
          return false
        const text = line.text
        const end = labelEnd(
          (pos) => text.charCodeAt(pos),
          line.pos,
          text.length,
        )
        if (end < 0 || text.charCodeAt(line.pos + 1) !== 94 /* ^ */)
          return false
        if (text.charCodeAt(end) !== 58 /* : */) return false
        const start = cx.lineStart + line.pos
        cx.startComposite('FootnoteDefinition', line.pos, 4)
        const close = cx.lineStart + end
        cx.addElement(cx.elt('FootnoteMark', start, start + 2))
        cx.addElement(cx.elt('FootnoteLabel', start + 2, close - 1))
        cx.addElement(cx.elt('FootnoteMark', close - 1, close + 1))
        line.moveBase(end + 1)
        return null
      },
      before: 'LinkReference',
    },
  ],
  parseInline: [
    {
      name: 'FootnoteReference',
      parse(cx, next, pos) {
        if (next !== 91 /* [ */ || cx.char(pos + 1) !== 94 /* ^ */) return -1
        const end = labelEnd((at) => cx.char(at), pos, cx.end)
        if (end < 0) return -1
        return cx.addElement(
          cx.elt('FootnoteReference', pos, end, [
            cx.elt('FootnoteMark', pos, pos + 2),
            cx.elt('FootnoteLabel', pos + 2, end - 1),
            cx.elt('FootnoteMark', end - 1, end),
          ]),
        )
      },
      before: 'Link',
    },
  ],
}

/** A CSS string for a list marker. */
const cssString = (text: string) => `"${text.replace(/["\\]/g, '\\$&')}"`

/** References render as superscript labels and definitions as notes labelled in their margin, both editable in place. */
export const contribution: FormattedContribution = {
  id: 'markdown.footnotes',
  extension: [
    footnoteDefinitions,
    definitionReader,
    // Table cells draw references again when labels change.
    formattedRenderInputs.compute(
      [footnoteDefinitions],
      (state) => state.field(footnoteDefinitions).labels,
    ),
  ],
  flavor: 'markdown.github',
  syntax: Footnotes,
  // References start at `[`, so text without one is still skipped.
  inlineStops: true,
  views: [
    {
      nodes: ['FootnoteReference'],
      decorate(node, out, { state }) {
        const [open, close] = node.node.getChildren('FootnoteMark')
        const label = node.node.getChild('FootnoteLabel')
        // Without a definition, the reference is text, as in exports.
        if (
          !open ||
          !close ||
          !label ||
          !defined(state, state.sliceDoc(label.from, label.to))
        )
          return false
        out.syntax(open.from, open.to)
        out.mark(label.from, label.to, { class: 'hibi-lp-footnote-ref' })
        out.syntax(close.from, close.to)
        return false
      },
    },
    {
      nodes: ['FootnoteDefinition'],
      // A note's lines hang like a list item's, its label in the margin.
      container: () => ({
        width: 'calc(1.5 * var(--text-editor))',
        class: 'hibi-lp-footnote',
      }),
      decorate(node, out, { state }) {
        const label = node.node.getChild('FootnoteLabel')
        if (!label) return undefined
        // The marker before the note's text is hidden with the line's prefix.
        out.line(state.doc.lineAt(node.from).from, {
          class: 'hibi-lp-footnote-label',
          style: `list-style-type: ${cssString(`${state.sliceDoc(label.from, label.to)} `)}`,
        })
        return undefined
      },
      layout(node, out, { state }) {
        // Continuation lines flow after a space, so their indentation is hidden.
        for (const block of node.node.getChildren('Paragraph')) {
          const first = state.doc.lineAt(block.from).number
          const last = state.doc.lineAt(block.to).number
          for (let number = first + 1; number <= last; number++) {
            const line = state.doc.line(number)
            const indent =
              line.text.length - line.text.replace(/^[ \t]+/, '').length
            if (indent) out.replace(line.from, line.from + indent)
          }
        }
        return undefined
      },
    },
  ],
}
