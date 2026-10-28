import {
  type EditorState,
  type Extension,
  Prec,
  type Range,
  RangeSet,
  RangeValue,
  StateEffect,
  StateField,
} from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view'
import { uncovered } from './chunked-markdown'
import { formattedTree } from './formatted-contributions'

/*
 * The formatted view draws code lines whole, one row each, while prose
 * wraps. CodeMirror estimates every line it has not drawn as wrapped text, so
 * a long code line it has not drawn yet counts as many rows. Code blocks the
 * document's index knows, away from the screen, are drawn as placeholders of
 * their exact height instead, so jumps through the note land where they
 * should; they turn back into lines before they reach the screen.
 */

/**
 * A code block of the note: its range, how many code lines it draws, and
 * its longest line in characters, which decides whether it scrolls sideways.
 */
export type CodeExtent = {
  from: number
  to: number
  lines: number
  columns: number
}

/**
 * The code blocks between `from` and `to`, replacing those known there:
 * the document's index sends them as it learns them and after edits.
 */
export const setCodeExtents = StateEffect.define<{
  from: number
  to: number
  extents: readonly CodeExtent[]
}>()

/** Heights in px of a drawn code block: its rows, its padding, its sideways scrollbar. */
type Metrics = {
  row: number
  top: number
  bottom: number
  scrollbar: number
  /** How many code characters fit before a block scrolls sideways. */
  room: number
}

const setMetrics = StateEffect.define<Metrics>()
/** The range the view draws code lines in, around its viewport. */
const setLive = StateEffect.define<{ from: number; to: number }>()

class Lines extends RangeValue {
  constructor(
    readonly lines: number,
    readonly columns: number,
  ) {
    super()
  }
  override eq(other: Lines) {
    return other.lines === this.lines && other.columns === this.columns
  }
}

class Placeholder extends WidgetType {
  constructor(readonly height: number) {
    super()
  }
  override eq(other: Placeholder) {
    return other.height === this.height
  }
  override get estimatedHeight() {
    return this.height
  }
  toDOM() {
    const element = document.createElement('div')
    element.className = 'hibi-lp-codeplaceholder'
    element.setAttribute('aria-hidden', 'true')
    element.style.height = `${this.height}px`
    return element
  }
}

type Placeholders = {
  extents: RangeSet<Lines>
  metrics: Metrics | null
  live: { from: number; to: number } | null
  set: DecorationSet
}

const height = (metrics: Metrics, lines: Lines) =>
  lines.lines * metrics.row +
  metrics.top +
  metrics.bottom +
  (lines.columns > metrics.room ? metrics.scrollbar : 0)

/**
 * Placeholders for the known code blocks touching `from`–`to`: those outside
 * the window, or in it before the view has parsed them, which would draw
 * their long lines as wrapped text first; never one with a selection end.
 */
function refresh(
  value: Placeholders,
  state: EditorState,
  from: number,
  to: number,
  keep = false,
): DecorationSet {
  const ends = state.selection.ranges.flatMap((range) => [
    range.anchor,
    range.head,
  ])
  const add: Range<Decoration>[] = []
  const { metrics, live } = value
  const tree = treeOf(state)
  // With `keep`, placeholders only come back: none turns into lines.
  const kept = new Set<number>()
  if (keep) value.set.between(from, to, (start) => void kept.add(start))
  if (metrics && live)
    value.extents.between(from, to, (start, end, lines) => {
      if (
        !kept.has(start) &&
        lines.lines > 0 &&
        (end < live.from ||
          start > live.to ||
          (tree && uncovered(tree, start, end))) &&
        !ends.some((at) => at >= start && at <= end)
      )
        add.push(
          Decoration.replace({
            block: true,
            widget: new Placeholder(height(metrics, lines)),
          }).range(start, end),
        )
    })
  return value.set.update({
    filter: (start, end) => keep || end < from || start > to,
    filterFrom: from,
    filterTo: to,
    add,
  })
}

