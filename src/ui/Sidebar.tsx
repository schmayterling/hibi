/** biome-ignore-all lint/a11y/useAriaPropsSupportedByRole: both conditional tree/tab roles support the corresponding ARIA attributes. */
import { ChevronRight, MoreHorizontal } from 'lucide-react'
import {
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import './sidebar.css'
import type { ExplorerDecoration } from '../shared/workspace'
import { TextInput } from './Controls'
import { sidebarParents, sidebarRows } from './sidebar-rows'
import type { ToolbarItem } from './toolbar'
import { MIN_SIDEBAR_WIDTH } from './useSidebarResize'
import { useSidebarWindow } from './useSidebarWindow'

export type SidebarItem = {
  id: string
  label: string
  icon?: ToolbarItem['icon']
  children?: SidebarItem[]
  /** Optional section label immediately before this row. */
  section?: string
  /** Draw a divider along this row's top edge. */
  divider?: boolean
  dirty?: boolean
  decoration?: Omit<ExplorerDecoration, 'path'>
}

export type SidebarProps = {
  items: readonly SidebarItem[]
  selected: string | null
  onSelect: (id: string) => void
  label: string
  mode?: 'tree' | 'tabs'
  /** False keeps every branch open and lets parent rows select content. */
  collapsible?: boolean
  open?: boolean
  /** Dock edge; resize gestures and overlay motion follow this side. */
  side?: 'left' | 'right'
  /** Show a dismissible drawer over the content, keeping desktop-sized controls. */
  overlay?: boolean
  onDismiss?: () => void
  disabled?: boolean
  className?: string
  idPrefix?: string
  panelPrefix?: string
  header?: ReactNode
  footer?: ReactNode
  afterItems?: ReactNode
  /** Fade rows at scroll edges instead of clipping them abruptly. */
  fadeEdges?: boolean
  /** Custom view content in the shared sidebar frame instead of tree rows. */
  content?: ReactNode
  empty?: ReactNode
  onMenu?: (id: string, anchor: HTMLElement) => void
  /** Move a tree item into a folder; null targets the tree root. */
  onMove?: (id: string, parent: string | null) => void
  editing?: {
    id: string
    value: string
    /** Select the extension too when naming a newly created file. */
    selectExtension?: boolean
    disabled: boolean
    onChange: (value: string) => void
    onCommit: () => void
    onCancel: () => void
  } | null
  resize?: {
    width: number
    maxWidth: number
    onChange: (width: number) => void
    onReset: () => void
    /** Pointer drags 48px past the minimum collapse a dismissible sidebar. */
    onCollapse?: () => void
  }
}

function RenameInput({
  editing,
}: {
  editing: NonNullable<SidebarProps['editing']>
}) {
  const input = useRef<HTMLInputElement>(null)
  const id = editing.id
  const selectExtension = editing.selectExtension
  useLayoutEffect(() => {
    const element = input.current
    if (!id || !element) return
    element.focus()
    const dot = element.value.lastIndexOf('.')
    element.setSelectionRange(
      0,
      !selectExtension && dot > 0 ? dot : element.value.length,
    )
    element.scrollIntoView({ block: 'nearest' })
  }, [id, selectExtension])
  return (
    <TextInput
      ref={input}
      className="sidebar-rename"
      aria-label="Rename item"
      value={editing.value}
      disabled={editing.disabled}
      onChange={(event) => editing.onChange(event.target.value)}
      onBlur={() => {
        if (!editing.disabled) editing.onCommit()
      }}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Enter') {
          event.preventDefault()
          editing.onCommit()
        } else if (event.key === 'Escape') {
          event.preventDefault()
          editing.onCancel()
        }
      }}
    />
  )
}

