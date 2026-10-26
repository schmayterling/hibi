import { Extension } from '@tiptap/core'
import type { Node } from '@tiptap/pm/model'
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state'
import { type Mappable, ReplaceStep } from '@tiptap/pm/transform'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import {
  type TableLayout,
  type TableSize,
  tableSizeChanges,
} from '../../shared/table-layout'
import { richSourceEcho } from './rich-source-session'
import {
  tableKey as layoutKey,
  readTableLayouts,
  storedTableLayouts,
  updateTableLayouts,
} from './table-layout-store'

type Axis = 'column' | 'row'
type Handle = { table: number; axis: Axis; index: number }
/** Sizes in pixels by column or row index; 0 is automatic. */
type Sized = {
  pos: number
  columns: number[]
  rows: number[]
  versions?: WeakSet<Node>
  unique?: boolean
}
type State = {
  tables: Sized[]
  stored: TableLayout[]
  handle: Handle | null
  commits: number
  decorations: DecorationSet
}
type Meta = {
  load?: TableLayout[]
  handle?: Handle | null
  size?: Handle & { value: number; commit: boolean }
}

const key = new PluginKey<State>('tableLayout')
const EDGE = 5
const MIN = { column: 40, row: 24 }

function tablesIn(doc: Node) {
  const found: { pos: number; node: Node }[] = []
  doc.descendants((node, pos) => {
    if (node.type.name !== 'table') return !node.isTextblock
    found.push({ pos, node })
    return false
  })
  return found
}

// ponytail: header cell index is the column index. Markdown tables have no
// spans; a pasted HTML table with colspans would need TableMap here.
const columnCount = (table: Node) => table.firstChild?.childCount ?? 0

/** Ordinal plus a hash of the header row, so edits elsewhere keep sizes. */
function tableKey(index: number, table: Node) {
  const header: string[] = []
  table.firstChild?.forEach((cell) => {
    header.push(cell.textContent)
  })
  return layoutKey(index, header)
}

function bind(doc: Node, stored: TableLayout[], tracked: Sized[]): Sized[] {
  if (!stored.length) return tracked
  const known = new Map(stored.map((table) => [table.key, table]))
  const bound = [...tracked]
  tablesIn(doc).forEach(({ pos, node }, index) => {
    const table = known.get(tableKey(index, node))
    if (table && !tracked.some((sized) => sized.pos === pos))
      bound.push({ pos, columns: table.columns ?? [], rows: table.rows ?? [] })
  })
  return bound
}

/** A source sync replaces the whole document; carry sizes over by table order. */
function rebind(before: Node, tracked: Sized[], doc: Node): Sized[] {
  const previous = tablesIn(before)
  const next = tablesIn(doc)
  return tracked.flatMap((sized) => {
    const index = previous.findIndex((table) => table.pos === sized.pos)
    const old = previous[index]
    const table = next[index]
    if (!old || !table) return []
    const same =
      tableKey(index, old.node) === tableKey(index, table.node) &&
      columnCount(old.node) === columnCount(table.node)
    return same
      ? [{ pos: table.pos, columns: sized.columns, rows: sized.rows }]
      : []
  })
}

/** Start positions of a table's rows, or of its header cells. */
function starts(table: Node, pos: number, axis: Axis) {
  const parent = axis === 'row' ? table : table.firstChild
  const found: number[] = []
  parent?.forEach((_, offset) => {
    found.push(pos + (axis === 'row' ? 1 : 2) + offset)
  })
  return found
}

/**
 * Carry each size to wherever its row or column moved. A replaced one keeps
 * its index unless the step removed rows or columns; deleted ones drop.
 */
function follow(
  sizes: number[],
  before: number[],
  after: number[],
  map: Mappable,
) {
  const moved: number[] = []
  const replaced: number[] = []
  sizes.forEach((size, index) => {
    const result = size ? map.mapResult(before[index] ?? -1, 1) : null
    const target = result ? after.indexOf(result.pos) : -1
    if (result && !result.deletedAfter && target >= 0) moved[target] = size
    else if (result && after.length >= before.length) replaced[index] = size
  })
  replaced.forEach((size, index) => {
    moved[index] ??= size
  })
  return Array.from(moved, (size) => size ?? 0)
}

