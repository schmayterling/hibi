import { Annotation, Facet, type Transaction } from '@codemirror/state'
import { EditorView, ViewPlugin } from '@codemirror/view'
import { readDOMPosition } from './native-dom-selection.ts'
import { isViewDead } from './view-death.ts'

/**
 * Whether the view placed the selection itself, as a note opens with its
 * caret at the end, so it is not where the reader is.
 */
export const placedSelection = Facet.define<boolean, boolean>({
  combine: (values) => values.some(Boolean),
})

// DIAG (never merge): reading-place trace, plain numbers only, from values
// this module already reads.
const traceTarget = globalThis as {
  __readingTrace?: object[]
  __readingTraceDropped?: number
}
function trace(event: string, fields: object = {}) {
  const log = (traceTarget.__readingTrace ??= [])
  if (log.length < 20000) log.push({ time: performance.now(), event, ...fields })
  else
    traceTarget.__readingTraceDropped =
      (traceTarget.__readingTraceDropped ?? 0) + 1
}
const traced = (position: Reading | null | undefined) =>
  position && {
    pos: position.pos,
    top: position.top,
    offset: position.offset,
    text: position.text,
    line: position.line,
    isTop: !!position.isTop,
  }

const scrollRequests = new WeakMap<EditorView, number>()
/**
 * Views with a scroll command they have not run: a measure can end without
 * running it while what the view draws keeps changing.
 */
const scrollsWaiting = new WeakSet<EditorView>()

/** The reading position during one rendering or background parsing slice. */
type Reading = {
  /** The element that scrolls the editor. */
  pane: Element
  pos: number
  /** Where `pos` is below the pane's top. The pane can move on the page, as under a bar that appears: its place in the pane is what holds. */
  top: number
  /** How far below its line block's top in the editor's heights `pos` showed. */
  offset: number
  /** Whether the editor drew `pos` as its own text, not in a widget. */
  text: boolean
  /** The end of the line `pos` is on. */
  line: number
  moved: boolean
  doc: EditorView['state']['doc']
  selection: EditorView['state']['selection']
  scrollRequest: number
  /** Read from the text at the top of a block taller than the pane, for as long as the pane stays. */
  isTop?: boolean
}
const reading = new WeakMap<EditorView, Reading | null>()

