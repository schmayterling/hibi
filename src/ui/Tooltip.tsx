import {
  cloneElement,
  type ReactElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from 'react'
import { createPortal } from 'react-dom'
import { sentenceCase } from '../shared/ui-case'
import {
  createTooltipScope,
  tooltipAnchorVisible,
  tooltipStore,
} from './tooltip-store'
import type { TooltipOptions } from './tooltips'
import './tooltip.css'

/** Child must forward data attributes to its DOM element. No layout wrapper. */
export function Tooltip({
  text,
  children,
}: {
  text: string
  children: ReactElement<{ 'data-tooltip'?: string }>
}) {
  return cloneElement(children, { 'data-tooltip': text })
}

/** Mount once per renderer, including renderers using native modal dialogs. */
export function TooltipHost() {
  const active = useSyncExternalStore(
    tooltipStore.subscribe,
    tooltipStore.snapshot,
  )
  const node = useRef<HTMLDivElement>(null)
  const id = useId()
  const text = useRef('')
  const verbatim = useRef(false)
  const container = useRef<HTMLElement>(document.body)
  if (active) {
    text.current = active.text
    verbatim.current = !!active.anchor.closest('[data-verbatim="true"]')
  }
  if (active)
    container.current =
      active.anchor.closest<HTMLElement>('dialog[open]') ?? document.body
  useEffect(() => {
    const scope = createTooltipScope()
    let timer: ReturnType<typeof setTimeout> | undefined
    let anchor: TooltipOptions['anchor'] | null = null
    let keyboardFocus = false
    const hide = () => {
      clearTimeout(timer)
      anchor = null
      tooltipStore.hide()
    }
    const enter = (event: Event) => {
      const current = tooltipStore.snapshot()
      if (event instanceof PointerEvent) {
        keyboardFocus = false
        if (event.pointerType === 'touch' || event.buttons) {
          hide()
          return
        }
        if (
          current &&
          event.target instanceof Node &&
          !current.anchor.contains(event.target)
        )
          hide()
      } else if (!keyboardFocus) {
        hide()
        return
      }
      const next =
        event.target instanceof Element
          ? event.target.closest<HTMLElement | SVGElement>('[data-tooltip]')
          : null
      if (!next) {
        if (
          !(event.target instanceof Node) ||
          !current?.anchor.contains(event.target)
        )
          hide()
        return
      }
      if (next === anchor) return
      hide()
      anchor = next
      const focus = event.type === 'focusin'
      const show = () => {
        if (
          anchor !== next ||
          !tooltipAnchorVisible(next) ||
          (focus
            ? !next.contains(document.activeElement)
            : !next.matches(':hover'))
        ) {
          anchor = null
          return
        }
        scope.api.show({
          anchor: next,
          text: next.getAttribute('data-tooltip') ?? '',
        })
      }
      if (event.type === 'focusin') show()
      else timer = setTimeout(show, 400)
    }
    const leave = (event: Event) => {
      const current = tooltipStore.snapshot()?.anchor ?? anchor
      if (!(event.target instanceof Node) || !current?.contains(event.target))
        return
      const related = (event as FocusEvent).relatedTarget
      if (!(related instanceof Node) || !current.contains(related)) hide()
    }
    const key = (event: KeyboardEvent) => {
      keyboardFocus = event.key === 'Tab' || event.key.startsWith('Arrow')
      hide()
    }
    const reset = () => {
      keyboardFocus = false
      hide()
    }
    const unsubscribe = tooltipStore.subscribe(() => {
      if (!tooltipStore.snapshot()) {
        clearTimeout(timer)
        anchor = null
      }
    })
    document.addEventListener('pointerover', enter)
    document.addEventListener('pointermove', enter, { passive: true })
    document.addEventListener('focusin', enter)
    document.addEventListener('pointerout', leave)
    document.addEventListener('focusout', leave)
    document.addEventListener('pointerdown', reset, true)
    document.addEventListener('pointercancel', reset)
    document.addEventListener('pointerleave', reset)
    document.addEventListener('visibilitychange', reset)
    document.addEventListener('scroll', hide, true)
    document.addEventListener('keydown', key, true)
    window.addEventListener('resize', reset)
    window.addEventListener('blur', reset)
    return () => {
      hide()
      scope.dispose()
      unsubscribe()
      document.removeEventListener('pointerover', enter)
      document.removeEventListener('pointermove', enter)
      document.removeEventListener('focusin', enter)
      document.removeEventListener('pointerout', leave)
      document.removeEventListener('focusout', leave)
      document.removeEventListener('pointerdown', reset, true)
      document.removeEventListener('pointercancel', reset)
      document.removeEventListener('pointerleave', reset)
      document.removeEventListener('visibilitychange', reset)
      document.removeEventListener('scroll', hide, true)
      document.removeEventListener('keydown', key, true)
      window.removeEventListener('resize', reset)
      window.removeEventListener('blur', reset)
    }
  }, [])
  useLayoutEffect(() => {
    const element = node.current
    if (!element) return
    if (!active) {
      element.hidePopover()
      return
    }
    const { anchor } = active
    if (!tooltipAnchorVisible(anchor)) {
      tooltipStore.hide(active)
      return
    }
    element.showPopover()
    const bounds = anchor.getBoundingClientRect()
    const height = element.offsetHeight
    const above = bounds.top - 8,
      below = innerHeight - bounds.bottom - 8
    const bottom =
      active.placement === 'top'
        ? above < height && below > above
        : below >= height || below >= above
    const left = Math.max(
      8,
      Math.min(
        innerWidth - element.offsetWidth - 8,
        bounds.left + (bounds.width - element.offsetWidth) / 2,
      ),
    )
    element.style.left = `${left}px`
    element.style.top = `${Math.max(8, Math.min(innerHeight - height - 8, bottom ? bounds.bottom + 7 : bounds.top - height - 7))}px`
    element.dataset.side = bottom ? 'bottom' : 'top'
    element.style.setProperty(
      '--tooltip-arrow-x',
      `${Math.max(8, Math.min(element.offsetWidth - 8, bounds.left + bounds.width / 2 - left))}px`,
    )
    const ids = (anchor.getAttribute('aria-describedby') ?? '')
      .split(/\s+/)
      .filter(Boolean)
    anchor.setAttribute('aria-describedby', [...ids, id].join(' '))
    const validate = () => {
      const current = anchor.getBoundingClientRect()
      if (
        !tooltipAnchorVisible(anchor) ||
        (['left', 'top', 'width', 'height'] as const).some(
          (key) => Math.abs(current[key] - bounds[key]) > 0.5,
        )
      )
        tooltipStore.hide(active)
    }
    // Changes that can move the anchor share one check before the next frame.
    let frame = 0
    const schedule = () => {
      frame ||= requestAnimationFrame(() => {
        frame = 0
        validate()
      })
    }
    // Attributes of the anchor, its siblings, and its ancestors can hide or move it.
    const attributes = new MutationObserver((records) => {
      if (
        records.some(
          (record) =>
            [
              'hidden',
              'inert',
              'style',
              'class',
              'open',
              'aria-hidden',
              'data-tooltip',
            ].includes(record.attributeName ?? '') &&
            record.target instanceof Element &&
            record.target.contains(anchor),
        )
      ) {
        tooltipStore.hide(active)
      } else schedule()
    })
    const container = anchor.closest('dialog[open]') ?? document.body
    const local =
      anchor.parentElement && anchor.parentElement !== container
        ? anchor.parentElement
        : anchor
    attributes.observe(local, { attributes: true, subtree: true })
    for (
      let parent = local.parentElement;
      parent;
      parent = parent.parentElement
    )
      attributes.observe(parent, { attributes: true })
    // Removal anywhere in the tooltip's container detaches the anchor; other structure changes can move it.
    const structure = new MutationObserver(() => {
      if (!anchor.isConnected) tooltipStore.hide(active)
      else schedule()
    })
    structure.observe(container, { childList: true, subtree: true })
    const resize = new ResizeObserver(validate)
    resize.observe(anchor)
    return () => {
      cancelAnimationFrame(frame)
      attributes.disconnect()
      structure.disconnect()
      resize.disconnect()
      const remaining = (anchor.getAttribute('aria-describedby') ?? '')
        .split(/\s+/)
        .filter((value) => value && value !== id)
        .join(' ')
      if (remaining) anchor.setAttribute('aria-describedby', remaining)
      else anchor.removeAttribute('aria-describedby')
    }
  }, [active, id])
  return createPortal(
    <div
      ref={node}
      id={id}
      role="tooltip"
      popover="manual"
      className="ui-tooltip"
      data-verbatim={verbatim.current || undefined}
      aria-hidden={!active}
    >
      {verbatim.current ? text.current : sentenceCase(text.current)}
    </div>,
    container.current,
  )
}
