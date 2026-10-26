import type { Editor } from '@tiptap/core'
import type { MarkdownPositionLookup } from './markdown-positions'
import { editorPosition, sourcePosition, sourceView } from './source-view'

/** Markdown follows text positions; other preview formats keep proportional scrolling. */
export function linkScroll(
  first: HTMLElement,
  second: HTMLElement,
  initial: HTMLElement,
  markdown?:
    | {
        editor: Editor
        content: () => { source: string; body: string } | null
        positions: MarkdownPositionLookup
      }
    | 'source',
) {
  const editor = markdown && markdown !== 'source' ? markdown.editor : null
  if (editor?.isDestroyed) return () => {}
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
    let point = from.hasFocus ? from.coordsAtPos(position) : null
    if (!point || point.top < bounds.top || point.bottom > bounds.bottom) {
      position =
        from.posAtCoords({
          x: from.contentDOM.getBoundingClientRect().left + 8,
          y: bounds.top + bounds.height / 2,
        }) ?? position
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
  function anchoredTop(target: HTMLElement): number | null {
    if (markdown === 'source') return sourceTop(target)
    if (!markdown || markdown.editor.isDestroyed) return null
    const content = second.querySelector<HTMLElement>('.cm-content')
    const view = content && sourceView(content)
    if (!view) return null
    const editor = markdown.editor
    const text = markdown.content()
    if (!text) return null
    const offset = text.source.lastIndexOf(text.body)
    if (offset < 0) return null
    const map = markdown.positions(text.body, editor.state.doc)
    const bounds = leader.getBoundingClientRect()
    const visible = (point: { top: number; bottom: number } | null) =>
      point && point.top >= bounds.top && point.bottom <= bounds.bottom
    let position: number, point: { top: number; bottom: number } | null
    if (leader === second) {
      position = view.state.selection.main.head
      point = view.hasFocus ? view.coordsAtPos(position) : null
      if (!visible(point)) {
        position =
          view.posAtCoords({
            x: view.contentDOM.getBoundingClientRect().left + 8,
            y: bounds.top + bounds.height / 2,
          }) ?? position
        point = view.coordsAtPos(position)
      }
      position = sourcePosition(view, position)
      if (!point || position < offset) return null
      const mapped = map(position - offset, 'source')
      if (mapped === null) return null
      const destination = editor.view.coordsAtPos(mapped)
      return (
        target.scrollTop +
        (destination.top + destination.bottom - point.top - point.bottom) / 2
      )
    }
    position = editor.state.selection.head
    point = editor.view.hasFocus() ? editor.view.coordsAtPos(position) : null
    if (!visible(point)) {
      position =
        editor.view.posAtCoords({
          left: editor.view.dom.getBoundingClientRect().left + 8,
          top: bounds.top + bounds.height / 2,
        })?.pos ?? position
      point = editor.view.coordsAtPos(position)
    }
    const mapped = map(position, 'rich')
    if (mapped === null || !point) return null
    const at = editorPosition(view, mapped + offset)
    if (at === null) return null
    const destination = view.coordsAtPos(at)
    // Distant CodeMirror lines are virtualized. Estimate once, then refine after rendering.
    const y = destination
      ? (destination.top + destination.bottom) / 2
      : view.documentTop + view.lineBlockAt(at).top + view.defaultLineHeight / 2
    return target.scrollTop + y - (point.top + point.bottom) / 2
  }
  const sync = () => {
    frame = 0
    const target = leader === first ? second : first
    let top: number | null
    if (markdown) top = anchoredTop(target)
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
  const observer = new ResizeObserver(schedule)
  for (const pane of [first, second]) {
    pane.addEventListener('wheel', intent, { passive: true })
    pane.addEventListener('pointerdown', intent)
  }
  if (markdown) {
    const richContent = editor?.view.dom ?? first.querySelector('.cm-content')
    if (richContent) observer.observe(richContent)
    const sourceContent = second.querySelector('.cm-content')
    if (sourceContent) observer.observe(sourceContent)
    document.addEventListener('selectionchange', selection)
    document.addEventListener('hibi:rich-content', selection)
    first.addEventListener('hibi:source-caret', selection)
    second.addEventListener('hibi:source-caret', selection)
    editor?.on('transaction', selection)
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
    document.removeEventListener('selectionchange', selection)
    document.removeEventListener('hibi:rich-content', selection)
    first.removeEventListener('hibi:source-caret', selection)
    second.removeEventListener('hibi:source-caret', selection)
    editor?.off('transaction', selection)
    first.removeEventListener('scroll', scroll)
    second.removeEventListener('scroll', scroll)
    first.removeEventListener('transitionend', settled)
    sourcePane?.removeEventListener('transitionend', settled)
  }
}