const placeholders = StateField.define<Placeholders>({
  create: () => ({
    extents: RangeSet.empty,
    metrics: null,
    live: null,
    set: Decoration.none,
  }),
  update(value, transaction) {
    const { state, startState } = transaction
    /** Ranges whose placeholders may change, in the new document. */
    const dirty: { from: number; to: number }[] = []
    let next = value
    if (transaction.docChanged) {
      // An edit inside a block makes its extent unknown until the index sends it again.
      const touched: { from: number; to: number }[] = []
      transaction.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
        touched.push({ from: fromB, to: toB })
        dirty.push({ from: fromB, to: toB })
      })
      let extents = value.extents.map(transaction.changes)
      for (const { from, to } of touched)
        extents = extents.update({
          filter: (start, end) => end < from || start > to,
          filterFrom: from,
          filterTo: to,
        })
      next = {
        ...next,
        extents,
        set: value.set.map(transaction.changes),
        live: value.live && {
          from: transaction.changes.mapPos(value.live.from, -1),
          to: transaction.changes.mapPos(value.live.to, 1),
        },
      }
    }
    for (const effect of transaction.effects)
      if (effect.is(setCodeExtents)) {
        const { from, to, extents } = effect.value
        next = {
          ...next,
          extents: next.extents.update({
            filter: (start, end) => end < from || start > to,
            filterFrom: from,
            filterTo: to,
            add: extents.map((extent) =>
              new Lines(extent.lines, extent.columns).range(
                extent.from,
                extent.to,
              ),
            ),
            sort: true,
          }),
        }
        dirty.push({ from, to })
      } else if (effect.is(setMetrics)) {
        next = { ...next, metrics: effect.value }
        dirty.push({ from: 0, to: state.doc.length })
      } else if (effect.is(setLive)) {
        if (next.live) dirty.push(next.live)
        next = { ...next, live: effect.value }
        dirty.push(effect.value)
      }
    // Code the view has to parse again turns back at once, from heights it
    // has measured to the same exact ones; parsed code turns into lines only
    // in the view's own measured update.
    const reparsed =
      next.live && treeOf(state) !== treeOf(startState) ? next.live : null
    // Blocks a selection end leaves or enters.
    if (transaction.selection || transaction.docChanged)
      for (const range of [
        ...startState.selection.ranges.map((range) => ({
          from: transaction.changes.mapPos(range.from),
          to: transaction.changes.mapPos(range.to),
        })),
        ...state.selection.ranges,
      ]) {
        dirty.push({ from: range.from, to: range.from })
        dirty.push({ from: range.to, to: range.to })
      }
    if (!dirty.length && !reparsed) return next
    let set = next.set
    for (const { from, to } of dirty)
      set = refresh({ ...next, set }, state, from, to)
    if (reparsed)
      set = refresh({ ...next, set }, state, reparsed.from, reparsed.to, true)
    return { ...next, set }
  },
  // Placeholders cover the hidden fence lines that start where they do.
  provide: (field) =>
    Prec.highest(EditorView.decorations.from(field, (value) => value.set)),
})

const treeOf = (state: EditorState) => state.facet(formattedTree)?.(state)

/** The window has placeholders for code the view has parsed since. */
function parsed({ set, live }: Placeholders, state: EditorState) {
  const tree = treeOf(state)
  let found = false
  if (live && tree)
    set.between(live.from, live.to, (from, to) => {
      if (!uncovered(tree, from, to)) {
        found = true
        return false
      }
    })
  return found
}

