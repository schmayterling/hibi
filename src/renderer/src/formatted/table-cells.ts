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
  Direction,
  EditorView,
  keymap,
  runScopeHandlers,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view'
import { type SyntaxNodeRef, Tree } from '@lezer/common'
import type { MarkdownConfig, MarkdownParser } from '@lezer/markdown'
import {
  literalText,
  customBody as nativeBody,
} from '../../../shared/formatted-custom-body.ts'
import { formattedInlineParser } from '../../../shared/formatted-markdown.ts'
import { markdownLiteral } from '../../../shared/markdown-literal.ts'
import { runSourceHistory } from '../../../shared/source-history.ts'
import {
  blockMarkedNodes,
  claimFormattedReplacement,
  delimiterRuns,
  type FormattedDecorations,
  type FormattedRenderContext,
  followsLink,
  formattedCellExtensions,
  formattedLinkAttributes,
  formattedLiteral,
  formattedMarkdown,
  formattedNodeViews,
  formattedRefresh,
  formattedTree,
  showMarkdownMarkers,
} from '../formatted-contributions.ts'
import { drawReference, referenceLink } from '../formatted-references.ts'
import {
  recordPageSelection,
  shiftDoubleClick,
} from '../native-dom-selection.ts'
import {
  formattingKeymap,
  type SourceFormatting,
  sourceFormatting,
  storedMarkInput,
} from '../source-formatting.ts'
import { rejectedInput } from '../source-formatting-actions.ts'
import { cellFixes, type InlineMark, planInline } from './table-source.ts'

/*
 * Table cells: their inline Markdown rendered the way the formatted view
 * renders text, as static DOM in the table, or as the decorations of a cell
 * editor, a small CodeMirror view over the cell's exact source.
 */

