import { isolateHistory } from '@codemirror/commands'
import { type EditorState, Transaction } from '@codemirror/state'
import { type EditorView, ViewPlugin } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { uncovered } from '../../renderer/src/chunked-markdown.ts'
import { formattedSyntaxTree } from '../../renderer/src/formatted-contributions.ts'
import type { ViewId } from '../../shared/foundation-contracts'
import { type LookupTarget, wordAt } from './lookup.ts'
import { readPreferences } from './settings.ts'

export const trackSourceViews = (
  views: Map<EditorView, ViewId>,
  viewId: ViewId,
) =>
  ViewPlugin.define((view) => {
    views.set(view, viewId)
    return { destroy: () => views.delete(view) }
  })

/**
 * Syntax whose text the formatted view does not show as text: destinations,
 * titles, reference and footnote labels and embeds, and the brackets that a
 * replaced selection must keep.
 */
const unshown = new Set([
  'URL',
  'LinkTitle',
  'LinkLabel',
  'FootnoteLabel',
  'Autolink',
  'WikiEmbed',
  'LinkMark',
  'FootnoteMark',
  'WikiMark',
])

/** A link or image without `(…)` or `[label]` after its text, whose text is then its reference's label. */
function namesReference(node: SyntaxNode, state: EditorState) {
  // Its last child is the `)` after a destination, a `[label]`, or the `]`
  // after its text, so its other children are never read.
  const last = node.lastChild
  return last?.name === 'LinkLabel'
    ? last.to - last.from <= 2
    : state.sliceDoc(node.to - 1, node.to) !== ')'
}

/**
 * The edit that replaces the word at `[from, to)` with a text. In the
 * formatted view, a word in a wikilink without an alias becomes the label of
 * an alias, so that the link keeps its target as it does in the rich view.
 * Null where the formatted view shows no text the word could change, such as
 * a link's destination, and in text it has not parsed yet.
 */
function wordEdit(state: EditorState, from: number, to: number) {
  const inPlace = (text: string) => ({
    from,
    to,
    insert: text,
    caret: text.length,
  })
  const tree = formattedSyntaxTree(state)
  if (!tree) return inPlace
  if (uncovered(tree, from, to)) return null
  let target = null as SyntaxNode | null
  const shown = (node: SyntaxNode) => {
    if (
      unshown.has(node.name) ||
      ((node.name === 'Link' || node.name === 'Image') &&
        namesReference(node, state))
    )
      return false
    if (node.name !== 'WikiTarget') return true
    // Behind an alias, a target is syntax.
    if (node.parent?.getChildren('WikiMark').length !== 2) return false
    target = node
    return true
  }
  // The nodes the word overlaps are those around its start and those that
  // start in it; a link's other children are not read.
  const cursor = tree.cursorAt(from, 1)
  for (let node: SyntaxNode | null = cursor.node; node; node = node.parent)
    if (!shown(node)) return null
  for (
    let more = cursor.childAfter(from) || cursor.next(false);
    more && cursor.from < to;
    more = cursor.next()
  )
    if (!shown(cursor.node)) return null
  if (!target) return inPlace
  const { from: start, to: end } = target
  let table: SyntaxNode | null = target
  while (table && table.name !== 'Table') table = table.parent
  // A table's cell ends at a bare pipe.
  const bar = table ? '\\|' : '|'
  return (text: string) => {
    const before = bar + state.sliceDoc(start, from) + text
    return {
      from: end,
      to: end,
      insert: before + state.sliceDoc(to, end),
      caret: before.length,
    }
  }
}

export function sourceTarget(
  view: EditorView,
  from: number,
  to: number,
): LookupTarget | null {
  const { doc } = view.state
  const line = doc.lineAt(from)
  if (to > line.to) return null
  const found = wordAt(
    line.text,
    from - line.from,
    to - line.from,
    readPreferences(),
  )
  if (!found) return null
  const edit = wordEdit(
    view.state,
    line.from + found.from,
    line.from + found.to,
  )
  if (!edit) return null
  return {
    word: found.word,
    editable: () => view.dom.isConnected && !view.state.readOnly,
    replace(text) {
      if (view.state.doc !== doc) return false
      const { caret, ...change } = edit(text)
      view.dispatch({
        changes: change,
        selection: { anchor: change.from + caret },
        annotations: [
          isolateHistory.of('full'),
          Transaction.userEvent.of('input.replace'),
        ],
      })
      const after = view.state.doc
      return (
        after !== doc &&
        after.sliceString(change.from, change.from + change.insert.length) ===
          change.insert
      )
    },
    focus: () => {
      if (view.dom.isConnected) view.focus()
    },
  }
}