export function Sidebar({
  items,
  selected,
  onSelect,
  label,
  mode = 'tree',
  collapsible = true,
  open = true,
  className = '',
  idPrefix = 'sidebar',
  panelPrefix = '',
  header,
  footer,
  afterItems,
  fadeEdges = false,
  content,
  empty,
  onMenu,
  onMove,
  editing,
  resize,
  overlay = false,
  side = 'left',
  onDismiss,
  disabled = false,
}: SidebarProps) {
  const container = useRef<HTMLDivElement>(null)
  const focusedElement = useRef<HTMLElement | null>(null)
  const pendingOpenFocus = useRef<Element | null>(null)
  const wasOverlayOpen = useRef(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: row replacement can remove the focused DOM node without changing drawer visibility.
  useLayoutEffect(() => {
    const opening = open && overlay && !wasOverlayOpen.current
    wasOverlayOpen.current = open && overlay
    if (!open || !overlay) {
      focusedElement.current = null
      pendingOpenFocus.current = null
      return
    }
    if (
      pendingOpenFocus.current &&
      document.activeElement !== pendingOpenFocus.current
    )
      pendingOpenFocus.current = null
    const previous = focusedElement.current
    const removedFocusedRow =
      previous &&
      !previous.isConnected &&
      document.activeElement === document.body
    if (!opening && !pendingOpenFocus.current && !removedFocusedRow) return
    const target =
      container.current?.querySelector<HTMLElement>(
        '[aria-selected="true"]:not(:disabled)',
      ) ??
      container.current?.querySelector<HTMLElement>(
        'input:not(:disabled), button:not(:disabled):not(.sidebar-scrim)',
      )
    if (target) {
      const owner = document.activeElement
      target.focus({ preventScroll: true })
      if (document.activeElement === target) pendingOpenFocus.current = null
      else if (opening) pendingOpenFocus.current = owner
    } else if (opening) {
      // Preserve focus intent until an empty drawer receives its first row.
      pendingOpenFocus.current = document.activeElement
    }
  }, [open, overlay, items, disabled])
  useEffect(() => {
    if (!open || !overlay) return
    const forgetFocus = () => {
      focusedElement.current = null
      pendingOpenFocus.current = null
    }
    const outsideFocus = (event: FocusEvent) => {
      if (!container.current?.contains(event.target as Node)) forgetFocus()
    }
    document.addEventListener('pointerdown', forgetFocus, true)
    document.addEventListener('focusin', outsideFocus, true)
    return () => {
      document.removeEventListener('pointerdown', forgetFocus, true)
      document.removeEventListener('focusin', outsideFocus, true)
    }
  }, [open, overlay])
  const drag = useRef<{ x: number; width: number; pointer: number } | null>(
    null,
  )
  const [dragging, setDragging] = useState(false)
  const draggedItem = useRef<string | null>(null)
  const [dragged, setDragged] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [focused, setFocused] = useState<string | null>(null)
  const buttons = useRef(new Map<string, HTMLButtonElement>())
  const pendingFocus = useRef<string | null>(null)
  const revealed = useRef('')
  const parents = useMemo(() => sidebarParents(items), [items])
  useEffect(() => {
    if (mode === 'tabs' || !collapsible) return
    const ancestors: string[] = []
    for (const target of [selected, editing?.id]) {
      let parent = target ? parents.get(target) : null
      while (parent != null) {
        ancestors.push(parent)
        parent = parents.get(parent)
      }
    }
    const key = JSON.stringify([selected, editing?.id, ancestors])
    if (revealed.current === key) return
    revealed.current = key
    if (ancestors.length) setExpanded((old) => new Set([...old, ...ancestors]))
  }, [parents, selected, mode, editing?.id, collapsible])
  const model = useMemo(
    () => sidebarRows(items, expanded, collapsible),
    [items, expanded, collapsible],
  )
  const { rows, indices } = model
  const active = selected === null ? -1 : (indices.get(selected) ?? -1)
  const focusId =
    focused !== null && indices.has(focused)
      ? focused
      : (rows[active]?.item.id ?? rows[0]?.item.id)
  const windowed = mode === 'tree' && rows.length > 200
  const rowWindow = useSidebarWindow(model, windowed, editing?.id)
  const [faded, setFaded] = useState({ top: false, bottom: false })
  const updateFade = useCallback(() => {
    if (!fadeEdges || !rowWindow.scroll.current) return
    const element = rowWindow.scroll.current
    const top = element.scrollTop > 1
    const bottom =
      element.scrollTop + element.clientHeight < element.scrollHeight - 1
    setFaded((current) =>
      current.top === top && current.bottom === bottom
        ? current
        : { top, bottom },
    )
  }, [fadeEdges, rowWindow.scroll])
  useLayoutEffect(() => {
    if (!fadeEdges || !rowWindow.scroll.current) return
    const element = rowWindow.scroll.current
    const observer = new ResizeObserver(updateFade)
    observer.observe(element)
    const itemList = element.querySelector('.sidebar-items')
    if (itemList) observer.observe(itemList)
    const mutations = new MutationObserver(updateFade)
    mutations.observe(element, { childList: true })
    updateFade()
    return () => {
      observer.disconnect()
      mutations.disconnect()
    }
  }, [fadeEdges, rowWindow.scroll, updateFade])
  const rendered = windowed
    ? (() => {
        const visible = new Set<number>()
        for (
          let index = rowWindow.range.from;
          index < rowWindow.range.to;
          index++
        )
          visible.add(index)
        for (const id of [focusId, selected, editing?.id, dragged]) {
          const index = id == null ? undefined : indices.get(id)
          if (index !== undefined) visible.add(index)
        }
        return [...visible].sort((a, b) => a - b)
      })()
    : rows.map((_row, index) => index)
  useLayoutEffect(() => {
    const id = pendingFocus.current
    if (!id) return
    if (!indices.has(id)) {
      pendingFocus.current = null
      return
    }
    const button = buttons.current.get(id)
    if (button) {
      pendingFocus.current = null
      button.focus({ preventScroll: true })
    }
  })
  const toggle = (id: string) =>
    setExpanded((old) => {
      const next = new Set(old)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  function focus(id: string | undefined) {
    if (!id) return
    setFocused(id)
    const button = buttons.current.get(id)
    if (button) {
      pendingFocus.current = null
      button.focus()
    } else {
      pendingFocus.current = id
      const index = indices.get(id)
      if (index !== undefined) rowWindow.reveal(index)
    }
    if (mode === 'tabs' && !overlay) onSelect(id)
  }
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the shared navigation dismisses after its child controls handle Escape.
    <div
      ref={container}
      className={`sidebar-slot ${className}`}
      data-open={open}
      data-overlay={overlay}
      data-side={side}
      inert={!open}
      aria-hidden={!open}
      onFocusCapture={(event) => {
        focusedElement.current = event.target
      }}
      onBlurCapture={(event) => {
        // Explicit blur wins over a later refresh; DOM removal does not.
        if (event.target.isConnected) focusedElement.current = null
      }}
      onKeyDown={(event) => {
        if (!overlay || !open || event.defaultPrevented) return
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onDismiss?.()
        }
      }}
    >
      {overlay && (
        <button
          type="button"
          className="sidebar-scrim"
          aria-label="Close sidebar"
          tabIndex={-1}
          onClick={onDismiss}
        />
      )}
      <aside className="sidebar" aria-label={label}>
        {header && <div className="sidebar-header">{header}</div>}
        {content !== undefined && (
          <div className="sidebar-content">{content}</div>
        )}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: drag/drop supplements the keyboard-accessible move menu. */}
        <div
          className="sidebar-scroll"
          ref={rowWindow.scroll}
          data-windowed={windowed || undefined}
          data-fade-top={(fadeEdges && faded.top) || undefined}
          data-fade-bottom={(fadeEdges && faded.bottom) || undefined}
          onScroll={() => {
            rowWindow.onScroll()
            updateFade()
          }}
          hidden={content !== undefined}
          data-drop-target={dropTarget === ''}
          onDragOver={(event) => {
            if (disabled || !onMove || !draggedItem.current) return
            event.preventDefault()
            event.dataTransfer.dropEffect = 'move'
            setDropTarget('')
          }}
          onDragLeave={(event) => {
            if (
              !event.currentTarget.contains(event.relatedTarget as Node | null)
            )
              setDropTarget(null)
          }}
          onDrop={(event) => {
            if (disabled || !onMove || !draggedItem.current) return
            event.preventDefault()
            event.stopPropagation()
            onMove(draggedItem.current, null)
            draggedItem.current = null
            setDragged(null)
            setDropTarget(null)
          }}
        >
          <div
            className="sidebar-items"
            data-windowed={windowed || undefined}
            style={
              windowed
                ? {
                    height: `calc(${rows.length} * var(--sidebar-row-height) + ${model.sections} * var(--sidebar-section-height))`,
                  }
                : undefined
            }
            role={mode === 'tabs' ? 'tablist' : 'tree'}
            aria-label={label}
            aria-orientation={mode === 'tabs' ? 'vertical' : undefined}
          >
            <div className="sidebar-metrics" aria-hidden="true">
              <span
                ref={rowWindow.rowMeasure}
                className="sidebar-row-measure"
              />
              <span
                ref={rowWindow.sectionMeasure}
                className="sidebar-section-measure"
              />
            </div>
            {active >= 0 && (
              <span
                className="sidebar-selection category-selection"
                aria-hidden="true"
                style={{
                  transform: `translateY(calc(${active} * var(--sidebar-row-height) + ${rows[active]!.sections} * var(--sidebar-section-height) + ${rows[active]!.dividers} * var(--sidebar-divider-gap, 0px)))`,
                }}
              />
            )}
            {rendered.map((index) => {
              const { item, depth, parent, position, size, sections } =
                rows[index]!
              const Icon = item.icon
              return (
                <Fragment key={item.id}>
                  {item.section && (
                    <div
                      className="sidebar-section"
                      role="presentation"
                      style={
                        windowed
                          ? {
                              top: `calc(${index} * var(--sidebar-row-height) + ${sections - 1} * var(--sidebar-section-height))`,
                            }
                          : undefined
                      }
                    >
                      {item.section}
                    </div>
                  )}
                  {/* biome-ignore lint/a11y/noStaticElementInteractions: tree buttons and the move menu provide keyboard equivalents. */}
                  <div
                    className="sidebar-row"
                    data-divider={item.divider || undefined}
                    style={
                      windowed
                        ? {
                            top: `calc(${index} * var(--sidebar-row-height) + ${sections} * var(--sidebar-section-height))`,
                          }
                        : undefined
                    }
                    onFocusCapture={() => setFocused(item.id)}
                    data-editing={editing?.id === item.id}
                    data-drop-target={dropTarget === item.id}
                    onDragOver={(event) => {
                      const source = draggedItem.current
                      if (disabled || !onMove || !source) return
                      event.stopPropagation()
                      const target = item.children ? item.id : parent
                      if (
                        source === target ||
                        target?.startsWith(`${source}/`)
                      ) {
                        setDropTarget(null)
                        return
                      }
                      event.preventDefault()
                      event.dataTransfer.dropEffect = 'move'
                      setDropTarget(target ?? '')
                    }}
                    onDrop={(event) => {
                      const source = draggedItem.current
                      if (disabled || !onMove || !source) return
                      event.preventDefault()
                      event.stopPropagation()
                      const target = item.children ? item.id : parent
                      if (
                        source !== target &&
                        !target?.startsWith(`${source}/`)
                      ) {
                        onMove(source, target)
                        if (target)
                          setExpanded((old) => new Set([...old, target]))
                      }
                      draggedItem.current = null
                      setDragged(null)
                      setDropTarget(null)
                    }}
                  >
                    {editing?.id === item.id ? (
                      <div
                        className="sidebar-edit"
                        style={{ paddingLeft: 16 + depth * 14 }}
                      >
                        {mode === 'tree' && (
                          <ChevronRight
                            className={`sidebar-chevron ${item.children && collapsible ? '' : 'leaf'}`}
                            size={12}
                            style={{
                              rotate:
                                item.children && expanded.has(item.id)
                                  ? '90deg'
                                  : '0deg',
                            }}
                            aria-hidden="true"
                          />
                        )}
                        {Icon && (
                          <Icon size={15} strokeWidth={1.5} aria-hidden />
                        )}
                        <RenameInput editing={editing} />
                      </div>
                    ) : (
                      <button
                        key={item.id}
                        ref={(element) => {
                          if (element) buttons.current.set(item.id, element)
                          else buttons.current.delete(item.id)
                        }}
                        id={`${idPrefix}-${item.id}`}
                        type="button"
                        disabled={disabled}
                        draggable={mode === 'tree' && !!onMove && !disabled}
                        onDragStart={(event) => {
                          if (!onMove) return
                          draggedItem.current = item.id
                          setDragged(item.id)
                          event.dataTransfer.setData(
                            'application/x-hibi-sidebar',
                            item.id,
                          )
                          event.dataTransfer.effectAllowed = 'move'
                        }}
                        onDragEnd={() => {
                          draggedItem.current = null
                          setDragged(null)
                          setDropTarget(null)
                        }}
                        role={mode === 'tabs' ? 'tab' : 'treeitem'}
                        aria-selected={selected === item.id}
                        aria-expanded={
                          item.children
                            ? !collapsible || expanded.has(item.id)
                            : undefined
                        }
                        aria-level={mode === 'tree' ? depth + 1 : undefined}
                        aria-posinset={mode === 'tree' ? position : undefined}
                        aria-setsize={mode === 'tree' ? size : undefined}
                        aria-controls={
                          mode === 'tabs'
                            ? `${panelPrefix}${item.id}`
                            : undefined
                        }
                        tabIndex={focusId === item.id ? 0 : -1}
                        style={{
                          paddingLeft: 16 + depth * 14,
                          color: item.decoration?.color
                            ? `var(--${item.decoration.color})`
                            : undefined,
                        }}
                        data-tooltip={[item.label, item.decoration?.label]
                          .filter(Boolean)
                          .join(' · ')}
                        data-verbatim={mode === 'tree' || undefined}
                        aria-description={
                          [
                            item.dirty ? 'unsaved changes' : '',
                            item.decoration?.label,
                          ]
                            .filter(Boolean)
                            .join('; ') || undefined
                        }
                        onContextMenu={(event) => {
                          if (onMenu && !disabled) {
                            event.preventDefault()
                            setFocused(item.id)
                            onMenu(item.id, event.currentTarget)
                          }
                        }}
                        onFocus={() => {
                          setFocused(item.id)
                          rowWindow.reveal(index)
                        }}
                        onClick={() => {
                          if (item.children && collapsible) toggle(item.id)
                          else onSelect(item.id)
                        }}
                        onKeyDown={(event) => {
                          if (
                            onMenu &&
                            (event.key === 'ContextMenu' ||
                              (event.shiftKey && event.key === 'F10'))
                          ) {
                            event.preventDefault()
                            onMenu(item.id, event.currentTarget)
                            return
                          }
                          switch (event.key) {
                            case 'ArrowDown':
                              event.preventDefault()
                              focus(
                                rows[Math.min(index + 1, rows.length - 1)]?.item
                                  .id,
                              )
                              break
                            case 'ArrowUp':
                              event.preventDefault()
                              focus(rows[Math.max(index - 1, 0)]?.item.id)
                              break
                            case 'Home':
                              event.preventDefault()
                              focus(rows[0]?.item.id)
                              break
                            case 'End':
                              event.preventDefault()
                              focus(rows.at(-1)?.item.id)
                              break
                            case 'ArrowRight':
                              if (item.children) {
                                event.preventDefault()
                                if (collapsible && !expanded.has(item.id))
                                  toggle(item.id)
                                else focus(item.children[0]?.id)
                              }
                              break
                            case 'ArrowLeft':
                              event.preventDefault()
                              if (
                                collapsible &&
                                item.children &&
                                expanded.has(item.id)
                              )
                                toggle(item.id)
                              else if (parent) focus(parent)
                              break
                          }
                        }}
                      >
                        {mode === 'tree' && (
                          <ChevronRight
                            className={`sidebar-chevron ${item.children && collapsible ? '' : 'leaf'}`}
                            size={12}
                            style={{
                              rotate:
                                item.children && expanded.has(item.id)
                                  ? '90deg'
                                  : '0deg',
                            }}
                            aria-hidden="true"
                          />
                        )}
                        {Icon && (
                          <Icon size={15} strokeWidth={1.5} aria-hidden />
                        )}
                        <span className="sidebar-label">{item.label}</span>
                        {item.dirty && (
                          <span className="sidebar-dirty" aria-hidden="true">
                            ●
                          </span>
                        )}
                        {item.decoration?.badge && (
                          <span
                            className="sidebar-decoration"
                            aria-hidden="true"
                          >
                            {item.decoration.badge}
                          </span>
                        )}
                      </button>
                    )}
                    {onMenu && editing?.id !== item.id && (
                      <button
                        type="button"
                        className="sidebar-more"
                        disabled={disabled}
                        tabIndex={
                          windowed && focusId !== item.id ? -1 : undefined
                        }
                        aria-label={`Actions for ${item.label}`}
                        aria-haspopup="menu"
                        onClick={(event) => {
                          setFocused(item.id)
                          onMenu(item.id, event.currentTarget)
                        }}
                      >
                        <MoreHorizontal size={14} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                </Fragment>
              )
            })}
          </div>
          {afterItems}
          {!rows.length && empty && (
            <div className="sidebar-empty">{empty}</div>
          )}
        </div>
        {footer && <div className="sidebar-footer">{footer}</div>}
        {resize && (
          <hr
            className="sidebar-resizer"
            data-dragging={dragging}
            aria-label={
              side === 'right' ? 'Resize right sidebar' : 'Resize sidebar'
            }
            aria-orientation="vertical"
            aria-valuemin={MIN_SIDEBAR_WIDTH}
            aria-valuemax={resize.maxWidth}
            aria-valuenow={resize.width}
            tabIndex={0}
            data-tooltip="Drag to resize; double-click to reset"
            onDoubleClick={resize.onReset}
            onPointerDown={(event) => {
              if (event.button !== 0 || !event.isPrimary) return
              event.preventDefault()
              event.currentTarget.focus({ preventScroll: true })
              event.currentTarget.setPointerCapture(event.pointerId)
              drag.current = {
                x: event.clientX,
                width: resize.width,
                pointer: event.pointerId,
              }
              setDragging(true)
            }}
            onPointerMove={(event) => {
              if (drag.current?.pointer !== event.pointerId) return
              const width =
                drag.current.width +
                (event.clientX - drag.current.x) * (side === 'right' ? -1 : 1)
              if (resize.onCollapse && width <= MIN_SIDEBAR_WIDTH - 48) {
                resize.onChange(drag.current.width)
                event.currentTarget.releasePointerCapture(event.pointerId)
                drag.current = null
                setDragging(false)
                resize.onCollapse()
              } else resize.onChange(width)
            }}
            onPointerUp={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId))
                event.currentTarget.releasePointerCapture(event.pointerId)
            }}
            onPointerCancel={() => {
              if (drag.current) resize.onChange(drag.current.width)
            }}
            onLostPointerCapture={() => {
              drag.current = null
              setDragging(false)
            }}
            onKeyDown={(event) => {
              const step = event.shiftKey ? 24 : 8
              switch (event.key) {
                case 'ArrowLeft':
                  resize.onChange(
                    resize.width + (side === 'right' ? step : -step),
                  )
                  break
                case 'ArrowRight':
                  resize.onChange(
                    resize.width + (side === 'right' ? -step : step),
                  )
                  break
                case 'Home':
                  resize.onChange(MIN_SIDEBAR_WIDTH)
                  break
                case 'End':
                  resize.onChange(resize.maxWidth)
                  break
                case 'Enter':
                  resize.onReset()
                  break
                case 'Escape':
                  if (!drag.current) return
                  resize.onChange(drag.current.width)
                  event.currentTarget.releasePointerCapture(
                    drag.current.pointer,
                  )
                  break
                default:
                  return
              }
              event.preventDefault()
              event.stopPropagation()
            }}
          />
        )}
      </aside>
    </div>
  )
}
