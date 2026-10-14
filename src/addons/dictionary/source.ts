import { isolateHistory } from '@codemirror/commands'
import { Transaction } from '@codemirror/state'
import { type EditorView, ViewPlugin } from '@codemirror/view'
import type { ViewId } from '../../shared/foundation-contracts'
import { type LookupTarget, wordAt } from './lookup'
import { readPreferences } from './settings'

export const trackSourceViews = (
  views: Map<EditorView, ViewId>,
  viewId: ViewId,
) =>
  ViewPlugin.define((view) => {
    views.set(view, viewId)
    return { destroy: () => views.delete(view) }
  })

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
  const range = { from: line.from + found.from, to: line.from + found.to }
  return {
    word: found.word,
    editable: () => view.dom.isConnected && !view.state.readOnly,
    replace(text) {
      if (view.state.doc !== doc) return false
      view.dispatch({
        changes: { ...range, insert: text },
        selection: { anchor: range.from + text.length },
        annotations: [
          isolateHistory.of('full'),
          Transaction.userEvent.of('input.replace'),
        ],
      })
      const after = view.state.doc
      return (
        after !== doc &&
        after.sliceString(range.from, range.from + text.length) === text
      )
    },
    focus: () => {
      if (view.dom.isConnected) view.focus()
    },
  }
}
