/** biome-ignore-all lint/a11y/useAriaPropsSupportedByRole: both conditional tree/tab roles support the corresponding ARIA attributes. */
import { ChevronRight, type LucideIcon, MoreHorizontal } from 'lucide-react'
import {
  Fragment,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import './sidebar.css'
import type { ExplorerDecoration } from '../shared/workspace'
import { TextInput } from './Controls'
import { MIN_SIDEBAR_WIDTH } from './useSidebarResize'

export type SidebarItem = {
  id: string
  label: string
  icon?: LucideIcon
  children?: SidebarItem[]
  /** Optional section label immediately before this row. */
  section?: string
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
  className?: string
  idPrefix?: string
  panelPrefix?: string
  header?: ReactNode
  footer?: ReactNode
  empty?: ReactNode
  onMenu?: (id: string, anchor: HTMLElement) => void
  /** Move a tree item into a folder; null targets the tree root. */
  onMove?: (id: string, parent: string | null) => void
  editing?: {
    id: string
    value: string
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
  }
}

function RenameInput({
  editing,
}: {
  editing: NonNullable<SidebarProps['editing']>
}) {
  const input = useRef<HTMLInputElement>(null)
  const id = editing.id
  useLayoutEffect(() => {
    const element = input.current
    if (!id || !element) return
    element.focus()
    const dot = element.value.lastIndexOf('.')
    element.setSelectionRange(0, dot > 0 ? dot : element.value.length)
    element.scrollIntoView({ block: 'nearest' })
  }, [id])
  return (
    <TextInput
      variant="inline"
      ref={input}
      className="inline-edit sidebar-rename"
      aria-label="Rename item"
      value={editing.value}
      disabled={editing.disabled}
      onChange={(event) => editing.onChange(event.target.value)}
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
  empty,
  onMenu,
  onMove,
  editing,
  resize,
}: SidebarProps) {
  const drag = useRef<{ x: number; width: number; pointer: number } | null>(
    null,
  )
  const [dragging, setDragging] = useState(false)
  const draggedItem = useRef<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [focused, setFocused] = useState<string | null>(null)
  const buttons = useRef(new Map<string, HTMLButtonElement>())
  const revealed = useRef('')
  useEffect(() => {
    if (mode === 'tabs' || !collapsible) return
    const parents: string[] = []
    function find(items: readonly SidebarItem[], target: string): boolean {
      return items.some((item) => {
        if (item.id === target) return true
        if (item.children && find(item.children, target)) {
          parents.push(item.id)
          return true
        }
        return false
      })
    }
    if (selected) find(items, selected)
    if (editing?.id) find(items, editing.id)
    const key = JSON.stringify([selected, editing?.id, parents])
    if (revealed.current === key) return
    revealed.current = key
    if (parents.length) setExpanded((old) => new Set([...old, ...parents]))
  }, [items, selected, mode, editing?.id, collapsible])
  const rows = useMemo(() => {
    const visible: {
      item: SidebarItem
      depth: number
      parent: string | null
      position: number
      size: number
    }[] = []
    function visit(
      items: readonly SidebarItem[],
      depth: number,
      parent: string | null,
    ) {
      items.forEach((item, index) => {
        visible.push({
          item,
          depth,
          parent,
          position: index + 1,
          size: items.length,
        })
        if (item.children && (!collapsible || expanded.has(item.id)))
          visit(item.children, depth + 1, item.id)
      })
    }
    visit(items, 0, null)
    return visible
  }, [items, expanded, collapsible])
  const active = rows.findIndex(({ item }) => item.id === selected)
  const focusId = rows.some(({ item }) => item.id === focused)
    ? focused
    : (rows[active]?.item.id ?? rows[0]?.item.id)
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
    buttons.current.get(id)?.focus()
    if (mode === 'tabs') onSelect(id)
  }
  return (
    <div
      className={`sidebar-slot ${className}`}
      data-open={open}
      inert={!open}
      aria-hidden={!open}
    >
      <aside className="sidebar" aria-label={label}>
        {header && <div className="sidebar-header">{header}</div>}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: drag/drop supplements the keyboard-accessible move menu. */}
        <div
          className="sidebar-scroll"
          data-drop-target={dropTarget === ''}
          onDragOver={(event) => {
            if (!onMove || !draggedItem.current) return
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
            if (!onMove || !draggedItem.current) return
            event.preventDefault()
            event.stopPropagation()
            onMove(draggedItem.current, null)
            draggedItem.current = null
            setDropTarget(null)
          }}
        >
          <div
            className="sidebar-items"
            role={mode === 'tabs' ? 'tablist' : 'tree'}
            aria-label={label}
            aria-orientation={mode === 'tabs' ? 'vertical' : undefined}
          >
            {active >= 0 && (
              <span
                className="sidebar-selection category-selection"
                aria-hidden="true"
                style={{
                  transform: `translateY(calc(${active} * var(--sidebar-row-height) + ${rows.slice(0, active + 1).filter(({ item }) => item.section).length} * var(--sidebar-section-height)))`,
                }}
              />
            )}
            {rows.map(({ item, depth, parent, position, size }, index) => {
              const Icon = item.icon
              return (
                <Fragment key={item.id}>
                  {item.section && (
                    <div className="sidebar-section" role="presentation">
                      {item.section}
                    </div>
                  )}
                  {/* biome-ignore lint/a11y/noStaticElementInteractions: tree buttons and the move menu provide keyboard equivalents. */}
                  <div
                    className="sidebar-row"
                    data-editing={editing?.id === item.id}
                    data-drop-target={dropTarget === item.id}
                    onDragOver={(event) => {
                      const source = draggedItem.current
                      if (!onMove || !source) return
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
                      if (!onMove || !source) return
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
                      setDropTarget(null)
                    }}
                  >
                    {editing?.id === item.id ? (
                      <RenameInput editing={editing} />
                    ) : (
                      <button
                        key={item.id}
                        ref={(element) => {
                          if (element) buttons.current.set(item.id, element)
                          else buttons.current.delete(item.id)
                        }}
                        id={`${idPrefix}-${item.id}`}
                        type="button"
                        draggable={mode === 'tree' && !!onMove}
                        onDragStart={(event) => {
                          if (!onMove) return
                          draggedItem.current = item.id
                          event.dataTransfer.setData(
                            'application/x-hibi-sidebar',
                            item.id,
                          )
                          event.dataTransfer.effectAllowed = 'move'
                        }}
                        onDragEnd={() => {
                          draggedItem.current = null
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
                        title={[item.label, item.decoration?.label]
                          .filter(Boolean)
                          .join(' · ')}
                        aria-description={
                          [
                            item.dirty ? 'unsaved changes' : '',
                            item.decoration?.label,
                          ]
                            .filter(Boolean)
                            .join('; ') || undefined
                        }
                        onContextMenu={(event) => {
                          if (onMenu) {
                            event.preventDefault()
                            onMenu(item.id, event.currentTarget)
                          }
                        }}
                        onFocus={() => setFocused(item.id)}
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
                          <Icon
                            size={15}
                            strokeWidth={1.5}
                            aria-hidden="true"
                          />
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
                        aria-label={`Actions for ${item.label}`}
                        aria-haspopup="menu"
                        onClick={(event) =>
                          onMenu(item.id, event.currentTarget)
                        }
                      >
                        <MoreHorizontal size={14} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                </Fragment>
              )
            })}
          </div>
          {!rows.length && empty && (
            <div className="sidebar-empty">{empty}</div>
          )}
        </div>
        {footer && <div className="sidebar-footer">{footer}</div>}
        {resize && (
          <hr
            className="sidebar-resizer"
            data-dragging={dragging}
            aria-label="Resize sidebar"
            aria-orientation="vertical"
            aria-valuemin={MIN_SIDEBAR_WIDTH}
            aria-valuemax={resize.maxWidth}
            aria-valuenow={resize.width}
            tabIndex={0}
            title="Drag to resize; double-click to reset"
            onDoubleClick={resize.onReset}
            onPointerDown={(event) => {
              if (event.button !== 0 || !event.isPrimary) return
              event.preventDefault()
              event.currentTarget.focus()
              event.currentTarget.setPointerCapture(event.pointerId)
              drag.current = {
                x: event.clientX,
                width: resize.width,
                pointer: event.pointerId,
              }
              setDragging(true)
            }}
            onPointerMove={(event) => {
              if (drag.current?.pointer === event.pointerId)
                resize.onChange(
                  drag.current.width + event.clientX - drag.current.x,
                )
            }}
            onPointerUp={(event) => {
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
                  resize.onChange(resize.width - step)
                  break
                case 'ArrowRight':
                  resize.onChange(resize.width + step)
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