/** Lezer Markdown for cell text: the formatted view's inline syntax and no blocks. */
const cellParsers = new WeakMap<readonly MarkdownConfig[], MarkdownParser>()
export function cellParser(state: EditorState) {
  const contributed = state.facet(formattedMarkdown)
  let found = cellParsers.get(contributed)
  if (!found) {
    found = formattedInlineParser(contributed)
    cellParsers.set(contributed, found)
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
  /** Text that reads as a link, whole around the decorations in it. */
  link(from: number, to: number, attributes: Record<string, string>): void
  /** Syntax hidden, or replaced by a widget. */
  hide(from: number, to: number, widget: WidgetType | null): void
  /** Syntax shown as an editable marker. */
  marker(from: number, to: number): void
  /** Hidden syntax delimiters, which the caret crosses together where they touch. */
  delimiter?(from: number, to: number): void
  widget(at: number, widget: WidgetType, side: number): void
  /** The visible character and hidden backslash of an escape share a source unit. */
  escape?(at: number, from: number): void
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
  from: number,
  source?: readonly number[],
  customBody = false,
) {
  const to = from + (source?.[text.length] ?? text.length)
  const views = formattedNodeViews(state)
  const literal = literalNodes(state)
  const replacements = new Set<string>()
  // Node and context positions stay in the owning document. Only the sink
  // maps them to the cell's displayed text, where escaped pipes lose a slash.
  const local = (position: number) => {
    const offset = Math.max(0, position - from)
    if (!source) return Math.min(text.length, offset)
    let low = 0,
      high = text.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (source[middle]! < offset) low = middle + 1
      else high = middle
    }
    return low
  }
  const revealedAt = (start: number, end: number) =>
    touched(local(start), local(end))
  // A cell is one block: its formatting shows all its delimiters while the
  // selection is in the cell.
  const revealedFor = (node: SyntaxNodeRef) =>
    blockMarkedNodes.has(node.name)
      ? touched(0, text.length)
      : revealedAt(node.from, node.to)
  // Line breaks in cells are written as <br>, as the rich editor saved them.
  const lineBreakAt = (node: SyntaxNodeRef) =>
    node.name === 'HTMLTag' &&
    /^<br\s*\/?>$/i.test(state.sliceDoc(node.from, node.to))
  const sink = (revealed: boolean): FormattedDecorations => ({
    mark(start, end, attributes) {
      const from = local(start),
        to = local(end)
      if (to > from) out.mark(from, to, attributes)
    },
    link(start, end, attributes) {
      const from = local(start),
        to = local(end)
      if (to > from) out.link(from, to, formattedLinkAttributes(attributes))
    },
    syntax(start, end) {
      const from = local(start),
        to = local(end)
      if (to <= from) return
      if (revealed) out.marker(from, to)
      else {
        out.hide(from, to, null)
        out.delimiter?.(from, to)
      }
    },
    line() {},
    widget(at, widget, side = 1) {
      out.widget(local(at), widget, side)
    },
    replace(start, end, widget) {
      const from = local(start),
        to = local(end)
      if (to > from && claimFormattedReplacement(replacements, from, to))
        out.hide(from, to, widget ?? null)
    },
  })
  const tree = cellParser(state).parse(state.sliceDoc(from, to))
  const cursor = new Tree(tree.type, [tree], [from], to).cursor()
  cursor.firstChild()
  cursor.iterate((node) => {
    // Syntax whose setting is off shows as written, its children too.
    if (literalText(node.node, literal, customBody || nativeBody(node.node)))
      return false
    if (node.name === 'Escape')
      out.escape?.(local(node.from + 1), local(node.from))
    const revealed = revealedFor(node)
    const nodeOut = sink(revealed)
    let skip = false
    // A cell draws its line breaks itself, so contributed HTML renderers
    // add no second one.
    const nodeViews = lineBreakAt(node) ? [] : views(node.type).views
    for (const nodeView of nodeViews) {
      const context: FormattedRenderContext = {
        state,
        visible: { from, to },
        revealed,
      }
      if (nodeView.decorate?.(node, nodeOut, context) === false) skip = true
    }
    return builtIn(node, nodeOut) === false || skip ? false : undefined
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
        if (!literal.has(node.name)) style('hibi-lp-em', node.from, node.to)
        return
      case 'StrongEmphasis':
        if (!literal.has(node.name)) style('hibi-lp-strong', node.from, node.to)
        return
      case 'EmphasisMark': {
        const parent = node.node.parent
        sink(!!parent && revealedFor(parent)).syntax(node.from, node.to)
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
          (mark) => state.sliceDoc(mark.from, mark.to) === ']',
        )
        if (!open || !close || state.sliceDoc(open.from, open.from + 1) !== '[')
          return false
        // A reference link renders when the note defines its label.
        const reference =
          state.sliceDoc(close.to, close.to + 1) !== '(' &&
          referenceLink(state.doc, node.node)
        if (reference === null) return false
        const answer = reference
          ? drawReference(state, reference.label, node.from)
          : null
        if (reference && !answer) return
        out.syntax(node.from, open.to)
        out.syntax(close.from, node.to)
        if (!literal.has('Link'))
          out.link(
            open.to,
            close.from,
            answer?.title ? { title: answer.title } : undefined,
          )
        return
      }
      case 'Autolink': {
        const url = node.node.getChild('URL')
        if (!url) return false
        out.syntax(node.from, url.from)
        out.syntax(url.to, node.to)
        if (!literal.has('Autolink')) out.link(url.from, url.to)
        return false
      }
      case 'URL': {
        const parent = node.node.parent?.name
        if (
          !literal.has('URL') &&
          parent !== 'Link' &&
          parent !== 'Image' &&
          parent !== 'LinkReference'
        )
          out.link(node.from, node.to)
        return
      }
      case 'Escape':
        out.syntax(node.from, node.from + 1)
        return
      case 'HTMLTag':
        if (lineBreakAt(node)) out.replace(node.from, node.to, lineBreak)
        return false
      case 'Image':
      case 'Entity':
        // Rendered by later formatted-view slices; shown as written for now.
        return false
    }
    return
  }
}

