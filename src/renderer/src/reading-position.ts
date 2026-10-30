import { EditorView } from '@codemirror/view'

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

/** Whether a pane whose content was `height` tall is scrolled to its bottom, as CodeMirror tells. */
const atBottom = (pane: Element, height = pane.scrollHeight) =>
  pane.scrollTop > Math.max(1, height - pane.clientHeight - 4)

/** The element that scrolls the editor: the first around it that scrolls vertically. */
function scrollPane(view: EditorView) {
  let pane: Element | null = view.scrollDOM
  while (
    pane &&
    !(
      pane.scrollHeight > pane.clientHeight &&
      /auto|scroll/.test(getComputedStyle(pane).overflowY)
    )
  )
    pane = pane.parentElement
  return pane
}

/** Where the reader is: the caret while it is on screen, else the first line below the top of the scrolled pane. */
function readingPosition(view: EditorView): Reading | null {
  const pane = scrollPane(view)
  // A reader at the bottom stays there instead: see `keepRead`.
  if (pane && atBottom(pane)) return null
  const scroller = pane ?? document.scrollingElement
  const { top, bottom } = pane?.getBoundingClientRect() ?? {
    top: 0,
    bottom: window.innerHeight,
  }
  let pos = view.state.selection.main.head
  let at = view.coordsAtPos(pos, 1)
  if (!at || at.top < top || at.top > bottom) {
    const { documentTop } = view
    let block = view.lineBlockAtHeight(top - documentTop)
    if (block.top + documentTop < top && block.to < view.state.doc.length)
      block = view.lineBlockAt(block.to + 1)
    pos = block.from
    at = view.coordsAtPos(pos, 1)
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

/**
 * Preserve the reader through asynchronous rendering or syntax changes.
 * Measure after CodeMirror applies its own anchoring, then correct the screen
 * delta once per slice. Later edits, selections and scrolling still stand.
 */
export function keepReading(view: EditorView, at = 0) {
  // Changes below what is on screen never move it, nor do hidden editors.
  if (!view.inView || at >= (view.visibleRanges.at(-1)?.to ?? 0)) return
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

/** Each editor's scrolled pane and how tall its content was when last measured. */
const heights = new WeakMap<EditorView, { pane: Element; height: number }>()
/**
 * A reader at the bottom of the pane stays there when heights change, as
 * drawn lines replace estimates and the space below the last line comes
 * back: CodeMirror keeps one only in its own scroller or during input.
 */
const keepBottom = {
  key: heights,
  read(view: EditorView) {
    const pane = scrollPane(view)
    const known = heights.get(view)
    const pinned =
      !!pane &&
      known?.pane === pane &&
      pane.scrollHeight !== known.height &&
      atBottom(pane, known.height)
    if (pane) heights.set(view, { pane, height: pane.scrollHeight })
    return pinned ? pane : null
  },
  write(pane: Element | null) {
    if (pane) pane.scrollTop = pane.scrollHeight
  },
}

export const keepRead = [
  EditorView.updateListener.of((update) =>
    update.view.requestMeasure(keepBottom),
  ),
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
