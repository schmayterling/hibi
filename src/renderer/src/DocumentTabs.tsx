import { X } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import type { DocumentState } from '../../shared/desktop'
import { IconButton } from '../../ui/Controls'
import type { MenuApi } from '../../ui/menus'

export function DocumentTabs({
  document,
  busy,
  onSelect,
  onClose,
  onCloseTabs,
  onMove,
  menus,
}: {
  document: DocumentState
  busy: boolean
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onCloseTabs: (ids: string[], preferredTab: string) => void
  onMove: (id: string, beforeId: string | null) => void
  menus: MenuApi
}) {
  const strip = useRef<HTMLDivElement>(null)
  const active = useRef<HTMLDivElement>(null)
  const positions = useRef(new Map<string, number>())
  const wasClosing = useRef(false)
  const dragged = useRef<string | null>(null)
  const keyboardFocus = useRef<string | null>(null)
  const [drop, setDrop] = useState<{
    id: string
    side: 'before' | 'after'
  } | null>(null)
  const [rendered, setRendered] = useState(document.tabs)
  const tabIds = document.tabs.map((tab) => tab.id).join(',')
  useLayoutEffect(() => {
    setRendered((previous) => {
      const next = [...document.tabs]
      previous.forEach((tab, index) => {
        if (!document.tabs.some((current) => current.id === tab.id))
          next.splice(Math.min(index, next.length), 0, tab)
      })
      return next
    })
  }, [document.tabs])
  useEffect(() => {
    const ids = new Set(tabIds.split(','))
    const timer = setTimeout(
      () => setRendered((tabs) => tabs.filter((tab) => ids.has(tab.id))),
      matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 200,
    )
    return () => clearTimeout(timer)
  }, [tabIds])
  const revealActive = useCallback(() => {
    const container = strip.current,
      tab = active.current
    if (!container || !tab) return
    const left = tab.offsetLeft,
      right = left + tab.offsetWidth
    const target =
      left < container.scrollLeft
        ? left
        : right > container.scrollLeft + container.clientWidth
          ? right - container.clientWidth
          : container.scrollLeft
    container.scrollTo({
      left: target,
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'instant'
        : 'smooth',
    })
  }, [])
  useLayoutEffect(() => {
    const container = strip.current
    if (!container) return
    const resize = new ResizeObserver(revealActive)
    resize.observe(container)
    return () => resize.disconnect()
  }, [revealActive])
  // biome-ignore lint/correctness/useExhaustiveDependencies: reveal after the retained tab list is mounted, selected, resized, or renamed.
  useLayoutEffect(() => {
    const next = new Map<string, number>()
    const closing = !!strip.current?.querySelector('[data-closing="true"]')
    for (const tab of strip.current?.querySelectorAll<HTMLElement>(
      '[data-tab-key]',
    ) ?? []) {
      const id = tab.dataset.tabKey!
      const previous = positions.current.get(id)
      const left = tab.offsetLeft
      if (tab.dataset.closing !== 'true')
        tab.style.setProperty('--tab-width', `${tab.offsetWidth}px`)
      next.set(id, left)
      if (
        previous !== undefined &&
        previous !== left &&
        !closing &&
        !wasClosing.current &&
        !matchMedia('(prefers-reduced-motion: reduce)').matches
      ) {
        tab.animate(
          [{ translate: `${previous - left}px` }, { translate: '0px' }],
          { duration: 180, easing: 'ease-out' },
        )
      }
    }
    positions.current = next
    wasClosing.current = closing
    if (keyboardFocus.current) {
      if (
        window.document.activeElement === window.document.body ||
        strip.current?.contains(window.document.activeElement)
      )
        strip.current
          ?.querySelector<HTMLButtonElement>(
            `[data-tab-id="${keyboardFocus.current}"]`,
          )
          ?.focus({ preventScroll: true })
      keyboardFocus.current = null
    }
    revealActive()
  }, [rendered, document.tabId, document.name, document.dirty])
  return (
    <div
      className="document-tabs"
      ref={strip}
      role="tablist"
      aria-label="Open documents"
      aria-description="Drag to reorder tabs, or use Alt+Shift+Left or Right on a focused tab."
      onKeyDown={(event) => {
        if (
          busy ||
          !(event.target instanceof HTMLElement) ||
          event.target.getAttribute('role') !== 'tab'
        )
          return
        const focusedId = event.target.getAttribute('data-tab-id')
        const index = document.tabs.findIndex((tab) => tab.id === focusedId)
        if (
          event.altKey &&
          event.shiftKey &&
          ['ArrowLeft', 'ArrowRight'].includes(event.key)
        ) {
          event.preventDefault()
          event.stopPropagation()
          const tab = document.tabs[index]
          if (!tab) return
          if (event.key === 'ArrowLeft' && index > 0) {
            keyboardFocus.current = tab.id
            onMove(tab.id, document.tabs[index - 1]!.id)
          } else if (
            event.key === 'ArrowRight' &&
            index < document.tabs.length - 1
          ) {
            keyboardFocus.current = tab.id
            onMove(tab.id, document.tabs[index + 2]?.id ?? null)
          }
          return
        }
        const last = document.tabs.length - 1
        const next =
          event.key === 'ArrowRight'
            ? (index + 1) % (last + 1)
            : event.key === 'ArrowLeft'
              ? (index + last) % (last + 1)
              : event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? last
                  : null
        if (next !== null) {
          event.preventDefault()
          const tab = document.tabs[next]
          if (tab) {
            onSelect(tab.id)
            event.currentTarget
              .querySelector<HTMLButtonElement>(`[data-tab-id="${tab.id}"]`)
              ?.focus({ preventScroll: true })
          }
        }
      }}
    >
      {rendered.map((tab) => {
        const closing = !document.tabs.some((current) => current.id === tab.id)
        const selected = tab.id === document.tabId
        const name = selected ? document.name : tab.name
        const dirty = selected ? document.dirty : tab.dirty
        return (
          // biome-ignore lint/a11y/noStaticElementInteractions: tab dragging has equivalent keyboard shortcuts.
          <div
            className="document-tab"
            key={tab.id}
            data-active={selected}
            data-closing={closing}
            data-tab-key={tab.id}
            data-drop-side={drop?.id === tab.id ? drop.side : undefined}
            ref={selected ? active : undefined}
            draggable={!busy && !closing}
            onDragStart={(event) => {
              dragged.current = tab.id
              event.dataTransfer.setData('application/x-hibi-tab', tab.id)
              event.dataTransfer.effectAllowed = 'move'
            }}
            onDragEnd={() => {
              dragged.current = null
              setDrop(null)
            }}
            onDragOver={(event) => {
              if (!dragged.current || busy || closing) return
              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'
              const bounds = event.currentTarget.getBoundingClientRect()
              const side =
                event.clientX > bounds.x + bounds.width / 2 ? 'after' : 'before'
              setDrop((old) =>
                old?.id === tab.id && old.side === side
                  ? old
                  : { id: tab.id, side },
              )
              const container = strip.current
              if (container) {
                const bounds = container.getBoundingClientRect()
                if (event.clientX < bounds.left + 24)
                  container.scrollBy({ left: -24, behavior: 'instant' })
                else if (event.clientX > bounds.right - 24)
                  container.scrollBy({ left: 24, behavior: 'instant' })
              }
            }}
            onDrop={(event) => {
              const id = dragged.current
              if (!id || busy || closing) return
              event.preventDefault()
              const bounds = event.currentTarget.getBoundingClientRect()
              const index = document.tabs.findIndex(
                (current) => current.id === tab.id,
              )
              const beforeId =
                event.clientX > bounds.x + bounds.width / 2
                  ? (document.tabs[index + 1]?.id ?? null)
                  : tab.id
              dragged.current = null
              setDrop(null)
              if (id !== beforeId) onMove(id, beforeId)
            }}
            inert={closing}
            aria-hidden={closing}
            onAnimationEnd={(event) => {
              if (closing && event.target === event.currentTarget)
                setRendered((tabs) => tabs.filter((item) => item.id !== tab.id))
            }}
          >
            <button
              type="button"
              role="tab"
              id={`document-tab-${tab.id}`}
              aria-controls="document-editor-panel"
              className="document-name"
              data-tab-id={tab.id}
              aria-label={name}
              aria-selected={selected}
              aria-description={dirty ? 'Unsaved changes' : undefined}
              aria-disabled={busy}
              tabIndex={selected ? 0 : -1}
              data-tooltip={name}
              data-verbatim="true"
              onMouseDown={(event) => {
                if (event.button === 0)
                  event.currentTarget.focus({ preventScroll: true })
              }}
              onContextMenu={(event) => {
                event.preventDefault()
                if (busy || closing) return
                event.currentTarget.focus({ preventScroll: true })
                const index = document.tabs.findIndex(
                  (current) => current.id === tab.id,
                )
                if (index < 0) return
                const left = document.tabs
                  .slice(0, index)
                  .map((item) => item.id)
                const right = document.tabs
                  .slice(index + 1)
                  .map((item) => item.id)
                menus.open({
                  label: 'Tab actions',
                  anchor: { x: event.clientX, y: event.clientY },
                  items: [
                    {
                      id: 'close',
                      label: 'Close tab',
                      onSelect: () => onClose(tab.id),
                    },
                    {
                      id: 'close-others',
                      label: 'Close other tabs',
                      disabled: document.tabs.length === 1,
                      separatorBefore: true,
                      onSelect: () =>
                        onCloseTabs(
                          document.tabs
                            .filter((item) => item.id !== tab.id)
                            .map((item) => item.id),
                          tab.id,
                        ),
                    },
                    {
                      id: 'close-right',
                      label: 'Close tabs to the right',
                      disabled: right.length === 0,
                      onSelect: () => onCloseTabs(right, tab.id),
                    },
                    {
                      id: 'close-left',
                      label: 'Close tabs to the left',
                      disabled: left.length === 0,
                      onSelect: () => onCloseTabs(left, tab.id),
                    },
                  ],
                })
              }}
              onClick={() => {
                if (!busy && !selected) onSelect(tab.id)
              }}
            >
              <span>{name}</span>
              {dirty && (
                <span
                  className="dirty-dot"
                  role="status"
                  aria-label={
                    selected ? 'Unsaved changes' : `Unsaved changes in ${name}`
                  }
                >
                  •
                </span>
              )}
            </button>
            <IconButton
              className="tab-close"
              aria-label={`Close ${name}`}
              title="Close tab"
              disabled={busy}
              onClick={() => onClose(tab.id)}
            >
              <X size={12} />
            </IconButton>
          </div>
        )
      })}
    </div>
  )
}