/** Follow sized tables through an edit, noting the tables it changed. */
function mapped(
  tables: Sized[],
  tr: Transaction,
  before: Node,
  touched: number[],
): Sized[] {
  let beforeTables: ReturnType<typeof tablesIn> | undefined
  let afterTables: ReturnType<typeof tablesIn> | undefined
  return tables.flatMap<Sized>((sized) => {
    const result = tr.mapping.mapResult(sized.pos, 1)
    const table = tr.doc.nodeAt(result.pos)
    const old = before.nodeAt(sized.pos)
    // Share versions across plugin states so history can restore earlier nodes.
    let versions = sized.versions ?? new WeakSet<Node>()
    if (old) versions.add(old)
    if (
      old?.type.name === 'table' &&
      (result.deleted || result.deletedAfter || table?.type.name !== 'table')
    ) {
      // Block moves can replace a whole parent while retaining its table nodes.
      afterTables ??= tablesIn(tr.doc)
      const retained = afterTables.filter(({ node }) => versions.has(node))
      if (retained.length > 1) return []
      const moved = retained[0]
      if (moved) {
        beforeTables ??= tablesIn(before)
        if (beforeTables.filter(({ node }) => versions.has(node)).length !== 1)
          return []
        touched.push(moved.pos)
        return [{ ...sized, pos: moved.pos, versions, unique: true }]
      }
    }
    if (table?.type.name !== 'table') return []
    if (old === table) {
      // A replacement around an unchanged table, like a block move, still
      // drops its decorations.
      if (
        result.deleted ||
        tr.mapping.mapResult(sized.pos + table.nodeSize, -1).deleted
      )
        touched.push(result.pos)
      return [{ ...sized, pos: result.pos, versions, unique: false }]
    }
    touched.push(result.pos)
    if (result.deleted) return []
    if (!old) return [{ ...sized, pos: result.pos, unique: false }]
    const step = tr.steps.length === 1 ? tr.steps[0] : null
    // A single interior replacement cannot introduce this family elsewhere.
    let unique =
      !!sized.unique &&
      step instanceof ReplaceStep &&
      step.from > sized.pos &&
      step.to < sized.pos + old.nodeSize
    const end = tr.mapping.mapResult(sized.pos + old.nodeSize, -1)
    const intact =
      !result.deletedAfter &&
      !end.deletedBefore &&
      end.pos === result.pos + table.nodeSize
    if (!unique || !intact) {
      beforeTables ??= tablesIn(before)
      afterTables ??= tablesIn(tr.doc)
      unique =
        intact &&
        beforeTables.filter(({ node }) => versions.has(node)).length === 1 &&
        afterTables.filter(({ node }) => node === table || versions.has(node))
          .length === 1
    }
    if (unique) versions.add(table)
    else versions = new WeakSet([table])
    // Step by step, so a paste that first adds columns and then replaces
    // cells keeps sizes: rows or columns that were inserted or deleted carry
    // their sizes along instead of leaving them at their old index.
    let { pos, columns, rows } = sized
    tr.mapping.maps.forEach((map, step) => {
      const next = map.mapResult(pos, 1)
      const from = tr.docs[step]?.nodeAt(pos)
      const to = (tr.docs[step + 1] ?? tr.doc).nodeAt(next.pos)
      if (from?.type.name === 'table' && to?.type.name === 'table') {
        const axis = (name: Axis, sizes: number[]) =>
          (
            name === 'row'
              ? from.childCount === to.childCount
              : columnCount(from) === columnCount(to)
          )
            ? sizes
            : follow(
                sizes,
                starts(from, pos, name),
                starts(to, next.pos, name),
                map,
              )
        columns = axis('column', columns)
        rows = axis('row', rows)
      }
      pos = next.pos
    })
    return [{ pos: result.pos, columns, rows, versions, unique }]
  })
}

