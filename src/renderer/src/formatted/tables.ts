import { EditorState, type Text } from '@codemirror/state'
import {
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view'
import type { SyntaxNodeRef } from '@lezer/common'
import {
  type MarkdownConfig,
  type MarkdownParser,
  parser,
  Table,
} from '@lezer/markdown'
import {
  type FormattedContribution,
  type FormattedDecorations,
  type FormattedNodeView,
  type FormattedRenderContext,
  formattedLiteral,
  formattedMarkdown,
  formattedViews,
  showMarkdownMarkers,
} from '../formatted-contributions.ts'
import {
  alignments,
  cellContent,
  type InlineMark,
  parseRow,
  planInline,
  rowStart,
  type TableAlignment,
} from './table-source.ts'
import './tables.css'

/*
 * GFM tables render as a table widget that looks like the rich editor's
 * tables. The widget reads its rows from the source text, so a giant table
 * needs no syntax nodes past its header, and builds DOM only for the rows
 * near the visible part of the page.
 */

/** A one-line row: a 28px line, the paragraph's 16px gap, 16px padding and a border. */
const ROW_HEIGHT = 61
/** Tables up to this many rows render every row, so their columns size like the rich editor's. */
const ALL_ROWS = 200

/** Lezer Markdown for cell text: the formatted view's inline syntax and no blocks. */
const cellParsers = new WeakMap<readonly MarkdownConfig[], MarkdownParser>()
function cellParser(state: EditorState) {
  const contributed = state.facet(formattedMarkdown)
  let found = cellParsers.get(contributed)
  if (!found) {
    const inline = parser.configure(contributed)
    const blocks =
      (inline as unknown as { blockNames?: readonly string[] }).blockNames ?? []
    found = inline.configure({ remove: [...blocks] })
    cellParsers.set(contributed, found)
  }
  return found
}

/** Contributed node views by node name, per set of views. */
const named = new WeakMap<
  readonly FormattedNodeView[],
  Map<string, FormattedNodeView[]>
>()
function namedViews(state: EditorState) {
  const views = state.facet(formattedViews)
  let found = named.get(views)
  if (!found) {
    found = new Map()
    for (const view of views)
      for (const name of view.nodes)
        found.set(name, [...(found.get(name) ?? []), view])
    named.set(views, found)
  }
  return found
}

/** Nodes of syntax settings that are off, per facet value. */
const literals = new WeakMap<readonly string[], ReadonlySet<string>>()
function literalNodes(state: EditorState) {
  const names = state.facet(formattedLiteral)
  let found = literals.get(names)
  if (!found) {
    found = new Set(names)
    literals.set(names, found)
  }
  return found
}

class BreakWidget extends WidgetType {
  override eq() {
    return true
  }
  toDOM() {
    return document.createElement('br')
  }
}
const lineBreak = new BreakWidget()

/** Where rendered text nodes start in their cell's content. */
const textStarts = new WeakMap<Node, number>()

/**
 * A cell's inline Markdown as DOM: the decorations the formatted view gives
 * text it does not reveal, from its own rendering and contributed views.
 */
function renderInline(view: EditorView, text: string, into: HTMLElement) {
  const marks: InlineMark[] = [],
    hidden: { from: number; to: number; widget: WidgetType | null }[] = [],
    widgets: { at: number; widget: WidgetType; side: number }[] = []
  const out: FormattedDecorations = {
    mark(from, to, attributes) {
      if (to > from) marks.push({ from, to, attributes })
    },
    syntax(from, to) {
      if (to > from) hidden.push({ from, to, widget: null })
    },
    line() {},
    widget(at, widget, side = 1) {
      widgets.push({ at, widget, side })
    },
    replace(from, to, widget) {
      if (to > from) hidden.push({ from, to, widget: widget ?? null })
    },
  }
  const style = (name: string, from: number, to: number) =>
    out.mark(from, to, { class: name })
  const views = namedViews(view.state)
  const literal = literalNodes(view.state)
  let context: FormattedRenderContext | null = null
  cellParser(view.state)
    .parse(text)
    .iterate({
      enter(node) {
        // Syntax whose setting is off shows as written, its children too.
        if (literal.has(node.name)) return false
        let skip = false
        for (const nodeView of views.get(node.name) ?? []) {
          context ??= {
            state: EditorState.create({ doc: text }),
            visible: { from: 0, to: text.length },
            revealed: false,
          }
          if (nodeView.decorate?.(node, out, context) === false) skip = true
        }
        return builtIn(node) === false || skip ? false : undefined
      },
    })

  /** The formatted view's own inline rendering, for text it does not reveal. */
  function builtIn(node: SyntaxNodeRef): false | undefined {
    switch (node.name) {
      case 'Emphasis':
        style('hibi-lp-em', node.from, node.to)
        return
      case 'StrongEmphasis':
        style('hibi-lp-strong', node.from, node.to)
        return
      case 'EmphasisMark':
        out.syntax(node.from, node.to)
        return
      case 'InlineCode': {
        const open = node.node.firstChild,
          close = node.node.lastChild
        if (
          open?.name !== 'CodeMark' ||
          close?.name !== 'CodeMark' ||
          open.from === close.from
        )
          return false
        out.syntax(open.from, open.to)
        out.syntax(close.from, close.to)
        style('hibi-lp-code', open.to, close.from)
        return false
      }
      case 'Link': {
        const linkMarks = node.node.getChildren('LinkMark')
        const open = linkMarks[0]
        const close = linkMarks.find(
          (mark) => text.slice(mark.from, mark.to) === ']',
        )
        // Reference links need the note's definitions, so they stay literal.
        if (
          !open ||
          !close ||
          text[open.from] !== '[' ||
          text[close.to] !== '('
        )
          return false
        out.syntax(node.from, open.to)
        out.syntax(close.from, node.to)
        style('hibi-lp-link', open.to, close.from)
        return
      }
      case 'Autolink': {
        const url = node.node.getChild('URL')
        if (!url) return false
        out.syntax(node.from, url.from)
        out.syntax(url.to, node.to)
        style('hibi-lp-link', url.from, url.to)
        return false
      }
      case 'URL': {
        const parent = node.node.parent?.name
        if (
          parent !== 'Link' &&
          parent !== 'Image' &&
          parent !== 'LinkReference'
        )
          style('hibi-lp-link', node.from, node.to)
        return
      }
      case 'Escape':
        out.syntax(node.from, node.from + 1)
        return
      case 'HTMLTag':
        // Line breaks in cells are written as <br>, as the rich editor saved them.
        if (/^<br\s*\/?>$/i.test(text.slice(node.from, node.to)))
          out.replace(node.from, node.to, lineBreak)
        return false
      case 'Image':
      case 'Entity':
        // Rendered by later formatted-view slices; shown as written for now.
        return false
    }
    return
  }

  // Text between decoration boundaries, inside spans for the marks over it.
  const parents: HTMLElement[] = [into]
  for (const op of planInline(text.length, marks, hidden, widgets)) {
    const parent = parents.at(-1)!
    if (op.type === 'open') {
      const element = document.createElement('span')
      for (const [key, value] of Object.entries(op.mark.attributes))
        element.setAttribute(key, value)
      parent.append(element)
      parents.push(element)
    } else if (op.type === 'close') parents.pop()
    else if (op.type === 'widget') parent.append(op.widget.toDOM(view))
    else {
      const node = document.createTextNode(text.slice(op.from, op.to))
      textStarts.set(node, op.from)
      parent.append(node)
    }
  }
}

type Line = { from: number; text: string }

const sameConfig = (a: CellConfig, b: CellConfig) =>
  a.markdown === b.markdown && a.views === b.views && a.literal === b.literal

/** What cells render with: the formatted view's syntax, renderers and syntax that is off. */
type CellConfig = {
  markdown: readonly MarkdownConfig[]
  views: readonly FormattedNodeView[]
  literal: readonly string[]
}

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
  /** Cells of a table line, relative to its start. */
  cells(line: Line) {
    const start =
      line.from === this.line(0).from
        ? this.start
        : rowStart(line.text, this.quotes)
    return parseRow(line.text.slice(start), start).cells
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

const tableViews = new WeakMap<HTMLElement, TableView>()
/** Mounted tables per editor, for the scroll-driven row window. */
const mounted = new WeakMap<EditorView, Set<TableView>>()

type Rendered = { element: HTMLTableRowElement; text: string }

/** The DOM of one table widget: header, then all rows or the window of rows in view. */
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

  readonly view: EditorView
  private widget: TableWidget
  constructor(view: EditorView, widget: TableWidget) {
    this.view = view
    this.widget = widget
    this.dom.className = 'tableWrapper hibi-lp-table'
    this.dom.addEventListener('mousedown', this.select)
    this.table.append(this.columns, this.body)
    this.dom.append(this.table)
    this.body.append(this.head)
    tableViews.set(this.dom, this)
    const tables = mounted.get(view) ?? new Set()
    mounted.set(view, tables.add(this))
    this.update(widget)
  }

  get windowed() {
    return this.heights !== null
  }

  update(widget: TableWidget) {
    const previous = this.widget
    this.widget = widget
    this.dom.classList.toggle('hibi-lp-table-inline', widget.inline)
    if (!sameConfig(previous.config, widget.config)) {
      // Other syntax or renderers: every cell renders again.
      this.headText = ''
      for (const row of this.rendered.values()) row.element.remove()
      this.rendered.clear()
    }
    const header = widget.line(0),
      delimiter = widget.line(1).text
    if (header.text !== this.headText || delimiter !== this.delimiterText) {
      // New columns: every row renders again.
      this.headText = header.text
      this.delimiterText = delimiter
      const start = rowStart(delimiter, widget.quotes)
      this.aligned = alignments(delimiter.slice(start))
      this.renderHead(header)
      for (const row of this.rendered.values()) row.element.remove()
      this.rendered.clear()
      this.heights = null
      this.start = this.end = 0
    }
    const windowed = widget.rows > ALL_ROWS
    if (
      windowed !== this.windowed ||
      (this.heights && this.heights.length !== widget.rows)
    ) {
      for (const row of this.rendered.values()) row.element.remove()
      this.rendered.clear()
      this.heights = windowed ? new Heights(widget.rows) : null
      this.start = this.end = 0
      this.fixed = false
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
      this.view.requestMeasure({
        key: this,
        read: () => this.read(),
        write: (measured) => this.write(measured),
      })
    } else {
      this.before?.remove()
      this.after?.remove()
      this.show(0, widget.rows)
    }
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
    const cells = this.widget.cells(header)
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
    const paragraph = document.createElement('p')
    const content = cell
      ? cellContent(line.text.slice(cell.from, cell.to))
      : null
    if (content?.text) renderInline(this.view, content.text, paragraph)
    else paragraph.append(document.createElement('br'))
    element.append(paragraph)
    return element
  }

  /** Render body rows `from`-`to`, keeping rendered rows whose text is unchanged. */
  private show(from: number, to: number) {
    const { widget } = this
    for (const [index, row] of this.rendered)
      if (index < from || index >= to) {
        row.element.remove()
        this.rendered.delete(index)
      }
    let next: Element | null = this.after
    for (let index = to - 1; index >= from; index--) {
      const line = widget.line(index + 2)
      let rendered = this.rendered.get(index)
      if (!rendered || rendered.text !== line.text) {
        const element = document.createElement('tr')
        element.dataset.line = String(index + 2)
        element.setAttribute('aria-rowindex', String(index + 2))
        // Missing cells render empty; cells past the header's count are not shown.
        const cells = widget.cells(line)
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
        measured.widths.forEach((width, index) => {
          const column = this.columns.children[index] as HTMLElement | undefined
          if (column) column.style.width = `${(width / total) * 100}%`
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
    if (changed)
      this.view.requestMeasure({
        key: this,
        read: () => this.read(),
        write: (next) => this.write(next),
      })
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

  /**
   * A click puts the caret at the same place in the cell's source, which
   * shows the table's source while the editor shows Markdown markers.
   */
  private select = (event: MouseEvent) => {
    if (event.button !== 0) return
    const { view, widget } = this
    if (!view.state.facet(showMarkdownMarkers) || view.state.readOnly) return
    const target = event.target as Element
    const cell = target.closest('th, td')
    const row = cell?.parentElement
    const line = row?.getAttribute('data-line')
    if (!cell || !row || line == null) return
    event.preventDefault()
    const source = widget.line(Number(line))
    const range = widget.cells(source)[[...row.children].indexOf(cell)]
    let offset = range ? range.to : source.text.length
    if (range) {
      const caret = document.caretPositionFromPoint(
        event.clientX,
        event.clientY,
      )
      const text = caret && textStarts.get(caret.offsetNode)
      if (caret && text != null && cell.contains(caret.offsetNode)) {
        const content = cellContent(source.text.slice(range.from, range.to))
        offset = range.from + content.source[text + caret.offset]!
      }
    }
    // The widget knows its text; where the table starts now comes from the view.
    const at = view.posAtDOM(this.dom) - widget.from + source.from + offset
    view.dispatch({
      selection: {
        anchor: event.shiftKey ? view.state.selection.main.anchor : at,
        head: at,
      },
      userEvent: 'select.pointer',
    })
    view.focus()
  }

  /** Where the table is now: the range its widget replaces. */
  range() {
    const from = this.view.posAtDOM(this.dom)
    return { from, to: from + this.widget.to - this.widget.from }
  }

  /** Where line `index` of the table has its row text now, after container markers and indentation. */
  rowPosition(index: number) {
    const { from, text } = this.widget.line(index)
    const start = index ? rowStart(text, this.widget.quotes) : this.widget.start
    const indent = /^[ \t]*/.exec(text.slice(start))![0].length
    return this.range().from - this.widget.from + from + start + indent
  }

  get lines() {
    return this.widget.rows + 2
  }

  destroy() {
    mounted.get(this.view)?.delete(this)
    this.dom.removeEventListener('mousedown', this.select)
  }
}

/** Mounted tables follow scrolling and layout changes with their row windows. */
const rowWindows = ViewPlugin.fromClass(
  class {
    readonly view: EditorView
    constructor(view: EditorView) {
      this.view = view
    }
    update(update: ViewUpdate) {
      if (update.geometryChanged || update.viewportChanged)
        for (const table of mounted.get(this.view) ?? []) table.scrolled()
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

/**
 * Up and down arrows move into an adjacent table's first or last source row
 * instead of over it, which shows its source while markers are shown.
 */
function enterTable(view: EditorView, forward: boolean) {
  const selection = view.state.selection.main
  if (!selection.empty || !view.state.facet(showMarkdownMarkers)) return false
  const target = view.moveVertically(selection, forward).head
  for (const table of mounted.get(view) ?? []) {
    const { from, to } = table.range()
    const crosses = forward
      ? selection.head < from && target >= from
      : selection.head > to && target <= to
    if (!crosses) continue
    const anchor = table.rowPosition(forward ? 0 : table.lines - 1)
    view.dispatch({
      selection: { anchor },
      scrollIntoView: true,
      userEvent: 'select',
    })
    return true
  }
  return false
}

/** GitHub tables: a table widget, or the source while the selection is in it. */
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
      layout(node, out, { state, revealed }) {
        if (revealed) return false
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
            },
          ),
          inline ? undefined : { block: true },
        )
        return false
      },
    },
  ],
  keys: [
    { key: 'ArrowDown', run: (view) => enterTable(view, true) },
    { key: 'ArrowUp', run: (view) => enterTable(view, false) },
  ],
  extension: rowWindows,
}
