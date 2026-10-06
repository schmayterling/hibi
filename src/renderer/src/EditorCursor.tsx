import { type CSSProperties, type RefObject, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { sourceView } from './source-view'

export type CursorSettings = {
  style: 'bar' | 'outline' | 'block' | 'underline'
  speed: 'fast' | 'normal' | 'slow'
  animation: 'smooth' | 'blink'
}
export const defaultCursor: CursorSettings = {
  style: 'bar',
  speed: 'normal',
  animation: 'blink',
}
export function loadCursor(): CursorSettings {
  try {
    const saved = JSON.parse(
      localStorage.getItem('cursor-settings') ?? '{}',
    ) as Partial<CursorSettings>
    return {
      style: ['bar', 'outline', 'block', 'underline'].includes(
        saved.style ?? '',
      )
        ? (saved.style as CursorSettings['style'])
        : 'bar',
      speed: ['fast', 'normal', 'slow'].includes(saved.speed ?? '')
        ? (saved.speed as CursorSettings['speed'])
        : 'normal',
      animation: ['smooth', 'blink'].includes(saved.animation ?? '')
        ? (saved.animation as CursorSettings['animation'])
        : 'blink',
    }
  } catch {
    return defaultCursor
  }
}

type Position = {
  pane: HTMLElement
  x: number
  cellX: number
  y: number
  width: number
  height: number
  move: boolean
}

export function EditorCursor({
  root,
  settings,
}: {
  root: RefObject<HTMLDivElement | null>
  settings: CursorSettings
}) {
  const [position, setPosition] = useState<Position | null>(null)
  useEffect(() => {
    let frame = 0
    let move = true
    let composing = false
    let observed: Element | null = null
    const observer = new ResizeObserver(() => schedule(false))
    function measure() {
      frame = 0
      const active = document.activeElement
      const selection = document.getSelection()
      if (
        composing ||
        !document.hasFocus() ||
        !(active instanceof HTMLElement) ||
        !active.isContentEditable ||
        !root.current?.contains(active) ||
        !selection?.isCollapsed ||
        !selection.rangeCount
      ) {
        setPosition(null)
        return
      }
      if (active !== observed) {
        observer.disconnect()
        observer.observe(active)
        observed = active
      }
      const range = selection.getRangeAt(0)
      if (!active.contains(range.startContainer)) {
        setPosition(null)
        return
      }
      const anchor =
        range.startContainer instanceof Element
          ? range.startContainer
          : range.startContainer.parentElement
      if (!anchor) return
      let rect = range.getBoundingClientRect()
      if (!rect.height && range.startContainer instanceof Element) {
        // Empty paragraphs have no range box; the line break carries the font baseline.
        // After exiting final formatting, the caret follows the empty placeholder.
        const { childNodes } = range.startContainer
        const child = childNodes[range.startOffset]
        const before = childNodes[range.startOffset - 1]
        if (child instanceof HTMLBRElement) rect = child.getBoundingClientRect()
        else if (
          before instanceof HTMLElement &&
          before.classList.contains('mark-exit')
        ) {
          const box = before.getBoundingClientRect()
          rect = new DOMRect(box.right, box.top, 0, box.height)
        }
      }
      const fallback = anchor.getBoundingClientRect()
      const fontSize = Number.parseFloat(getComputedStyle(anchor).fontSize)
      const source = active.classList.contains('cm-content')
        ? sourceView(active)
        : null
      // DOM ranges around CodeMirror's empty-line placeholder have line-box
      // geometry, not caret geometry. Let the editor resolve its own position.
      const sourceCaret = source?.coordsAtPos(source.state.selection.main.head)
      if (source && (!source.state.selection.main.empty || !sourceCaret)) {
        setPosition(null)
        return
      }
      const x = sourceCaret?.left ?? (rect.height ? rect.left : fallback.left)
      const y = sourceCaret?.top ?? (rect.height ? rect.top : fallback.top)
      const height = sourceCaret
        ? sourceCaret.bottom - sourceCaret.top
        : rect.height || fontSize * 1.2
      const paneElement = active.closest<HTMLElement>(
        '.rich-pane, .source-pane',
      )
      const pane = paneElement?.getBoundingClientRect()
      if (
        !pane ||
        !paneElement ||
        y < pane.top ||
        y + height > pane.bottom ||
        x < pane.left ||
        x > pane.right
      ) {
        setPosition(null)
        return
      }
      let width = source?.defaultCharacterWidth ?? fontSize * 0.6
      let cellX = x
      if (
        !source &&
        range.startContainer.nodeType === Node.TEXT_NODE &&
        range.startOffset < (range.startContainer.textContent?.length ?? 0)
      ) {
        const cell = range.cloneRange()
        const length =
          (range.startContainer.textContent?.codePointAt(range.startOffset) ??
            0) > 0xffff
            ? 2
            : 1
        cell.setEnd(range.startContainer, range.startOffset + length)
        const bounds = cell.getBoundingClientRect()
        if (Math.abs(bounds.top - y) < 2 && bounds.width) {
          width = bounds.width
          cellX = bounds.left
        }
      }
      setPosition({
        pane: paneElement,
        x: x - pane.left + paneElement.scrollLeft,
        cellX: cellX - pane.left + paneElement.scrollLeft,
        y: y - pane.top + paneElement.scrollTop,
        width,
        height,
        move,
      })
    }
    function schedule(animate = true) {
      move = frame ? move && animate : animate
      if (!frame) frame = requestAnimationFrame(measure)
    }
    const update = () => schedule()
    const reposition = () => schedule(false)
    const compositionStart = () => {
      composing = true
      setPosition(null)
    }
    const compositionEnd = () => {
      composing = false
      schedule(false)
    }
    for (const event of ['selectionchange', 'input', 'focusin', 'focusout'])
      document.addEventListener(event, update)
    document.addEventListener('scroll', reposition, true)
    document.addEventListener('compositionstart', compositionStart)
    document.addEventListener('compositionend', compositionEnd)
    window.addEventListener('resize', reposition)
    window.addEventListener('blur', update)
    window.addEventListener('focus', update)
    schedule(false)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      for (const event of ['selectionchange', 'input', 'focusin', 'focusout'])
        document.removeEventListener(event, update)
      document.removeEventListener('scroll', reposition, true)
      document.removeEventListener('compositionstart', compositionStart)
      document.removeEventListener('compositionend', compositionEnd)
      window.removeEventListener('resize', reposition)
      window.removeEventListener('blur', update)
      window.removeEventListener('focus', update)
    }
  }, [root])
  if (!position) return null
  return createPortal(
    <span
      className="editor-cursor"
      aria-hidden="true"
      data-style={settings.style}
      data-animation={settings.animation}
      data-move={settings.animation === 'smooth' && position.move}
      style={
        {
          transform: `translate3d(${settings.style === 'bar' ? position.x : position.cellX}px, ${position.y}px, 0)`,
          width: position.width,
          height: position.height,
          '--cursor-duration': `${{ fast: 600, normal: 1000, slow: 1600 }[settings.speed]}ms`,
        } as CSSProperties
      }
    />,
    position.pane,
  )
}
