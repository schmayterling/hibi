import { focusedEditor, mappedPositionAt } from './native-dom-selection'
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
    const block = to.lineBlockAt(at)
    if (!block.height) return null
    const destination = to.coordsAtPos(at)
    const y = destination
      ? (destination.top + destination.bottom) / 2
      : to.documentTop + block.top + to.defaultLineHeight / 2
    return target.scrollTop + y - (point.top + point.bottom) / 2
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
    if (Math.abs(target.scrollTop - clamped) < 1) return
    target.scrollTop = clamped
    if (markdown && refinements++ < 3) frame = requestAnimationFrame(sync)
  }
  const schedule = () => {
    cancelAnimationFrame(frame)
    refinements = 0
    frame = requestAnimationFrame(sync)
  }
  const scroll = (event: Event) => {
    if (!syncScrolling) return
    const origin = event.currentTarget as HTMLElement
    // Virtualized source layout can emit several delayed scroll events. Only
    // direct input or focus changes may hand control to the other pane.
    if (origin !== leader) return
    schedule()
  }
  const intent = (event: Event) => {
    leader = event.currentTarget as HTMLElement
    if (!syncScrolling) {
      cancelAnimationFrame(frame)
      frame = 0
    }
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
    const changed =
      next &&
      (next.pane !== previousCaret?.pane ||
        next.doc !== previousCaret?.doc ||
        next.mirrorDoc !== previousCaret?.mirrorDoc ||
        next.anchor !== previousCaret?.anchor ||
        next.head !== previousCaret?.head)
    previousCaret = next
    // Virtualized scrolls can rewrite the native selection without moving the caret.
    const deliberate =
      event instanceof Event && ['pointerup', 'focusin'].includes(event.type)
    if (!changed && !deliberate) return
    schedule()
  }
  // CodeMirror panes report caret and focus changes as hibi:source-caret.
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
  }
  const observer = new ResizeObserver(settled)
  for (const pane of [first, second]) {
    pane.addEventListener('wheel', intent, { passive: true })
    pane.addEventListener('pointerdown', intent)
  }
  if (markdown) {
    const richContent = first.querySelector('.cm-content')
    if (!syncScrolling)
      for (const pane of [first, second]) {
        pane.addEventListener('pointerup', click)
        pane.addEventListener('focusin', selection)
      }
    if (richContent) observer.observe(richContent)
    const sourceContent = second.querySelector('.cm-content')
    if (sourceContent) observer.observe(sourceContent)
    document.addEventListener('selectionchange', nativeSelection)
    first.addEventListener('hibi:source-caret', selection)
    second.addEventListener('hibi:source-caret', selection)
  }
  first.addEventListener('scroll', scroll, { passive: true })
  second.addEventListener('scroll', scroll, { passive: true })
  // Widths settle during the view transition; new files are already at their final widths.
  first.addEventListener('transitionend', settled)
  sourcePane?.addEventListener('transitionend', settled)
  settled()
  return () => {
    cancelAnimationFrame(frame)
    observer.disconnect()
    for (const pane of [first, second]) {
      pane.removeEventListener('wheel', intent)
      pane.removeEventListener('pointerdown', intent)
      pane.removeEventListener('pointerup', click)
      pane.removeEventListener('focusin', selection)
    }
    document.removeEventListener('selectionchange', nativeSelection)
    first.removeEventListener('hibi:source-caret', selection)
    second.removeEventListener('hibi:source-caret', selection)
    first.removeEventListener('scroll', scroll)
    second.removeEventListener('scroll', scroll)
    first.removeEventListener('transitionend', settled)
    sourcePane?.removeEventListener('transitionend', settled)
  }
}
