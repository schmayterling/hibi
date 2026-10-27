import type { EditorView } from '@codemirror/view'
import type { Editor } from '@tiptap/core'
import { type RefObject, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { MarkdownPositionLookup } from './markdown-positions'
import {
  editorPosition,
  sourceView as findSourceView,
  sourcePosition,
} from './source-view'

export function MirrorCursor({
  editor,
  root,
  content,
  active,
  positions,
}: {
  editor?: Editor | null
  root: RefObject<HTMLDivElement | null>
  content?: () => { source: string; body: string } | null
  active: boolean
  positions?: MarkdownPositionLookup
}) {
  const [position, setPosition] = useState<{
    pane: HTMLElement
    x: number
    y: number
    height: number
  } | null>(null)
  useEffect(() => {
    if (!active) {
      setPosition(null)
      return
    }
    let frame = 0
    const measure = () => {
      frame = 0
      if (editor?.isDestroyed) {
        setPosition(null)
        return
      }
      const focused = document.activeElement
      const sourceElement = root.current?.querySelector<HTMLElement>(
        '.source-pane .cm-content',
      )
      const sourceView = sourceElement && findSourceView(sourceElement)
      const richElement =
        editor?.view.dom ??
        root.current?.querySelector<HTMLElement>('.rich-pane .cm-content')
      const richView = richElement && findSourceView(richElement)
      const richFocus = focused === richElement
      const sourceFocus = focused === sourceElement
      if (
        !document.hasFocus() ||
        !sourceView ||
        (!editor && !richView) ||
        (!richFocus && !sourceFocus) ||
        (editor?.view.composing ?? richView?.compositionStarted) ||
        sourceView.compositionStarted ||
        (richFocus
          ? !(
              editor?.state.selection.empty ??
              richView?.state.selection.main.empty
            )
          : !sourceView.state.selection.main.empty)
      ) {
        setPosition(null)
        return
      }
      const pane = root.current?.querySelector<HTMLElement>(
        richFocus ? '.source-pane' : '.rich-pane',
      )
      if (!pane) {
        setPosition(null)
        return
      }
      let caret: ReturnType<EditorView['coordsAtPos']> = null
      if (editor) {
        const text = content?.()
        if (!text || !positions) {
          setPosition(null)
          return
        }
        const { source, body } = text
        const bodyOffset = source.lastIndexOf(body)
        if (
          bodyOffset < 0 ||
          (sourceFocus &&
            sourcePosition(sourceView, sourceView.state.selection.main.head) <
              bodyOffset)
        ) {
          setPosition(null)
          return
        }
        const map = positions(body, editor.state.doc)
        const target = map(
          richFocus
            ? editor.state.selection.head
            : sourcePosition(sourceView, sourceView.state.selection.main.head) -
                bodyOffset,
          richFocus ? 'rich' : 'source',
        )
        if (target !== null) {
          const sourceTarget = editorPosition(sourceView, target + bodyOffset)
          caret = richFocus
            ? sourceTarget === null
              ? null
              : sourceView.coordsAtPos(sourceTarget)
            : editor.view.coordsAtPos(target)
        }
      } else if (richView) {
        const from = richFocus ? richView : sourceView
        const to = richFocus ? sourceView : richView
        const target = editorPosition(
          to,
          sourcePosition(from, from.state.selection.main.head),
        )
        // Collapsed metadata and offscreen text have no secondary caret.
        if (
          target !== null &&
          to.visibleRanges.some(
            ({ from, to }) => target >= from && target <= to,
          )
        )
          caret = to.coordsAtPos(target)
      }
      const bounds = pane.getBoundingClientRect()
      if (
        !caret ||
        caret.top < bounds.top ||
        caret.bottom > bounds.bottom ||
        caret.left < bounds.left ||
        caret.left > bounds.right
      ) {
        setPosition(null)
        return
      }
      const next = {
        pane,
        x: caret.left - bounds.left + pane.scrollLeft,
        y: caret.top - bounds.top + pane.scrollTop,
        height: caret.bottom - caret.top,
      }
      setPosition((previous) =>
        previous?.pane === next.pane &&
        previous.x === next.x &&
        previous.y === next.y &&
        previous.height === next.height
          ? previous
          : next,
      )
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure)
    }
    const observer = new ResizeObserver(schedule)
    if (root.current) observer.observe(root.current)
    root.current?.querySelectorAll('.cm-content').forEach((element) => {
      observer.observe(element)
    })
    for (const event of [
      'selectionchange',
      'input',
      'focusin',
      'focusout',
      'compositionstart',
      'compositionend',
      'hibi:source-caret',
      'hibi:rich-content',
    ])
      document.addEventListener(event, schedule)
    document.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    editor?.on('transaction', schedule)
    schedule()
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      for (const event of [
        'selectionchange',
        'input',
        'focusin',
        'focusout',
        'compositionstart',
        'compositionend',
        'hibi:source-caret',
        'hibi:rich-content',
      ])
        document.removeEventListener(event, schedule)
      document.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
      editor?.off('transaction', schedule)
    }
  }, [active, editor, root, positions, content])
  return (
    position &&
    createPortal(
      <span
        aria-hidden="true"
        className="mirror-cursor"
        style={{
          transform: `translate(${position.x}px, ${position.y}px)`,
          height: position.height,
        }}
      />,
      position.pane,
    )
  )
}
