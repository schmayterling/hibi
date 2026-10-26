import { SearchCursor } from '@codemirror/search'
import type { Range } from '@codemirror/state'
import { Decoration, EditorView } from '@codemirror/view'
import { foldSearchText } from '../../shared/search-fold.ts'

/** Viewport highlights use the same fold as the worker's document-wide scan. */
export function sourceFindHighlights(query: string) {
  const margin = foldSearchText(query.normalize('NFKD')).length * 2
  return EditorView.decorations.of((view) => {
    if (!query) return Decoration.none
    const marks: Range<Decoration>[] = []
    const visible = view.visibleRanges
    for (let index = 0; index < visible.length; index++) {
      const from = Math.max(0, visible[index]!.from - margin)
      let to = Math.min(view.state.doc.length, visible[index]!.to + margin)
      while (
        index + 1 < visible.length &&
        visible[index + 1]!.from - margin <= to
      )
        to = Math.min(view.state.doc.length, visible[++index]!.to + margin)
      const cursor = new SearchCursor(
        view.state.doc,
        query,
        from,
        to,
        foldSearchText,
      )
      while (!cursor.next().done) {
        const { from, to } = cursor.value
        const selected = view.state.selection.ranges.some(
          (range) => range.from === from && range.to === to,
        )
        marks.push(
          Decoration.mark({
            class: selected
              ? 'cm-searchMatch cm-searchMatch-selected'
              : 'cm-searchMatch',
          }).range(from, to),
        )
      }
    }
    return Decoration.set(marks, true)
  })
}