/** Size and resize-handle decorations of the table at `pos`. */
function tableDecorations(
  doc: Node,
  pos: number,
  sized: Sized | undefined,
  handle: Handle | null,
) {
  const decorations: Decoration[] = []
  const table = doc.nodeAt(pos)
  if (table?.type.name !== 'table') return decorations
  const node = (from: number, to: Node, attrs: Record<string, string>) =>
    decorations.push(Decoration.node(from, from + to.nodeSize, attrs))
  if (sized) {
    const columns = columnCount(table)
    if (sized.columns.some(Boolean))
      node(pos, table, {
        'data-columns-sized':
          sized.columns.length >= columns &&
          sized.columns.slice(0, columns).every(Boolean)
            ? 'all'
            : 'some',
      })
    table.forEach((row, offset, index) => {
      const start = pos + 1 + offset
      if (sized.rows[index])
        node(start, row, {
          style: `--table-row-height: ${sized.rows[index]}px`,
        })
      if (index === 0)
        row.forEach((cell, cellOffset, column) => {
          if (sized.columns[column])
            node(start + 1 + cellOffset, cell, {
              style: `width: ${sized.columns[column]}px`,
            })
        })
    })
  }
  if (handle?.table === pos)
    table.forEach((row, offset, index) => {
      const start = pos + 1 + offset
      row.forEach((cell, cellOffset, column) => {
        if ((handle.axis === 'row' ? index : column) === handle.index)
          node(start + 1 + cellOffset, cell, {
            'data-resize-handle': handle.axis,
          })
      })
    })
  return decorations
}

function decorate(doc: Node, tables: Sized[], handle: Handle | null) {
  if (!tables.length && !handle) return DecorationSet.empty
  const positions = new Set(tables.map((sized) => sized.pos))
  if (handle) positions.add(handle.table)
  return DecorationSet.create(
    doc,
    [...positions].flatMap((pos) =>
      tableDecorations(
        doc,
        pos,
        tables.find((sized) => sized.pos === pos),
        handle,
      ),
    ),
  )
}

/** Rebuild the tables at `positions`; other tables keep their decorations. */
function redecorate(
  decorations: DecorationSet,
  doc: Node,
  positions: number[],
  tables: Sized[],
  handle: Handle | null,
) {
  for (const pos of new Set(positions)) {
    const table = doc.nodeAt(pos)
    if (table?.type.name !== 'table') continue
    const end = pos + table.nodeSize
    decorations = decorations
      .remove(
        decorations
          .find(pos, end)
          .filter(
            (decoration) => decoration.from >= pos && decoration.to <= end,
          ),
      )
      .add(
        doc,
        tableDecorations(
          doc,
          pos,
          tables.find((sized) => sized.pos === pos),
          handle,
        ),
      )
  }
  return decorations
}

function layout(state: State, doc: Node): TableLayout[] {
  return tablesIn(doc)
    .flatMap(({ pos, node }, index) => {
      const sized = state.tables.find((table) => table.pos === pos)
      const columns = sized?.columns.slice(0, columnCount(node))
      const rows = sized?.rows.slice(0, node.childCount)
      return columns?.some(Boolean) || rows?.some(Boolean)
        ? [
            {
              key: tableKey(index, node),
              columns: columns?.some(Boolean) ? columns : null,
              rows: rows?.some(Boolean) ? rows : null,
            },
          ]
        : []
    })
    .slice(0, 1000)
}

/** The resize handle under the pointer, with the element whose size it sets. */
function handleAt(view: EditorView, event: MouseEvent) {
  const cell = (event.target as Element | null)?.closest?.('td, th')
  if (!(cell instanceof HTMLTableCellElement) || !view.dom.contains(cell))
    return null
  const row = cell.parentElement as HTMLTableRowElement
  const bounds = cell.getBoundingClientRect()
  let axis: Axis
  let element: Element | null
  if (bounds.right - event.clientX <= EDGE) {
    axis = 'column'
    element = cell
  } else if (event.clientX - bounds.left <= EDGE) {
    axis = 'column'
    element = cell.previousElementSibling
  } else if (bounds.bottom - event.clientY <= EDGE) {
    axis = 'row'
    element = row
  } else if (event.clientY - bounds.top <= EDGE) {
    axis = 'row'
    element = row.previousElementSibling
  } else return null
  if (!(element instanceof HTMLElement)) return null
  const $cell = view.state.doc.resolve(view.posAtDOM(cell, 0))
  for (let depth = $cell.depth; depth > 0; depth--)
    if ($cell.node(depth).type.name === 'table') {
      const index =
        element instanceof HTMLTableRowElement
          ? element.rowIndex
          : (element as HTMLTableCellElement).cellIndex
      return {
        handle: { table: $cell.before(depth), axis, index },
        element,
      }
    }
  return null
}

