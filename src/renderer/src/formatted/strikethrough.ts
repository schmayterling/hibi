import { Strikethrough } from '@lezer/markdown'
import type { FormattedContribution } from '../formatted-contributions.ts'

/** `~~text~~` strikes through its text and hides the tildes. */
export const contribution: FormattedContribution = {
  id: 'markdown.strikethrough',
  feature: 'markdown.strike',
  syntax: Strikethrough,
  views: [
    {
      nodes: ['Strikethrough'],
      decorate(node, out) {
        out.mark(node.from, node.to, { class: 'hibi-lp-strike' })
        for (const mark of node.node.getChildren('StrikethroughMark'))
          out.syntax(mark.from, mark.to)
        return undefined
      },
    },
  ],
}
