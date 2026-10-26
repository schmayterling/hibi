import { EditorView } from '@codemirror/view'
import type { FormattedContribution } from '../../renderer/src/formatted-contributions.ts'
import { subscriptSyntax, subtextSyntax } from './formatted-syntax.ts'

const flavor = 'text-extras.text-extras'

/** `~text~` reads as the rich view's `<sub>`; its tildes are syntax. */
const subscript: FormattedContribution = {
  id: 'text-extras.subscript',
  feature: 'text-extras.subscript',
  flavor,
  syntax: subscriptSyntax,
  inlineStops: true,
  views: [
    {
      nodes: ['Subscript'],
      decorate(node, out) {
        out.syntax(node.from, node.from + 1)
        out.mark(node.from + 1, node.to - 1, { class: 'hibi-lp-subscript' })
        out.syntax(node.to - 1, node.to)
        return undefined
      },
    },
  ],
  // The browser's styles for `<sub>`, which only it gives the rich view's subscripts.
  extension: EditorView.baseTheme({
    '.hibi-lp-subscript': { verticalAlign: 'sub', fontSize: 'smaller' },
  }),
}

/** A `-# ` line is the rich view's small-text paragraph; its marker is syntax. */
const subtext: FormattedContribution = {
  id: 'text-extras.subtext',
  feature: 'text-extras.subtext',
  flavor,
  syntax: subtextSyntax,
  views: [
    {
      nodes: ['Subtext'],
      // A paragraph's `0 0 1em` margins at the addon's 0.85em size.
      space: { top: 0, bottom: 13.6 },
      decorate(node, out, { state }) {
        out.line(state.doc.lineAt(node.from).from, {
          class: 'markdown-subtext',
        })
        out.syntax(node.from, node.from + 3)
        return undefined
      },
    },
  ],
}

export const contributions = { subscript, subtext }
