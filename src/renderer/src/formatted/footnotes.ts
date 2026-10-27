import { Footnotes } from '../../../shared/markdown-extra-syntax.ts'
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

export { Footnotes } from '../../../shared/markdown-extra-syntax.ts'

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
        // A link to the definition: a modified click moves there.
        out.link(label.from, label.to, { class: 'hibi-lp-footnote-ref' })
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
