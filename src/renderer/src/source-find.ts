import { SearchCursor } from '@codemirror/search'
import type { Range, Text } from '@codemirror/state'
import { Decoration, EditorView } from '@codemirror/view'
import { foldSearchText } from '../../shared/search-fold.ts'

/** Resume the worker's non-overlap phase within one bounded scan interval. */
export function sourceFindHighlights(
  query: string,
  document: Text,
  starts: readonly number[],
) {
  const margin = foldSearchText(query.normalize('NFKD')).length * 2
  return EditorView.decorations.of((view) => {
    if (!query || view.state.doc !== document) return Decoration.none
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
      let lo = 0,
        hi = starts.length
      while (lo < hi) {
        const middle = (lo + hi) >>> 1
        if (starts[middle]! <= from) lo = middle + 1
        else hi = middle
      }
      const cursor = new SearchCursor(
        view.state.doc,
        query,
        starts[Math.max(0, lo - 1)]!,
        to,
        foldSearchText,
      )
      while (!cursor.next().done) {
        if (cursor.value.to <= from) continue
        const { from: matchFrom, to: matchTo } = cursor.value
        const selected = view.state.selection.ranges.some(
          (range) => range.from === matchFrom && range.to === matchTo,
        )
        marks.push(
          Decoration.mark({
            class: selected
              ? 'cm-searchMatch cm-searchMatch-selected'
              : 'cm-searchMatch',
          }).range(matchFrom, matchTo),
        )
      }
    }
    return Decoration.set(marks, true)
  })
}
