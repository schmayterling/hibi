import type { EditorView } from '@codemirror/view'
import { focusedEditor, mappedPositionAt } from './native-dom-selection'
import { inOwnScroll, ownScroll } from './own-scroll'
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
  let placed: {
    caret: ReturnType<typeof caret>
    leader: Place
    target: Place
  } | null = null
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
    return { caret: caret(leader), leader: from, target: to }
  }
  const record = () => {
    if (!syncScrolling && aligning) placed = measure()
  }
  // A script scrolling a pane ends the alignment where it writes. Hibi's own
  // corrections write inside ownScroll, as do the panes' views measuring and
  // focusing, which keep their place; the browser's anchoring writes nothing.
  let unguard: (() => void) | null = null
  const guard = () => {
    if (syncScrolling || unguard) return
    const scrollTop = Object.getOwnPropertyDescriptor(
      Element.prototype,
      'scrollTop',
    )
    if (!scrollTop?.get || !scrollTop.set) return
    const { get, set } = scrollTop
    const foreign = () => {
      if (!inOwnScroll()) disarm()
    }
    const undo: (() => void)[] = []
    for (const pane of [first, second]) {
      Object.defineProperty(pane, 'scrollTop', {
        configurable: true,
        get() {
          return get.call(this)
        },
        set(value: number) {
          foreign()
          set.call(this, value)
        },
      })
      for (const name of ['scroll', 'scrollTo', 'scrollBy'] as const) {
        const method = Element.prototype[name] as (...args: unknown[]) => void
        Object.defineProperty(pane, name, {
          configurable: true,
          writable: true,
          value(this: Element, ...args: unknown[]) {
            foreign()
            method.apply(this, args)
          },
        })
      }
      undo.push(() => {
        for (const name of ['scrollTop', 'scroll', 'scrollTo', 'scrollBy'])
          delete (pane as unknown as Record<string, unknown>)[name]
      })
      const content = pane.querySelector('.cm-content')
      const view = content && sourceView(content)
      if (!view) continue
      for (const name of ['measure', 'focus'] as const) {
        // ponytail: measure is the view's own entry to its measure pass, not
        // public API; the source-anchor test fails if the view stops calling it.
        const method = (
          view as unknown as Record<string, (...args: unknown[]) => void>
        )[name]
        if (!method) continue
        Object.defineProperty(view, name, {
          configurable: true,
          writable: true,
          value(this: EditorView, ...args: unknown[]) {
            return ownScroll(() => method.apply(this, args))
          },
        })
        undo.push(() => {
          delete (view as unknown as Record<string, unknown>)[name]
        })
      }
    }
    unguard = () => {
      unguard = null
      for (const step of undo) step()
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
  /** Realigns after layout under the aligned lines; ends on a scroll. */
  const check = () => {
    const was = placed
    if (!aligning || !was) return
    const now = measure()
    // A caret moved since, as a view scrolling to show it, aligns anew.
    if (!now || !sameCaret(now.caret, was.caret)) return schedule()
    const panes = ['leader', 'target'] as const
    // Layout reaches the drawn line at once and the height map at the view's
    // next measure, which can scroll to keep its place: either counts.
    const shifted = (a: Place, b: Place) =>
      moved(a.line, b.line)
    if (panes.some((pane) => shifted(now[pane], was[pane]))) schedule()
    else if (panes.some((pane) => moved(now[pane].top, was[pane].top))) disarm()
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
