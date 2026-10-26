import { defaultKeymap, isolateHistory } from '@codemirror/commands'
import {
  Annotation,
  type ChangeSpec,
  Compartment,
  EditorSelection,
  EditorState,
  Prec,
  type Range,
  Transaction,
} from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  runScopeHandlers,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view'
import type { SyntaxNodeRef } from '@lezer/common'
import {
  type MarkdownConfig,
  type MarkdownParser,
  parser,
} from '@lezer/markdown'
import { runSourceHistory } from '../../../shared/source-history.ts'
import {
  type FormattedDecorations,
  type FormattedNodeView,
  type FormattedRenderContext,
  formattedLiteral,
  formattedMarkdown,
  formattedViews,
  showMarkdownMarkers,
} from '../formatted-contributions.ts'
import {
  formattingKeymap,
  type SourceFormatting,
  sourceFormatting,
} from '../source-formatting.ts'
import { cellFixes, type InlineMark, planInline } from './table-source.ts'

/*
 * Table cells: their inline Markdown rendered the way the formatted view
 * renders text, as static DOM in the table, or as the decorations of a cell
 * editor, a small CodeMirror view over the cell's exact source.
 */

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

type CellDecorations = {
  mark(from: number, to: number, attributes: Record<string, string>): void
  /** Syntax hidden, or replaced by a widget. */
  hide(from: number, to: number, widget: WidgetType | null): void
  /** Syntax shown as an editable marker. */
  marker(from: number, to: number): void
  widget(at: number, widget: WidgetType, side: number): void
}

/**
 * Decorations for a cell's inline Markdown: the formatted view's own
 * rendering and contributed views, with the syntax of nodes the selection
 * touches as markers. `state` is the formatted view's.
 */