/** The element scrolling the editor, if not the page. */
function scrollingPane(view: EditorView) {
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

/** Where the pane's top is on screen. */
function paneTop(pane: Element) {
  return pane === document.scrollingElement
    ? 0
    : pane.getBoundingClientRect().top
}

/**
 * Where the reader is: the caret while it is on screen, else the first line
 * below the top of the scrolled pane, or the block the pane's top is in.
 */
function readingPosition(view: EditorView): Reading | null {
  const pane = scrollingPane(view)
  const scroller = pane ?? document.scrollingElement
  const { top, bottom } = pane?.getBoundingClientRect() ?? {
    top: 0,
    bottom: window.innerHeight,
  }
  let pos = view.state.selection.main.head
  // A caret the view placed is not where the reader is.
  let at = view.state.facet(placedSelection) ? null : view.coordsAtPos(pos, 1)
  if (!at || at.top < top || at.top > bottom) {
    // The place held last, while nothing but holding it scrolled the pane:
    // read again, the text at the top of a line the editor lays out again
    // can start a row earlier each time, and the place would creep a row
    // per slice.
    const before = anchors.get(view)
    if (before?.position.doc === view.state.doc) {
      // Reading the layout runs a pending measure first, which moves the pane,
      // as every fresh read does, and can hold another place.
      view.coordsAtPos(before.position.pos, 1)
      const held = anchors.get(view)
      if (
        held?.position.doc === view.state.doc &&
        Math.abs(held.position.pane.scrollTop - held.scroll) <= 1
      ) {
        trace('read-held', { held: traced(held.position), scroll: held.scroll })
        return {
          ...held.position,
          moved: false,
          selection: view.state.selection,
          scrollRequest: scrollRequests.get(view) ?? 0,
        }
      }
    }
    const { documentTop } = view
    let block = view.lineBlockAtHeight(top - documentTop)
    // The text the page shows at the pane's top, inside a block that starts
    // above it, as a long paragraph or line: the block's start would hold
    // the screen while the editor lays the block out again.
    const text = block.top + documentTop < top ? textAt(view, top + 1) : null
    const box = text === null ? null : view.coordsAtPos(text, 1)
    if (text !== null && box) {
      trace('read-text', { text, boxTop: box.top, paneTop: top })
      return reader(view, scroller, text, box.top)
    }
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
  trace('read-block', { pos, atTop: at?.top ?? null, paneTop: top })
  return at ? reader(view, scroller, pos, at.top) : null
}

/** The reader at `pos`, shown `top` on screen, in the scrolling `pane`. */
function reader(
  view: EditorView,
  pane: Element | null,
  pos: number,
  top: number,
): Reading | null {
  if (!pane) return null
  const text = drawnText(view, pos)
  // As restoring reads it: the two differ at a row that starts at a join.
  const shown = (text ? drawnTop(view, pos) : null) ?? top
  return {
    pane,
    pos,
    top: shown - paneTop(pane),
    offset: shown - view.documentTop - view.lineBlockAt(pos).top,
    text,
    line: view.state.doc.lineAt(pos).to,
    moved: false,
    doc: view.state.doc,
    selection: view.state.selection,
    scrollRequest: scrollRequests.get(view) ?? 0,
  }
}

/**
 * The position of the editor's own text the page shows at the start of the
 * content's line at `y`. Text a widget draws, as a table's cells, moves with
 * the widget's own layout: the widget's block holds the reader.
 */
function textAt(view: EditorView, y: number) {
  const x = contentLeft(view)
  const { ownerDocument } = view.dom
  // Below what covers the pane's top, as the find bar over a narrow pane.
  const over = ownerDocument.elementFromPoint(x, y)
  const below =
    over && !over.contains(view.dom) && !view.dom.contains(over)
      ? over.getBoundingClientRect().bottom + 1
      : y
  const caret = ownerDocument.caretPositionFromPoint(x, below)
  const read = caret && readDOMPosition(view, caret.offsetNode, caret.offset)
  if (!read || read.mapped) return null
  // A joined newline belongs to the row above when revealed. Hold the next
  // character, whose own box is the text the reader sees here.
  return (
    read.at +
    (view.state.doc.sliceString(read.at, read.at + 1) === '\n' ? 1 : 0)
  )
}

/** Just inside where the content's lines start. */
function contentLeft(view: EditorView) {
  return (
    view.contentDOM.getBoundingClientRect().left +
    Number.parseFloat(getComputedStyle(view.contentDOM).paddingLeft) +
    1
  )
}

/** The start of the block the page shows at the start of the content's line at `y`. */
function blockAt(view: EditorView, y: number) {
  const x = contentLeft(view)
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
  if (isViewDead(view)) return
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
        isViewDead(view) ||
        !position?.moved ||
        !view.dom.isConnected ||
        view.composing ||
        view.state.doc !== position.doc ||
        view.state.selection !== position.selection
      )
        return
      const restored = restore(view, position)
      trace('keep-restored', { restored, position: traced(position) })
      if (restored)
        kept.set(view, {
          ...position,
          scroll: position.pane.scrollTop,
          left: 8,
        })
    })
  }
  if (position && at <= position.line) position.moved = true
  trace('keep', { at, position: traced(position) })
}

/** Whether the editor draws `pos` as text: not in a widget, nor in the undrawn part of a long line. */
function drawnText(view: EditorView, pos: number) {
  return view.visibleRanges.some((range) => range.from <= pos && pos < range.to)
}

/**
 * Where the page draws the text at `pos`. Scroll handlers run while the
 * editor updates, when it can't measure positions itself.
 */
function drawnTop(view: EditorView, pos: number) {
  let { node, offset } = view.domAtPos(pos, 1)
  // Between elements, as before a widget's buffer at a row that starts at a
  // join of lines: the line's next text.
  if (node.nodeType !== Node.TEXT_NODE) {
    const next = node.childNodes[offset]
    const line = next && (node as Element).closest('.cm-line')
    if (!line) return null
    const walker = view.dom.ownerDocument.createTreeWalker(
      line,
      NodeFilter.SHOW_TEXT,
    )
    walker.currentNode = next
    const text = next.nodeType === Node.TEXT_NODE ? next : walker.nextNode()
    if (!text) return null
    node = text
    offset = 0
  }
  const range = view.dom.ownerDocument.createRange()
  range.setStart(node, offset)
  // The character after the position, in the row it starts.
  if (
    node.nodeType === Node.TEXT_NODE &&
    offset < (node.nodeValue?.length ?? 0)
  )
    range.setEnd(node, offset + 1)
  const box = range.getClientRects()[0]
  return box ? box.top : null
}

/** Reading positions the editor is asked to draw so they can be scrolled back, by view. */
const revealing = new WeakMap<EditorView, Reading>()

/** A scroll command the reading position sends itself. */
const revealed = Annotation.define<boolean>()
// ponytail: CodeMirror exports no type for its scroll command's effect; its
// value's class names it. A public effect type would replace this.
const scrollTarget = (EditorView.scrollIntoView(0).value as object).constructor

