import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import type { DocumentView } from '../../shared/document-types'

/**
 * Keep source focus and pane transitions identical across editor surfaces.
 * With `releaseSource`, leaving the source view unmounts it, so a large
 * note's text is not held twice while only the other view shows it.
 */
export function useEditorPanes(
  mode: DocumentView,
  markdownDocument: boolean,
  sourceFirst = false,
  releaseSource = false,
) {
  const [focusedPane, setFocusedPane] = useState<'rich' | 'source'>('rich')
  const [sourceMounted, setSourceMounted] = useState(mode !== 'normal')
  const [sourceReady, setSourceReady] = useState(false)
  const [sourceSettled, setSourceSettled] = useState(false)
  const [initialMode] = useState(mode)
  // Only the first opening from normal view waits for source layout.
  const paneMode =
    sourceFirst || sourceSettled || initialMode !== 'normal' ? mode : 'normal'
  const content = useRef<HTMLDivElement>(null)
  const previousFocusMode = useRef(mode)
  const focusOwner = useRef<Element | null>(window.document.activeElement)
  const focusIntent = useRef(0)
  const modeFocusIntent = useRef(0)
  useLayoutEffect(() => {
    const recordIntent = () => focusIntent.current++
    window.document.addEventListener('pointerdown', recordIntent, true)
    window.document.addEventListener('focusin', recordIntent, true)
    return () => {
      window.document.removeEventListener('pointerdown', recordIntent, true)
      window.document.removeEventListener('focusin', recordIntent, true)
    }
  }, [])
  useLayoutEffect(() => {
    if (previousFocusMode.current === mode) return
    previousFocusMode.current = mode
    focusOwner.current = window.document.activeElement
    modeFocusIntent.current = focusIntent.current
  }, [mode])
  const focusOwnedByEditor = useCallback(() => {
    const active = window.document.activeElement
    return (
      focusIntent.current === modeFocusIntent.current &&
      !active?.closest(
        '.settings-screen, [role="dialog"], input, textarea, select',
      ) &&
      (active === window.document.body ||
        (content.current?.contains(active) &&
          active?.matches('.tiptap, .cm-content')) ||
        (active !== null && active === focusOwner.current))
    )
  }, [])
  useEffect(() => {
    if (
      sourceReady &&
      paneMode === mode &&
      (mode === 'markdown' || (!markdownDocument && mode !== 'normal'))
    ) {
      const ownsFocus = focusOwnedByEditor()
      if (!ownsFocus) {
        focusOwner.current = null
        return
      }
      setFocusedPane('source')
      const source = content.current?.querySelector<HTMLElement>(
        '.source-pane .cm-content',
      )
      if (source !== window.document.activeElement) source?.focus()
      if (source === window.document.activeElement) focusOwner.current = null
    }
  }, [markdownDocument, sourceReady, paneMode, mode, focusOwnedByEditor])
  const previousMode = useRef(paneMode)
  useLayoutEffect(() => {
    if (previousMode.current === paneMode) return
    previousMode.current = paneMode
    const element = content.current
    if (!element) return
    const opacity = Number(getComputedStyle(element).opacity)
    for (const animation of element.getAnimations()) animation.cancel()
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const duration = getComputedStyle(element)
      .getPropertyValue('--motion-feedback')
      .trim()
    element.animate(
      [
        { opacity, offset: 0 },
        { opacity: 0, offset: 0.25 },
        { opacity: 0, offset: 0.625 },
        { opacity: 1, offset: 1 },
      ],
      {
        duration:
          Number.parseFloat(duration) * (duration.endsWith('ms') ? 1 : 1000) ||
          160,
      },
    )
  }, [paneMode])
  useEffect(() => {
    if (mode !== 'normal') setSourceMounted(true)
    else if (releaseSource && paneMode === 'normal') {
      setSourceMounted(false)
      setSourceReady(false)
      setSourceSettled(false)
    }
  }, [mode, paneMode, releaseSource])
  return {
    content,
    paneMode,
    focusedPane,
    setFocusedPane,
    sourceMounted,
    sourceReady,
    setSourceReady,
    setSourceSettled,
    focusOwnedByEditor,
  }
}
