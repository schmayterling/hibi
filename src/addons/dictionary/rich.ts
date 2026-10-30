import type { Editor } from '@tiptap/core'
import { closeHistory } from '@tiptap/pm/history'
import { TextSelection } from '@tiptap/pm/state'
import { type LookupTarget, wordAt } from './lookup'
import { readPreferences } from './settings'

export function richTarget(
  editor: Editor,
  from: number,
  to: number,
): LookupTarget | null {
  const { doc } = editor.state
  const $from = doc.resolve(from)
  if (!$from.parent.isTextblock || $from.parent.type.spec.code) return null
  if (to > $from.end()) return null
  const base = $from.start()
  const found = wordAt(
    $from.parent.textBetween(0, $from.parent.content.size, undefined, '￼'),
    from - base,
    to - base,
    readPreferences(),
  )
  if (!found) return null
  const range = { from: base + found.from, to: base + found.to }
  if (doc.textBetween(range.from, range.to) !== found.word) return null
  return {
    word: found.word,
    editable: () => !editor.isDestroyed && editor.isEditable,
    replace(text) {
      if (editor.isDestroyed || editor.state.doc !== doc) return false
      const tr = closeHistory(editor.state.tr).insertText(
        text,
        range.from,
        range.to,
      )
      tr.setSelection(TextSelection.create(tr.doc, range.from + text.length))
      editor.view.dispatch(tr)
      // Read-only editors drop document changes without throwing.
      const after = editor.state.doc
      const end = range.from + text.length
      if (
        after === doc ||
        end > after.content.size ||
        after.textBetween(range.from, end) !== text
      )
        return false
      editor.view.dispatch(closeHistory(editor.state.tr))
      return true
    },
    focus: () => {
      if (!editor.isDestroyed) editor.view.focus()
    },
  }
}