/** Whether a transaction asks the view to scroll, other than to a reading position. */
function asksScroll(transaction: Transaction) {
  return (
    !transaction.annotation(revealed) &&
    (transaction.scrollIntoView ||
      transaction.effects.some(
        (effect) => effect.value instanceof scrollTarget,
      ))
  )
}

/**
 * Has the editor draw the reading position, then lines it up where it was
 * (scrollHandler), all before the page paints or the reader's next scroll.
 * Inside the part of a long line the editor leaves undrawn, a position's
 * coordinates are a line gap's edge and its heights there are estimates, so
 * neither can line it up.
 */
function reveal(view: EditorView, position: Reading) {
  if (revealing.get(view) === position) return
  revealing.set(view, position)
  queueMicrotask(() => {
    if (revealing.get(view) !== position) return
    if (
      !view.dom.isConnected ||
      (scrollRequests.get(view) ?? 0) !== position.scrollRequest
    ) {
      revealing.delete(view)
      return
    }
    // Where the editor scrolls it when the page can't place it either.
    trace('reveal-dispatch', { position: traced(position) })
    view.dispatch({
      effects: EditorView.scrollIntoView(position.pos, {
        y: 'start',
        yMargin: position.top,
      }),
      annotations: revealed.of(true),
    })
    // Reading the layout runs the command.
    view.lineBlockAtHeight(0)
  })
}

/**
 * Where the reading position is on screen: where it is drawn, else where the
 * editor's heights put it. New heights above can move it out of what the
 * editor draws, as when it estimates a long paragraph's lines again.
 */
function screenTop(view: EditorView, position: Reading) {
  const drawn =
    (position.text ? drawnTop(view, position.pos) : null) ??
    view.coordsAtPos(position.pos, 1)?.top
  if (drawn !== undefined) return drawn
  return view.documentTop + view.lineBlockAt(position.pos).top + position.offset
}

/** The place each view held last, with the pane's scroll once it was held. */
const anchors = new WeakMap<EditorView, { position: Reading; scroll: number }>()
function hold(view: EditorView, position: Reading) {
  anchors.set(view, { position, scroll: position.pane.scrollTop })
  trace('hold', {
    position: traced(position),
    scroll: anchors.get(view)!.scroll,
  })
}

/**
 * Holds the text at the pane's top inside a block taller than the pane. The
 * editor keeps such a block's start in place but none of the text in it, so
 * when the width or the line gaps change, the same scroll shows other text.
 * A new width has already wrapped the text once anything can tell, so the
 * place is read as the reader moves. This reads no heights: asking for them
 * runs a pending measure, which can move the line gaps before the place is
 * read.
 */
function holdTop(view: EditorView) {
  if (isViewDead(view)) return
  const pane = scrollingPane(view)
  if (!pane) return
  const held = anchors.get(view)
  if (held?.position.isTop) {
    if (
      held.position.doc === view.state.doc &&
      Math.abs(pane.scrollTop - held.scroll) <= 1
    )
      return
    anchors.delete(view)
  }
  const text = textAt(view, pane.getBoundingClientRect().top + 1)
  if (text === null || view.lineBlockAt(text).height <= pane.clientHeight) {
    trace('hold-top-skip', { text })
    return
  }
  const top = drawnTop(view, text)
  trace('hold-top', { text, drawnTop: top })
  const position = top === null ? null : reader(view, pane, text, top)
  // Not at a line gap's edge, where nothing is drawn to hold.
  if (position?.text) {
    hold(view, { ...position, isTop: true })
    paneSizes.get(view)?.observe(pane)
  }
}

/** Scrolls the reading position back to where it was on screen. */
function restore(view: EditorView, position: Reading) {
  // Asking runs a pending measure first: its own correction for new heights
  // above would come on top of this one, and it can move the line gaps.
  // Its draw can kill the view before the coordinate read returns.
  try {
    view.coordsAtPos(position.pos, 1)
  } catch (error) {
    if (!isViewDead(view)) throw error
  }
  if (isViewDead(view)) return false
  // Text the editor doesn't draw now: a widget's position keeps its own
  // coordinates, without a scroll command for each correction.
  if (position.text && !drawnText(view, position.pos)) {
    if ((scrollRequests.get(view) ?? 0) !== position.scrollRequest) return false
    // The view keeps only the last command, which this one would replace.
    if (scrollsWaiting.has(view)) {
      view.requestMeasure()
      return false
    }
    trace('restore-reveal', { position: traced(position) })
    reveal(view, position)
    return true
  }
  const now = screenTop(view, position) - paneTop(position.pane)
  trace('restore', {
    position: traced(position),
    now,
    delta: now - position.top,
  })
  // Measuring can execute a pending scroll command; its destination takes precedence.
  if ((scrollRequests.get(view) ?? 0) !== position.scrollRequest) return false
  if (Math.abs(now - position.top) >= 0.5)
    position.pane.scrollTop += now - position.top
  hold(view, position)
  return true
}

