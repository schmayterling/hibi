import type {
  EditorContextAction,
  EditorHover,
  EditorInteractionRequest,
} from '../../shared/editor-interactions'
import {
  contextActionBroker,
  hoverBroker,
  sameInteraction,
} from './editor-interaction-broker'

type Adapter = {
  element: HTMLElement
  positionAt: (x: number, y: number) => number | null
  anchorAt: (
    position: number,
  ) => { left: number; top: number; bottom: number } | null
  selectionPosition: () => number | null
  capture: (position: number) => EditorInteractionRequest | null
  apply: (
    action: EditorContextAction,
    request: EditorInteractionRequest,
  ) => boolean
  focus: () => void
}

function panel(role: string, label: string) {
  const element = document.createElement('div')
  element.popover = 'manual'
  element.setAttribute('role', role)
  element.setAttribute('aria-label', label)
  element.className = 'command-results'
  Object.assign(element.style, {
    position: 'fixed',
    inset: 'auto',
    margin: '0',
    width: 'min(320px, calc(100vw - 16px))',
    maxHeight: 'min(308px, calc(100vh - 16px))',
    overflowY: 'auto',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-popover)',
    background: 'var(--background)',
    color: 'var(--ink)',
    fontFamily: 'var(--font-ui)',
    fontSize: 'var(--text-ui)',
  })
  document.body.append(element)
  return element
}

function place(element: HTMLElement, x: number, y: number) {
  const bounds = element.getBoundingClientRect()
  element.style.left = `${Math.max(8, Math.min(x, innerWidth - bounds.width - 8))}px`
  element.style.top = `${Math.max(8, Math.min(y, innerHeight - bounds.height - 8))}px`
}

function copy(label: string, detail?: string) {
  const entry = document.createElement('span')
  entry.className = 'command-copy'
  const title = document.createElement('span')
  title.className = 'command-label'
  title.textContent = label
  entry.append(title)
  if (detail) {
    const description = document.createElement('span')
    description.className = 'command-detail'
    description.textContent = detail
    entry.append(description)
  }
  return entry
}

