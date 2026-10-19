import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { sentenceCase } from '../shared/ui-case'
import { menus } from './menu-store'
import type { MenuApi } from './menus'
import './menus.css'

export function useMenus(onError: (error: unknown) => void): MenuApi {
  const error = useRef(onError)
  error.current = onError
  const scope = useRef<ReturnType<typeof menus.scope> | null>(null)
  useLayoutEffect(() => {
    scope.current = menus.scope((cause) => error.current(cause))
    return () => {
      scope.current?.dispose()
      scope.current = null
    }
  }, [])
  return {
    open: (options) => scope.current?.api.open(options) ?? { close() {} },
  }
}

export function MenuHost() {
  const open = useSyncExternalStore(menus.subscribe, menus.snapshot)
  const element = useRef<HTMLDivElement>(null)
  const last = useRef(open)
  if (open) last.current = open
  const menu = open ?? last.current
  useLayoutEffect(() => {
    const host = element.current
    if (!host) return
    if (!open) {
      if (host.matches(':popover-open')) host.hidePopover()
      return
    }
    host.showPopover()
    const bounds = host.getBoundingClientRect()
    host.style.left = `${Math.max(8, Math.min(open.x, innerWidth - bounds.width - 8))}px`
    host.style.top = `${Math.max(8, Math.min(open.y + 4, innerHeight - bounds.height - 8))}px`
    host.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [open])
  // Manual popovers skip native light dismiss, whose release check would close
  // a context menu that opened on button press (macOS and Linux).
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (!element.current?.contains(event.target as Node)) menus.close()
    }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [open])
  return createPortal(
    <div
      ref={element}
      popover="manual"
      role="menu"
      aria-label={menu?.label ?? 'Actions'}
      className="ui-menu"
      onToggle={(event) => {
        // A queued close from an earlier menu must not close its replacement.
        if (
          (event.nativeEvent as ToggleEvent).newState !== 'closed' ||
          event.currentTarget.matches(':popover-open')
        )
          return
        if (open) menus.close()
        if (
          document.activeElement === document.body ||
          element.current?.contains(document.activeElement)
        )
          menu?.anchor?.focus({ preventScroll: true })
      }}
      onKeyDown={(event) => {
        const items = [
          ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
            'button:not(:disabled)',
          ),
        ]
        const index = items.indexOf(document.activeElement as HTMLButtonElement)
        let next: number
        if (event.key === 'ArrowDown') next = (index + 1) % items.length
        else if (event.key === 'ArrowUp')
          next = (index - 1 + items.length) % items.length
        else if (event.key === 'Home') next = 0
        else if (event.key === 'End') next = items.length - 1
        else if (event.key === 'Escape' || event.key === 'Tab') {
          menus.close()
          return
        } else return
        event.preventDefault()
        items[next]?.focus()
      }}
    >
      {menu?.items.map((item) => {
        const Icon = item.icon
        return (
          <button
            role="menuitem"
            type="button"
            key={item.id}
            className="ui-menu-item"
            data-separator={item.separatorBefore}
            disabled={item.disabled}
            onClick={() => void item.onSelect()}
          >
            {Icon && <Icon size={15} aria-hidden={true} />}
            <span>{sentenceCase(item.label)}</span>
          </button>
        )
      })}
    </div>,
    document.body,
  )
}
