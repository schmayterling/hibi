import type { Transaction } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { focusedEditor, mappedPositionAt } from './native-dom-selection'
import { foreignScroll, inOwnScroll, ownScroll } from './own-scroll'
import { asksScroll } from './reading-position'
import { editorPosition, sourcePosition, sourceView } from './source-view'

/** Markdown caret alignment stays active even when linked scrolling is disabled. */
export function linkScroll(
  first: HTMLElement,
  second: HTMLElement,
  initial: HTMLElement,
  markdown?: 'source',
  syncScrolling = true,
) {
  let leader = initial
  let frame = 0
  let refinements = 0
  // With scrolling unlinked, a caret alignment follows the layout settling
  // under it until a pane scrolls apart from it. Layout moves the aligned
  // lines within their panes' content; a scroll, any scroll, moves only the
  // panes.
  let aligning = false
  let ends: {
    from: EditorView
    position: number
    to: EditorView
    at: number
  } | null = null
  // A pane's scroll and its aligned line's place in the pane's scrolled
  // content: where it is drawn, if it is, and where the view's height map
  // has it.
  type Place = { top: number; drawn: number | null; line: number }
  let placed: { leader: Place; target: Place } | null = null
  const paneState = (pane: HTMLElement) => {
    const content = pane.querySelector('.cm-content')
    const view = content && sourceView(content)
    return view?.state
  }
  const caret = (pane: HTMLElement) => {
    const state = paneState(pane)
    if (!state) return null
    const selection = state.selection.main
    return {
      pane,
      doc: state.doc,
      mirrorDoc: paneState(pane === first ? second : first)?.doc,
      anchor: selection.anchor,
      head: selection.head,
    }
  }
  let previousCaret = caret(initial)
  const sameCaret = (
    a: ReturnType<typeof caret>,
    b: ReturnType<typeof caret>,
  ) =>
    a?.pane === b?.pane &&
    a?.doc === b?.doc &&
    a?.mirrorDoc === b?.mirrorDoc &&
    a?.anchor === b?.anchor &&
    a?.head === b?.head
  const sourcePane = second.closest('.source-pane')
  function sourceTop(target: HTMLElement): number | null {
    const fromContent = leader.querySelector('.cm-content')
    const toContent = target.querySelector('.cm-content')
    const from = fromContent && sourceView(fromContent)
    const to = toContent && sourceView(toContent)
    if (!from || !to) return null
    const bounds = leader.getBoundingClientRect()
    let position = from.state.selection.main.head
    // A table cell's editor, inside the view, has the formatted view's caret.
    let point = focusedEditor(from) ? from.coordsAtPos(position) : null
    if (!point || point.top < bounds.top || point.bottom > bounds.bottom) {
      // Unlinked, only a caret in view has a line to align.
      if (!syncScrolling) return null
      const content = from.contentDOM.getBoundingClientRect()
      const y = bounds.top + bounds.height / 2
      // posAtCoords gives a table's edges for a point in its cells, and the
      // content's left edge can be in the table's margin, so the table is
      // asked at the middle of its cells. Sized columns can leave them
      // narrower than the content.
      let x = content.left + content.width / 2
      const cells = document
        .elementFromPoint(x, y)
        ?.closest('.hibi-lp-table')
        ?.querySelector(':scope > table')
        ?.getBoundingClientRect()
      if (cells)
        x =
          (Math.max(cells.left, content.left) +
            Math.min(cells.right, content.right)) /
          2
      position =
        mappedPositionAt(from, x, y) ??
        from.posAtCoords({ x: content.left + 8, y }) ??
        position
      point = from.coordsAtPos(position)
    }
    const at = editorPosition(to, sourcePosition(from, position))
    if (!point || at === null) return null
    ends = { from, position, to, at }
    const block = to.lineBlockAt(at)
    if (!block.height) return null
    const destination = to.coordsAtPos(at)
    const y = destination
      ? (destination.top + destination.bottom) / 2
      : to.documentTop + block.top + to.defaultLineHeight / 2
    return target.scrollTop + y - (point.top + point.bottom) / 2
  }
  const lineY = (
    pane: HTMLElement,
    view: EditorView,
    pos: number,
  ): Place | null => {
    if (pos > view.state.doc.length) return null
    const offset = pane.scrollTop - pane.getBoundingClientRect().top
    const point = view.coordsAtPos(pos)
    return {
      top: pane.scrollTop,
      drawn: point && offset + (point.top + point.bottom) / 2,
      line: offset + view.documentTop + view.lineBlockAt(pos).top,
    }
  }
  const measure = () => {
    if (!ends) return null
    const target = leader === first ? second : first
    const from = lineY(leader, ends.from, ends.position)
    const to = lineY(target, ends.to, ends.at)
    if (from === null || to === null) return null
    return { leader: from, target: to }
  }
  const record = () => {
    if (!syncScrolling && aligning) placed = measure()
  }
  // While an alignment holds, each pane is where hibi's own corrections put
  // it: the panes' views measuring and focusing, reading-position keeping its
  // place, and this alignment's writes. A pane anywhere else was scrolled by
  // someone else: a script writing to it, a descendant scrolled into view, a
  // scroll command moving no caret, an addon's measure. (The browser keeps
  // no place of its own: CodeMirror's scrollers turn its anchoring off.)
  const placedAt = new Map<HTMLElement, number>()
  /** Whether a pane is no longer where hibi's own corrections left it. */
  const strayed = () =>
    [first, second].some((pane) => {
      const top = pane.scrollTop
      const at = placedAt.get(pane) ?? top
      if (Math.abs(top - at) < 1) return false
      // Content shrinking under a pane at its end pulls the end into view.
      if (top < at && top >= pane.scrollHeight - pane.clientHeight - 1) {
        placedAt.set(pane, top)
        return false
      }
      return true
    })
  let unguard: (() => void) | null = null
  const guard = () => {
    if (syncScrolling || unguard) return
    const scrollTop = Object.getOwnPropertyDescriptor(
      Element.prototype,
      'scrollTop',
    )
    if (!scrollTop?.get || !scrollTop.set) return
    const { get, set } = scrollTop
    const undo: (() => void)[] = []
    // Puts back whatever the object had of its own, as SourceEditor's measure.
    const patch = (target: object, name: string, own: PropertyDescriptor) => {
      const before = Object.getOwnPropertyDescriptor(target, name)
      Object.defineProperty(target, name, { configurable: true, ...own })
      const installed = Object.getOwnPropertyDescriptor(target, name)
      undo.push(() => {
        const now = Object.getOwnPropertyDescriptor(target, name)
        // Replaced since by its owner: theirs stays.
        if (now?.value !== installed?.value || now?.set !== installed?.set)
          return
        if (before) Object.defineProperty(target, name, before)
        else delete (target as Record<string, unknown>)[name]
      })
    }
    // A correction arriving after someone else moved the pane doesn't make
    // their scroll its own.
    const writing = (pane: HTMLElement, write: () => void) => {
      if (!inOwnScroll() || strayed()) {
        disarm()
        return write()
      }
      write()
      placedAt.set(pane, get.call(pane))
    }
    for (const pane of [first, second]) {
      placedAt.set(pane, get.call(pane))
      patch(pane, 'scrollTop', {
        get() {
          return get.call(this)
        },
        set(value: number) {
          writing(pane, () => set.call(this, value))
        },
      })
      for (const name of ['scroll', 'scrollTo', 'scrollBy'] as const) {
        const method = Element.prototype[name] as (...args: unknown[]) => void
        patch(pane, name, {
          writable: true,
          value(this: Element, ...args: unknown[]) {
            writing(pane, () => method.apply(this, args))
          },
        })
      }
      const content = pane.querySelector('.cm-content')
      const view = content && sourceView(content)
      if (!view) continue
      const methods = view as unknown as Record<
        string,
        (...args: unknown[]) => unknown
      >
      // A scroll command that moves no caret runs at the view's next measure:
      // what that measure scrolls is the command's, not the view's own.
      let commanded = false
      for (const name of ['measure', 'focus'] as const) {
        // ponytail: measure is the view's own entry to its measure pass, not
        // public API; the source-anchor test fails if the view stops calling it.
        const method = methods[name]
        if (!method) continue
        patch(view, name, {
          writable: true,
          value(this: EditorView, ...args: unknown[]) {
            if (name === 'measure' && commanded) {
              commanded = false
              return foreignScroll(() => method.apply(this, args))
            }
            return ownScroll(() => method.apply(this, args))
          },
        })
      }
      // What others ask of a measure is theirs, even inside the view's.
      const request = methods.requestMeasure
      type Request = {
        read: (view: EditorView) => unknown
        write?: (measured: unknown, view: EditorView) => void
      }
      const theirs = new WeakMap<Request, Request>()
      const foreign = (asked: Request): Request => ({
        ...asked,
        read: (view) => foreignScroll(() => asked.read(view)),
        write: (measured, view) =>
          foreignScroll(() => asked.write?.(measured, view)),
      })
      if (request)
        patch(view, 'requestMeasure', {
          writable: true,
          value(this: EditorView, asked?: Request) {
            if (!asked) return request.call(this)
            const wrapped = theirs.get(asked) ?? foreign(asked)
            theirs.set(asked, wrapped)
            return request.call(this, wrapped)
          },
        })
      const update = methods.update
      if (update)
        patch(view, 'update', {
          writable: true,
          value(this: EditorView, transactions: readonly Transaction[]) {
            if (
              transactions.some(
                (transaction) =>
                  asksScroll(transaction) &&
                  (!transaction.selection ||
                    transaction.selection.eq(transaction.startState.selection)),
              )
            )
              commanded = true
            return update.call(this, transactions)
          },
        })
    }
    unguard = () => {
      unguard = null
      for (const step of undo.reverse()) step()
    }
  }
  const disarm = () => {
    unguard?.()
    aligning = false
    placed = null
    cancelAnimationFrame(frame)
    frame = 0
  }
  // Within a fraction of a pixel: a scroll of half a pixel still counts.
  const moved = (a: number, b: number) => Math.abs(a - b) > 0.25
  /** Realigns after layout under the aligned lines. */
  const check = () => {
    const was = placed
    if (!aligning || !was) return
    const now = measure()
    if (!now) return schedule()
    const panes = ['leader', 'target'] as const
    // Layout reaches the drawn line at once and the height map at the view's
    // next measure, which can scroll to keep its place: either counts.
    const shifted = (a: Place, b: Place) =>
      moved(a.line, b.line) ||
      (a.drawn !== null && b.drawn !== null && moved(a.drawn, b.drawn))
    if (panes.some((pane) => shifted(now[pane], was[pane]))) schedule()
  }
  const sync = () => {
    frame = 0
    const target = leader === first ? second : first
    let top: number | null
    if (markdown) top = sourceTop(target)
    else {
      const range = leader.scrollHeight - leader.clientHeight
      const position = range > 0 ? leader.scrollTop / range : 0
      top =
        Math.max(0, Math.min(1, position)) *
        Math.max(0, target.scrollHeight - target.clientHeight)
    }
    if (top === null) return
    const clamped = Math.max(
      0,
      Math.min(top, target.scrollHeight - target.clientHeight),
    )
    // Unlinked, only an alignment that still holds writes: its own lookups
    // can end it, and a pane moved since by anyone else ends it.
    if (!syncScrolling && (!aligning || strayed())) {
      if (aligning) disarm()
      return
    }
    if (Math.abs(target.scrollTop - clamped) < 1) return record()
    ownScroll(() => {
      target.scrollTop = clamped
    })
    if (markdown && refinements++ < 3) frame = requestAnimationFrame(sync)
  }
  const schedule = () => {
    cancelAnimationFrame(frame)
    refinements = 0
    frame = requestAnimationFrame(sync)
  }
  const scroll = (event: Event) => {
    if (!syncScrolling) return check()
    const origin = event.currentTarget as HTMLElement
    // Virtualized source layout can emit several delayed scroll events. Only
    // direct input or focus changes may hand control to the other pane.
    if (origin !== leader) return
    schedule()
  }
  const intent = (event: Event) => {
    leader = event.currentTarget as HTMLElement
    if (!syncScrolling) disarm()
  }
  const selection = (event?: Event) => {
    const focused = document.activeElement
    if (first.contains(focused)) leader = first
    else if (second.contains(focused)) leader = second
    else return
    if (syncScrolling) {
      schedule()
      return
    }
    const next = caret(leader)
    const changed = next && !sameCaret(next, previousCaret)
    previousCaret = next
    // Virtualized scrolls can rewrite the native selection without moving the caret.
    const deliberate =
      event instanceof Event && ['pointerup', 'focusin'].includes(event.type)
    if (!changed && !deliberate) return
    aligning = true
    guard()
    placed = null
    schedule()
  }
  // CodeMirror panes report caret and text changes, and focus leaving, as
  // hibi:editor-interactions-invalidate; only the focused view's report hands
  // control. Focus counts when it comes: their reports of focus are a moment
  // late, and the other pane scrolled in that moment keeps the lead. Nor does
  // a caret the view placed itself, as a long note's opening caret moves
  // once the formatted view parses its end.
  const edited = (event: Event) => {
    if (
      (event.target as Element).contains(document.activeElement) &&
      !(event as CustomEvent<{ placed?: boolean }>).detail?.placed
    )
      selection()
  }
  // Their selectionchange also fires when a view redraws an unchanged
  // selection, as after the other pane scrolls it, which hands no control.
  const nativeSelection = () => {
    const focused = document.activeElement
    if (focused && sourceView(focused)) return
    selection()
  }
  const click = (event: Event) => {
    if (event.target instanceof Element && event.target.closest('.cm-content'))
      selection(event)
  }
  const settled = () => {
    if (syncScrolling) schedule()
    else check()
  }
  const observer = new ResizeObserver(settled)
  // Virtualized table rows can arrive without changing the content's height.
  const drawn = new MutationObserver(settled)
  for (const pane of [first, second]) {
    pane.addEventListener('wheel', intent, { passive: true })
    pane.addEventListener('pointerdown', intent)
  }
  if (markdown) {
    const richContent = first.querySelector('.cm-content')
    if (!syncScrolling)
      for (const pane of [first, second])
        pane.addEventListener('pointerup', click)
    if (richContent) {
      observer.observe(richContent)
      drawn.observe(richContent, { childList: true, subtree: true })
    }
    const sourceContent = second.querySelector('.cm-content')
    if (sourceContent) observer.observe(sourceContent)
    document.addEventListener('selectionchange', nativeSelection)
    for (const pane of [first, second]) {
      pane.addEventListener('focusin', selection)
      // The report does not bubble.
      pane.addEventListener('hibi:editor-interactions-invalidate', edited, true)
    }
    first.addEventListener('hibi:source-layout', schedule)
  }
  first.addEventListener('scroll', scroll, { passive: true })
  second.addEventListener('scroll', scroll, { passive: true })
  // Widths settle during the view transition; new files are already at their final widths.
  first.addEventListener('transitionend', settled)
  sourcePane?.addEventListener('transitionend', settled)
  settled()
  return () => {
    unguard?.()
    cancelAnimationFrame(frame)
    observer.disconnect()
    drawn.disconnect()
    for (const pane of [first, second]) {
      pane.removeEventListener('wheel', intent)
      pane.removeEventListener('pointerdown', intent)
      pane.removeEventListener('pointerup', click)
      pane.removeEventListener('focusin', selection)
    }
    document.removeEventListener('selectionchange', nativeSelection)
    for (const pane of [first, second]) {
      pane.removeEventListener('focusin', selection)
      pane.removeEventListener(
        'hibi:editor-interactions-invalidate',
        edited,
        true,
      )
    }
    first.removeEventListener('hibi:source-layout', schedule)
    first.removeEventListener('scroll', scroll)
    second.removeEventListener('scroll', scroll)
    first.removeEventListener('transitionend', settled)
    sourcePane?.removeEventListener('transitionend', settled)
  }
}
