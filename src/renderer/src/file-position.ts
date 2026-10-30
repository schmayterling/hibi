import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import type { DocumentState } from '../../shared/desktop'
import type { DocumentView } from '../../shared/document-types'
import { editorPreferences, useEditorPreference } from './editor-preferences'
import type { OutlineRequest } from './OutlineSidebar'
import { sourceView } from './source-view'

type Pane = 'rich' | 'source'
type ScrollPosition = { top: number; left: number }
type FilePosition = {
  leader: Pane
  panes: Partial<Record<Pane, ScrollPosition>>
}

const key = 'hibi:file-positions'
const limit = 100
let positions: Map<string, FilePosition> | undefined
let writeTimer: ReturnType<typeof setTimeout> | undefined

function scrollPosition(value: unknown): ScrollPosition | null {
  if (
    !value ||
    typeof value !== 'object' ||
    !('top' in value) ||
    !('left' in value) ||
    typeof value.top !== 'number' ||
    typeof value.left !== 'number' ||
    !Number.isFinite(value.top) ||
    !Number.isFinite(value.left) ||
    value.top < 0 ||
    value.left < 0
  )
    return null
  return { top: value.top, left: value.left }
}

function filePosition(value: unknown): FilePosition | null {
  if (
    !value ||
    typeof value !== 'object' ||
    !('leader' in value) ||
    (value.leader !== 'rich' && value.leader !== 'source') ||
    !('panes' in value) ||
    !value.panes ||
    typeof value.panes !== 'object'
  )
    return null
  const rich = 'rich' in value.panes && scrollPosition(value.panes.rich)
  const source = 'source' in value.panes && scrollPosition(value.panes.source)
  const panes = { ...(rich && { rich }), ...(source && { source }) }
  return panes[value.leader] ? { leader: value.leader, panes } : null
}

function files() {
  if (positions) return positions
  positions = new Map()
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? '{}')
    if (value && typeof value === 'object' && !Array.isArray(value))
      for (const [id, entry] of Object.entries(value).slice(-limit)) {
        const position = filePosition(entry)
        if (id && position) positions.set(id, position)
      }
  } catch {}
  return positions
}

function flush() {
  if (writeTimer === undefined) return
  clearTimeout(writeTimer)
  writeTimer = undefined
  try {
    localStorage.setItem(key, JSON.stringify(Object.fromEntries(files())))
  } catch {}
}

function remember(id: string, pane: Pane, leader: Pane, element: HTMLElement) {
  const cache = files()
  const panes = {
    ...cache.get(id)?.panes,
    [pane]: {
      top: Math.max(0, element.scrollTop),
      left: Math.max(0, element.scrollLeft),
    },
  }
  cache.delete(id)
  cache.set(id, { leader: panes[leader] ? leader : pane, panes })
  if (cache.size > limit) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  clearTimeout(writeTimer)
  writeTimer = setTimeout(flush, 250)
}