/** Code lines and boxes as drawn, once one shows. */
function measure(view: EditorView): Metrics | null {
  const lines = [
    ...view.contentDOM.querySelectorAll<HTMLElement>(
      '.cm-line.hibi-lp-codeblock',
    ),
  ]
  const middle = lines.find(
    (line) =>
      !line.classList.contains('hibi-lp-codeblock-first') &&
      !line.classList.contains('hibi-lp-codeblock-last'),
  )
  const first = lines.find((line) =>
    line.classList.contains('hibi-lp-codeblock-first'),
  )
  const last = lines.find((line) =>
    line.classList.contains('hibi-lp-codeblock-last'),
  )
  const text = middle?.querySelector<HTMLElement>('.hibi-lp-codetext')
  const box = middle?.closest<HTMLElement>('.hibi-lp-codescroll')
  if (!middle || !first || !last || !text?.textContent || !box) return null
  const row = middle.getBoundingClientRect().height
  // A character's width in the code font, from a line of text.
  const character = text.getBoundingClientRect().width / text.textContent.length
  const style = getComputedStyle(middle)
  const inner =
    box.clientWidth -
    Number.parseFloat(style.paddingLeft) -
    Number.parseFloat(style.paddingRight)
  // A scrollbar's height where scrollbars take space; overlay ones take none.
  // Outside the content, which the editor watches for changes.
  const probe = document.createElement('div')
  probe.style.cssText =
    'position: absolute; visibility: hidden; overflow-x: scroll; height: 40px; width: 40px'
  probe.className = 'hibi-lp-codescroll'
  view.dom.append(probe)
  const scrollbar = probe.offsetHeight - probe.clientHeight
  probe.remove()
  return {
    row,
    top: first.getBoundingClientRect().height - row,
    bottom: last.getBoundingClientRect().height - row,
    scrollbar,
    room: Math.floor(inner / character),
  }
}

/**
 * Code turns into lines where the editor draws, its viewport, which reaches
 * past the screen: lines it has not drawn would count as estimates again, and
 * drawn ones it has measured keep their height as placeholders. The window
 * follows the viewport once the editor has measured it, at most once a
 * measure: an update the editor has not measured yet keeps the text at the
 * top by estimated heights.
 */
const follow = ViewPlugin.fromClass(
  class {
    private measured = false
    private destroyed = false
    constructor(readonly view: EditorView) {
      this.check()
    }
    update(update: ViewUpdate) {
      if (update.geometryChanged) this.measured = false
      if (
        update.viewportChanged ||
        update.geometryChanged ||
        update.docChanged ||
        !this.measured ||
        treeOf(update.state) !== treeOf(update.startState)
      )
        this.check()
    }
    check() {
      // Measure requests run once the viewport no longer changes.
      this.view.requestMeasure({
        key: this,
        read: (view) => ({
          metrics: this.measured ? null : measure(view),
          viewport: view.viewport,
        }),
        write: ({ metrics, viewport }, view) => {
          const value = view.state.field(placeholders)
          const { metrics: known, live } = value
          const effects: StateEffect<unknown>[] = []
          if (metrics) {
            this.measured = true
            if (
              !known ||
              Object.entries(metrics).some(
                ([key, value]) =>
                  Math.abs(value - known[key as keyof Metrics]) > 0.5,
              )
            )
              effects.push(setMetrics.of(metrics))
          }
          // Parsed code turns into lines here too, never in the parser's update.
          if (
            live?.from !== viewport.from ||
            live.to !== viewport.to ||
            parsed(value, view.state)
          )
            effects.push(setLive.of({ from: viewport.from, to: viewport.to }))
          // After the measure, before the frame is painted.
          if (effects.length)
            queueMicrotask(() => {
              if (this.destroyed) return
              // The editor keeps the text at the top in place while it
              // measures these lines; the browser's own scroll anchoring
              // would move it again from their estimated heights.
              const { style } = this.view.dom
              style.overflowAnchor = 'none'
              try {
                this.view.dispatch({ effects })
                // Reading the layout measures the lines that turned back now,
                // before another update takes the text at the top from their
                // estimated heights.
                this.view.lineBlockAtHeight(0)
              } finally {
                style.overflowAnchor = ''
              }
            })
        },
      })
    }
    destroy() {
      this.destroyed = true
    }
  },
)

/** Height-exact placeholders for known code blocks away from the screen. */
export const codePlaceholders: Extension = [placeholders, follow]