/** Source boundaries of rendered text in its cell's content. */
const textPositions = new WeakMap<
  Node,
  { from: number; start?: number; to?: number }
>()
export const markStarts = new WeakMap<Element, number>()

/** Replacement glyphs and escaped characters include their complete source unit. */
export function textPosition(node: Node, offset: number): number | null {
  for (let current: Node | null = node; current; current = current.parentNode) {
    const range = textPositions.get(current)
    if (range)
      return offset === 0
        ? (range.start ?? range.from)
        : (range.to ?? range.from + offset)
  }
  return null
}

/** A cell's inline Markdown as static DOM, as the formatted view renders text it does not reveal. */
export function renderInline(
  view: EditorView,
  text: string,
  into: HTMLElement,
  from = 0,
  source?: readonly number[],
  customBody = false,
) {
  const marks: InlineMark[] = [],
    hidden: { from: number; to: number; widget: WidgetType | null }[] = [],
    widgets: { at: number; widget: WidgetType; side: number }[] = []
  const escapes = new Map<number, number>()
  decorateCell(
    view.state,
    text,
    {
      mark: (from, to, attributes) => marks.push({ from, to, attributes }),
      link: (from, to, attributes) => marks.push({ from, to, attributes }),
      hide: (from, to, widget) => hidden.push({ from, to, widget }),
      marker() {},
      widget: (at, widget, side) => widgets.push({ at, widget, side }),
      escape: (at, from) => escapes.set(at, from),
    },
    () => false,
    from,
    source,
    customBody,
  )
  // Text between decoration boundaries, inside spans for the marks over it.
  const parents: HTMLElement[] = [into]
  for (const op of planInline(text.length, marks, hidden, widgets)) {
    const parent = parents.at(-1)!
    if (op.type === 'open') {
      const element = document.createElement('span')
      markStarts.set(element, op.mark.from)
      for (const [key, value] of Object.entries(op.mark.attributes))
        element.setAttribute(key, value)
      parent.append(element)
      parents.push(element)
    } else if (op.type === 'close') parents.pop()
    else if (op.type === 'widget') {
      const dom = op.widget.toDOM(view)
      textPositions.set(dom, { from: op.from, to: op.to })
      parent.append(dom)
    } else {
      const node = document.createTextNode(text.slice(op.from, op.to))
      textPositions.set(node, {
        from: op.from,
        start: escapes.get(op.from) ?? op.from,
      })
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
function editorDecorations(
  main: EditorState,
  view: EditorView,
  from?: number,
  customBody = false,
) {
  const text = view.state.doc.toString()
  const reveal =
    view.hasFocus && main.facet(showMarkdownMarkers)
      ? view.state.selection.ranges
      : []
  const decorations: Range<Decoration>[] = [],
    atomic: Range<Decoration>[] = [],
    delimiters: { from: number; to: number }[] = []
  const hide = (from: number, to: number, widget: WidgetType | null) => {
    if (to <= from) return
    const range = Decoration.replace(widget ? { widget } : {}).range(from, to)
    decorations.push(range)
    atomic.push(range)
  }
  // Spaces around the content are the cell's padding, not its text.
  let { start, end } = padding(text)
  // Newly typed whitespace must keep the caret in visible cell text.
  if (view.hasFocus)
    for (const range of view.state.selection.ranges) {
      start = Math.min(start, range.from)
      end = Math.max(end, range.to)
    }
  hide(0, start, null)
  hide(end, text.length, null)
  if (from !== undefined)
    decorateCell(
      main,
      text,
      {
        mark: (from, to, attributes) =>
          decorations.push(Decoration.mark({ attributes }).range(from, to)),
        // Inclusive, so that widgets at the text's ends are inside the link too.
        link: (from, to, attributes) =>
          decorations.push(
            Decoration.mark({ attributes, inclusive: true }).range(from, to),
          ),
        hide,
        marker: (from, to) =>
          decorations.push(
            Decoration.mark({ class: 'hibi-lp-marker' }).range(from, to),
          ),
        widget: (at, widget, side) =>
          decorations.push(Decoration.widget({ widget, side }).range(at)),
        delimiter: (from, to) => delimiters.push({ from, to }),
      },
      (from, to) =>
        reveal.some((range) => range.from <= to && range.to >= from),
      from,
      undefined,
      customBody,
    )
  return {
    decorations: Decoration.set(decorations, true),
    atomic: Decoration.set(atomic, true),
    runs: Decoration.set(
      delimiterRuns(delimiters).map(({ from, to }) =>
        Decoration.replace({}).range(from, to),
      ),
    ),
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
/** A line break in a cell's editor, which Enter, Shift-Enter and Mod-Enter all make in the rich editor's cells. */
export function cellLineBreak(view: EditorView) {
  view.dispatch(view.state.replaceSelection('<br>'), { userEvent: 'input' })
  return true
}

export type CellMove = 'next' | 'previous' | 'up' | 'down' | 'left' | 'right'

/** The table around a cell editor. */
export type CellHost = {
  /** The formatted view. */
  readonly main: EditorView
  /** Whether native custom-body syntax surrounds the table. */
  customBody(): boolean
  /** Whether the table's cell spans describe the current document. */
  current(): boolean
  /** The cell's text between its delimiters in the formatted view's document now; null while its row ends before it. */
  span(): { from: number; to: number; closed: boolean } | null
  /** The change that ends the cell's row with this cell, holding `text`. */
  fill(text: string): ChangeSpec
  /** Move to another cell or out of the table; false when there is nowhere to go. */
  move(move: CellMove): boolean
  /** Leave the table, after it or before it, back to the formatted view. */
  leave(after: boolean): void
  /** Leave for a paragraph below a table that ends the note, as Mod-Enter does after a final block; false elsewhere. */
  exit(): boolean
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
  readonly formatting: SourceFormatting
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
        runs: DecorationSet
        constructor(view: EditorView) {
          ;({
            decorations: this.decorations,
            atomic: this.atomic,
            runs: this.runs,
          } = editorDecorations(
            host.main.state,
            view,
            host.span()?.from,
            host.customBody(),
          ))
        }
        update(update: ViewUpdate) {
          // Local input reaches the parent after view.update. Keep mapped
          // decorations until dispatch refreshes against that committed state.
          if (update.docChanged) {
            this.decorations = this.decorations.map(update.changes)
            this.atomic = this.atomic.map(update.changes)
            this.runs = this.runs.map(update.changes)
          } else if (
            update.selectionSet ||
            update.focusChanged ||
            update.transactions.some((transaction) =>
              transaction.effects.some((effect) => effect.is(formattedRefresh)),
            )
          )
            ({
              decorations: this.decorations,
              atomic: this.atomic,
              runs: this.runs,
            } = editorDecorations(
              host.main.state,
              update.view,
              host.span()?.from,
              host.customBody(),
            ))
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
    // Arrows leave the cell from the selection's head, so a cell Tab selected
    // is left with one press. Sideways that is the rich editor's tables' rule;
    // up and down it is the caret's (table-tab-001).
    const visualLine = (view: EditorView, end: boolean) => {
      const { head } = view.state.selection.main
      const at = view.coordsAtPos(head),
        edge = view.coordsAtPos(end ? view.state.doc.length : 0)
      return !at || !edge || Math.abs(at.top - edge.top) < 2
    }
    const content = (view: EditorView) => padding(view.state.doc.toString())
    /**
     * Arrows move one visible step, as in the formatted view: touching hidden
     * delimiters are crossed together, and a step that crossed only them goes
     * on to the next character.
     */
    const overRun = (view: EditorView, right: boolean) => {
      const range = view.state.selection.main
      const runs = view.plugin(preview)?.runs
      if (!runs || !range.empty || view.state.selection.ranges.length > 1)
        return false
      const forward =
        right === (view.textDirectionAt(range.head) === Direction.LTR)
      const step = (from: number) => {
        let at = view.moveByChar(EditorSelection.cursor(from), forward).head
        runs.between(at, at, (a, b) => {
          if (a < at && at < b) at = forward ? b : a
        })
        return at
      }
      const first = view.moveByChar(range, forward).head
      let target = step(range.head)
      const low = Math.min(range.head, target),
        high = Math.max(range.head, target)
      let hidden = false
      runs.between(low, high, (a, b) => {
        if (a <= low && b >= high && low < high) hidden = true
      })
      // Into or out of the ends of the cell's text, formatting is left or
      // entered without moving, as at the end of the note.
      const { start, end } = content(view)
      const ends = [start, end]
      if (hidden && !ends.includes(target) && !ends.includes(range.head))
        target = step(target)
      if (target === first) return false
      view.dispatch({
        selection: { anchor: target },
        scrollIntoView: true,
        userEvent: 'select',
      })
      return true
    }
    const move = (to: CellMove) => () => host.move(to)
    // Inline formatting shortcuts format the cell's source; block ones do nothing in a cell.
    let formatting: SourceFormatting | null = null
    const inline = ['bold', 'italic', 'strike', 'subscript', 'inline-code']
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
          storedMarkInput,
          shiftDoubleClick,
          formattedTree.of((state) =>
            cellParser(host.main.state).parse(state.doc.toString()),
          ),
          main.facet(formattedLiteral).map((name) => formattedLiteral.of(name)),
          main
            .facet(formattedCellExtensions)
            .map((extension) => extension(host.main)),
          this.access.of(access(main)),
          EditorState.transactionFilter.of((transaction) => {
            // Nothing writes while the host takes no input or has old spans.
            if (
              transaction.docChanged &&
              !this.remote &&
              (!writable(host.main.state) || !host.current())
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
              // As in the rich editor, select all takes the whole note.
              {
                key: 'Mod-a',
                run: () => {
                  host.main.focus()
                  host.main.dispatch({
                    selection: { anchor: 0, head: host.main.state.doc.length },
                    userEvent: 'select.all',
                  })
                  return true
                },
              },
              {
                key: 'Home',
                run: edge(false, false),
                shift: edge(false, true),
              },
              { key: 'End', run: edge(true, false), shift: edge(true, true) },
              { key: 'Enter', run: cellLineBreak, shift: cellLineBreak },
              {
                key: 'Mod-Enter',
                run: (view) => host.exit() || cellLineBreak(view),
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
                  (view.state.selection.main.head <= content(view).start &&
                    host.move('left')) ||
                  overRun(view, false),
              },
              {
                key: 'ArrowRight',
                run: (view) =>
                  (view.state.selection.main.head >= content(view).end &&
                    host.move('right')) ||
                  overRun(view, true),
              },
            ]),
          ),
          keymap.of(
            formattingKeymap((id) =>
              inline.includes(id) ? (formatting?.run(id) ?? false) : true,
            ),
          ),
          keymap.of(defaultKeymap),
          // A script or assistive tool can select from this cell into
          // another while the editor keeps focus. A measure that reads the
          // page before it reports the change draws the editor's caret over
          // it, with no update for plugins to see; attributes are read in
          // every update before that draw. The pick goes back on the page
          // for the formatted view to take.
          EditorView.contentAttributes.of((view) => {
            const page = view.dom.ownerDocument.getSelection()
            const anchor = page?.anchorNode,
              focus = page?.focusNode
            if (
              !page ||
              !anchor ||
              !focus ||
              !view.hasFocus ||
              view.contentDOM.contains(anchor) ===
                view.contentDOM.contains(focus) ||
              !host.main.contentDOM.contains(anchor) ||
              !host.main.contentDOM.contains(focus)
            )
              return null
            const { anchorOffset, focusOffset } = page
            queueMicrotask(() => {
              if (
                anchor.isConnected &&
                focus.isConnected &&
                (page.anchorNode !== anchor ||
                  page.anchorOffset !== anchorOffset ||
                  page.focusNode !== focus ||
                  page.focusOffset !== focusOffset)
              )
                page.setBaseAndExtent(anchor, anchorOffset, focus, focusOffset)
            })
            return null
          }),
          // Undo and redo are the formatted view's, through its history; a
          // view that takes no input takes neither, and the browser's own
          // undo of the cell's DOM never runs.
          Prec.lowest(
            EditorView.domEventHandlers({
              // A click that follows a link leaves the selection; the table follows it.
              mousedown: (event) =>
                followsLink(event) &&
                event.target instanceof Element &&
                !!event.target.closest('.hibi-lp-link'),
              keydown: (event) =>
                (event.metaKey || event.ctrlKey) &&
                /^[yz]$/i.test(event.key) &&
                (!writable(host.main.state) ||
                  runScopeHandlers(host.main, event, 'editor')),
              beforeinput: (event, view) => {
                const { inputType, data } = event
                if (
                  inputType === 'insertText' &&
                  data &&
                  /[\r\n]/.test(data) &&
                  !event.isComposing &&
                  !view.composing &&
                  writable(host.main.state) &&
                  host.current()
                ) {
                  event.preventDefault()
                  const { from, to } = view.state.selection.main
                  const text = view.state.toText(data).toString()
                  const insert = () =>
                    view.state.update(
                      view.state.replaceSelection(markdownLiteral(text)),
                      {
                        userEvent: 'input.type',
                        scrollIntoView: true,
                      },
                    )
                  if (
                    !view.state
                      .facet(EditorView.inputHandler)
                      .some((handler) => handler(view, from, to, text, insert))
                  )
                    view.dispatch(insert())
                  view.contentDOM.dispatchEvent(
                    new InputEvent('input', {
                      inputType,
                      data,
                      bubbles: true,
                    }),
                  )
                  return true
                }
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
    this.formatting = formatting = sourceFormatting(this.view)
  }

  /** Apply the editor's transactions, and send each change and selection to the formatted view. */
  private dispatch(transactions: readonly Transaction[], view: EditorView) {
    // Rejected input leaves the cell as it was, for CodeMirror to redraw.
    for (const transaction of transactions) {
      const error = transaction.annotation(rejectedInput)
      if (error) {
        this.host.main.dispatch({ annotations: rejectedInput.of(error) })
        return
      }
    }
    view.update(transactions)
    if (this.remote) {
      if (transactions.some((transaction) => transaction.docChanged))
        this.refresh()
      return
    }
    for (const transaction of transactions) {
      if (!view.dom.isConnected || !this.host.current()) return
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
      // The editor draws its own pointer selections: as one, the formatted
      // view would write the page's selection over them and take the focus.
      const own = transaction.annotation(Transaction.userEvent)
      const userEvent = own === 'select.pointer' ? 'select' : own
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
    if (
      transactions.some((transaction) => transaction.docChanged) &&
      view.dom.isConnected
    )
      this.refresh()
  }

  /** Redraw inline syntax after the formatted view's render inputs change. */
  refresh() {
    this.view.dispatch({ effects: formattedRefresh.of(null) })
  }

  /** Take input as the formatted view does, after it changed. */
  reconfigure(main: EditorState) {
    if (writable(main) !== writable(this.view.state))
      this.view.dispatch({ effects: this.access.reconfigure(access(main)) })
  }

  /** Select in the cell's text, for a selection the formatted view set. */
  select(anchor: number, head: number) {
    // The view writes its pointer selections to the page while this editor
    // has focus; the editor's record of the page is then stale, and it
    // would leave the page there.
    const page = this.view.dom.ownerDocument.getSelection()
    if (
      this.view.hasFocus &&
      !this.view.contentDOM.contains(page?.focusNode ?? null)
    )
      recordPageSelection(this.view)
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
    const span = this.host.span()
    const selected = this.host.main.state.selection.main
    const selection =
      span && selected.from >= span.from && selected.to <= span.to
        ? {
            anchor: selected.anchor - span.from,
            head: selected.head - span.from,
          }
        : undefined
    this.remote = true
    try {
      this.view.dispatch({
        selection,
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