export function useFilePosition({
  document,
  content,
  mode,
  ready,
  focused,
  outlineTarget,
}: {
  document: DocumentState
  content: RefObject<HTMLDivElement | null>
  mode: DocumentView
  ready: boolean
  focused: boolean
  outlineTarget: OutlineRequest | null
}) {
  const [enabled] = useEditorPreference(
    editorPreferences.rememberScrollPosition,
  )
  const fileId = document.canAutosave ? document.id : null
  const [opening] = useState(() => ({
    fileId,
    position: enabled && fileId ? files().get(fileId) : undefined,
    outlineTarget,
  }))
  const remembered = enabled && opening.fileId === fileId && !!opening.position
  const [restoring, setRestoring] = useState(remembered)
  const pending = useRef<'waiting' | 'measuring' | 'done'>(
    restoring ? 'waiting' : 'done',
  )
  const leader = useRef<Pane>(
    mode === 'side-by-side'
      ? (opening.position?.leader ?? 'rich')
      : mode === 'markdown'
        ? 'source'
        : 'rich',
  )
  const interacted = useRef(false)
  const finish = useCallback(() => {
    pending.current = 'done'
    setRestoring(false)
  }, [])
  const cancelRestore = useCallback(
    (pane: Pane) => {
      leader.current = pane
      finish()
    },
    [finish],
  )
  useLayoutEffect(() => {
    if (!remembered || outlineTarget !== opening.outlineTarget) finish()
  }, [remembered, outlineTarget, opening, finish])
  useLayoutEffect(() => {
    const root = content.current
    if (!root || !enabled || !fileId) return
    const element = (pane: Pane) =>
      root.querySelector<HTMLElement>(
        pane === 'rich' ? '.rich-pane' : '.source-pane .cm-scroller',
      )
    const visible = (pane: Pane) =>
      mode === 'side-by-side' ||
      pane === (mode === 'markdown' ? 'source' : 'rich')
    const capture = (pane: Pane) => {
      const scroller = element(pane)
      if (
        !focused ||
        !ready ||
        !visible(pane) ||
        !scroller?.isConnected ||
        !scroller.clientHeight
      )
        return
      if (pending.current !== 'done') return
      if (!scroller.scrollTop && !scroller.scrollLeft && !files().has(fileId))
        return
      if (mode !== 'side-by-side') leader.current = pane
      remember(fileId, pane, leader.current, scroller)
    }
    const scroll = (event: Event) => {
      for (const pane of ['rich', 'source'] as const)
        if (event.target === element(pane)) capture(pane)
    }
    const intent = (event: Event) => {
      if (!focused) return
      interacted.current = true
      const target = event.target
      if (target instanceof Element && root.contains(target))
        leader.current = target.closest('.source-pane') ? 'source' : 'rich'
      finish()
    }
    const focus = (event: Event) => {
      if (pending.current !== 'done' || !interacted.current) return
      intent(event)
      capture(leader.current)
    }
    root.addEventListener('scroll', scroll, true)
    root.addEventListener('focusin', focus)
    for (const type of ['pointerdown', 'wheel', 'keydown', 'beforeinput'])
      window.addEventListener(type, intent, { capture: true, passive: true })
    const pagehide = () => flush()
    window.addEventListener('pagehide', pagehide)
    if (
      pending.current === 'done' &&
      (interacted.current || fileId !== opening.fileId)
    )
      for (const pane of ['rich', 'source'] as const) capture(pane)
    return () => {
      root.removeEventListener('scroll', scroll, true)
      root.removeEventListener('focusin', focus)
      for (const type of ['pointerdown', 'wheel', 'keydown', 'beforeinput'])
        window.removeEventListener(type, intent, true)
      window.removeEventListener('pagehide', pagehide)
      flush()
    }
  }, [content, enabled, fileId, mode, ready, focused, opening, finish])
  useEffect(() => {
    const position = opening.position
    const root = content.current
    if (!restoring || !remembered || !ready || !focused || !position || !root)
      return
    let stopped = false
    let frame = 0
    void window.document.fonts.ready.then(() => {
      if (stopped) return
      frame = requestAnimationFrame(() => {
        if (pending.current === 'done' || !root.isConnected) return
        pending.current = 'measuring'
        const panes = (['rich', 'source'] as const).flatMap((pane) => {
          if (mode === 'normal' && pane === 'source') return []
          if (mode === 'markdown' && pane === 'rich') return []
          const saved = position.panes[pane]
          const scroller = root.querySelector<HTMLElement>(
            pane === 'rich' ? '.rich-pane' : '.source-pane .cm-scroller',
          )
          return saved && scroller?.clientHeight ? [{ saved, scroller }] : []
        })
        const apply = () => {
          for (const { scroller, saved } of panes) {
            scroller.scrollTop = saved.top
            scroller.scrollLeft = saved.left
          }
        }
        apply()
        const views = panes.flatMap(({ scroller }) => {
          const element = scroller.querySelector('.cm-content')
          const view = element && sourceView(element)
          return view ? [view] : []
        })
        let measurements = views.length
        if (!measurements) finish()
        for (const view of views)
          view.requestMeasure({
            read: () => null,
            write: () => {
              if (--measurements) return
              // CodeMirror anchors scroll after measure writes, so correct once next frame.
              frame = requestAnimationFrame(() => {
                if (stopped || pending.current !== 'measuring') return
                apply()
                finish()
              })
            },
          })
      })
    })
    return () => {
      stopped = true
      cancelAnimationFrame(frame)
    }
  }, [content, opening, mode, ready, focused, remembered, restoring, finish])
  return {
    remembered,
    restoring,
    leader: remembered ? leader.current : null,
    cancelRestore,
  }
}
