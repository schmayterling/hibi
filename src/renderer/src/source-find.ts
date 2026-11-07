import { SearchCursor } from '@codemirror/search'
import {
  type Range,
  StateEffect,
  StateField,
  type Text,
} from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view'
import { foldSearchText } from '../../shared/search-fold.ts'
import type { SourceMatch } from '../../shared/source-search.ts'
import { type FindRange, findWindow, visibleRange } from './find-window.ts'

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
    const scan = (
      from: number,
      to: number,
      keep: (match: FindRange) => boolean,
    ) => {
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
        if (!keep(cursor.value)) continue
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
    const length = view.state.doc.length
    const shown = view.state.field(formattedWindow, false)
    if (shown === undefined) {
      const visible = view.visibleRanges
      for (let index = 0; index < visible.length; index++) {
        const from = Math.max(0, visible[index]!.from - margin)
        let to = Math.min(length, visible[index]!.to + margin)
        while (
          index + 1 < visible.length &&
          visible[index + 1]!.from - margin <= to
        )
          to = Math.min(length, visible[++index]!.to + margin)
        scan(from, to, (match) => match.to > from)
      }
    } else {
      // The formatted view highlights matches as the rich editor does.
      const overlaps = (range: FindRange) =>
        !!shown && range.from < shown.to && range.to > shown.from
      if (shown)
        scan(shown.from - margin, Math.min(length, shown.to + margin), overlaps)
      // Outside the window, a match is highlighted only while it is selected.
      // Matches fit within the margin, so a longer selection is not one.
      for (const range of view.state.selection.ranges)
        if (!range.empty && range.to - range.from <= margin && !overlaps(range))
          scan(
            range.from - margin,
            range.to,
            (match) => match.from === range.from && match.to === range.to,
          )
    }
    return Decoration.set(marks, true)
  })
}

/** Highlight contributing source segments without painting hidden Markdown. */
export function renderedFindHighlights(
  matches: readonly SourceMatch[],
  current: boolean,
  document: Text,
) {
  return EditorView.decorations.of((view) => {
    if (view.state.doc !== document) return Decoration.none
    const { selection } = view.state
    const marks: Range<Decoration>[] = []
    const mark = (from: number, to: number, selected: boolean) =>
      marks.push(
        Decoration.mark({
          class: selected
            ? 'cm-searchMatch cm-searchMatch-selected'
            : 'cm-searchMatch',
        }).range(from, to),
      )
    let found = false
    for (const match of matches) {
      const selected = selection.ranges.some(
        (range) => range.from === match.from && range.to === match.to,
      )
      found ||= selected
      for (const segment of match.segments ?? [match])
        mark(segment.from, segment.to, selected)
    }
    if (current && !found && !selection.main.empty)
      mark(selection.main.from, selection.main.to, true)
    return Decoration.set(marks, true)
  })
}

const setWindow = StateEffect.define<FindRange>()

/** Positions near the formatted view's screen whose matches are highlighted. */
const formattedWindow = StateField.define<FindRange | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects)
      if (effect.is(setWindow)) return effect.value
    if (!value || !tr.docChanged) return value
    const from = tr.changes.mapPos(value.from, 1)
    const to = tr.changes.mapPos(value.to, -1)
    return from < to ? { from, to } : null
  },
})

/** The formatted highlight window, measured before its first worker request. */
export function formattedFindViewport(view: EditorView): FindRange {
  let shown = view.state.field(formattedWindow, false)
  if (!shown) {
    const visible = visibleRange(view.contentDOM, (node, offset) =>
      view.posAtDOM(node, offset),
    )
    // Off screen, as while its pane slides in, the view draws the text near
    // its scroll; its viewport can be a whole long line.
    const drawn = view.visibleRanges
    shown = visible
      ? findWindow(visible, view.state.doc.length)
      : drawn.length
        ? { from: drawn[0]!.from, to: drawn.at(-1)!.to }
        : view.viewport
  }
  // Layout can still describe the previous document during an edit.
  const length = view.state.doc.length
  return {
    from: Math.min(length, shown.from),
    to: Math.min(length, shown.to),
  }
}

/** The highlight window changed by an update, if any. */
export function movedFindWindow(update: ViewUpdate) {
  let moved: FindRange | null = null
  for (const tr of update.transactions)
    for (const effect of tr.effects)
      if (effect.is(setWindow)) moved = effect.value
  return moved
}

/** Bounds formatted find highlights by the screen, however long its lines. */
export const formattedFindWindow = [
  formattedWindow,
  ViewPlugin.define((view) => {
    let frame = 0
    // Measured once per frame, after scrolling, layout, or find changes.
    const measure = () => {
      frame = 0
      const visible = visibleRange(view.contentDOM, (node, offset) =>
        view.posAtDOM(node, offset),
      )
      const shown = view.state.field(formattedWindow)
      if (
        !visible ||
        (shown && shown.from <= visible.from && visible.to <= shown.to)
      )
        return
      view.dispatch({
        effects: setWindow.of(findWindow(visible, view.state.doc.length)),
      })
    }
    const schedule = () => {
      frame ||= requestAnimationFrame(measure)
    }
    const resize = new ResizeObserver(schedule)
    resize.observe(view.contentDOM)
    document.addEventListener('scroll', schedule, {
      capture: true,
      passive: true,
    })
    window.addEventListener('resize', schedule)
    // A pane sliding in, as from the source view's side, changes no size or
    // scroll: what it shows is measured once it is in place.
    const slid = (event: Event) => {
      if ((event.target as Node).contains(view.dom)) schedule()
    }
    document.addEventListener('transitionend', slid, true)
    return {
      update(update) {
        if (update.docChanged || update.selectionSet || update.viewportChanged)
          schedule()
      },
      destroy() {
        cancelAnimationFrame(frame)
        resize.disconnect()
        document.removeEventListener('scroll', schedule, { capture: true })
        window.removeEventListener('resize', schedule)
        document.removeEventListener('transitionend', slid, true)
      },
    }
  }),
]