const same = (a: Handle | null, b: Handle | null) =>
  a === b ||
  (!!a &&
    !!b &&
    a.table === b.table &&
    a.axis === b.axis &&
    a.index === b.index)

/**
 * Column widths and row heights for tables in the visual editor. Sizes are
 * decorations, so they never enter the Markdown source or its history.
 */
export const tableLayout = Extension.create<{ tabId: string }>({
  name: 'tableLayout',
  addOptions: () => ({ tabId: '' }),
  addProseMirrorPlugins() {
    const { tabId } = this.options
    let dragging = false
    const setHandle = (view: EditorView, handle: Handle | null) => {
      if (!same(key.getState(view.state)?.handle ?? null, handle))
        view.dispatch(view.state.tr.setMeta(key, { handle } satisfies Meta))
    }
    return [
      new Plugin<State>({
        key,
        state: {
          init: () => ({
            tables: [],
            stored: [],
            handle: null,
            commits: 0,
            decorations: DecorationSet.empty,
          }),
          apply(tr, previous, before, state) {
            const meta = tr.getMeta(key) as Meta | undefined
            if (!meta && !tr.docChanged) return previous
            let { tables, stored, handle, commits, decorations } = previous
            // Tables whose decorations need rebuilding; null rebuilds all.
            let dirty: number[] | null = []
            if (tr.docChanged) {
              if (tr.getMeta(richSourceEcho)) {
                tables = bind(
                  state.doc,
                  stored,
                  rebind(before.doc, tables, state.doc),
                )
                dirty = null
              } else {
                tables = mapped(tables, tr, before.doc, dirty)
                decorations = decorations.map(tr.mapping, tr.doc)
              }
              const from = handle?.table ?? -1
              const table = handle && tr.mapping.mapResult(from, 1)
              handle =
                handle &&
                table &&
                !table.deleted &&
                state.doc.nodeAt(table.pos)?.type.name === 'table'
                  ? { ...handle, table: table.pos }
                  : null
              if (
                handle &&
                before.doc.nodeAt(from) !== state.doc.nodeAt(handle.table)
              )
                dirty?.push(handle.table)
            }
            if (meta?.load) {
              stored = meta.load
              tables = bind(state.doc, stored, tables)
              dirty = null
            }
            if (meta?.handle !== undefined) {
              if (handle) dirty?.push(handle.table)
              handle = meta.handle
              if (handle) dirty?.push(handle.table)
            }
            if (meta?.size) {
              const { table, axis, index, value, commit } = meta.size
              const existing = tables.find((sized) => sized.pos === table)
              const sized = existing
                ? { ...existing }
                : { pos: table, columns: [], rows: [] }
              const sizes = [...sized[axis === 'column' ? 'columns' : 'rows']]
              while (sizes.length <= index) sizes.push(0)
              sizes[index] = value
              sized[axis === 'column' ? 'columns' : 'rows'] = sizes
              tables = [...tables.filter((other) => other !== existing), sized]
              if (commit) commits++
              dirty?.push(table)
            }
            return {
              tables,
              stored,
              handle,
              commits,
              decorations: dirty
                ? redecorate(decorations, state.doc, dirty, tables, handle)
                : decorate(state.doc, tables, handle),
            }
          },
        },
        props: {
          decorations: (state) => key.getState(state)?.decorations,
          attributes: (state): Record<string, string> => {
            const handle = key.getState(state)?.handle
            return handle ? { 'data-table-resize': handle.axis } : {}
          },
          handleDOMEvents: {
            mousemove(view, event) {
              if (view.editable && !dragging)
                setHandle(view, handleAt(view, event)?.handle ?? null)
              return false
            },
            mouseleave(view) {
              if (!dragging) setHandle(view, null)
              return false
            },
            mousedown(view, event) {
              const found =
                view.editable && event.button === 0 && handleAt(view, event)
              if (!found) return false
              event.preventDefault()
              const { handle, element } = found
              const axis = handle.axis
              const frames = view.dom.ownerDocument.defaultView!
              const start = axis === 'column' ? event.clientX : event.clientY
              const bounds = element.getBoundingClientRect()
              const initial = axis === 'column' ? bounds.width : bounds.height
              let value: number | null = null
              let frame = 0
              const size = (commit: boolean) => {
                frame = 0
                if (value !== null && !view.isDestroyed)
                  view.dispatch(
                    view.state.tr.setMeta(key, {
                      size: { ...handle, value, commit },
                    } satisfies Meta),
                  )
              }
              const move = (moved: MouseEvent) => {
                const offset =
                  (axis === 'column' ? moved.clientX : moved.clientY) - start
                value = Math.min(
                  10000,
                  Math.max(MIN[axis], Math.round(initial + offset)),
                )
                frame ||= frames.requestAnimationFrame(() => size(false))
              }
              const finish = () => {
                frames.removeEventListener('mousemove', move)
                frames.removeEventListener('mouseup', finish)
                frames.cancelAnimationFrame(frame)
                dragging = false
                // A click without movement keeps the size; double-click resets it.
                size(true)
              }
              dragging = true
              setHandle(view, handle)
              frames.addEventListener('mousemove', move)
              frames.addEventListener('mouseup', finish)
              return true
            },
            dblclick(view, event) {
              const found = view.editable && handleAt(view, event)
              if (!found) return false
              event.preventDefault()
              view.dispatch(
                view.state.tr.setMeta(key, {
                  size: { ...found.handle, value: 0, commit: true },
                } satisfies Meta),
              )
              return true
            },
          },
        },
        view(view) {
          let timer: ReturnType<typeof setTimeout> | undefined
          let written = JSON.stringify(storedTableLayouts(tabId) ?? [])
          const save = () => {
            clearTimeout(timer)
            timer = undefined
            const state = key.getState(view.state)
            if (!state) return
            const tables = layout(state, view.state.doc)
            const json = JSON.stringify(tables)
            if (json === written) return
            const previous = JSON.parse(written) as TableLayout[]
            written = json
            // Only the sizes this editor changed: sizes other views and
            // windows stored since stay as they are.
            const before = new Map(previous.map((table) => [table.key, table]))
            const keys = new Set(tables.map((table) => table.key))
            const set: TableSize[] = []
            for (const table of tables)
              set.push(
                ...tableSizeChanges(
                  before.get(table.key) ?? {
                    key: table.key,
                    columns: null,
                    rows: null,
                  },
                  table,
                ),
              )
            updateTableLayouts(tabId, previous, {
              remove: previous
                .filter((table) => !keys.has(table.key))
                .map((table) => table.key),
              put: [],
              set,
            })
          }
          void Promise.resolve(readTableLayouts(tabId)).then(
            (tables) => {
              if (!tables?.length || view.isDestroyed) return
              written = JSON.stringify(tables)
              view.dispatch(
                view.state.tr.setMeta(key, { load: tables } satisfies Meta),
              )
            },
            (error: unknown) =>
              console.error('table sizes could not be read:', error),
          )
          return {
            update(view, previous) {
              const state = key.getState(view.state)
              const before = key.getState(previous)
              if (
                state &&
                before &&
                (state.commits !== before.commits ||
                  (view.state.doc !== previous.doc &&
                    (state.tables.length || before.tables.length)))
              ) {
                clearTimeout(timer)
                timer = setTimeout(save, 500)
              }
            },
            destroy() {
              if (timer) save()
            },
          }
        },
      }),
    ]
  },
})