/**
 * A scroll a view's widget makes itself, as a table showing the cell it
 * edits: it takes precedence as a scroll command does, over a place read
 * before it and not restored yet.
 */
export function scrolledItself(view: EditorView) {
  scrollRequests.set(view, (scrollRequests.get(view) ?? 0) + 1)
}

/** Each view's watch on its pane's size, which a view's own updates don't change. */
const paneSizes = new WeakMap<EditorView, ResizeObserver>()

/** Puts the text held at the pane's top back, after its layout changed. */
function holdHeld(view: EditorView) {
  if (isViewDead(view)) return
  const held = anchors.get(view)
  if (
    !held?.position.isTop ||
    held.position.doc !== view.state.doc ||
    // The reader's scroll, whose event comes after this update.
    Math.abs(held.position.pane.scrollTop - held.scroll) > 1
  )
    return
  trace('hold-held', { held: traced(held.position), scroll: held.scroll })
  restore(view, {
    ...held.position,
    scrollRequest: scrollRequests.get(view) ?? 0,
  })
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
  // A view given a new state, as after a failed edit, drops its scroll command.
  ViewPlugin.define((view) => {
    scrollsWaiting.delete(view)
    // Before the page paints a new size: the editor measures it later.
    const resize = new ResizeObserver(() => holdHeld(view))
    paneSizes.set(view, resize)
    return { destroy: () => resize.disconnect() }
  }),
  EditorView.domEventObservers({
    scroll: (_, view) => {
      trace('scroll-event')
      holdTop(view)
    },
  }),
  EditorView.updateListener.of((update) => {
    const asked = update.transactions.some(asksScroll)
    // A scroll command takes precedence from when it is sent: the view keeps
    // only the last one, which a reading position's would replace.
    if (asked) {
      scrollRequests.set(
        update.view,
        (scrollRequests.get(update.view) ?? 0) + 1,
      )
      scrollsWaiting.add(update.view)
      revealing.delete(update.view)
    }
    // An edit can move the line gaps before anything reads the place again,
    // so the place follows its text.
    const held = anchors.get(update.view)
    if (held?.position.isTop && update.docChanged) {
      const { doc } = update.state
      const pos = update.changes.mapPos(held.position.pos, 1)
      held.position = {
        ...held.position,
        pos,
        doc,
        line: doc.lineAt(pos).to,
      }
    }
    // Scrolling away ends the place held: back at the same scroll, the
    // heights under it can be new.
    if (held && Math.abs(held.position.pane.scrollTop - held.scroll) > 1)
      held.scroll = Number.POSITIVE_INFINITY
    const keep = kept.get(update.view)
    if (
      keep &&
      (update.docChanged ||
        update.selectionSet ||
        Math.abs(keep.pane.scrollTop - keep.scroll) > 1)
    )
      kept.delete(update.view)
    trace('update', {
      docChanged: update.docChanged,
      geometry: update.geometryChanged,
      height: update.heightChanged,
      viewport: update.viewportChanged,
      asked,
      keep: keep ? keep.left : null,
      held: held
        ? {
            isTop: !!held.position.isTop,
            pos: held.position.pos,
            scroll: held.scroll,
          }
        : null,
    })
    if (
      !update.geometryChanged &&
      !update.heightChanged &&
      !update.viewportChanged
    )
      return
    if (!keep || kept.get(update.view) !== keep) {
      holdHeld(update.view)
      return
    }
    if (--keep.left <= 0) kept.delete(update.view)
    restore(update.view, keep)
    keep.scroll = keep.pane.scrollTop
  }),
  EditorView.scrollHandler.of((view, range) => {
    // The editor drew a reading position it was asked to: line it up.
    const position = revealing.get(view)
    revealing.delete(view)
    if (position && range.head === position.pos) {
      const now = drawnTop(view, position.pos)
      if (now === null) {
        trace('scroll-handler', { position: traced(position), now })
        return false
      }
      const delta = now - paneTop(position.pane) - position.top
      trace('scroll-handler', { position: traced(position), now, delta })
      position.pane.scrollTop += delta
      const keep = kept.get(view)
      if (keep) keep.scroll = keep.pane.scrollTop
      hold(view, position)
      return true
    }
    trace('scroll-other', {
      head: range.head,
      revealing: position ? position.pos : null,
    })
    scrollRequests.set(view, (scrollRequests.get(view) ?? 0) + 1)
    scrollsWaiting.delete(view)
    reading.delete(view)
    kept.delete(view)
    return false
  }),
]
