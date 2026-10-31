import { mappedPositionAt } from './native-dom-selection'
import { editorPosition, sourcePosition, sourceView } from './source-view'

/** Markdown follows text positions; other preview formats keep proportional scrolling. */
export function linkScroll(
  first: HTMLElement,
  second: HTMLElement,
  initial: HTMLElement,
  markdown?: 'source',
) {
  let leader = initial
  let frame = 0
  let refinements = 0
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
    const active = document.activeElement
    const focused =
      from.hasFocus ||
      (document.hasFocus() &&
        !!active?.classList.contains('cm-content') &&
        from.contentDOM.contains(active))
    let point = focused ? from.coordsAtPos(position) : null
    if (!point || point.top < bounds.top || point.bottom > bounds.bottom) {
      const x = from.contentDOM.getBoundingClientRect().left + 8
      const y = bounds.top + bounds.height / 2
      // posAtCoords gives a table's edges for a point in its cells.
      position =
        mappedPositionAt(from, x, y) ?? from.posAtCoords({ x, y }) ?? position
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
    const origin = event.currentTarget as HTMLElement
    // Virtualized source layout can emit several delayed scroll events. Only
    // direct input or focus changes may hand control to the other pane.
    if (origin !== leader) return
    schedule()
  }
  const intent = (event: Event) => {
    leader = event.currentTarget as HTMLElement
  }
  const selection = () => {
    const focused = document.activeElement
    if (first.contains(focused)) leader = first
    else if (second.contains(focused)) leader = second
    else return
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
  const observer = new ResizeObserver(schedule)
  for (const pane of [first, second]) {
    pane.addEventListener('wheel', intent, { passive: true })
    pane.addEventListener('pointerdown', intent)
  }
  if (markdown) {
    const richContent = first.querySelector('.cm-content')
    if (richContent) observer.observe(richContent)
    const sourceContent = second.querySelector('.cm-content')
    if (sourceContent) observer.observe(sourceContent)
    document.addEventListener('selectionchange', nativeSelection)
    first.addEventListener('hibi:source-caret', selection)
    second.addEventListener('hibi:source-caret', selection)
  }
  first.addEventListener('scroll', scroll, { passive: true })
  second.addEventListener('scroll', scroll, { passive: true })
  const settled = () => schedule()
  // Widths settle during the view transition; new files are already at their final widths.
  first.addEventListener('transitionend', settled)
  sourcePane?.addEventListener('transitionend', settled)
  schedule()
  return () => {
    cancelAnimationFrame(frame)
    observer.disconnect()
    for (const pane of [first, second]) {
      pane.removeEventListener('wheel', intent)
      pane.removeEventListener('pointerdown', intent)
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
