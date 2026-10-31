import { Facet } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

/**
 * Whether the view placed the selection itself, as a note opens with its
 * caret at the end, so it is not where the reader is.
 */
export const placedSelection = Facet.define<boolean, boolean>({
  combine: (values) => values.some(Boolean),
})

const scrollRequests = new WeakMap<EditorView, number>()

/** The reading position during one rendering or background parsing slice. */
type Reading = {
  /** The element that scrolls the editor. */
  pane: Element
  pos: number
  /** Where `pos` is on screen. */
  top: number
  /** The end of the line `pos` is on. */
  line: number
  moved: boolean
  doc: EditorView['state']['doc']
  selection: EditorView['state']['selection']
  scrollRequest: number
}
const reading = new WeakMap<EditorView, Reading | null>()

/**
 * Where the reader is: the caret while it is on screen, else the first line
 * below the top of the scrolled pane, or the block the pane's top is in.
 */
function readingPosition(view: EditorView): Reading | null {
  let pane: Element | null = view.scrollDOM
  while (
    pane &&
    !(
      pane.scrollHeight > pane.clientHeight &&
      /auto|scroll/.test(getComputedStyle(pane).overflowY)
    )
  )
    pane = pane.parentElement
  const scroller = pane ?? document.scrollingElement
  const { top, bottom } = pane?.getBoundingClientRect() ?? {
    top: 0,
    bottom: window.innerHeight,
  }
  let pos = view.state.selection.main.head
  // A caret the view placed is not where the reader is.
  let at = view.state.facet(placedSelection) ? null : view.coordsAtPos(pos, 1)
  if (!at || at.top < top || at.top > bottom) {
    const { documentTop } = view
    let block = view.lineBlockAtHeight(top - documentTop)
    if (block.top + documentTop < top && block.to < view.state.doc.length)
      block = view.lineBlockAt(block.to + 1)
    pos = block.from
    at = view.coordsAtPos(pos, 1)
    // Under a block taller than the pane, such as a long table, the next
    // line may be far below and not drawn, and while the editor's heights
    // for the text above are new estimates the page does not show yet, they
    // name another block. The block the page shows there holds the reader.
    if (!at) {
      const shown = blockAt(view, top + 1)
      if (shown !== null) {
        pos = shown
        at = view.coordsAtPos(pos, 1)
      }
    }
  }
  return at && scroller
    ? {
        pane: scroller,
        pos,
        top: at.top,
        line: view.state.doc.lineAt(pos).to,
        moved: false,
        doc: view.state.doc,
        selection: view.state.selection,
        scrollRequest: scrollRequests.get(view) ?? 0,
      }
    : null
}

/** The start of the block the page shows at the start of the content's line at `y`. */
function blockAt(view: EditorView, y: number) {
  const box = view.contentDOM.getBoundingClientRect()
  const x =
    box.left +
    Number.parseFloat(getComputedStyle(view.contentDOM).paddingLeft) +
    1
  // Under what covers the pane's top, as the find bar over a narrow pane.
  const element = view.dom.ownerDocument
    .elementsFromPoint(x, y)
    .find((element) => element.parentElement === view.contentDOM)
  if (!element) return null
  try {
    return view.posAtDOM(element, 0)
  } catch {
    return null
  }
}

/**
 * Preserve the reader through asynchronous rendering or syntax changes.
 * Measure after CodeMirror applies its own anchoring, then correct the screen
 * delta once per slice. Later edits, selections and scrolling still stand.
 */
export function keepReading(view: EditorView, at = 0) {
  // Changes below what is on screen never move it, nor do hidden editors. A
  // screen inside one block, as a long table, has no visible ranges.
  const end = view.visibleRanges.at(-1)?.to ?? view.viewport.to
  if (!view.inView || at >= end) return
  let position = reading.get(view)
  if (position === undefined) {
    position = readingPosition(view)
    reading.set(view, position)
    queueMicrotask(() => {
      if (reading.get(view) !== position) return
      reading.delete(view)
      if (
        !position?.moved ||
        !view.dom.isConnected ||
        view.composing ||
        view.state.doc !== position.doc ||
        view.state.selection !== position.selection
      )
        return
      if (restore(view, position))
        kept.set(view, {
          ...position,
          scroll: position.pane.scrollTop,
          left: 8,
        })
    })
  }
  if (position && at <= position.line) position.moved = true
}

/** Scrolls the reading position back to where it was on screen. */
function restore(view: EditorView, position: Reading) {
  const now = view.coordsAtPos(position.pos, 1)
  // Measuring can execute a pending scroll command; its destination takes precedence.
  if ((scrollRequests.get(view) ?? 0) !== position.scrollRequest) return false
  if (now && Math.abs(now.top - position.top) >= 0.5)
    position.pane.scrollTop += now.top - position.top
  return true
}

/**
 * Keep the position through subsequent geometry updates: newly drawn content
 * can change the measured heights again after the first correction. Edits,
 * selection changes and any other scrolling, such as the reader's, end it.
 */
const kept = new WeakMap<
  EditorView,
  Reading & { scroll: number; left: number }
>()
export const keepRead = [
  EditorView.updateListener.of((update) => {
    const keep = kept.get(update.view)
    if (!keep) return
    if (
      update.docChanged ||
      update.selectionSet ||
      Math.abs(keep.pane.scrollTop - keep.scroll) > 1
    ) {
      kept.delete(update.view)
      return
    }
    if (
      !update.geometryChanged &&
      !update.heightChanged &&
      !update.viewportChanged
    )
      return
    if (--keep.left <= 0) kept.delete(update.view)
    restore(update.view, keep)
    keep.scroll = keep.pane.scrollTop
  }),
  EditorView.scrollHandler.of((view) => {
    scrollRequests.set(view, (scrollRequests.get(view) ?? 0) + 1)
    reading.delete(view)
    kept.delete(view)
    return false
  }),
]
