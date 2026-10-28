import { isolateHistory } from '@codemirror/commands'
import {
  type ChangeDesc,
  MapMode,
  Prec,
  type Text,
  Transaction,
} from '@codemirror/state'
import {
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view'
import { type MarkdownConfig, Table } from '@lezer/markdown'
import {
  type TableLayout,
  tableSizeChanges,
} from '../../../shared/table-layout.ts'
import {
  type FormattedContribution,
  type FormattedNodeView,
  followsLink,
  formattedDocument,
  formattedFollowLink,
  formattedLiteral,
  formattedMarkdown,
  formattedRenderInputs,
  formattedViews,
} from '../formatted-contributions.ts'
import { tableActions } from '../source-formatting.ts'
import {
  readTableLayouts,
  storedTableLayouts,
  subscribeTableLayouts,
  tableKey,
  updateTableLayouts,
} from '../table-layout-store.ts'
import {
  CellEditor,
  type CellHost,
  type CellMove,
  cellInput,
  cellLineBreak,
  markStarts,
  padding,
  renderInline,
  textStarts,
  writable,
} from './table-cells.ts'
import {
  alignments,
  cellContent,
  cellSpan,
  countTables,
  deleteColumn,
  deleteRow,
  insertColumn,
  insertRow,
  parseRow,
  rowStart,
  type TableAlignment,
  type TableEdit,
  type TableText,
} from './table-source.ts'
import './tables.css'

/*
 * GFM tables render as a table widget that looks like the rich editor's
 * tables, and a cell editor edits a cell's source in place. The widget reads
 * its rows from the source text, so a giant table needs no syntax nodes past
 * its header, and builds DOM only for the rows near the visible part.
 */

/** A one-line row: a 28px line, the paragraph's 16px gap, 16px padding and a border. */
const ROW_HEIGHT = 61
/** Tables up to this many rows render every row, so their columns size like the rich editor's. */
const ALL_ROWS = 200

type Line = { from: number; text: string }

/** What cells render with: the formatted view's syntax, renderers, syntax that is off and what renderers read. */
type CellConfig = {
  markdown: readonly MarkdownConfig[]
  views: readonly FormattedNodeView[]
  literal: readonly string[]
  inputs: readonly unknown[]
}

const sameConfig = (a: CellConfig, b: CellConfig) =>
  a.markdown === b.markdown &&
  a.views === b.views &&
  a.literal === b.literal &&
  a.inputs === b.inputs

/**
 * A table: lines `first` (header) to `first + rows + 1` of `doc`, replaced
 * from `from` to `to`. The text snapshot is enough to render; where the
 * table is now comes from the view.
 */
class TableWidget extends WidgetType {
  readonly doc: Text
  readonly from: number
  readonly to: number
  readonly first: number
  /** Where the table starts on its first line, after container markers. */
  readonly start: number
  readonly rows: number
  /** Quotes around the table, whose markers start its later lines. */
  readonly quotes: number
  /** In a quote or list: an inline widget on the container's line. */
  readonly inline: boolean
  readonly config: CellConfig
  constructor(
    doc: Text,
    from: number,
    to: number,
    first: number,
    start: number,
    rows: number,
    quotes: number,
    inline: boolean,
    config: CellConfig,
  ) {
    super()
    this.doc = doc
    this.from = from
    this.to = to
    this.first = first
    this.start = start
    this.rows = rows
    this.quotes = quotes
    this.inline = inline
    this.config = config
  }
  override eq(other: TableWidget) {
    return (
      other.doc === this.doc &&
      other.from === this.from &&
      other.to === this.to &&
      other.inline === this.inline &&
      sameConfig(other.config, this.config)
    )
  }
  override get estimatedHeight() {
    return (this.rows + 1) * ROW_HEIGHT
  }
  /** Line `index` of the table: 0 is the header, 1 the delimiter row. */
  line(index: number): Line {
    return this.doc.line(this.first + index)
  }
  /** Where a table line's row starts, relative to the line. */
  rowStart(index: number, text: string) {
    return index ? rowStart(text, this.quotes) : this.start
  }
  /** Cells and pipes of table line `index`, relative to its start. */
  row(index: number) {
    const { text } = this.line(index)
    const start = this.rowStart(index, text)
    return parseRow(text.slice(start), start)
  }
  toDOM(view: EditorView) {
    return new TableView(view, this).dom
  }
  override updateDOM(dom: HTMLElement, view: EditorView) {
    const table = tableViews.get(dom)
    if (!table || table.view !== view) return false
    table.update(this)
    return true
  }
  override destroy(dom: HTMLElement) {
    tableViews.get(dom)?.destroy()
  }
}

/** Heights of body rows with prefix sums; rows keep an estimate until they render. */
class Heights {
  private sums: Float64Array
  private values: Float64Array
  readonly length: number
  constructor(length: number) {
    this.length = length
    this.values = new Float64Array(length).fill(ROW_HEIGHT)
    this.sums = new Float64Array(length + 1)
    for (let i = 1; i <= length; i++) {
      this.sums[i]! += ROW_HEIGHT
      const parent = i + (i & -i)
      if (parent <= length) this.sums[parent]! += this.sums[i]!
    }
  }
  set(index: number, height: number) {
    const delta = height - this.values[index]!
    if (!delta) return
    this.values[index] = height
    for (let i = index + 1; i <= this.length; i += i & -i)
      this.sums[i]! += delta
  }
  /** The height of the rows before `index`. */
  before(index: number) {
    let sum = 0
    for (let i = index; i > 0; i -= i & -i) sum += this.sums[i]!
    return sum
  }
  /** The row at `y` below the first row's top. */
  at(y: number) {
    let index = 0
    for (
      let step = 2 ** Math.floor(Math.log2(this.length || 1));
      step;
      step >>= 1
    )
      if (index + step <= this.length && this.sums[index + step]! <= y) {
        index += step
        y -= this.sums[index]!
      }
    return Math.min(index, this.length - 1)
  }
}

/** The part of the window's height that `element`'s scrolling ancestors show. */
function visibleBand(element: HTMLElement) {
  let top = 0,
    bottom = element.ownerDocument.defaultView?.innerHeight ?? 0
  for (let node = element.parentElement; node; node = node.parentElement) {
    if (getComputedStyle(node).overflowY === 'visible') continue
    const rect = node.getBoundingClientRect()
    top = Math.max(top, rect.top)
    bottom = Math.min(bottom, rect.bottom)
  }
  return { top, bottom }
}

/** Pointer distance from a cell edge that resizes its column or row, and the smallest sizes. */
const EDGE = 5
const MIN = { column: 40, row: 24 }

/** Counts the column and row positions size tracking maps, for tests. */
export const tableSizeProbe = { mapped: 0 }

/** A focusable size handle on a cell's edge, for keyboard resizing. */
const resizers = {
  column: { 'aria-label': 'Resize column', 'aria-orientation': 'vertical' },
  row: { 'aria-label': 'Resize row', 'aria-orientation': 'horizontal' },
}
function resizer(axis: 'column' | 'row') {
  const handle = document.createElement('hr')
  handle.className = 'hibi-lp-table-resizer'
  handle.dataset.axis = axis
  handle.tabIndex = 0
  for (const [name, value] of Object.entries(resizers[axis]))
    handle.setAttribute(name, value)
  return handle
}

/** The tab a formatted view shows and the table sizes read for it, shared with the rich editor. */
type Store = { tabId: string; loaded: TableLayout[] | null }
const stores = new WeakMap<EditorView, Store>()
function store(view: EditorView): Store | null {
  const { tabId } = view.state.facet(formattedDocument)
  if (!tabId) return null
  const found = stores.get(view)
  if (found?.tabId === tabId) return found
  const entry: Store = { tabId, loaded: null }
  stores.set(view, entry)
  const loaded = (tables: TableLayout[] | null) => {
    if (stores.get(view) !== entry) return
    entry.loaded = tables ?? []
    for (const table of mounted.get(view) ?? []) table.sized()
  }
  const read = readTableLayouts(tabId)
  if (Array.isArray(read)) entry.loaded = read
  else
    void read.then(loaded, (error: unknown) =>
      console.error('table sizes could not be read:', error),
    )
  return entry
}
/** The sizes stored for a view's tab now: this window's, once it stored any. */
const storedTables = (entry: Store | null) =>
  entry && (storedTableLayouts(entry.tabId) ?? entry.loaded)

/** A table's sizes as a view holds them, and their positions through changes since the last redraw. */
type SizeState = {
  sizes: { key: string | null; columns: number[]; rows: Map<number, number> }
  header: string[]
  moved: Moved | null
  /** What the store has for the table, as last bound or saved. */
  stored: string | null
}
type Moved = {
  columns: (number | null)[]
  /** The header cells' text, which finds columns whose cells a change rewrote. */
  texts: string[]
  rows: { index: number; size: number; pos: number | null }[]
  sizes: { columns: number[] }
  count: number
  lines: number
}
/** Where a table may start and end after a change: text inserted at its edges may or may not join it. */
type Place = { from: number[]; to: number[] }
const placed = (place: Place, widget: TableWidget) =>
  place.from.includes(widget.from) && place.to.includes(widget.to)
/**
 * Size state of the tables an update changes, by where each table is after
 * it: CodeMirror may show a table in another table's view after an edit, so
 * state follows the table, not the view.
 */
const handoffs = new WeakMap<
  EditorView,
  { place: Place; state: SizeState; owner: TableView }[]
>()

const tableViews = new WeakMap<HTMLElement, TableView>()
/** Mounted tables per editor, for row windows, entering tables and table actions. */
const mounted = new WeakMap<EditorView, Set<TableView>>()

type Rendered = { element: HTMLTableRowElement; text: string }

/** A cell by table line (0 the header, 2 the first row) and column. */
type Cell = { line: number; column: number }
/** Where an edited row was when a change deleted it, in the document now, and the edited column. */
type Lost = { at: number; column: number }

/** The DOM of one table widget: header, then all rows or the window of rows in view, and the cell being edited. */
class TableView {
  readonly dom = document.createElement('div')
  private table = document.createElement('table')
  private columns = document.createElement('colgroup')
  private body = document.createElement('tbody')
  private head = document.createElement('tr')
  private headText = ''
  private delimiterText = ''
  private aligned: TableAlignment[] = []
  /** Rendered body rows by index; the delimiter row is not rendered. */
  private rendered = new Map<number, Rendered>()
  private start = 0
  private end = 0
  /** Body rows render in a window between spacer rows. */
  private heights: Heights | null = null
  private before: HTMLTableRowElement | null = null
  private after: HTMLTableRowElement | null = null
  private fixed = false
  /** The column widths fixed from the first rows shown, which automatic columns go back to. */
  private fixedWidths: string[] = []
  /** The cell being edited, with its row's line in the document now. */
  private editing:
    | (Cell & {
        editor: CellEditor
        element: Element
        from: number
        to: number
      })
    | null = null
  /** Header cells' text, part of the table's key in the size store. */
  private header: string[] = []
  /** Column widths by index, 0 for automatic, and the heights of sized rows by index, counting the header. */
  private sizes: {
    key: string | null
    columns: number[]
    rows: Map<number, number>
  } = { key: null, columns: [], rows: new Map() }
  /** The column or row edge under the pointer, and whether it is being dragged. */
  private handle: { axis: 'column' | 'row'; index: number } | null = null
  private dragging = false
  private saving: ReturnType<typeof setTimeout> | undefined
  private unsubscribe: (() => void) | null = null
  /** Sized columns' header cells and sized rows' lines through changes since the last redraw, null where deleted. */
  private moved: Moved | null = null
  /** Sizes of columns edits removed, with their index and header text, for when a column comes back there. */
  private dropped: { index: number; size: number; text: string }[] = []
  /** The stored entry as last bound or saved, so saves that change nothing write nothing. */
  private stored: string | null = null
  /** Where the table is after the change being applied, while its state is handed over. */
  private place: Place | null = null

  readonly view: EditorView
  private widget: TableWidget
  constructor(view: EditorView, widget: TableWidget) {
    this.view = view
    this.widget = widget
    this.dom.className = 'tableWrapper hibi-lp-table'
    this.dom.addEventListener('mousedown', this.select)
    this.dom.addEventListener('mousemove', this.hover)
    this.dom.addEventListener('mouseleave', this.leaveHandle)
    this.dom.addEventListener('dblclick', this.reset)
    this.dom.addEventListener('keydown', this.key)
    this.dom.addEventListener('click', this.followLink)
    this.dom.addEventListener('contextmenu', this.followLink)
    this.table.append(this.columns, this.body)
    this.dom.append(this.table)
    this.body.append(this.head)
    tableViews.set(this.dom, this)
    const tables = mounted.get(view) ?? new Set()
    mounted.set(view, tables.add(this))
    this.update(widget)
  }

  /** Cell positions are valid only for the widget's text snapshot. */
  get current() {
    return this.widget.doc === this.view.state.doc
  }

  get windowed() {
    return this.heights !== null
  }

  get lines() {
    return this.widget.rows + 2
  }

  update(widget: TableWidget) {
    const previous = this.widget
    this.widget = widget
    this.takeOver()
    this.relocate()
    this.followSizes()
    this.dom.classList.toggle('hibi-lp-table-inline', widget.inline)
    const header = widget.line(0),
      delimiter = widget.line(1).text
    const aligned = alignments(delimiter.slice(widget.rowStart(1, delimiter)))
    if (
      delimiter !== this.delimiterText ||
      aligned.length !== this.aligned.length ||
      widget.row(0).cells.length !== this.head.cells.length
    ) {
      // New columns or alignments: every row renders again.
      this.stopEditing()
      this.delimiterText = delimiter
      this.aligned = aligned
      this.headText = ''
      for (const row of this.rendered.values()) row.element.remove()
      this.rendered.clear()
      this.heights = null
      this.start = this.end = 0
    }
    if (header.text !== this.headText) {
      if (this.editing?.line === 0) this.refresh(this.head, 0, this.headText)
      else this.renderHead(header)
      this.headText = header.text
      const texts = this.headerTexts()
      const renamed =
        this.header.length > 0 && texts.join('\t') !== this.header.join('\t')
      this.header = texts
      // Sized tables keep their sizes under the new header; others look theirs up.
      if (!this.sizes.key) this.sized()
      else if (renamed) this.save(500)
    }
    const windowed = widget.rows > ALL_ROWS
    if (
      windowed !== this.windowed ||
      (this.heights && this.heights.length !== widget.rows)
    ) {
      // The edited row stays; the others render again.
      const editing = this.editing ? this.editing.line - 2 : -1
      for (const [index, row] of this.rendered)
        if (index !== editing) {
          row.element.remove()
          this.rendered.delete(index)
        }
      this.heights = windowed ? new Heights(widget.rows) : null
      this.seedHeights()
      this.start = this.end = 0
      this.fixed = false
      this.fixedWidths = []
      this.table.style.tableLayout = ''
      for (const column of this.columns.children)
        (column as HTMLElement).style.width = ''
    }
    this.table.setAttribute('aria-rowcount', String(widget.rows + 1))
    if (this.heights) {
      this.before ??= this.spacer()
      this.after ??= this.spacer()
      if (!this.before.isConnected) this.head.after(this.before)
      if (!this.after.isConnected) this.body.append(this.after)
      this.show(this.start, Math.min(widget.rows, Math.max(this.end, 20)))
      this.scrolled()
    } else {
      this.before?.remove()
      this.after?.remove()
      this.show(0, widget.rows)
    }
    if (!sameConfig(previous.config, widget.config)) {
      // New syntax or render inputs redraw cells without unmounting the editor.
      this.refresh(this.head, 0, this.headText, true)
      for (const [index, row] of this.rendered)
        this.refresh(row.element, index + 2, row.text, true)
      this.editing?.editor.refresh()
    }
    this.applySizes()
    this.syncEditor()
  }

  private spacer() {
    const row = document.createElement('tr')
    row.className = 'hibi-lp-table-spacer'
    row.setAttribute('aria-hidden', 'true')
    const cell = document.createElement('td')
    cell.colSpan = this.aligned.length
    row.append(cell)
    return row
  }

  private renderHead(header: Line) {
    const cells = this.widget.row(0).cells
    const count = cells.length
    this.table.style.minWidth = `${count * 25}px`
    this.columns.replaceChildren(
      ...Array.from({ length: count }, () => {
        const column = document.createElement('col')
        column.style.minWidth = '25px'
        return column
      }),
    )
    this.head.replaceChildren(
      ...cells.map((cell, index) => this.cell('th', header, cell, index)),
    )
    this.head.setAttribute('aria-rowindex', '1')
    this.head.dataset.line = '0'
    for (const spacer of [this.before, this.after])
      (spacer?.firstElementChild as HTMLTableCellElement | null)?.setAttribute(
        'colspan',
        String(count),
      )
  }

  private cell(
    tag: 'th' | 'td',
    line: Line,
    cell: { from: number; to: number } | undefined,
    column: number,
  ) {
    const element = document.createElement(tag)
    const align = this.aligned[column]
    if (align) element.style.textAlign = align
    // Header cells carry their column's width, also when they render again.
    const width = tag === 'th' ? this.sizes.columns[column] : 0
    if (width) element.style.width = `${width}px`
    const paragraph = document.createElement('p')
    const content = cell
      ? cellContent(line.text.slice(cell.from, cell.to))
      : null
    if (content?.text && cell)
      renderInline(
        this.view,
        content.text,
        paragraph,
        this.now(line.from + cell.from),
        content.source,
      )
    else paragraph.append(document.createElement('br'))
    element.append(paragraph)
    // Keyboard handles for the column's width and the row's height.
    if (tag === 'th') element.append(resizer('column'))
    if (column === 0) element.append(resizer('row'))
    return element
  }

  /** Render changed cells, or all of them, except the one being edited. */
  private refresh(
    row: HTMLTableRowElement,
    index: number,
    previous: string,
    force = false,
  ) {
    const line = this.widget.line(index)
    const start = this.widget.rowStart(index, previous)
    const before = parseRow(previous.slice(start), start).cells
    const after = this.widget.row(index).cells
    for (let column = 0; column < row.cells.length; column++) {
      const element = row.cells[column]
      if (!element || element === this.editing?.element) continue
      const a = before[column],
        b = after[column]
      if (
        !force &&
        (a && b
          ? previous.slice(a.from, a.to) === line.text.slice(b.from, b.to)
          : !a && !b)
      )
        continue
      element.replaceWith(this.cell(index ? 'td' : 'th', line, b, column))
    }
  }

  /** Render body rows `from`-`to`, keeping rendered rows whose text is unchanged. */
  private show(from: number, to: number) {
    const { widget } = this
    const editing = this.editing ? this.editing.line - 2 : -1
    for (const [index, row] of this.rendered)
      if ((index < from || index >= to) && index !== editing) {
        row.element.remove()
        this.rendered.delete(index)
      }
    let next: Element | null = this.after
    for (let index = to - 1; index >= from; index--) {
      const line = widget.line(index + 2)
      let rendered = this.rendered.get(index)
      if (rendered && rendered.text !== line.text && index === editing) {
        this.refresh(rendered.element, index + 2, rendered.text)
        rendered.text = line.text
      } else if (!rendered || rendered.text !== line.text) {
        const element = document.createElement('tr')
        element.dataset.line = String(index + 2)
        element.setAttribute('aria-rowindex', String(index + 2))
        const height = this.sizes.rows.get(index + 1)
        if (height) element.style.height = `${height}px`
        // Missing cells render empty; cells past the header's count are not shown.
        const cells = widget.row(index + 2).cells
        for (let column = 0; column < this.aligned.length; column++)
          element.append(this.cell('td', line, cells[column], column))
        if (rendered) rendered.element.replaceWith(element)
        rendered = { element, text: line.text }
        this.rendered.set(index, rendered)
      }
      if (
        rendered.element.nextElementSibling !== next ||
        !rendered.element.isConnected
      )
        this.body.insertBefore(rendered.element, next)
      next = rendered.element
    }
    // The row being edited stays mounted next to the window.
    const kept = this.rendered.get(editing)?.element
    if (kept && (editing < from || editing >= to))
      if (editing < from) (this.before ?? this.head).after(kept)
      else this.body.insertBefore(kept, this.after)
    this.start = from
    this.end = to
    if (this.heights) {
      this.spacerHeight(this.before, this.heights.before(from))
      this.spacerHeight(
        this.after,
        this.heights.before(widget.rows) - this.heights.before(to),
      )
    }
  }

  private spacerHeight(spacer: HTMLTableRowElement | null, height: number) {
    const cell = spacer?.firstElementChild as HTMLElement | null | undefined
    if (cell) cell.style.height = `${height}px`
    spacer?.classList.toggle('hibi-lp-table-empty', height < 0.5)
  }

  /** Layout reads: rendered row heights and where the visible band falls in the body. */
  private read() {
    const heights: [number, number][] = []
    for (const [index, row] of this.rendered)
      if (index >= this.start && index < this.end)
        heights.push([index, row.element.getBoundingClientRect().height])
    const band = visibleBand(this.dom)
    const top = this.head.getBoundingClientRect().bottom
    const bottom = this.dom.getBoundingClientRect().bottom
    const widths = this.fixed
      ? null
      : [...this.head.children].map(
          (cell) => cell.getBoundingClientRect().width,
        )
    return { heights, band, top, bottom, widths }
  }

  private write(measured: ReturnType<TableView['read']>) {
    const heights = this.heights
    if (!heights || !this.dom.isConnected) return
    const total = heights.before(heights.length)
    for (const [index, height] of measured.heights)
      if (index < heights.length) heights.set(index, height)
    // Columns keep the widths of the first rows shown while other rows scroll in.
    if (measured.widths && !this.fixed) {
      const total = measured.widths.reduce((sum, width) => sum + width, 0)
      if (total > 0) {
        this.fixed = true
        this.table.style.tableLayout = 'fixed'
        this.fixedWidths = measured.widths.map(
          (width) => `${(width / total) * 100}%`,
        )
        this.fixedWidths.forEach((width, index) => {
          const column = this.columns.children[index] as HTMLElement | undefined
          if (column) column.style.width = width
        })
      }
    }
    const { band, top, bottom } = measured
    const margin = Math.max(band.bottom - band.top, 200)
    let from = this.start,
      to = this.end
    if (bottom > band.top - margin && top < band.bottom + margin) {
      const first = heights.at(Math.max(0, band.top - top - margin))
      const last = heights.at(Math.max(0, band.bottom - top + margin)) + 1
      // Keep the window while it still covers the visible rows.
      const shown =
        heights.before(this.start) <= Math.max(0, band.top - top) &&
        heights.before(this.end) >=
          Math.min(heights.before(heights.length), band.bottom - top)
      if (!shown || this.end <= this.start) {
        from = first
        to = Math.min(heights.length, Math.max(last, first + 1))
      }
    }
    const changed =
      from !== this.start ||
      to !== this.end ||
      Math.abs(heights.before(heights.length) - total) > 0.5
    this.show(from, to)
    // Measure the new rows and let the editor see the table's new height.
    if (changed) this.scrolled()
  }

  /** Scrolling moves the window of rendered rows. */
  scrolled() {
    if (!this.heights) return
    this.view.requestMeasure({
      key: this,
      read: () => this.read(),
      write: (measured) => this.write(measured),
    })
  }

  /** Where the table is now: the range its widget replaces. */
  range() {
    const from = this.view.posAtDOM(this.dom)
    return { from, to: from + this.widget.to - this.widget.from }
  }

  /** A position of the widget's text snapshot, where it is now. */
  private now(snapshot: number) {
    return this.dom.isConnected
      ? this.range().from - this.widget.from + snapshot
      : snapshot
  }

  /** The cell at a position of the formatted view's document, with the offset in its text. */
  locate(pos: number): (Cell & { offset: number | 'end' }) | null {
    if (!this.current) return null
    const { widget } = this
    const snapshot = pos - this.range().from + widget.from
    const index = widget.doc.lineAt(snapshot).number - widget.first
    const line = Math.max(0, Math.min(this.lines - 1, index === 1 ? 0 : index))
    const { from, text } = widget.line(line)
    const row = widget.row(line)
    const count = Math.min(row.cells.length, this.aligned.length)
    for (let column = 0; column < count; column++) {
      const span = cellSpan(row, column, text.length)!
      if (snapshot - from <= span.to || column === count - 1)
        return {
          line,
          column,
          offset: Math.max(0, Math.min(span.to, snapshot - from) - span.from),
        }
    }
    return { line, column: 0, offset: 'end' }
  }

  /** A cell's text between its delimiters now; null while stale or its row ends before it. */
  private span({ line, column }: Cell) {
    if (!this.current) return null
    const { text, from } = this.widget.line(line)
    const span = cellSpan(this.widget.row(line), column, text.length)
    if (!span) return null
    return {
      from: this.now(from + span.from),
      to: this.now(from + span.to),
      closed: span.closed,
    }
  }

  /** The table's lines in the document now, for its source edits. */
  private source(): TableText {
    const { doc } = this.view.state
    const first = doc.lineAt(this.range().from).number
    return {
      lines: this.lines,
      line: (index) => doc.line(first + index),
      start: this.widget.start,
      quotes: this.widget.quotes,
    }
  }

  /** Edit a cell, with the caret at its content's start or end or at an offset in its text. */
  edit(
    line: number,
    column: number,
    at: 'start' | 'end' | number,
    head?: number,
  ) {
    if (line === 1) line = 0
    if (
      line < 0 ||
      line >= this.lines ||
      !this.aligned.length ||
      !this.current ||
      !writable(this.view.state)
    )
      return false
    column = Math.max(0, Math.min(column, this.aligned.length - 1))
    this.stopEditing()
    if (line > 1 && !this.rendered.has(line - 2)) this.reveal(line - 2)
    const row = line ? this.rendered.get(line - 2)?.element : this.head
    const element = row?.cells[column]
    const paragraph = element?.firstElementChild
    if (!element || !(paragraph instanceof HTMLElement)) return false
    const span = this.span({ line, column })
    // A row that ends before the cell gets it on the first input.
    const text = span ? this.view.state.sliceDoc(span.from, span.to) : '  '
    // The caret goes in the content, not the padding around it.
    const { start, end } = padding(text)
    const clamp = (pos: number) => Math.max(start, Math.min(pos, end))
    const anchor = at === 'start' ? start : at === 'end' ? end : clamp(at)
    paragraph.replaceChildren()
    const editor = new CellEditor(
      this.host(),
      paragraph,
      text,
      anchor,
      head === undefined ? anchor : clamp(head),
    )
    const source = this.widget.line(line)
    this.editing = {
      line,
      column,
      editor,
      element,
      from: this.now(source.from),
      to: this.now(source.from + source.text.length),
    }
    editor.focus()
    editor.mirror()
    element.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    return true
  }

  /** Edit the cell at a selection of the formatted view's document, when it stays in one cell. */
  editAt(anchor: number, head = anchor) {
    const { from: start, to: end } = this.range()
    if (anchor < start || anchor > end || head < start || head > end)
      return false
    const cell = this.locate(head)
    if (!cell) return false
    const { line, column, offset } = cell
    const from = anchor === head ? null : this.locate(anchor)
    if (from && (from.line !== line || from.column !== column)) return false
    return this.edit(
      line,
      column,
      from?.offset ?? offset,
      offset === 'end' ? undefined : offset,
    )
  }

  /** Render a window of rows around row `index`, for editing it. */
  private reveal(index: number) {
    const from = Math.max(0, index - 10)
    this.show(from, Math.min(this.widget.rows, Math.max(index + 10, from + 1)))
    this.scrolled()
  }

  private host(): CellHost {
    return {
      main: this.view,
      current: () => this.current,
      span: () => (this.editing ? this.span(this.editing) : null),
      fill: (text) => this.fill(text),
      move: (move) => this.move(move),
      leave: (after) => this.leave(after),
      blurred: (editor) => {
        if (this.editing?.editor === editor) this.stopEditing()
      },
    }
  }

  /** The change that ends the edited row with its cell, holding `text`. */
  private fill(text: string) {
    const { line, column } = this.editing!
    const source = this.source().line(line)
    const start = this.widget.rowStart(line, source.text)
    const row = parseRow(source.text.slice(start), source.from + start)
    const last = row.pipes.at(-1)
    const trailing =
      last !== undefined &&
      !source.text.slice(last - source.from + 1).trim() &&
      (!row.cells.length || row.cells.at(-1)!.to <= last)
    const empty = '  |'.repeat(Math.max(0, column - row.cells.length))
    return trailing
      ? { from: last + 1, insert: `${empty}${text}|` }
      : {
          from: source.from + source.text.length,
          insert: ` |${empty}${text}|`,
        }
  }

  private move(move: CellMove): boolean {
    if (!this.editing) return false
    const { line, column } = this.editing
    // The last row to edit; a table of only a header has no body rows yet.
    const last = this.lines > 2 ? this.lines - 1 : 0,
      columns = this.aligned.length
    const below = line === 0 ? 2 : line + 1,
      above = line === 2 ? 0 : line - 1
    switch (move) {
      case 'next':
      case 'right':
        if (column + 1 < columns) return this.edit(line, column + 1, 'start')
        if (line < last) return this.edit(below, 0, 'start')
        // Tab in the last cell adds a row, as in the rich editor.
        if (move === 'next' && this.run('row-after')) return true
        this.leave(true)
        return true
      case 'previous':
      case 'left':
        if (column > 0) return this.edit(line, column - 1, 'end')
        if (line > 0) return this.edit(above, columns - 1, 'end')
        if (move === 'left') this.leave(false)
        return true
      case 'down':
        if (line < last) return this.edit(below, column, 'end')
        this.leave(true)
        return true
      case 'up':
        if (line > 0) return this.edit(above, column, 'end')
        this.leave(false)
        return true
    }
  }

  /**
   * Back to the formatted view, on the line after or before the table. A
   * table at the document's end or start gets an empty paragraph there:
   * text on the line right after a table would be one of its rows.
   */
  leave(after: boolean) {
    if (!this.current) return
    const { doc } = this.view.state
    const { from, to } = this.range()
    this.stopEditing()
    const before = doc.lineAt(from).from,
      end = doc.lineAt(to).to
    // Whether only blank lines follow the table.
    let last = after
    for (let pos = end; last && pos < doc.length; ) {
      const line = doc.lineAt(pos + 1)
      last = !line.text.trim()
      pos = line.to
    }
    let anchor = after ? end + 1 : before - 1
    let insert: { from: number; insert: string } | null = null
    if (last) {
      if (doc.sliceString(end, end + 2) !== '\n\n')
        insert = { from: end, insert: '\n\n' }
      anchor = end + 2
    } else if (!after && before === 0) {
      insert = { from: 0, insert: '\n\n' }
      anchor = 0
    }
    // A read-only view only moves the caret.
    if (!writable(this.view.state)) {
      insert = null
      anchor = Math.max(0, Math.min(anchor, doc.length))
    }
    this.view.dispatch({
      ...(insert ? { changes: insert } : {}),
      selection: { anchor },
      scrollIntoView: true,
      userEvent: insert ? 'input' : 'select',
    })
    this.view.focus()
  }

  stopEditing(redraw = true) {
    const editing = this.editing
    if (!editing) return
    this.editing = null
    editing.editor.destroy()
    // The cell renders statically again unless its table is being removed.
    if (redraw && editing.line < this.lines && editing.element.isConnected)
      editing.element.replaceWith(
        this.cell(
          editing.line ? 'td' : 'th',
          this.widget.line(editing.line),
          this.widget.row(editing.line).cells[editing.column],
          editing.column,
        ),
      )
  }

  /** Follow the edited row through the formatted view's changes; where it was when they deleted it. */
  map(changes: ChangeDesc): Lost | null {
    this.track(changes)
    this.handOver(changes)
    const editing = this.editing
    if (!editing) return null
    editing.from = changes.mapPos(editing.from, 1)
    editing.to = changes.mapPos(editing.to, -1)
    return editing.to > editing.from
      ? null
      : { at: editing.from, column: editing.column }
  }

  /** Offer this table's size state to the view that shows the table after a change. */
  private handOver(changes: ChangeDesc) {
    const { from, to } = this.range()
    const sized =
      this.sizes.key !== null ||
      this.sizes.rows.size > 0 ||
      this.sizes.columns.some(Boolean)
    // A table or line added or removed above may change its ordinal: check its key once edits pause.
    if (sized && changes.touchesRange(0, Math.max(0, from - 1))) this.save(500)
    if (!sized) return
    const place = {
      from: [changes.mapPos(from, -1), changes.mapPos(from, 1)],
      to: [changes.mapPos(to, -1), changes.mapPos(to, 1)],
    }
    this.place = place
    let entries = handoffs.get(this.view)
    if (!entries) {
      const created: { place: Place; state: SizeState; owner: TableView }[] = []
      handoffs.set(this.view, created)
      // Only for the redraw of this update.
      queueMicrotask(() => {
        if (handoffs.get(this.view) === created) handoffs.delete(this.view)
      })
      entries = created
    }
    entries.push({
      place,
      owner: this,
      state: {
        sizes: this.sizes,
        header: this.header,
        moved: this.moved,
        stored: this.stored,
      },
    })
    queueMicrotask(() => {
      if (this.place === place) this.place = null
    })
  }

  /** Take the size state of the table this view shows now, which another view may have held. */
  private takeOver() {
    const { widget } = this
    const place = this.place
    this.place = null
    if (widget.doc !== this.view.state.doc) return
    if (place && placed(place, widget)) return
    const state = handoffs
      .get(this.view)
      ?.find(
        (entry) => entry.owner !== this && placed(entry.place, widget),
      )?.state
    if (!place && !state) return
    // Another table than before: its own state, or none until it is looked up.
    clearTimeout(this.saving)
    this.saving = undefined
    this.stopEditing()
    this.sizes = state?.sizes ?? { key: null, columns: [], rows: new Map() }
    this.header = state?.header ?? []
    this.moved = state?.moved ?? null
    this.stored = state?.stored ?? null
    // Taken over after a change: its ordinal may have changed with it.
    if (state) this.save(500)
  }

  /**
   * Map the header cells of sized columns and the lines of sized rows
   * through a change of the table, any change (table actions, typing, undo
   * and redo), so that sizes follow their columns and rows as in the rich
   * editor. A column or row whose position the change deleted drops, unless
   * the table kept as many: then it was replaced and keeps its index.
   */
  private track(changes: ChangeDesc) {
    const { columns, rows } = this.sizes
    if (!rows.size && !columns.some(Boolean)) return
    if (!this.moved) {
      const { from, to } = this.range()
      if (!changes.touchesRange(from, to)) return
      const header = this.widget.line(0),
        cells = this.widget.row(0).cells
      this.moved = {
        columns: columns.map((size, index) => {
          const cell = cells[index]
          return size && cell ? this.now(header.from + cell.from) : null
        }),
        // Only sized rows: a long table with a few sized rows maps a few.
        rows: [...rows].flatMap(([index, size]) => {
          const line = index ? index + 1 : 0
          return line < this.lines
            ? [{ index, size, pos: this.now(this.widget.line(line).from) }]
            : []
        }),
        texts: cells.map(({ from, to }) => header.text.slice(from, to)),
        sizes: { columns: [...columns] },
        count: this.aligned.length,
        lines: this.lines,
      }
    }
    const map = (pos: number | null) =>
      pos === null ? null : changes.mapPos(pos, 1, MapMode.TrackAfter)
    this.moved.columns = this.moved.columns.map(map)
    for (const row of this.moved.rows) row.pos = map(row.pos)
    tableSizeProbe.mapped += this.moved.columns.length + this.moved.rows.length
  }

  /** Give sized columns and rows the cells and lines they moved to, after the table changed. */
  private followSizes() {
    const moved = this.moved
    if (!moved) return
    this.moved = null
    const { widget } = this
    const { doc } = widget
    if (doc !== this.view.state.doc) return
    const header = widget.line(0),
      row = widget.row(0)
    const columns: number[] = [],
      rows = new Map<number, number>()
    const texts = row.cells.map(({ from, to }) => header.text.slice(from, to))
    /** The one new column with this header text, for a column whose cell the change rewrote: only a text no other column had or has. */
    const unique = (list: string[], text: string) =>
      list.indexOf(text) >= 0 && list.indexOf(text) === list.lastIndexOf(text)
    const byText = (text: string | undefined) =>
      text !== undefined && unique(texts, text) && unique(moved.texts, text)
        ? texts.indexOf(text)
        : -1
    moved.columns.forEach((pos, index) => {
      const size = moved.sizes.columns[index]
      if (!size) return
      let target = pos === null ? byText(moved.texts[index]) : -1
      if (target < 0 && pos === null && row.cells.length >= moved.count)
        target = index
      for (
        let column = 0;
        pos !== null && column < row.cells.length;
        column++
      ) {
        const span = cellSpan(row, column, header.text.length)
        if (
          span &&
          pos >= header.from + span.from &&
          pos <= header.from + span.to
        ) {
          target = column
          break
        }
      }
      if (target >= 0) columns[target] = size
      // A dropped column's size comes back with its column, as after undo.
      else this.dropped.push({ index, size, text: moved.texts[index] ?? '' })
    })
    for (const { index, size, pos } of moved.rows) {
      let target = pos === null && this.lines >= moved.lines ? index : -1
      if (pos !== null) {
        const line = doc.lineAt(pos).number - widget.first
        if (line >= 0 && line < this.lines && line !== 1)
          target = line ? line - 1 : 0
      }
      if (target >= 0) rows.set(target, size)
    }
    if (row.cells.length > moved.count)
      this.dropped = this.dropped.filter(({ index, size, text }) => {
        if (columns[index] !== undefined || texts[index] !== text) return true
        columns[index] = size
        return false
      })
    const next = Array.from(columns, (size) => size ?? 0)
    if (
      next.length === moved.sizes.columns.length &&
      next.every((size, index) => size === moved.sizes.columns[index]) &&
      rows.size === moved.rows.length &&
      moved.rows.every(({ index, size }) => rows.get(index) === size)
    )
      return
    this.sizes.columns = next
    this.sizes.rows = rows
    this.seedHeights()
    // Saved after the redraw, which the table's position needs.
    this.save(1)
  }

  /** Edit the same cell where its row is now, after rows were added or removed around it. */
  private relocate() {
    const editing = this.editing
    if (!editing) return
    const { widget } = this
    const doc = this.view.state.doc
    if (editing.to <= editing.from) {
      this.stopEditing()
      return
    }
    if (widget.doc !== doc) return
    const index = doc.lineAt(editing.from).number - widget.first
    if (index !== editing.line) {
      if (
        index < 0 ||
        index === 1 ||
        index >= this.lines ||
        !index !== !editing.line
      ) {
        this.stopEditing()
        return
      }
      const row = this.rendered.get(editing.line - 2)
      this.rendered.delete(editing.line - 2)
      this.rendered.get(index - 2)?.element.remove()
      if (row) {
        this.rendered.set(index - 2, row)
        row.element.dataset.line = String(index)
        row.element.setAttribute('aria-rowindex', String(index))
      }
      editing.line = index
    }
    const line = widget.line(index)
    editing.from = line.from
    editing.to = line.from + line.text.length
  }

  /** Whether a cell editor of this table has focus. */
  get focused() {
    return this.editing?.editor.view.hasFocus ?? false
  }

  /** Let the cell editor take input as the formatted view does. */
  reconfigure() {
    this.editing?.editor.reconfigure(this.view.state)
  }

  /**
   * After the formatted view changed under a focused cell editor: edit where
   * a selection it set lands, as after undo, or, when the edited row was
   * deleted, the row now in its place, in the table there then. Elsewhere,
   * editing ends there. Focus moved out of the editor meanwhile stays put.
   * False while the widget's old snapshot must wait for a redraw.
   */
  follow(lost: Lost | null): boolean {
    const editing = this.editing
    if (editing?.editor.view.composing) return true
    const { view } = this
    const active = view.root.activeElement
    if (
      active &&
      active !== view.dom.ownerDocument.body &&
      !view.dom.contains(active)
    )
      return true
    if (lost) {
      // The row that starts where the deleted one did, or the last row when
      // the table now ends just before it.
      for (const table of mounted.get(view) ?? []) {
        if (!table.current) return false
        const { from, to } = table.range()
        if (lost.at < from || lost.at > to + 1) continue
        const cell = table.locate(Math.min(lost.at, to))
        if (!cell) return false
        if (table.edit(cell.line, lost.column, 'end')) return true
        break
      }
      view.focus()
      return true
    }
    if (!this.dom.isConnected) {
      view.focus()
      return true
    }
    if (!this.current) return false
    const { anchor, head } = this.view.state.selection.main
    const span = editing && this.span(editing)
    if (
      editing &&
      span &&
      Math.min(anchor, head) >= span.from &&
      Math.max(anchor, head) <= span.to
    ) {
      editing.editor.select(anchor - span.from, head - span.from)
      return true
    }
    if (!this.editAt(anchor, head)) {
      this.stopEditing()
      this.view.focus()
    }
    return true
  }

  /** Show the edited cell's text after the formatted view changed it. */
  private syncEditor() {
    const editing = this.editing
    if (!editing) return
    if (editing.line >= this.lines || editing.column >= this.aligned.length) {
      this.stopEditing()
      return
    }
    const span = this.span(editing)
    if (span) editing.editor.sync(this.view.state.sliceDoc(span.from, span.to))
  }

  /** Run a toolbar table action on the edited cell, or on the cell at the selection. */
  run(id: string): boolean {
    if (!this.current || !writable(this.view.state)) return false
    const cell =
      this.editing ?? this.locate(this.view.state.selection.main.head)
    if (!cell) return false
    if (id === 'hard-break') {
      // A cell's line break is `<br>`, typed in the cell's editor.
      const { anchor, head } = this.view.state.selection.main
      if (!this.editing && !this.editAt(anchor, head)) return false
      const editor = this.editing?.editor
      if (!editor) return false
      editor.focus()
      return cellLineBreak(editor.view)
    }
    const source = this.source()
    let result: TableEdit
    switch (id) {
      case 'row-before':
        result = insertRow(source, cell.line, false)
        break
      case 'row-after':
        result = insertRow(source, cell.line, true)
        break
      case 'row-delete':
        result = deleteRow(source, cell.line) ?? this.removal()
        break
      case 'column-before':
        result = insertColumn(source, cell.column, false)
        break
      case 'column-after':
        result = insertColumn(source, cell.column, true)
        break
      case 'column-delete':
        result = deleteColumn(source, cell.column) ?? this.removal()
        break
      case 'table-delete':
        result = this.removal()
        break
      default:
        return false
    }
    const { line } = cell
    this.stopEditing()
    this.view.dispatch({
      changes: result.changes,
      annotations: [
        Transaction.userEvent.of('input.format'),
        isolateHistory.of('full'),
      ],
    })
    // Editing goes on in the cell the action leaves the caret in.
    if (result.cell && this.dom.isConnected)
      this.edit(
        result.cell.line < 0 ? line : result.cell.line,
        result.cell.column,
        'start',
      )
    else this.view.focus()
    return true
  }

  /** The source edit that deletes the table, with the blank line after it. */
  private removal(): TableEdit {
    const { doc } = this.view.state
    let { from, to } = this.range()
    if (!this.widget.inline) {
      from = doc.lineAt(from).from
      to = doc.lineAt(to).to
      if (doc.sliceString(to, to + 2) === '\n\n') to += 2
      else if (to < doc.length) to += 1
    }
    return { changes: [{ from, to, insert: '' }], cell: null }
  }

  /** Enter the table from an adjacent line: its header or last row, under `x` or at the near edge. */
  enter(down: boolean, x: number | null) {
    const line = down ? 0 : this.lines - 1
    if (line > 1 && !this.rendered.has(line - 2)) this.reveal(line - 2)
    const row = line ? this.rendered.get(line - 2)?.element : this.head
    let column = x === null && !down ? this.aligned.length - 1 : 0
    if (x !== null && row)
      for (const [index, cell] of [...row.cells].entries()) {
        const box = cell.getBoundingClientRect()
        if (x >= box.left && x <= box.right) column = index
      }
    return this.edit(line, column, down ? 'start' : 'end')
  }

  /** Header cells' text as the rich editor reads it, from their rendered Markdown. */
  private headerTexts() {
    const header = this.widget.line(0)
    return this.widget.row(0).cells.map((cell) => {
      const element = document.createElement('p')
      const content = cellContent(header.text.slice(cell.from, cell.to))
      renderInline(
        this.view,
        content.text,
        element,
        this.now(header.from + cell.from),
        content.source,
      )
      return element.textContent ?? ''
    })
  }

  /** The number of tables before this one in the note. */
  private ordinal() {
    const { doc } = this.view.state
    return countTables(doc.iterLines(1, doc.lineAt(this.range().from).number))
  }

  /** Find the table's stored sizes by its key: its ordinal and header, so each entry binds one table, as in the rich editor. */
  sized() {
    const entry = store(this.view)
    const tables = storedTables(entry)
    if (!entry || !tables) return
    this.unsubscribe ??= subscribeTableLayouts(entry.tabId, this.refreshed)
    const hash = tableKey(0, this.header).split(':')[1]
    // The ordinal needs the note before the table: only look for a stored header.
    const key = tables.some((table) => table.key.endsWith(`:${hash}`))
      ? tableKey(this.ordinal(), this.header)
      : null
    const found = key ? tables.find((table) => table.key === key) : undefined
    const rows = new Map<number, number>()
    found?.rows?.forEach((size, index) => {
      if (size) rows.set(index, size)
    })
    this.sizes = {
      key: found?.key ?? null,
      columns: [...(found?.columns ?? [])],
      rows,
    }
    this.stored = found
      ? JSON.stringify({
          key: found.key,
          columns: found.columns,
          rows: found.rows,
        })
      : null
    this.seedHeights()
    this.applySizes()
  }

  /** Another table or view changed the stored sizes: bind them again, unless this table is changing its own. */
  private refreshed = () => {
    if (!this.dragging && this.saving === undefined) this.sized()
  }

  /** Rows with a stored height count it before they render, so the row window and spacers place them. */
  private seedHeights() {
    const { heights } = this
    if (!heights) return
    for (const [index, size] of this.sizes.rows)
      if (index && index - 1 < heights.length) heights.set(index - 1, size)
  }

  /** Show the column widths and row heights, as the rich editor's table decorations do. */
  private applySizes() {
    const { columns, rows } = this.sizes
    const count = this.aligned.length
    const sized = columns.slice(0, count).filter(Boolean).length
    if (sized) this.dom.dataset.columnsSized = sized === count ? 'all' : 'some'
    else delete this.dom.dataset.columnsSized
    for (const [index, cell] of [...this.head.cells].entries())
      cell.style.width = columns[index] ? `${columns[index]}px` : ''
    for (const [index, column] of [...this.columns.children].entries())
      if (this.fixed)
        (column as HTMLElement).style.width = columns[index]
          ? `${columns[index]}px`
          : (this.fixedWidths[index] ?? '')
    const height = (row: HTMLElement, index: number) => {
      const size = rows.get(index)
      row.style.height = size ? `${size}px` : ''
    }
    height(this.head, 0)
    for (const [index, row] of this.rendered) height(row.element, index + 1)
  }

  /** Store the sizes under the table's key, now or after `delay` ms. */
  private save(delay = 0) {
    clearTimeout(this.saving)
    this.saving = undefined
    if (delay) {
      this.saving = setTimeout(() => this.save(), delay)
      return
    }
    const entry = store(this.view)
    const tables = storedTables(entry)
    if (!entry || !tables || !this.dom.isConnected) return
    const key = tableKey(this.ordinal(), this.header)
    const columns = this.sizes.columns.slice(0, this.aligned.length)
    let last = -1
    for (const [index] of this.sizes.rows)
      if (index < this.lines - 1) last = Math.max(last, index)
    const rows = Array.from(
      { length: last + 1 },
      (_, index) => this.sizes.rows.get(index) ?? 0,
    )
    const some = (sizes: number[]) => (sizes.some(Boolean) ? sizes : null)
    const put =
      some(columns) || some(rows)
        ? [{ key, columns: some(columns), rows: some(rows) }]
        : []
    const json = put.length ? JSON.stringify(put[0]) : null
    if (json === this.stored && (put.length || !this.sizes.key)) return
    // Only the sizes that changed, from none for a table without an entry,
    // so that other views' and windows' changes to the table stay; a table
    // whose key changed moves its whole entry.
    const moving = this.sizes.key !== null && this.sizes.key !== key
    const previous =
      this.stored && !moving
        ? (JSON.parse(this.stored) as TableLayout)
        : { key, columns: null, rows: null }
    const remove = moving ? [key, this.sizes.key as string] : []
    this.sizes.key = put.length ? key : null
    this.stored = json
    updateTableLayouts(
      entry.tabId,
      tables,
      moving
        ? { remove, put }
        : {
            remove: [],
            put: [],
            set: tableSizeChanges(
              previous,
              put[0] ?? { key, columns: null, rows: null },
            ),
          },
    )
  }

  /** The column or row edge within reach of the pointer. */
  private edgeAt(event: MouseEvent) {
    const cell = (event.target as Element).closest?.('th, td')
    if (!(cell instanceof HTMLTableCellElement) || !this.dom.contains(cell))
      return null
    const row = cell.parentElement as HTMLTableRowElement
    if (row.classList.contains('hibi-lp-table-spacer')) return null
    const box = cell.getBoundingClientRect()
    const index = row === this.head ? 0 : Number(row.dataset.line) - 1
    if (box.right - event.clientX <= EDGE)
      return { axis: 'column' as const, index: cell.cellIndex }
    if (event.clientX - box.left <= EDGE && cell.cellIndex > 0)
      return { axis: 'column' as const, index: cell.cellIndex - 1 }
    if (box.bottom - event.clientY <= EDGE)
      return { axis: 'row' as const, index }
    if (event.clientY - box.top <= EDGE && index > 0)
      return { axis: 'row' as const, index: index === 1 ? 0 : index - 1 }
    return null
  }

  /** Mark the cells along a resize handle, like the rich editor. */
  private mark(handle: TableView['handle']) {
    for (const cell of this.dom.querySelectorAll('[data-resize-handle]'))
      cell.removeAttribute('data-resize-handle')
    this.handle = handle
    if (!handle) {
      delete this.dom.dataset.tableResize
      return
    }
    this.dom.dataset.tableResize = handle.axis
    const rows = [
      this.head,
      ...[...this.rendered.values()].map((row) => row.element),
    ]
    for (const row of rows) {
      const index = row === this.head ? 0 : Number(row.dataset.line) - 1
      const cells =
        handle.axis === 'column'
          ? [row.cells[handle.index]]
          : index === handle.index
            ? [...row.cells]
            : []
      for (const cell of cells)
        cell?.setAttribute('data-resize-handle', handle.axis)
    }
  }

  private hover = (event: MouseEvent) => {
    if (this.dragging || this.view.state.readOnly) return
    const edge = this.edgeAt(event)
    if (edge?.axis !== this.handle?.axis || edge?.index !== this.handle?.index)
      this.mark(edge)
  }

  private leaveHandle = () => {
    if (!this.dragging) this.mark(null)
  }

  /** Set a column width or row height, 0 for automatic. */
  private resize(axis: 'column' | 'row', index: number, size: number) {
    if (axis === 'column') {
      const { columns } = this.sizes
      while (columns.length <= index) columns.push(0)
      columns[index] = size
    } else if (size) this.sizes.rows.set(index, size)
    else this.sizes.rows.delete(index)
    if (
      axis === 'row' &&
      index &&
      this.heights &&
      index - 1 < this.heights.length
    )
      this.heights.set(index - 1, size || ROW_HEIGHT)
    this.applySizes()
  }

  /** Drag a handle to resize; a click without movement keeps the size. */
  private drag(event: MouseEvent) {
    const handle = this.handle!
    const element =
      handle.axis === 'column'
        ? this.head.cells[handle.index]
        : handle.index === 0
          ? this.head
          : this.rendered.get(handle.index - 1)?.element
    if (!element) return
    const start = handle.axis === 'column' ? event.clientX : event.clientY
    const box = element.getBoundingClientRect()
    const initial = handle.axis === 'column' ? box.width : box.height
    const frames = this.dom.ownerDocument.defaultView!
    let size: number | null = null
    const move = (moved: MouseEvent) => {
      const offset =
        (handle.axis === 'column' ? moved.clientX : moved.clientY) - start
      size = Math.min(
        10000,
        Math.max(MIN[handle.axis], Math.round(initial + offset)),
      )
      this.resize(handle.axis, handle.index, size)
    }
    const finish = () => {
      frames.removeEventListener('mousemove', move)
      frames.removeEventListener('mouseup', finish)
      this.dragging = false
      if (size !== null) this.save()
    }
    this.dragging = true
    frames.addEventListener('mousemove', move)
    frames.addEventListener('mouseup', finish)
  }

  /** Arrow keys on a size handle resize its column or row; Home makes it smallest, Enter automatic. */
  private key = (event: KeyboardEvent) => {
    const handle = event.target
    if (
      !(handle instanceof HTMLElement) ||
      !handle.classList.contains('hibi-lp-table-resizer') ||
      !writable(this.view.state)
    )
      return
    const cell = handle.parentElement as HTMLTableCellElement
    const row = cell.parentElement as HTMLTableRowElement
    const axis = handle.dataset.axis === 'row' ? 'row' : 'column'
    const index =
      axis === 'column'
        ? cell.cellIndex
        : row === this.head
          ? 0
          : Number(row.dataset.line) - 1
    const box = (axis === 'column' ? cell : row).getBoundingClientRect()
    const current =
      (axis === 'column'
        ? this.sizes.columns[index]
        : this.sizes.rows.get(index)) ||
      Math.round(axis === 'column' ? box.width : box.height)
    const step = event.shiftKey ? 24 : 8
    let size: number
    switch (event.key) {
      case axis === 'column' ? 'ArrowLeft' : 'ArrowUp':
        size = current - step
        break
      case axis === 'column' ? 'ArrowRight' : 'ArrowDown':
        size = current + step
        break
      case 'Home':
        size = MIN[axis]
        break
      case 'Enter':
        size = 0
        break
      default:
        return
    }
    event.preventDefault()
    event.stopPropagation()
    this.resize(axis, index, size && Math.min(10000, Math.max(MIN[axis], size)))
    this.save(300)
  }

  /** Double-clicking a handle makes the column or row automatic again. */
  private reset = (event: MouseEvent) => {
    const handle = this.handle
    if (!handle || this.view.state.readOnly) return
    event.preventDefault()
    this.resize(handle.axis, handle.index, 0)
    this.save()
  }

  /** A click edits the clicked cell at the clicked place; shift-click extends the selection. */
  private select = (event: MouseEvent) => {
    if (event.button !== 0 || !this.current || !writable(this.view.state))
      return
    if (this.handle) {
      event.preventDefault()
      this.drag(event)
      return
    }
    const target = event.target as Element
    if (this.editing?.editor.view.dom.contains(target)) return
    const cell = target.closest('th, td')
    const row = cell?.parentElement
    const index = row?.getAttribute('data-line')
    if (!cell || !row || index == null) return
    event.preventDefault()
    // A click that follows a link neither edits nor selects.
    if (followsLink(event) && target.closest('.hibi-lp-link')) return
    const line = Number(index),
      column = [...row.children].indexOf(cell)
    const source = this.widget.line(line)
    const parsed = this.widget.row(line)
    const range = parsed.cells[column]
    const span = cellSpan(parsed, column, source.text.length)
    let offset: number | 'end' = 'end'
    if (range && span) {
      const caret = document.caretPositionFromPoint(
        event.clientX,
        event.clientY,
      )
      const text = caret && textStarts.get(caret.offsetNode)
      if (caret && text != null && cell.contains(caret.offsetNode)) {
        const content = cellContent(source.text.slice(range.from, range.to))
        offset = range.from - span.from + content.source[text + caret.offset]!
      }
    }
    if (event.shiftKey) {
      const head = span
        ? this.now(
            source.from +
              span.from +
              (offset === 'end' ? span.to - span.from : offset),
          )
        : this.now(source.from + source.text.length)
      this.view.dispatch({
        selection: { anchor: this.view.state.selection.main.anchor, head },
        userEvent: 'select.pointer',
      })
      this.view.focus()
      return
    }
    this.edit(line, column, offset)
  }

  /** Shift- or Ctrl+Cmd-click follows a cell's link, as elsewhere in the formatted view. */
  private followLink = (event: MouseEvent) => {
    // A Ctrl+Cmd-click arrives as a context menu on macOS.
    if (
      event.type === 'contextmenu'
        ? !event.ctrlKey || !event.metaKey
        : !followsLink(event)
    )
      return
    const link = (event.target as Element).closest('.hibi-lp-link')
    const pos = link && this.dom.contains(link) ? this.linkStart(link) : null
    const wiki = link?.closest('[data-wiki-link]')
    const target = wiki?.getAttribute('data-wiki-link') ?? undefined
    if (
      pos != null &&
      this.view.state.facet(formattedFollowLink)?.(this.view, pos, target)
    )
      event.preventDefault()
  }

  /** Where the text of a cell's link starts in the document now. */
  private linkStart(link: Element) {
    const editing = this.editing
    if (editing?.editor.view.dom.contains(link)) {
      const span = this.span(editing)
      return span && span.from + editing.editor.view.posAtDOM(link)
    }
    const cell = link.closest('th, td')
    const row = cell?.parentElement
    const index = row?.getAttribute('data-line')
    if (!cell || !row || index == null) return null
    let start: number | undefined
    for (
      let wrapper: Element | null = link;
      wrapper && cell.contains(wrapper);
      wrapper = wrapper.parentElement
    ) {
      if (!wrapper.matches('.hibi-lp-link')) continue
      start = markStarts.get(wrapper)
      if (start !== undefined) break
    }
    const line = Number(index)
    const source = this.widget.line(line)
    const range = this.widget.row(line).cells[[...row.children].indexOf(cell)]
    if (start === undefined || !range) return null
    const content = cellContent(source.text.slice(range.from, range.to))
    const offset = content.source[start]
    return offset === undefined
      ? null
      : this.now(source.from + range.from + offset)
  }

  destroy() {
    this.stopEditing(false)
    if (this.saving) this.save()
    this.unsubscribe?.()
    mounted.get(this.view)?.delete(this)
    this.dom.removeEventListener('mousedown', this.select)
    this.dom.removeEventListener('mousemove', this.hover)
    this.dom.removeEventListener('mouseleave', this.leaveHandle)
    this.dom.removeEventListener('dblclick', this.reset)
    this.dom.removeEventListener('keydown', this.key)
    this.dom.removeEventListener('click', this.followLink)
    this.dom.removeEventListener('contextmenu', this.followLink)
  }
}

/** The mounted table containing a position of the formatted view's document. */
function tableAt(view: EditorView, pos: number, strict = false) {
  for (const table of mounted.get(view) ?? []) {
    const { from, to } = table.range()
    if (strict ? pos > from && pos < to : pos >= from && pos <= to) return table
  }
  return null
}

/**
 * Tables follow scrolling with their row windows, and a collapsed
 * selection that lands inside a table, as after undo or find, edits the
 * cell there.
 */
const tableEditing = ViewPlugin.fromClass(
  class {
    readonly view: EditorView
    /** Focused cell editors that follow their tables' changes once tables redraw. */
    private following: { table: TableView; lost: Lost | null }[] = []
    constructor(view: EditorView) {
      this.view = view
    }
    update(update: ViewUpdate) {
      const tables = mounted.get(this.view) ?? []
      // Undo and keyboard navigation move a focused cell editor; ignore
      // DOM selection echoes from the unfocused formatted view.
      const selected = update.transactions.some(
        (transaction) =>
          transaction.selection &&
          !transaction.annotation(cellInput) &&
          (transaction.annotation(Transaction.userEvent) !== 'select' ||
            transaction.scrollIntoView ||
            update.view.hasFocus),
      )
      // Until they follow, deleted rows' places move with every change, and
      // a selection set since takes their place.
      for (const pending of this.following)
        if (selected) pending.lost = null
        else if (pending.lost && update.docChanged)
          pending.lost.at = update.changes.mapPos(pending.lost.at, 1)
      for (const table of tables) {
        const focused = table.focused
        // Before tables redraw: the edited rows where they are now.
        const lost = update.docChanged ? table.map(update.changes) : null
        if (focused && (selected || lost))
          this.following.push({ table, lost: selected ? null : lost })
      }
      if (update.geometryChanged || update.viewportChanged)
        for (const table of tables) table.scrolled()
      if (writable(update.startState) !== writable(update.state))
        for (const table of tables) table.reconfigure()
      // The cell at the selection is found once tables have redrawn, from the
      // selection then: until the redraw, tables are where they were before
      // this update, and it may remove them.
      if (update.view.hasFocus || this.following.length)
        queueMicrotask(() => {
          const following = this.following
          this.following = []
          // Old snapshots wait for the next syntax/layout update to retry.
          for (const pending of following)
            if (!pending.table.follow(pending.lost))
              this.following.push(pending)
          const { view } = this
          const { main } = view.state.selection
          if (view.hasFocus)
            tableAt(view, main.head, true)?.editAt(main.anchor, main.head)
        })
    }
  },
  {
    eventObservers: {
      scroll() {
        for (const table of mounted.get(this.view) ?? []) table.scrolled()
      },
    },
  },
)

/** Arrow keys move into an adjacent table's nearest cell instead of over it. */
function enterTable(view: EditorView, key: 'up' | 'down' | 'left' | 'right') {
  const selection = view.state.selection.main
  if (!selection.empty) return false
  const forward = key === 'down' || key === 'right',
    vertical = key === 'down' || key === 'up'
  const target = vertical
    ? view.moveVertically(selection, forward).head
    : view.moveByChar(selection, forward).head
  for (const table of mounted.get(view) ?? []) {
    const { from, to } = table.range()
    const crosses = forward
      ? selection.head < from && target >= from
      : selection.head > to && target <= to
    if (crosses)
      return table.enter(
        forward,
        vertical ? (view.coordsAtPos(selection.head)?.left ?? null) : null,
      )
  }
  return false
}

/** GitHub tables: a table widget whose cells edit their source in place. */
export const contribution: FormattedContribution = {
  id: 'markdown.tables',
  feature: 'markdown.tables',
  flavor: 'markdown.github',
  syntax: Table,
  opaque: ['Table'],
  views: [
    {
      nodes: ['Table'],
      space: { top: 20, bottom: 20 },
      // Rows are read from the text; neither pass walks them as nodes.
      decorate: () => false,
      layout(node, out, { state }) {
        const first = state.doc.lineAt(node.from),
          last = state.doc.lineAt(node.to)
        let quotes = 0,
          inline = false
        for (let parent = node.node.parent; parent; parent = parent.parent)
          if (parent.name === 'Blockquote') quotes++
          else if (parent.name === 'ListItem') inline = true
        // In quotes and lists the table is an inline widget on its first
        // line, which keeps the container's indent and bars.
        inline ||= quotes > 0
        const from = inline ? node.from : first.from,
          to = inline ? node.to : last.to
        out.replace(
          from,
          to,
          new TableWidget(
            state.doc,
            from,
            to,
            first.number,
            node.from - first.from,
            last.number - first.number - 1,
            quotes,
            inline,
            {
              markdown: state.facet(formattedMarkdown),
              views: state.facet(formattedViews),
              literal: state.facet(formattedLiteral),
              inputs: state.facet(formattedRenderInputs),
            },
          ),
          inline ? undefined : { block: true },
        )
        return false
      },
    },
  ],
  keys: [
    { key: 'ArrowDown', run: (view) => enterTable(view, 'down') },
    { key: 'ArrowUp', run: (view) => enterTable(view, 'up') },
    { key: 'ArrowRight', run: (view) => enterTable(view, 'right') },
    { key: 'ArrowLeft', run: (view) => enterTable(view, 'left') },
  ],
  extension: [
    tableEditing,
    Prec.lowest(
      EditorView.domEventHandlers({
        keydown(event, view) {
          if (
            event.target !== view.contentDOM ||
            event.isComposing ||
            view.composing ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey ||
            [...event.key].length !== 1 ||
            !writable(view.state)
          )
            return false
          const selection = view.state.selection.main
          if (
            selection.empty ||
            view.state.selection.ranges.length !== 1 ||
            ![...(mounted.get(view) ?? [])].some((table) => {
              if (!table.current || !table.dom.isConnected) return false
              const { from, to } = table.range()
              return selection.from <= from && selection.to >= to
            })
          )
            return false
          // Chromium can drop typing over a selected block widget.
          const insert = () =>
            view.state.update(view.state.replaceSelection(event.key), {
              userEvent: 'input.type',
              scrollIntoView: true,
            })
          if (
            !view.state
              .facet(EditorView.inputHandler)
              .some((handler) =>
                handler(view, selection.from, selection.to, event.key, insert),
              )
          )
            view.dispatch(insert())
          return true
        },
      }),
    ),
    EditorView.inputHandler.of((view) => {
      // Mapped widget bounds are current even when its snapshot's length is old.
      const { node, offset } = view.domAtPos(view.state.selection.main.head)
      for (const table of mounted.get(view) ?? [])
        if (
          !table.current &&
          (node.childNodes[offset] === table.dom ||
            node.childNodes[offset - 1] === table.dom)
        )
          return true
      return false
    }),
    tableActions.of({
      active: (view) => !!tableAt(view, view.state.selection.main.head),
      run: (view, id) =>
        tableAt(view, view.state.selection.main.head)?.run(id) ?? false,
    }),
  ],
}
