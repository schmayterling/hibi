import { Strikethrough } from '@lezer/markdown'
import { formattedMarkerRanges } from '../../../shared/formatted-text-rules.ts'
import type { FormattedContribution } from '../formatted-contributions.ts'

/** `~~text~~` strikes through its text and hides the tildes. */
export const contribution: FormattedContribution = {
  id: 'markdown.strikethrough',
  feature: 'markdown.strike',
  flavor: 'markdown.github',
  syntax: Strikethrough,
  inlineStops: true,
  views: [
    {
      nodes: ['Strikethrough'],
      decorate(node, out, { state }) {
        out.mark(node.from, node.to, { class: 'hibi-lp-strike' })
        for (const range of formattedMarkerRanges(node.node, (a, b) =>
          state.sliceDoc(a, b),
        ))
          out.syntax(range.from, range.to)
        return undefined
      },
    },
  ],
}