export function attachEditorInteractions(adapter: Adapter) {
  const hover = panel('tooltip', 'Editor hover')
  const menu = panel('menu', 'Editor actions')
  let hoverTimer: ReturnType<typeof setTimeout> | null = null
  let hoverCancel: (() => void) | null = null
  let actionCancel: (() => void) | null = null
  let hoveredPosition: number | null = null
  let shown: {
    request: EditorInteractionRequest
    items: readonly EditorContextAction[]
  } | null = null
  let selected = 0
  let disposed = false

  const hide = (element: HTMLElement) => {
    if (element.matches(':popover-open')) element.hidePopover()
  }
  const closeHover = () => {
    if (hoverTimer) clearTimeout(hoverTimer)
    hoverTimer = null
    hoverCancel?.()
    hoverCancel = null
    hoveredPosition = null
    hide(hover)
  }
  const closeMenu = () => {
    actionCancel?.()
    actionCancel = null
    shown = null
    selected = 0
    hide(menu)
  }
  const invalidate = () => {
    closeHover()
    closeMenu()
  }
  const show = (element: HTMLElement, x: number, y: number) => {
    if (!element.matches(':popover-open')) element.showPopover()
    place(element, x, y)
  }
  const hoverAt = (position: number, x: number, y: number) => {
    const request = adapter.capture(position)
    if (!request) return
    hoverCancel = hoverBroker.request(
      () => request,
      () => adapter.capture(position),
      (items: readonly EditorHover[]) => {
        if (disposed || hoveredPosition !== position || !items.length) {
          hide(hover)
          return
        }
        hover.replaceChildren(
          ...items.map((item) => copy(item.label, item.detail)),
        )
        show(hover, x + 10, y + 16)
      },
    )
  }
  const pointerMove = (event: PointerEvent) => {
    if (!hoverBroker.hasProviders() || actionCancel || event.buttons) {
      closeHover()
      return
    }
    const position = adapter.positionAt(event.clientX, event.clientY)
    if (position === hoveredPosition) return
    closeHover()
    if (position === null) return
    hoveredPosition = position
    const { clientX, clientY } = event
    hoverTimer = setTimeout(() => {
      hoverTimer = null
      hoverAt(position, clientX, clientY)
    }, 120)
  }
  const select = (index: number) => {
    if (!shown?.items.length) return
    selected = (index + shown.items.length) % shown.items.length
    for (const [position, element] of [...menu.children].entries()) {
      const active = position === selected
      element.setAttribute('aria-current', String(active))
      ;(element as HTMLElement).style.background = active ? 'var(--active)' : ''
    }
    menu.children[selected]?.scrollIntoView({ block: 'nearest' })
  }
  const accept = (index: number) => {
    const current = shown
    const item = current?.items[index]
    if (!current || !item) return
    const live = sameInteraction(
      current.request,
      adapter.capture(current.request.position),
    )
    closeMenu()
    if (live) adapter.apply(item, current.request)
    adapter.focus()
  }
  const openMenu = (position: number, x: number, y: number) => {
    closeHover()
    closeMenu()
    if (!contextActionBroker.hasProviders()) return false
    const request = adapter.capture(position)
    if (!request) return false
    adapter.element.dispatchEvent(new Event('hibi:editor-actions-open'))
    actionCancel = contextActionBroker.request(
      () => request,
      () => adapter.capture(position),
      (items: readonly EditorContextAction[]) => {
        if (disposed || !items.length) {
          shown = null
          hide(menu)
          return
        }
        shown = { request, items }
        selected = Math.min(selected, items.length - 1)
        menu.replaceChildren(
          ...items.map((item, index) => {
            const button = document.createElement('button')
            button.type = 'button'
            button.setAttribute('role', 'menuitem')
            button.append(copy(item.label, item.detail))
            button.addEventListener('pointermove', () => select(index))
            button.addEventListener('click', () => accept(index))
            return button
          }),
        )
        show(menu, x, y)
        select(selected)
      },
    )
    return !!actionCancel
  }
  const contextMenu = (event: MouseEvent) => {
    const position = adapter.positionAt(event.clientX, event.clientY)
    if (position === null || !contextActionBroker.hasProviders()) return
    if (openMenu(position, event.clientX, event.clientY)) event.preventDefault()
  }
  const keyDown = (event: KeyboardEvent) => {
    if (
      event.key === 'F10' &&
      event.shiftKey &&
      !event.altKey &&
      !event.metaKey &&
      !event.ctrlKey
    ) {
      const position = adapter.selectionPosition()
      const anchor = position === null ? null : adapter.anchorAt(position)
      if (
        position !== null &&
        anchor &&
        openMenu(position, anchor.left, anchor.bottom + 6)
      ) {
        event.preventDefault()
        event.stopPropagation()
      }
      return
    }
    if (event.key === 'Escape' && (shown || actionCancel)) {
      closeMenu()
      event.preventDefault()
      event.stopPropagation()
      return
    }
    if (!shown || event.ctrlKey || event.metaKey || event.altKey) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      select(selected + (event.key === 'ArrowDown' ? 1 : -1))
      event.preventDefault()
      event.stopPropagation()
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      accept(selected)
      event.preventDefault()
      event.stopPropagation()
    }
  }
  const outside = (event: PointerEvent) => {
    if (!menu.contains(event.target as Node)) closeMenu()
  }
  const scroll = () => invalidate()
  menu.addEventListener('pointerdown', (event) => event.preventDefault())
  adapter.element.addEventListener('pointermove', pointerMove)
  adapter.element.addEventListener('pointerleave', closeHover)
  adapter.element.addEventListener('contextmenu', contextMenu)
  adapter.element.addEventListener('keydown', keyDown, true)
  adapter.element.addEventListener('blur', invalidate)
  adapter.element.addEventListener(
    'hibi:editor-interactions-invalidate',
    invalidate,
  )
  document.addEventListener('pointerdown', outside, true)
  document.addEventListener('scroll', scroll, true)
  window.addEventListener('blur', invalidate)
  return () => {
    disposed = true
    invalidate()
    adapter.element.removeEventListener('pointermove', pointerMove)
    adapter.element.removeEventListener('pointerleave', closeHover)
    adapter.element.removeEventListener('contextmenu', contextMenu)
    adapter.element.removeEventListener('keydown', keyDown, true)
    adapter.element.removeEventListener('blur', invalidate)
    adapter.element.removeEventListener(
      'hibi:editor-interactions-invalidate',
      invalidate,
    )
    document.removeEventListener('pointerdown', outside, true)
    document.removeEventListener('scroll', scroll, true)
    window.removeEventListener('blur', invalidate)
    hover.remove()
    menu.remove()
  }
}
