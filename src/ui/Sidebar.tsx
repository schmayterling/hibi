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
  /** Row `dirty` and `decoration` values by id, used before the item's own. Changing them keeps the tree model, expansion, and focus. */
  status?: ReadonlyMap<string, Pick<SidebarItem, 'dirty' | 'decoration'>>
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
  /** Tree pages are being refreshed; rows remain visible but unavailable. */
  pending?: boolean
  /** Drags belong to the tree revision where they started. */
  interactionRevision?: number | undefined
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
  /** Let tree rows build a multiple selection with modifier clicks, Shift ranges, and Space. Ids missing from `items` are dropped. */
  selection?: {
    ids: readonly string[]
    onChange: (ids: string[]) => void
  }
  /** `ids` lists the selected group when the row belongs to it, otherwise only `id`. */
  onMenu?: (id: string, anchor: HTMLElement, ids?: string[]) => void
  /** Move a tree item into a folder; null targets the tree root. `ids` lists every dragged item. */
  onMove?: (id: string, parent: string | null, ids?: string[]) => void
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
  status,
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
  selection,
  onMenu,
  onMove,
  editing,
  resize,
  overlay = false,
  side = 'left',
  onDismiss,
  disabled = false,
  pending = false,
  interactionRevision,
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
  const draggedItem = useRef<{
    id: string
    ids: string[]
    revision: number | undefined
  } | null>(null)
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
    // Selecting inside open folders keeps the row model.
    if (ancestors.length)
      setExpanded((old) =>
        ancestors.every((id) => old.has(id))
          ? old
          : new Set([...old, ...ancestors]),
      )
  }, [parents, selected, mode, editing?.id, collapsible])
  const model = useMemo(
    () => sidebarRows(items, expanded, collapsible),
    [items, expanded, collapsible],
  )
  const { rows, indices } = model
  const selectionIds = mode === 'tree' ? selection?.ids : undefined
  // Tree order keeps batch actions predictable; removed items drop out.
  const picked = useMemo(() => {
    if (!selectionIds) return null
    const ids = new Set(selectionIds)
    // Following the active file needs no ordering pass over the whole tree.
    if (ids.size < 2) return [...ids].filter((id) => parents.has(id))
    return [...parents.keys()].filter((id) => ids.has(id))
  }, [selectionIds, parents])
  const pickedSet = useMemo(() => picked && new Set(picked), [picked])
  const anchor = useRef<string | null>(null)
  const chosen = useRef<readonly string[] | undefined>(undefined)
  const onSelectionChange = selection?.onChange
  function choose(ids: string[]) {
    chosen.current = ids
    onSelectionChange?.(ids)
  }
  useEffect(() => {
    // A selection the caller replaced, such as another workspace's, starts a new range.
    const previous = chosen.current
    if (
      selectionIds?.length !== previous?.length ||
      selectionIds?.some((id, index) => id !== previous?.[index])
    )
      anchor.current = null
    chosen.current = selectionIds
    if (picked && picked.length !== selectionIds?.length) {
      chosen.current = picked
      onSelectionChange?.(picked)
    }
  }, [picked, selectionIds, onSelectionChange])
  // One selected row keeps the sliding marker; a group highlights each row.
  const marked = picked
    ? picked.length === 1
      ? (picked[0] ?? null)
      : null
    : selected
  const active = marked === null ? -1 : (indices.get(marked) ?? -1)
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
  /** Visible rows from the anchor through `id`; collapsed descendants stay out. */
  function selectRange(id: string, from: string) {
    if (!anchor.current || !indices.has(anchor.current)) anchor.current = from
    const start = indices.get(anchor.current) ?? 0
    const end = indices.get(id) ?? start
    choose(
      rows
        .slice(Math.min(start, end), Math.max(start, end) + 1)
        .map((row) => row.item.id),
    )
  }
  function toggleSelected(id: string) {
    if (!picked) return
    anchor.current = id
    choose(
      pickedSet?.has(id)
        ? picked.filter((other) => other !== id)
        : [...picked, id],
    )
  }
  /** Menus and drags keep a selected group; an unselected row replaces it. */
  function menuGroup(id: string) {
    if (!picked || pickedSet?.has(id)) return picked ?? [id]
    anchor.current = id
    choose([id])
    return [id]
  }
  function focus(id: string | undefined, extendFrom?: string) {
    if (!id) return
    if (picked && extendFrom) selectRange(id, extendFrom)
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
    if (mode === 'tabs' && !overlay && !disabled && !pending) onSelect(id)
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
            if (
              disabled ||
              pending ||
              !onMove ||
              !draggedItem.current ||
              draggedItem.current.revision !== interactionRevision
            )
              return
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
            if (
              disabled ||
              pending ||
              !onMove ||
              !draggedItem.current ||
              draggedItem.current.revision !== interactionRevision
            )
              return
            event.preventDefault()
            event.stopPropagation()
            onMove(draggedItem.current.id, null, draggedItem.current.ids)
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
            aria-busy={pending || undefined}
            aria-orientation={mode === 'tabs' ? 'vertical' : undefined}
            aria-multiselectable={picked ? true : undefined}
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
              const shown = status?.get(item.id)
              const dirty = shown?.dirty ?? item.dirty
              const decoration = shown?.decoration ?? item.decoration
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
                    data-selected={
                      (marked === null && pickedSet?.has(item.id)) || undefined
                    }
                    data-drop-target={dropTarget === item.id}
                    onDragOver={(event) => {
                      const source = draggedItem.current
                      if (
                        disabled ||
                        pending ||
                        !onMove ||
                        !source ||
                        source.revision !== interactionRevision
                      )
                        return
                      event.stopPropagation()
                      const target = item.children ? item.id : parent
                      if (
                        source.ids.some(
                          (id) => id === target || target?.startsWith(`${id}/`),
                        )
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
                      if (
                        disabled ||
                        pending ||
                        !onMove ||
                        !source ||
                        source.revision !== interactionRevision
                      )
                        return
                      event.preventDefault()
                      event.stopPropagation()
                      const target = item.children ? item.id : parent
                      if (
                        !source.ids.some(
                          (id) => id === target || target?.startsWith(`${id}/`),
                        )
                      ) {
                        onMove(source.id, target, source.ids)
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
                        aria-disabled={disabled || pending || undefined}
                        draggable={
                          mode === 'tree' && !!onMove && !disabled && !pending
                        }
                        onDragStart={(event) => {
                          if (disabled || pending || !onMove) {
                            event.preventDefault()
                            return
                          }
                          draggedItem.current = {
                            revision: interactionRevision,
                            id: item.id,
                            ids: menuGroup(item.id),
                          }
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
                        aria-selected={
                          pickedSet
                            ? pickedSet.has(item.id)
                            : selected === item.id
                        }
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
                          color: decoration?.color
                            ? `var(--${decoration.color})`
                            : undefined,
                        }}
                        data-tooltip={[item.label, decoration?.label]
                          .filter(Boolean)
                          .join(' · ')}
                        data-verbatim={mode === 'tree' || undefined}
                        aria-description={
                          [dirty ? 'unsaved changes' : '', decoration?.label]
                            .filter(Boolean)
                            .join('; ') || undefined
                        }
                        onContextMenu={(event) => {
                          if (onMenu && !disabled && !pending) {
                            event.preventDefault()
                            setFocused(item.id)
                            onMenu(
                              item.id,
                              event.currentTarget,
                              menuGroup(item.id),
                            )
                          }
                        }}
                        onFocus={() => {
                          setFocused(item.id)
                          rowWindow.reveal(index)
                        }}
                        onClick={(event) => {
                          if (disabled || pending) return
                          if (picked) {
                            if (event.shiftKey)
                              return selectRange(item.id, picked[0] ?? item.id)
                            if (event.metaKey || event.ctrlKey)
                              return toggleSelected(item.id)
                            anchor.current = item.id
                            choose([item.id])
                          }
                          if (item.children && collapsible) toggle(item.id)
                          else onSelect(item.id)
                        }}
                        onKeyUp={(event) => {
                          // Space toggles selection instead of activating the button.
                          if (picked && event.key === ' ')
                            event.preventDefault()
                        }}
                        onKeyDown={(event) => {
                          if (
                            (disabled || pending) &&
                            ([
                              'Enter',
                              'Delete',
                              'Backspace',
                              'F2',
                              'ContextMenu',
                              'F10',
                            ].includes(event.key) ||
                              (event.key === ' ' && !picked))
                          ) {
                            event.preventDefault()
                            return
                          }
                          if (
                            onMenu &&
                            (event.key === 'ContextMenu' ||
                              (event.shiftKey && event.key === 'F10'))
                          ) {
                            event.preventDefault()
                            onMenu(
                              item.id,
                              event.currentTarget,
                              menuGroup(item.id),
                            )
                            return
                          }
                          const extend = event.shiftKey ? item.id : undefined
                          if (picked && !event.altKey && !event.shiftKey) {
                            if (event.key === ' ') {
                              event.preventDefault()
                              toggleSelected(item.id)
                              return
                            }
                            if (
                              (event.metaKey || event.ctrlKey) &&
                              event.key.toLowerCase() === 'a'
                            ) {
                              event.preventDefault()
                              event.stopPropagation()
                              choose(rows.map((row) => row.item.id))
                              return
                            }
                          }
                          switch (event.key) {
                            case 'ArrowDown':
                              event.preventDefault()
                              focus(
                                rows[Math.min(index + 1, rows.length - 1)]?.item
                                  .id,
                                extend,
                              )
                              break
                            case 'ArrowUp':
                              event.preventDefault()
                              focus(
                                rows[Math.max(index - 1, 0)]?.item.id,
                                extend,
                              )
                              break
                            case 'Home':
                              event.preventDefault()
                              focus(rows[0]?.item.id, extend)
                              break
                            case 'End':
                              event.preventDefault()
                              focus(rows.at(-1)?.item.id, extend)
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
                        {dirty && (
                          <span className="sidebar-dirty" aria-hidden="true">
                            ●
                          </span>
                        )}
                        {decoration?.badge && (
                          <span
                            className="sidebar-decoration"
                            aria-hidden="true"
                          >
                            {decoration.badge}
                          </span>
                        )}
                      </button>
                    )}
                    {onMenu && editing?.id !== item.id && (
                      <button
                        type="button"
                        className="sidebar-more"
                        aria-disabled={disabled || pending || undefined}
                        tabIndex={
                          windowed && focusId !== item.id ? -1 : undefined
                        }
                        aria-label={`Actions for ${item.label}`}
                        aria-haspopup="menu"
                        onClick={(event) => {
                          if (disabled || pending) return
                          setFocused(item.id)
                          onMenu(
                            item.id,
                            event.currentTarget,
                            menuGroup(item.id),
                          )
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