function decorateCell(
  state: EditorState,
  text: string,
  out: CellDecorations,
  touched: (from: number, to: number) => boolean,
) {
  const views = namedViews(state)
  const literal = literalNodes(state)
  let cellState: EditorState | null = null
  const sink = (revealed: boolean): FormattedDecorations => ({
    mark(from, to, attributes) {
      if (to > from) out.mark(from, to, attributes)
    },
    syntax(from, to) {
      if (to <= from) return
      if (revealed) out.marker(from, to)
      else out.hide(from, to, null)
    },
    line() {},
    widget(at, widget, side = 1) {
      out.widget(at, widget, side)
    },
    replace(from, to, widget) {
      if (to > from) out.hide(from, to, widget ?? null)
    },
  })
  cellParser(state)
    .parse(text)
    .iterate({
      enter(node) {
        // Syntax whose setting is off shows as written, its children too.
        if (literal.has(node.name)) return false
        const revealed = touched(node.from, node.to)
        const nodeOut = sink(revealed)
        let skip = false
        for (const nodeView of views.get(node.name) ?? []) {
          cellState ??= EditorState.create({ doc: text })
          const context: FormattedRenderContext = {
            state: cellState,
            visible: { from: 0, to: text.length },
            revealed,
          }
          if (nodeView.decorate?.(node, nodeOut, context) === false) skip = true
        }
        return builtIn(node, nodeOut) === false || skip ? false : undefined
      },
    })

  /** The formatted view's own inline rendering. */
  function builtIn(
    node: SyntaxNodeRef,
    out: FormattedDecorations,
  ): false | undefined {
    const style = (name: string, from: number, to: number) =>
      out.mark(from, to, { class: name })
    switch (node.name) {
      case 'Emphasis':
        style('hibi-lp-em', node.from, node.to)
        return
      case 'StrongEmphasis':
        style('hibi-lp-strong', node.from, node.to)
        return
      case 'EmphasisMark': {
        const parent = node.node.parent
        sink(!!parent && touched(parent.from, parent.to)).syntax(
          node.from,
          node.to,
        )
        return
      }
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
}

/** Where rendered text nodes start in their cell's content. */
export const textStarts = new WeakMap<Node, number>()

/** A cell's inline Markdown as static DOM, as the formatted view renders text it does not reveal. */
export function renderInline(
  view: EditorView,
  text: string,
  into: HTMLElement,
) {
  const marks: InlineMark[] = [],
    hidden: { from: number; to: number; widget: WidgetType | null }[] = [],
    widgets: { at: number; widget: WidgetType; side: number }[] = []
  decorateCell(
    view.state,
    text,
    {
      mark: (from, to, attributes) => marks.push({ from, to, attributes }),
      hide: (from, to, widget) => hidden.push({ from, to, widget }),
      marker() {},
      widget: (at, widget, side) => widgets.push({ at, widget, side }),
    },
    () => false,
  )
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

/** Where a cell's content starts and ends inside its padding. */
export function padding(text: string) {
  const space = (at: number) => text[at] === ' ' || text[at] === '\t'
  let start = 0,
    end = text.length
  while (start < end && space(start)) start++
  if (start === end) {
    const middle = Math.ceil(text.length / 2)
    return { start: middle, end: middle }
  }
  while (space(end - 1)) end--
  return { start, end }
}

/** Decorations of a cell editor: hidden padding, and the cell's Markdown rendered with markers under the selection. */
function editorDecorations(main: EditorState, view: EditorView) {
  const text = view.state.doc.toString()
  const reveal =
    view.hasFocus && main.facet(showMarkdownMarkers)
      ? view.state.selection.ranges
      : []
  const decorations: Range<Decoration>[] = [],
    atomic: Range<Decoration>[] = []
  const hide = (from: number, to: number, widget: WidgetType | null) => {
    if (to <= from) return
    const range = Decoration.replace(widget ? { widget } : {}).range(from, to)
    decorations.push(range)
    atomic.push(range)
  }
  // Spaces around the content are the cell's padding, not its text.
  const { start, end } = padding(text)
  hide(0, start, null)
  hide(end, text.length, null)
  decorateCell(
    main,
    text,
    {
      mark: (from, to, attributes) =>
        decorations.push(Decoration.mark({ attributes }).range(from, to)),
      hide,
      marker: (from, to) =>
        decorations.push(
          Decoration.mark({ class: 'hibi-lp-marker' }).range(from, to),
        ),
      widget: (at, widget, side) =>
        decorations.push(Decoration.widget({ widget, side }).range(at)),
    },
    (from, to) => reveal.some((range) => range.from <= to && range.to >= from),
  )
  return {
    decorations: Decoration.set(decorations, true),
    atomic: Decoration.set(atomic, true),
  }
}

/** Marks the formatted view's transactions that a cell editor sends. */
export const cellInput = Annotation.define<true>()

/** Whether the formatted view takes input: a cell editor follows it. */
export const writable = (state: EditorState) =>
  !state.readOnly && state.facet(EditorView.editable)
/** Read-only, not uneditable: a cell editor keeps focus while input waits. */
const access = (state: EditorState) => EditorState.readOnly.of(!writable(state))

/** Where a cell editor moves: to another cell, or out of the table. */
export type CellMove = 'next' | 'previous' | 'up' | 'down' | 'left' | 'right'

/** The table around a cell editor. */
export type CellHost = {
  /** The formatted view. */
  readonly main: EditorView
  /** The cell's text between its delimiters in the formatted view's document now; null while its row ends before it. */
  span(): { from: number; to: number; closed: boolean } | null
  /** The change that ends the cell's row with this cell, holding `text`. */
  fill(text: string): ChangeSpec
  /** Move to another cell or out of the table; false when there is nowhere to go. */
  move(move: CellMove): boolean
  /** Leave the table, after it or before it, back to the formatted view. */
  leave(after: boolean): void
  /** Focus left the editor for something outside it. */
  blurred(editor: CellEditor): void
}

/**
 * Edits one cell's source in place: a CodeMirror view over the text between
 * the cell's delimiters. Each change is one edit of the formatted view's
 * document at the cell's position, its selection maps to the same source
 * positions, and the formatted view's own changes flow back.
 */
export class CellEditor {
  readonly view: EditorView
  /** A change from the formatted view is being applied. */
  private remote = false
  private access = new Compartment()

  private host: CellHost

  constructor(
    host: CellHost,
    parent: HTMLElement,
    text: string,
    anchor: number,
    head = anchor,
  ) {
    this.host = host
    const main = host.main.state
    const preview = ViewPlugin.fromClass(
      class {
        decorations: DecorationSet
        atomic: DecorationSet
        constructor(view: EditorView) {
          ;({ decorations: this.decorations, atomic: this.atomic } =
            editorDecorations(host.main.state, view))
        }
        update(update: ViewUpdate) {
          if (update.docChanged || update.selectionSet || update.focusChanged)
            ({ decorations: this.decorations, atomic: this.atomic } =
              editorDecorations(host.main.state, update.view))
        }
      },
      {
        decorations: (plugin) => plugin.decorations,
        provide: (plugin) =>
          EditorView.atomicRanges.of(
            (view) => view.plugin(plugin)?.atomic ?? Decoration.none,
          ),
      },
    )
    const visualLine = (view: EditorView, end: boolean) => {
      const { head, empty } = view.state.selection.main
      if (!empty) return false
      const at = view.coordsAtPos(head),
        edge = view.coordsAtPos(end ? view.state.doc.length : 0)
      return !at || !edge || Math.abs(at.top - edge.top) < 2
    }
    const content = (view: EditorView) => padding(view.state.doc.toString())
    const move = (to: CellMove) => () => host.move(to)
    // Inline formatting shortcuts format the cell's source; block ones do nothing in a cell.
    let formatting: SourceFormatting | null = null
    const inline = ['bold', 'italic', 'strike', 'inline-code']
    /** Put the caret at the content's start or end, inside the cell's padding. */
    const edge = (end: boolean, extend: boolean) => (view: EditorView) => {
      const { start, end: last } = content(view)
      const at = end ? last : start
      const { anchor } = view.state.selection.main
      view.dispatch({
        selection: { anchor: extend ? anchor : at, head: at },
        userEvent: 'select',
      })
      return true
    }
    this.view = new EditorView({
      parent,
      state: EditorState.create({
        doc: text,
        selection: { anchor, head },
        extensions: [
          preview,
          this.access.of(access(main)),
          EditorState.transactionFilter.of((transaction) => {
            // Nothing writes the cell while the formatted view takes no input.
            if (
              transaction.docChanged &&
              !this.remote &&
              !writable(host.main.state)
            )
              return []
            // The caret moves within the content, not into the padding.
            if (!transaction.docChanged && transaction.selection) {
              if (this.remote) return transaction
              const { start, end } = padding(transaction.newDoc.toString())
              const clamp = (pos: number) => Math.max(start, Math.min(end, pos))
              const ranges = transaction.newSelection.ranges
              if (
                ranges.every(
                  (range) =>
                    clamp(range.anchor) === range.anchor &&
                    clamp(range.head) === range.head,
                )
              )
                return transaction
              return {
                selection: EditorSelection.create(
                  ranges.map((range) =>
                    EditorSelection.range(
                      clamp(range.anchor),
                      clamp(range.head),
                    ),
                  ),
                  transaction.newSelection.mainIndex,
                ),
                annotations: transaction.annotation(Transaction.userEvent)
                  ? Transaction.userEvent.of(
                      transaction.annotation(Transaction.userEvent)!,
                    )
                  : [],
              }
            }
            if (!transaction.docChanged || this.remote) return transaction
            const fixes = cellFixes(
              transaction.newDoc.toString(),
              host.span()?.closed ?? true,
            )
            return fixes.length
              ? [transaction, { changes: fixes, sequential: true }]
              : transaction
          }),
          Prec.highest(
            keymap.of([
              { key: 'Tab', run: move('next'), shift: move('previous') },
              {
                key: 'Home',
                run: edge(false, false),
                shift: edge(false, true),
              },
              { key: 'End', run: edge(true, false), shift: edge(true, true) },
              { key: 'Enter', run: move('down') },
              {
                key: 'Shift-Enter',
                run: (view) => {
                  view.dispatch(view.state.replaceSelection('<br>'), {
                    userEvent: 'input',
                  })
                  return true
                },
              },
              {
                key: 'Mod-Enter',
                run: () => {
                  host.leave(true)
                  return true
                },
              },
              {
                key: 'Escape',
                run: () => {
                  host.leave(true)
                  return true
                },
              },
              {
                key: 'ArrowUp',
                run: (view) => visualLine(view, false) && host.move('up'),
              },
              {
                key: 'ArrowDown',
                run: (view) => visualLine(view, true) && host.move('down'),
              },
              {
                key: 'ArrowLeft',
                run: (view) =>
                  view.state.selection.main.empty &&
                  view.state.selection.main.head <= content(view).start &&
                  host.move('left'),
              },
              {
                key: 'ArrowRight',
                run: (view) =>
                  view.state.selection.main.empty &&
                  view.state.selection.main.head >= content(view).end &&
                  host.move('right'),
              },
            ]),
          ),
          keymap.of(
            formattingKeymap((id) =>
              inline.includes(id) ? (formatting?.run(id) ?? false) : true,
            ),
          ),
          keymap.of(defaultKeymap),
          // Undo and redo are the formatted view's, through its history; a
          // view that takes no input takes neither, and the browser's own
          // undo of the cell's DOM never runs.
          Prec.lowest(
            EditorView.domEventHandlers({
              keydown: (event) =>
                (event.metaKey || event.ctrlKey) &&
                /^[yz]$/i.test(event.key) &&
                (!writable(host.main.state) ||
                  runScopeHandlers(host.main, event, 'editor')),
              beforeinput: (event) => {
                const { inputType } = event
                if (inputType !== 'historyUndo' && inputType !== 'historyRedo')
                  return false
                if (writable(host.main.state))
                  runSourceHistory(
                    host.main,
                    inputType === 'historyUndo' ? 'undo' : 'redo',
                  )
                return true
              },
              focusout: (event) => {
                const next = event.relatedTarget
                if (!(next instanceof Node) || !this.view.dom.contains(next))
                  host.blurred(this)
              },
            }),
          ),
          EditorView.lineWrapping,
          showMarkdownMarkers.of(main.facet(showMarkdownMarkers)),
          EditorView.editorAttributes.of({ class: 'hibi-lp-cell-editor' }),
          EditorView.contentAttributes.of({
            'aria-label': 'Table cell',
            spellcheck: host.main.contentDOM.spellcheck ? 'true' : 'false',
          }),
        ],
      }),
      dispatchTransactions: (transactions, view) =>
        this.dispatch(transactions, view),
    })
    formatting = sourceFormatting(this.view)
  }

  /** Apply the editor's transactions, and send each change and selection to the formatted view. */
  private dispatch(transactions: readonly Transaction[], view: EditorView) {
    view.update(transactions)
    if (this.remote) return
    for (const transaction of transactions) {
      if (!view.dom.isConnected) return
      const span = this.host.span()
      const changes: ChangeSpec[] = []
      if (transaction.docChanged) {
        if (!span) changes.push(this.host.fill(transaction.newDoc.toString()))
        else
          transaction.changes.iterChanges((fromA, toA, _fromB, _toB, text) => {
            const insert = text.toString()
            // Choosing a composition's candidates rewrites its text unchanged.
            if (transaction.startState.sliceDoc(fromA, toA) !== insert)
              changes.push({
                from: span.from + fromA,
                to: span.from + toA,
                insert,
              })
          })
      }
      if (!changes.length && !transaction.selection) continue
      // A composition's candidates stay in the cell, so that the formatted
      // view's history keeps the composition one step.
      if (!changes.length && view.composing) continue
      const selection = transaction.newSelection
      const userEvent = transaction.annotation(Transaction.userEvent)
      const isolate = transaction.annotation(isolateHistory)
      this.host.main.dispatch({
        changes,
        ...(span
          ? {
              selection: EditorSelection.create(
                selection.ranges.map((range) =>
                  EditorSelection.range(
                    span.from + range.anchor,
                    span.from + range.head,
                  ),
                ),
                selection.mainIndex,
              ),
            }
          : {}),
        ...(userEvent ? { userEvent } : {}),
        annotations: [
          cellInput.of(true),
          ...(isolate ? [isolateHistory.of(isolate)] : []),
        ],
      })
    }
  }

  /** Take input as the formatted view does, after it changed. */
  reconfigure(main: EditorState) {
    if (writable(main) !== writable(this.view.state))
      this.view.dispatch({ effects: this.access.reconfigure(access(main)) })
  }

  /** Select in the cell's text, for a selection the formatted view set. */
  select(anchor: number, head: number) {
    this.remote = true
    try {
      this.view.dispatch({ selection: { anchor, head } })
    } finally {
      this.remote = false
    }
  }

  /** Show the cell's text after the formatted view changed it. */
  sync(text: string) {
    const doc = this.view.state.doc.toString()
    if (doc === text) return
    let start = 0,
      end = 0
    while (
      start < doc.length &&
      start < text.length &&
      doc[start] === text[start]
    )
      start++
    while (
      end < doc.length - start &&
      end < text.length - start &&
      doc[doc.length - 1 - end] === text[text.length - 1 - end]
    )
      end++
    this.remote = true
    try {
      this.view.dispatch({
        changes: {
          from: start,
          to: doc.length - end,
          insert: text.slice(start, text.length - end),
        },
        annotations: Transaction.remote.of(true),
      })
    } finally {
      this.remote = false
    }
  }

  /** Put the formatted view's selection where the editor's is. */
  mirror() {
    const span = this.host.span()
    if (!span) return
    const { anchor, head } = this.view.state.selection.main
    this.host.main.dispatch({
      selection: { anchor: span.from + anchor, head: span.from + head },
      annotations: cellInput.of(true),
    })
  }

  focus() {
    this.view.focus()
  }

  destroy() {
    this.view.destroy()
  }
}
