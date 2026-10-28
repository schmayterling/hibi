import { DocInput } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import type { Tree } from '@lezer/common'
import type { MarkdownParser } from '@lezer/markdown'
import {
  formattedTextEffects,
  formattedTextWindow,
} from '../../shared/formatted-text-effects.ts'
import { formattedTextRuns } from '../../shared/formatted-text-runs.ts'
import { renderedRange } from '../../shared/rendered-range.ts'
import { defined } from './formatted/footnote-definitions.ts'
import {
  formattedLiteral,
  formattedTextFeatures,
} from './formatted-contributions.ts'
import { knownReference } from './formatted-references.ts'

/** Render selected source with the view's retained grammar and note-wide lookup state. */
export function formattedSelectionText(
  state: EditorState,
  tree: Tree,
  inline: MarkdownParser,
  from: number,
  to: number,
  blockSeparator = '',
) {
  if (from === to) return ''
  const doc = new DocInput(state.doc)
  const input = {
    length: doc.length,
    read: (a: number, b: number) => doc.read(a, b),
    lineAt: (at: number) => state.doc.lineAt(at),
  }
  const selection = { from, to },
    literal = state.facet(formattedLiteral),
    window = formattedTextWindow(tree, selection, new Set(literal))
  if (!window) return null
  const effects = formattedTextEffects(
    tree,
    0,
    input,
    { ...window, selection },
    {
      literal,
      textFeatures: state.facet(formattedTextFeatures),
    },
    inline,
    { has: (label: string) => defined(state, label) },
    true,
    false,
    (label) => !!knownReference(state, label),
  )
  const runs = formattedTextRuns(effects, input, { window, selection })
  const text: string[] = []
  for (const chunk of renderedRange(runs, from, to, input, { blockSeparator }))
    text.push(chunk.text)
  return text.join('')
}
