import {
  Compartment,
  EditorSelection,
  EditorState,
  type Extension,
  Facet,
  Prec,
  type Range,
  RangeSet,
  StateEffect,
  StateField,
  type Text,
  type TransactionSpec,
} from '@codemirror/state'
import {
  BlockWrapper,
  Decoration,
  type DecorationSet,
  Direction,
  EditorView,
  keymap,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view'
import {
  IterMode,
  type NodeType,
  type SyntaxNode,
  type SyntaxNodeRef,
  type Tree,
} from '@lezer/common'
import { highlightTree } from '@lezer/highlight'
import { literalText } from '../../shared/formatted-custom-body.ts'
import {
  formattedDefinitionRange,
  formattedListStart,
  formattedMarkerRanges,
} from '../../shared/formatted-text-rules.ts'
import { listWindow, parsedChunks, uncovered } from './chunked-markdown'
import { codeHighlighter } from './code-languages'
import { codePlaceholders } from './code-placeholders'
import {
  blockAtom,
  blockBreak,
  blockText,
  codeIndent,
  deleteBackward,
  deleteForward,
  exitBlock,
  gapInput,
  indent,
  lineBreak,
  lineInput,
} from './formatted-commands'
import {
  blockMarkedNodes,
  claimFormattedReplacement,
  delimiterRuns,
  type FormattedContainer,
  type FormattedDecorations,
  type FormattedLayout,
  type FormattedNodeView,
  type FormattedNodeViews,
  formattedBlockEdges,
  formattedContributions,
  formattedDocument,
  formattedLegacyLiteral,
  formattedLinkAttributes,
  formattedLiteral,
  formattedNodeViews,
  formattedPrefix,
  formattedRefresh,
  formattedRenderInputs,
  formattedTree,
  formattedViews,
  showMarkdownMarkers,
} from './formatted-contributions'
import {
  drawReference,
  knownReference,
  referenceLink,
  referenceLinks,
} from './formatted-references'
import type { FormattedSyntax } from './formatted-syntax'
import { openedBlock, openSelection } from './formatted-text-end'
import { nativeDOMSelection, shiftDoubleClick } from './native-dom-selection'
import './formatted'
import './live-preview.css'

/*
 * Live preview renders Markdown in place: syntax the formatted view shows as
 * formatting is hidden, block structure becomes line styles and widgets, and
 * the source text stays the only document. Work is bounded by the visible
 * ranges (inline styles) and by parsed chunks (layout), never the document.
 */

const hide = Decoration.replace({})
/** Measure key of the sideways scroll to the caret. */
const revealCaret = {}
// Chromium makes a scrolling box a Tab stop of its own; Tab passes it by.
const codeScroll = BlockWrapper.create({
  tagName: 'div',
  attributes: { class: 'hibi-lp-codescroll', tabindex: '-1' },
})

/** Whether Tab indents formatted text and code; list items always take Tab. */
export const formattedTabIndents = Facet.define<boolean, boolean>({
  combine: (values) => values.at(-1) ?? true,
})

type Revealed = { from: number; to: number }

/** Where the widget under the first press of a click sequence starts. */
const pressedWidget = new WeakMap<EditorView, number | null>()

/** A range over the whole note, or all its text after metadata the view keeps hidden. */
function selectsWholeNote(state: EditorState, range: Revealed) {
  if (range.to !== state.doc.length || range.from === range.to) return false
  if (range.from === 0) return true
  let body = 0
  for (const measure of state.facet(formattedPrefix))
    body = Math.max(body, measure(state))
  return range.from === body
}

class SpaceWidget extends WidgetType {
  override eq() {
    return true
  }
  toDOM() {
    const gap = document.createElement('span')
    gap.textContent = ' '
    return gap
  }
}
const space = Decoration.replace({ widget: new SpaceWidget() })
const hiddenLine = Decoration.replace({ block: true })
/** Lines of a link reference definition, which exports leave out too. */
const hiddenDefinition = Decoration.replace({ block: true })
/** A definition after a list marker, hidden up to the item's next block, which follows the marker. */
const hiddenItemDefinition = Decoration.replace({})
const definitionRange = (value: Decoration) =>
  value === hiddenDefinition || value === hiddenItemDefinition

/** Margins of a block in px, as in the formatted view's document styles. */
function blockSpace(name: string): { top: number; bottom: number } {
  const heading = headingLevel(name)
  if (heading) {
    const size = [30, 24, 20, 17, 17, 17][heading - 1]!
    return { top: size * 1.4, bottom: size * 0.6 }
  }
  switch (name) {
    case 'HorizontalRule':
      return { top: 32, bottom: 32 }
    case 'Table':
      return { top: 20, bottom: 20 }
    case 'Blockquote':
    case 'FencedCode':
    case 'CodeBlock':
      return { top: 16, bottom: 16 }
    default:
      return { top: 0, bottom: 16 }
  }
}

/** Rules of the render in progress: syntax shown as written and contributed node views. */
type Blocks = {
  literal: ReadonlySet<string>
  views: (type: NodeType) => FormattedNodeViews
  shapes: (node: SyntaxNode) => FormattedContainer | undefined
}
const noViews: FormattedNodeViews = { views: [], grouped: [] }
const noBlocks: Blocks = {
  literal: new Set(),
  views: () => noViews,
  shapes: () => undefined,
}
let blocks = noBlocks

/** Native heading DOM falls back to its first enabled level. */
function headingLevel(name: string) {
  const heading = /^(?:ATX|Setext)Heading(\d)$/.exec(name)
  if (!heading) return undefined
  return blocks.literal.has(name)
    ? [1, 2, 3, 4, 5, 6].find(
        (level) => !blocks.literal.has(`ATXHeading${level}`),
      )
    : Number(heading[1])
}

/** Blocks the view lays out; link reference definitions take no space. */
const isBlock = (node: SyntaxNode) =>
  node.type.is('Block') && node.name !== 'LinkReference'
const isList = (node: SyntaxNode) =>
  node.name === 'BulletList' || node.name === 'OrderedList'
/** Blocks that hold blocks; unless padded, their first and last children's margins collapse through them. */
const isContainer = (node: SyntaxNode) =>
  !blocks.literal.has(node.name) &&
  (node.name === 'Blockquote' ||
    node.name === 'ListItem' ||
    isList(node) ||
    blocks.views(node.type).views.some((view) => view.container))

function blockSibling(node: SyntaxNode, forward: boolean) {
  let next = forward ? node.nextSibling : node.prevSibling
  while (next && !isBlock(next))
    next = forward ? next.nextSibling : next.prevSibling
  return next
}

function blockChild(node: SyntaxNode, last: boolean) {
  const child = last ? node.lastChild : node.firstChild
  return child && !isBlock(child) ? blockSibling(child, !last) : child
}

/**
 * The line of a list item's marker when the item's first block starts on
 * the next line and shows from it: the rich view draws the marker beside
 * that block, so the marker's own line collapses.
 */
function loneMarker(doc: Text, item: SyntaxNode) {
  const own = doc.lineAt(item.from)
  // Read the line first: most items hold text after their marker.
  if (
    !/^(?:[-+*]|\d{1,9}[.)])[ \t\r]*$/.test(doc.sliceString(item.from, own.to))
  )
    return null
  let first = item.childAfter(own.to)
  // Quote markers on the next line come before its block.
  if (first && !isBlock(first)) first = blockSibling(first, true)
  return first && !isContainer(first) && first.name !== 'FencedCode'
    ? own
    : null
}

/**
 * What a link reference definition hides, as exports drop it: its lines and
 * the blank lines up to the next block, or after the previous block when
 * none follows. After a list marker, it hides from its text, with the
 * item's definitions after it, up to the item's next paragraph, which then
 * shows beside the marker, or up to the last definition before other blocks.
 */
function definitionLines(doc: Text, node: SyntaxNode) {
  return formattedDefinitionRange(
    node,
    (from, to) => doc.sliceString(from, to),
    (at) => doc.lineAt(at),
  )
}

/** The first line a block shows: a lone list marker's line collapses into the next. */
function shownLine(doc: Text, node: SyntaxNode) {
  const line = doc.lineAt(node.from)
  if (!/(?:[-+*]|\d[.)])[ \t\r]*$/.test(line.text)) return line
  for (
    let inner: SyntaxNode | null = node;
    inner && inner.from <= line.to;
    inner = isContainer(inner) ? blockChild(inner, false) : null
  )
    if (inner.name === 'ListItem' && loneMarker(doc, inner))
      return doc.line(line.number + 1)
  return line
}

/** A block's margins in its container: list items and the blocks inside them sit closer. */
function margins(node: SyntaxNode): { top: number; bottom: number } {
  // Syntax shown as written keeps a paragraph's 1em margins on both sides.
  if (literalText(node, blocks.literal)) return { top: 16, bottom: 16 }
  const parent = node.parent
  // Items and nested lists sit 0.3em apart; blocks after the first in an item one line apart.
  if (parent?.name === 'ListItem')
    return {
      top: isList(node) ? 4.8 : blockSibling(node, false) ? 16 : 0,
      bottom: 0,
    }
  if (parent && isList(parent))
    return { top: blockSibling(node, false) ? 4.8 : 0, bottom: 0 }
  const space =
    blocks.views(node.type).views.find((view) => view.space)?.space ??
    blockSpace(node.name)
  // A quote's last block has no bottom margin.
  return parent?.name === 'Blockquote' && !blockSibling(node, true)
    ? { top: space.top, bottom: 0 }
    : space
}

/** The collapsed top margin of a block and its first descendants. */
function topMargin(node: SyntaxNode): number {
  const first =
    isContainer(node) &&
    !blocks.shapes(node)?.padding?.top &&
    blockChild(node, false)
  return Math.max(margins(node).top, first ? topMargin(first) : 0)
}

function bottomMargin(node: SyntaxNode): number {
  const last =
    isContainer(node) &&
    !blocks.shapes(node)?.padding?.bottom &&
    blockChild(node, true)
  return Math.max(margins(node).bottom, last ? bottomMargin(last) : 0)
}

/** Whether a layout block replace hides the whole line. */
function replacedLine(
  layout: DecorationSet,
  current: ReturnType<Text['lineAt']>,
) {
  let replaced = false
  layout.between(current.from, current.from, (from, to, value) => {
    if (value.spec.block && from <= current.from && to >= current.to)
      replaced = true
  })
  return replaced
}

/** Visit each line from `from` to `to` that intersects `range`. */
function eachLine(
  doc: Text,
  from: number,
  to: number,
  range: { from: number; to: number },
  visit: (line: ReturnType<Text['lineAt']>) => void,
) {
  const start = Math.max(from, range.from),
    end = Math.min(to, range.to)
  if (start > end) return
  for (let line = doc.lineAt(start); ; line = doc.line(line.number + 1)) {
    visit(line)
    if (line.to >= end || line.number >= doc.lines) break
  }
}

/** A code line longer than `shortLine`: its start, where its code starts, and its end. */
type LongLine = { from: number; start: number; to: number }
/** Code lines up to this length are decorated whole instead of measured. */
const shortLine = 256
/** Refreshes code tokens after measuring the columns of long code lines. */
const measuredColumns = StateEffect.define<null>()

/** The first position from `from` to `to` where `test` holds, or `to`. */
function firstWhere(from: number, to: number, test: (pos: number) => boolean) {
  while (from < to) {
    const middle = (from + to) >> 1
    if (test(middle)) to = middle
    else from = middle + 1
  }
  return from
}

/**
 * Columns of long code lines within a screen width of the visible ones,
 * found on each line's caret positions so tabs and wide characters count,
 * or null for lines that wrap. `changed` when decorated columns no longer
 * cover what shows.
 */
function measureColumns(
  view: EditorView,
  long: readonly LongLine[],
  columns: ReadonlyMap<number, Revealed | null>,
) {
  const next = new Map<number, Revealed | null>()
  let changed = false
  for (const line of long) {
    const { node } = view.domAtPos(line.start)
    const element = (
      node instanceof Element ? node : node.parentElement
    )?.closest('.cm-line')
    const scroller = element?.closest('.hibi-lp-codescroll')
    if (!element || !scroller) continue
    const known = columns.has(line.from)
      ? (columns.get(line.from) ?? null)
      : { from: line.start, to: Math.min(line.to, line.start + 2 * shortLine) }
    if (!/^(pre|nowrap)$/.test(getComputedStyle(element).whiteSpace)) {
      next.set(line.from, null)
      changed ||= known !== null
      continue
    }
    const left = scroller.getBoundingClientRect().left
    const right = left + scroller.clientWidth
    const width = right - left
    const x = (pos: number) =>
      view.coordsAtPos(pos, pos < line.to ? 1 : -1)?.left ?? left
    if (
      known &&
      (known.from <= line.start || x(known.from) <= left) &&
      (known.to >= line.to || x(known.to) >= right)
    ) {
      next.set(line.from, known)
      continue
    }
    const from = Math.max(
      line.start,
      firstWhere(line.start, line.to, (pos) => x(pos) > left - width) - 1,
    )
    next.set(line.from, {
      from,
      to: firstWhere(from, line.to, (pos) => x(pos) >= right + width),
    })
    changed = true
  }
  return { next, changed }
}

type LineInfo = {
  classes: string[]
  style: string[]
  /** Quotes and list items around the line, outermost first. */
  containers: SyntaxNode[]
  /** The innermost list item around the line. */
  item: SyntaxNode | null
  /** Where the hidden quote markers at the line start end. */
  quoteEnd: number | null
  /** Where the line's first block starts, when one starts on it. */
  leaf: number | null
  /** Where a code line's text starts. */
  code: number | null
  /** The innermost list item shows its list marker. */
  marker: boolean
  /** Other attributes from contributed views. */
  attributes: Record<string, string>
  /** Space above the line in px. */
  gap: number
  /** The line only holds the space between two blocks. */
  margin: boolean
}

/** Item start offsets per immutable list tree, so ordinals need no sibling walk. */
const itemOffsets = new WeakMap<Tree, number[]>()

/** The item's index in its list, from offsets cached on the list tree. */
function ordinal(
  list: SyntaxNode,
  item: SyntaxNode,
  local: Map<number, number[]>,
) {
  const tree = list.tree
  let offsets = tree ? itemOffsets.get(tree) : local.get(list.from)
  if (!offsets) {
    offsets = []
    for (let child = list.firstChild; child; child = child.nextSibling)
      if (child.name === 'ListItem') offsets.push(child.from - list.from)
    if (tree) itemOffsets.set(tree, offsets)
    else local.set(list.from, offsets)
  }
  const at = item.from - list.from
  let low = 0,
    high = offsets.length - 1
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (offsets[middle]! <= at) low = middle
    else high = middle - 1
  }
  return low
}

/** Inline formatting, hidden markers and line styles for the visible ranges. */
function inline(
  view: EditorView,
  tree: Tree,
  reveal: readonly Revealed[],
  layout: DecorationSet,
  /** Decorated columns of long code lines by line start; null where a line wraps. */
  columns: ReadonlyMap<number, Revealed | null>,
): {
  decorations: DecorationSet
  groupMarks: DecorationSet
  atomic: DecorationSet
  runs: DecorationSet
  /** Starts of the lines that only hold the space between two blocks. */
  margins: number[]
  outer: DecorationSet
  wrappers: RangeSet<BlockWrapper>
  end: number
  long: LongLine[]
} {
  const { state } = view
  const doc = state.doc
  const views = formattedNodeViews(state)
  const literal = new Set(state.facet(formattedLiteral))
  const legacy = state.facet(formattedLegacyLiteral)
  const atomic: Range<Decoration>[] = []
  const touched = (from: number, to: number) =>
    reveal.some((range) => range.from <= to && range.to >= from)
  /** Whether a node shows its source: the delimiters of emphasis, code and strikethrough show for their whole block. */
  const revealedAt = (node: SyntaxNodeRef) => {
    let block: SyntaxNode | null = blockMarkedNodes.has(node.name)
      ? node.node.parent
      : null
    while (block && !block.type.is('LeafBlock')) block = block.parent
    return block ? touched(block.from, block.to) : touched(node.from, node.to)
  }
  /** Contributed container layouts, once per container node and render. */
  const shapeCache = new Map<string, FormattedContainer | undefined>()
  const shapes = (node: SyntaxNode) => {
    const key = `${node.from} ${node.name}`
    if (shapeCache.has(key)) return shapeCache.get(key)
    let shape: FormattedContainer | undefined
    const context = {
      state,
      revealed: touched(node.from, node.to),
      visible: null,
    }
    for (const nodeView of views(node.type).views) {
      shape = nodeView.container?.(node, context)
      if (shape) break
    }
    shapeCache.set(key, shape)
    return shape
  }
  blocks = { literal, views, shapes }
  const decorations: Range<Decoration>[] = []
  /**
   * Marks of views for a node's group. One set nests marks over the same
   * text in no fixed order, so these get a source of their own.
   */
  const groupMarks: Range<Decoration>[] = []
  // Text that has to stay one element wraps the other decorations.
  const outer: Range<Decoration>[] = []
  const replacements = new Set<string>()
  const lines = new Map<number, LineInfo>()
  const headings = new Map<number, Heading>()
  /** Code blocks drawn: their code lines' extent and first drawn line. */
  const codeBlocks = new Map<
    number,
    { from: number; to: number; shown: number }
  >()
  const long: LongLine[] = []
  const line = (pos: number) => {
    let info = lines.get(pos)
    if (!info) {
      info = {
        classes: [],
        style: [],
        containers: [],
        item: null,
        quoteEnd: null,
        leaf: null,
        code: null,
        marker: true,
        attributes: {},
        gap: 0,
        margin: false,
      }
      lines.set(pos, info)
    }
    return info
  }
  // Hidden syntax is atomic, so the caret steps over it and it never splits.
  const hideRange = (from: number, to: number) => {
    if (to <= from) return
    const range = hide.range(from, to)
    decorations.push(range)
    atomic.push(range)
  }
  const mark = (className: string, from: number, to: number) => {
    if (to > from)
      decorations.push(Decoration.mark({ class: className }).range(from, to))
  }
  /** Inclusive, so that widgets at the text's ends are inside the link too. */
  const linkText = (
    from: number,
    to: number,
    attributes?: Record<string, string>,
  ) => {
    if (to > from)
      outer.push(
        Decoration.mark({
          attributes: formattedLinkAttributes(attributes),
          inclusive: true,
        }).range(from, to),
      )
  }
  /** Hidden delimiters, which the caret crosses together where they touch. */
  const delimiters: { from: number; to: number }[] = []
  /** Markers of formatting under the selection stay visible and editable. */
  const syntax = (from: number, to: number, revealed: boolean) => {
    if (!revealed) {
      hideRange(from, to)
      if (to > from) delimiters.push({ from, to })
    } else if (to > from) {
      mark('hibi-lp-marker hibi-lp-syntax', from, to)
    }
  }

  function link(node: SyntaxNode) {
    const linkMarks = node.getChildren('LinkMark')
    const open = linkMarks[0]
    const close = linkMarks.find(
      (current) => doc.sliceString(current.from, current.to) === ']',
    )
    if (!open || !close || doc.sliceString(open.from, open.to) !== '[')
      return false
    // A reference link renders when the note defines its label; until then
    // its brackets show around its formatted text.
    const reference =
      doc.sliceString(close.to, close.to + 1) !== '(' &&
      referenceLink(doc, node)
    if (reference === null) return false
    const answer = reference ? drawReference(state, reference.label) : null
    if (reference && !answer) return undefined
    const revealed = touched(node.from, node.to)
    // A destination or label on later lines is hidden by the layout field.
    for (const range of formattedMarkerRanges(
      node,
      (from, to) => doc.sliceString(from, to),
      !!answer,
    ))
      if (
        range.from === node.from ||
        doc.lineAt(close.from).number === doc.lineAt(node.to).number
      )
        syntax(range.from, range.to, revealed)
    if (!literal.has('Link'))
      linkText(
        open.to,
        close.from,
        answer?.title ? { title: answer.title } : undefined,
      )
    return undefined
  }

  function code(node: SyntaxNode, range: { from: number; to: number }) {
    const fenced = node.name === 'FencedCode'
    const first = doc.lineAt(node.from),
      last = doc.lineAt(node.to)
    const closing = node.lastChild
    const closed =
      fenced &&
      closing?.name === 'CodeMark' &&
      closing.from >= last.from &&
      last.number > first.number
    const from = fenced ? first.number + 1 : first.number
    const to = closed ? last.number - 1 : last.number
    const visibleFrom = doc.lineAt(range.from).number,
      visibleTo = doc.lineAt(range.to).number
    if (from > to) return
    let block = codeBlocks.get(node.from)
    if (!block) {
      block = { from: doc.line(from).from, to: doc.line(to).to, shown: -1 }
      codeBlocks.set(node.from, block)
    }
    const texts = node.getChildren('CodeText')
    let text = 0
    for (
      let number = Math.max(from, visibleFrom);
      number <= Math.min(to, visibleTo);
      number++
    ) {
      const current = doc.line(number)
      const info = line(current.from)
      // A line that line gaps split into two visible ranges is set up once.
      if (info.code === null) {
        if (block.shown < 0) block.shown = current.from
        info.classes.push('hibi-lp-codeblock')
        if (number === from) info.classes.push('hibi-lp-codeblock-first')
        if (number === to) info.classes.push('hibi-lp-codeblock-last')
        // The line's text starts at its code text: quote markers, list
        // indentation and the four columns of indented code before it are hidden.
        while (text < texts.length && texts[text]!.to <= current.from) text++
        const next = texts[text]
        info.code =
          next && next.from <= current.to
            ? Math.max(next.from, current.from)
            : current.to
        // Code text is smaller than the block's line box, as in a pre element.
        mark('hibi-lp-codetext', info.code, current.to)
        if (current.to - info.code > shortLine)
          long.push({ from: current.from, start: info.code, to: current.to })
      }
      const start = info.code
      // Nested code languages use the shared token classes. Long lines that
      // do not wrap decorate the columns the view measured near the visible
      // ones, or their first columns until it has.
      const shown =
        current.to - start > shortLine
          ? columns.has(current.from)
            ? columns.get(current.from)
            : { from: start, to: Math.min(current.to, start + 2 * shortLine) }
          : null
      const a = Math.max(start, range.from, shown?.from ?? start),
        b = Math.min(current.to, range.to, shown?.to ?? current.to)
      if (b > a)
        highlightTree(
          tree,
          codeHighlighter,
          (from, to, classes) => mark(classes, from, to),
          a,
          b,
        )
    }
  }

  /** Decorations from a contributed view for one node, revealed while the selection touches it. */
  const sink = (
    revealed: boolean,
    marks = decorations,
  ): FormattedDecorations => ({
    mark(from, to, attributes) {
      if (to > from) marks.push(Decoration.mark({ attributes }).range(from, to))
    },
    link: linkText,
    syntax: (from, to) => syntax(from, to, revealed),
    line(at, attributes) {
      const info = line(at)
      for (const [key, value] of Object.entries(attributes))
        if (key === 'class') info.classes.push(value)
        else if (key === 'style') info.style.push(value)
        else info.attributes[key] = value
    },
    widget(at, widget, side = 1) {
      decorations.push(Decoration.widget({ widget, side }).range(at))
    },
    replace(from, to, widget) {
      // View plugins may not replace line breaks; layout views can.
      if (
        to <= from ||
        doc.lineAt(from).to < to ||
        !claimFormattedReplacement(replacements, from, to)
      )
        return
      const range = Decoration.replace(widget ? { widget } : {}).range(from, to)
      decorations.push(range)
      atomic.push(range)
    },
  })

  for (const range of view.visibleRanges) {
    let legacyParent:
      | { to: number; views: ReadonlySet<FormattedNodeView> }
      | undefined
    tree.iterate({
      from: range.from,
      to: range.to,
      mode: IterMode.IgnoreMounts,
      enter(ref: SyntaxNodeRef) {
        const name = ref.name
        if (legacyParent && legacyParent.to <= ref.from)
          legacyParent = undefined
        const owned = legacyParent?.views ?? legacy.get(name)
        if (!legacyParent && owned?.size)
          legacyParent = { to: ref.to, views: owned }
        let skip = legacy.has(name)
          ? !owned?.size
          : literalText(ref.node, literal)
        if (!skip) {
          const matched = views(ref.type)
          const contributed = owned
            ? {
                ...matched,
                views: matched.views.filter((view) => owned.has(view)),
              }
            : matched
          if (contributed.views.length) {
            const revealed = revealedAt(ref)
            const out = sink(revealed)
            const grouped = sink(revealed, groupMarks)
            const context = { state, revealed, visible: range }
            for (const nodeView of contributed.views)
              if (
                nodeView.decorate?.(
                  ref,
                  contributed.grouped.includes(nodeView) ? grouped : out,
                  context,
                ) === false
              )
                skip = true
            // Other blocks with a container hook hold their lines like quotes.
            if (
              name !== 'Blockquote' &&
              name !== 'ListItem' &&
              contributed.views.some((nodeView) => nodeView.container)
            ) {
              const node = ref.node
              eachLine(doc, ref.from, ref.to, range, (current) => {
                line(current.from).containers.push(node)
              })
            }
          }

          if (!owned) skip = builtIn(ref, range) === false || skip
        }
        if (!skip) return
        // Container syntax stays independent of skipped inline or literal nodes.
        if (
          !literal.has('Blockquote') &&
          lines
            .get(doc.lineAt(Math.max(ref.from, range.from)).from)
            ?.containers.some((node) => node.name === 'Blockquote')
        ) {
          const pending = [ref.node.cursor(IterMode.IgnoreMounts)]
          for (let cursor = pending.pop(); cursor; cursor = pending.pop()) {
            if (!cursor.childAfter(range.from)) continue
            do {
              if (cursor.from > range.to) break
              if (cursor.name === 'QuoteMark') {
                const current = doc.lineAt(cursor.from)
                const depth = line(current.from).containers.filter(
                  (node) => node.name === 'Blockquote',
                ).length
                // Quotes nested in literal containers stay literal too.
                const before = doc.sliceString(current.from, cursor.from)
                if ((before.match(/>/g)?.length ?? 0) < depth)
                  builtIn(cursor.node, range)
              } else pending.push(cursor.node.cursor(IterMode.IgnoreMounts))
            } while (cursor.nextSibling())
          }
        }
        return false
      },
    })
  }

  /** Rendering of the core Markdown syntax that no contribution renders. */
  function builtIn(
    ref: SyntaxNodeRef,
    range: { from: number; to: number },
  ): undefined | false {
    const name = ref.name
    if (ref.type.is('LeafBlock') && ref.from >= range.from) {
      const info = line(doc.lineAt(ref.from).from)
      if (info.leaf === null) info.leaf = ref.from
    }
    const heading = /^(ATX|Setext)Heading(\d)$/.exec(name)
    if (heading) {
      const level = headingLevel(name)
      if (!level) return
      if (!headings.has(ref.from))
        headings.set(ref.from, {
          from: ref.from,
          to: ref.to,
          level: name.slice(-1),
        })
      eachLine(doc, ref.from, ref.to, range, (current) => {
        // A setext underline line is hidden by the layout field.
        if (
          heading[1] === 'Setext' &&
          current.to >= ref.to &&
          current.from > ref.from
        )
          return
        line(current.from).classes.push('hibi-lp-heading', `hibi-lp-h${level}`)
      })
      return
    }
    switch (name) {
      case 'HeaderMark': {
        const current = doc.lineAt(ref.from)
        const revealed = touched(current.from, current.to)
        for (const range of formattedMarkerRanges(ref.node, (from, to) =>
          doc.sliceString(from, to),
        ))
          syntax(range.from, range.to, revealed)
        return
      }
      case 'Emphasis':
        if (!literal.has(ref.name)) mark('hibi-lp-em', ref.from, ref.to)
        return
      case 'StrongEmphasis':
        if (!literal.has(ref.name)) mark('hibi-lp-strong', ref.from, ref.to)
        return
      case 'EmphasisMark': {
        const parent = ref.node.parent
        syntax(ref.from, ref.to, !!parent && revealedAt(parent))
        return
      }
      case 'InlineCode': {
        const open = ref.node.firstChild,
          close = ref.node.lastChild
        if (
          open?.name !== 'CodeMark' ||
          close?.name !== 'CodeMark' ||
          open.from === close.from
        )
          return false
        const revealed = revealedAt(ref)
        for (const range of formattedMarkerRanges(ref.node, (from, to) =>
          doc.sliceString(from, to),
        ))
          syntax(range.from, range.to, revealed)
        mark('hibi-lp-code', open.to, close.from)
        return false
      }
      case 'Link':
        return link(ref.node)
      case 'Autolink': {
        const url = ref.node.getChild('URL')
        if (!url) return false
        const revealed = touched(ref.from, ref.to)
        for (const range of formattedMarkerRanges(ref.node, (from, to) =>
          doc.sliceString(from, to),
        ))
          syntax(range.from, range.to, revealed)
        if (!literal.has('Autolink')) linkText(url.from, url.to)
        return false
      }
      case 'URL': {
        const parent = ref.node.parent?.name
        if (
          !literal.has('URL') &&
          parent !== 'Link' &&
          parent !== 'Image' &&
          parent !== 'LinkReference'
        )
          linkText(ref.from, ref.to)
        return
      }
      case 'HTMLBlock':
      case 'CommentBlock':
      case 'ProcessingInstructionBlock':
      case 'Image':
      case 'LinkReference':
      case 'HTMLTag':
      case 'Table':
      case 'Entity':
        // Rendered by later formatted-view slices; shown as source text for now.
        return false
      case 'Escape':
        syntax(ref.from, ref.from + 1, touched(ref.from, ref.to))
        return
      case 'HardBreak':
        hideRange(ref.from, Math.min(ref.to, doc.lineAt(ref.from).to))
        return
      case 'Blockquote':
        eachLine(doc, ref.from, ref.to, range, (current) => {
          line(current.from).containers.push(ref.node)
        })
        return
      case 'QuoteMark': {
        const after = doc.sliceString(ref.to, Math.min(doc.length, ref.to + 1))
        const info = line(doc.lineAt(ref.from).from)
        info.quoteEnd = Math.max(
          info.quoteEnd ?? 0,
          ref.to + (after === ' ' || after === '\t' ? 1 : 0),
        )
        return
      }
      case 'ListItem':
        eachLine(doc, ref.from, ref.to, range, (current) => {
          const info = line(current.from)
          info.item = ref.node
          info.containers.push(ref.node)
        })
        return
      case 'FencedCode':
      case 'CodeBlock':
        code(ref.node, range)
        // Quote markers inside the block are hidden with the line prefix.
        return
    }
    return undefined
  }
  const end = spacing(view, tree, line, layout)
  const ordinals = new Map<number, number[]>()
  for (const [at, info] of lines) {
    const current = doc.lineAt(at)
    const edges = containers(
      doc,
      at,
      info,
      layout,
      state.facet(formattedBlockEdges),
    )
    if (edges)
      decorations.push(Decoration.widget({ widget: edges, side: -1 }).range(at))
    let prefix = info.quoteEnd ?? at
    if (info.code !== null) prefix = info.code
    else if (info.item) prefix = itemLine(doc, current, info, prefix, ordinals)
    else if (info.leaf !== null) prefix = info.leaf
    // Quote markers, list markers and indentation before the line's
    // content, unless the layout field replaces the whole line.
    if (!replacedLine(layout, current))
      hideRange(at, Math.min(prefix, current.to))
    if (info.gap) info.style.push(`padding-top: ${info.gap}px`)
    decorations.push(
      Decoration.line({
        attributes: {
          ...info.attributes,
          ...(info.classes.length ? { class: info.classes.join(' ') } : {}),
          ...(info.style.length ? { style: info.style.join('; ') } : {}),
        },
      }).range(at),
    )
  }
  blocks = noBlocks
  const wrappers: Range<BlockWrapper>[] = []
  // A code block scrolls sideways as one box, inside the indentation and
  // paint of the quotes and lists around it, which a box around it keeps.
  for (const { from, to, shown } of codeBlocks.values()) {
    const end = Math.min(doc.length, to + 1)
    if (end <= from || shown < 0) continue
    wrappers.push(codeScroll.range(from, end))
    const style = lines
      .get(shown)
      ?.style.filter(
        (entry) =>
          entry.startsWith('--hibi-indent:') ||
          entry.startsWith('--hibi-paint:'),
      )
    if (style?.length)
      wrappers.push(
        BlockWrapper.create({
          tagName: 'div',
          attributes: { class: 'hibi-lp-codenest', style: style.join('; ') },
          rank: 60,
        }).range(from, end),
      )
  }
  for (const { from, to, level } of headings.values()) {
    wrappers.push(
      BlockWrapper.create({
        tagName: 'div',
        attributes: {
          role: 'heading',
          'aria-level': level,
        },
      }).range(doc.lineAt(from).from, to),
    )
  }
  return {
    decorations: Decoration.set(decorations, true),
    groupMarks: Decoration.set(groupMarks, true),
    atomic: Decoration.set(atomic, true),
    runs: Decoration.set(
      delimiterRuns(delimiters).map(({ from, to }) => hide.range(from, to)),
    ),
    margins: [...lines].flatMap(([at, info]) => (info.margin ? [at] : [])),
    outer: Decoration.set(outer, true),
    wrappers: BlockWrapper.set(wrappers, true),
    end,
    long,
  }
}

type Heading = { from: number; to: number; level: string }

/** One name from rendered text; editable syntax stays readable in the original DOM. */
function nameHeadings(view: EditorView) {
  for (const heading of view.contentDOM.querySelectorAll('[role="heading"]')) {
    if (!heading.querySelector('.hibi-lp-syntax')) {
      heading.removeAttribute('aria-label')
      continue
    }
    const name = [...heading.querySelectorAll('.cm-line')]
      .map((line) => {
        const copy = line.cloneNode(true) as HTMLElement
        for (const syntax of copy.querySelectorAll(
          '.hibi-lp-syntax, .cm-widgetBuffer, [aria-hidden="true"]',
        ))
          syntax.remove()
        for (const image of copy.querySelectorAll('img'))
          image.replaceWith(image.alt)
        for (const br of copy.querySelectorAll('br')) br.replaceWith(' ')
        return copy.textContent
      })
      .join(' ')
    if (heading.getAttribute('aria-label') !== name)
      heading.setAttribute('aria-label', name)
  }
}

/** Where a container's last line that the layout does not hide starts. */
function lastLine(doc: Text, node: SyntaxNode, layout: DecorationSet) {
  let last = doc.lineAt(node.to)
  while (last.from > node.from && replacedLine(layout, last))
    last = doc.line(last.number - 1)
  return last.from
}

/** Invisible anchors let overlays measure each rendered container's actual edge. */
class ContainerEdges extends WidgetType {
  readonly edges: readonly (readonly [string, string])[]
  constructor(edges: readonly (readonly [string, string])[]) {
    super()
    this.edges = edges
  }
  override eq(other: ContainerEdges) {
    return (
      this.edges.length === other.edges.length &&
      this.edges.every(
        ([key, left], i) =>
          key === other.edges[i]?.[0] && left === other.edges[i]?.[1],
      )
    )
  }
  toDOM() {
    const wrap = document.createElement('span')
    wrap.setAttribute('aria-hidden', 'true')
    wrap.style.cssText =
      'position: absolute; top: 0; left: 0; width: 0; height: 0; pointer-events: none'
    for (const [key, left] of this.edges) {
      const edge = document.createElement('span')
      edge.dataset.hibiBlockEdge = key
      edge.style.cssText = `position: absolute; left: calc(-1 * var(--hibi-indent) + ${left}); width: 0; height: 0`
      wrap.append(edge)
    }
    return wrap
  }
}

/**
 * Containers indent a line by their widths: a quote's 20px padding and 1px
 * bar, a list's 1.5em, or what a contributed view gives. Bars and paint are
 * drawn from the container's left edge, below the space above its first
 * line, which lies outside it; contributed padding goes inside.
 */
function containers(
  doc: Text,
  at: number,
  info: LineInfo,
  layout: DecorationSet,
  measure: boolean,
) {
  if (!info.containers.length) return
  const widths: string[] = []
  const edges: [string, string][] | null = measure ? [] : null
  const depths = measure ? new Map<string, number>() : null
  const paint: string[] = []
  let top = 0,
    bottom = 0,
    right = 0
  for (const container of info.containers) {
    const left = widths.length ? `calc(${widths.join(' + ')})` : '0px'
    const shape = blocks.shapes(container)
    const depth = depths?.get(container.name) ?? 0
    depths?.set(container.name, depth + 1)
    // Nesting keys survive mapped decorations while a reparse is unfinished.
    const key = edges ? `${container.name}:${depth}` : ''
    if (container.name !== 'ListItem' || shape?.marker === false)
      edges?.push([key, left])
    const first = shownLine(doc, container).from === at
    const offset = `${first ? info.gap + top : 0}px`
    if (shape?.class) info.classes.push(shape.class)
    if (shape?.paint) paint.push(shape.paint(left, offset))
    else if (container.name === 'Blockquote') {
      info.classes.push('hibi-lp-quote')
      paint.push(
        `linear-gradient(var(--border), var(--border)) ${left} ${offset} / 1px calc(100% - ${offset}) no-repeat`,
      )
    }
    if (
      shape?.marker === false &&
      container.name === 'ListItem' &&
      container.from === info.item?.from
    )
      info.marker = false
    const padding = shape?.padding
    if (padding) {
      if (first) top += padding.top ?? 0
      if (padding.bottom && lastLine(doc, container, layout) === at)
        bottom += padding.bottom
      right += padding.right ?? 0
    }
    widths.push(
      shape?.width ??
        (container.name === 'Blockquote'
          ? '21px'
          : container.name === 'ListItem'
            ? '1.5 * var(--text-editor)'
            : '0px'),
    )
    if (container.name === 'ListItem' && shape?.marker !== false)
      edges?.push([key, `calc(${widths.join(' + ')})`])
  }
  info.gap += top
  if (bottom) info.style.push(`padding-bottom: ${bottom}px`)
  if (right) info.style.push(`padding-right: ${right}px`)
  info.classes.push('hibi-lp-nested')
  info.style.push(`--hibi-indent: calc(${widths.join(' + ')})`)
  if (paint.length) {
    info.classes.push('hibi-lp-painted')
    info.style.push(`--hibi-paint: ${paint.join(', ')}`)
  }
  return edges ? new ContainerEdges(edges) : undefined
}

/** List lines: native markers in the indentation, source markers and continuation indentation hidden. */
function itemLine(
  doc: Text,
  current: ReturnType<Text['lineAt']>,
  info: LineInfo,
  prefix: number,
  ordinals: Map<number, number[]>,
) {
  const item = info.item!
  const depth = info.containers.filter(
    (container) => container.name === 'ListItem',
  ).length
  const marker = item.getChild('ListMark')
  // Continuation lines start at the item's content.
  const continuation = () =>
    info.leaf ??
    prefix + /^[ \t]*/.exec(doc.sliceString(prefix, current.to))![0].length
  // A lone marker is drawn on the line after its own.
  const lone = marker && loneMarker(doc, item)
  if (
    !marker ||
    current.number !== (lone ? lone.number + 1 : doc.lineAt(item.from).number)
  )
    return continuation()
  let content: number
  if (lone) content = continuation()
  else {
    // The marker and up to four following spaces are hidden.
    content = formattedListStart(
      (from, to) => doc.sliceString(from, to),
      marker,
      current.to,
      info.leaf ?? 0,
    )
  }
  if (!info.marker) return content
  info.classes.push('hibi-lp-list-item')
  const list = item.parent!
  if (list.name === 'OrderedList') {
    const first = list.getChild('ListItem')?.getChild('ListMark')
    const start = first
      ? Number.parseInt(doc.sliceString(first.from, first.to), 10)
      : 1
    // A window into a giant block lacks the items before it.
    let top: SyntaxNode = list
    while (top.parent && top.parent.name !== 'Document') top = top.parent
    const skipped = top.tree?.prop(listWindow)?.get(list.from - top.from) ?? 0
    info.classes.push('hibi-lp-list-ordered')
    info.style.push(
      `counter-set: list-item ${(Number.isFinite(start) ? start : 1) + skipped + ordinal(list, item, ordinals)}`,
    )
  } else
    info.style.push(
      `list-style-type: ${['disc', 'circle', 'square'][Math.min(depth, 3) - 1]}`,
    )
  return content
}

/**
 * Collapsed margins between sibling blocks, at every level of quotes and
 * lists near the visible ranges, become blank-line heights or first-line
 * padding. Returns the space below the note's last line.
 */
function spacing(
  view: EditorView,
  tree: Tree,
  line: (pos: number) => LineInfo,
  layout: DecorationSet,
) {
  const doc = view.state.doc
  const place = (
    previous: SyntaxNode,
    block: SyntaxNode,
    range: { from: number; to: number },
  ) => {
    // The first block after an unparsed prefix such as frontmatter starts the document.
    if (previous.name === 'Frontmatter') return
    const gap = Math.max(bottomMargin(previous), topMargin(block))
    const start = doc.lineAt(block.from)
    // Lines the layout hides between the blocks, such as definitions, take no space.
    let first = doc.lineAt(previous.to).number + 1
    while (first < start.number && replacedLine(layout, doc.line(first)))
      first++
    if (first >= start.number) {
      const shown = shownLine(doc, block)
      if (shown.from >= range.from && shown.from <= range.to)
        line(shown.from).gap = gap
      return
    }
    for (let number = first; number < start.number; number++) {
      const blank = doc.line(number)
      if (blank.from < range.from || blank.from > range.to) continue
      const info = line(blank.from)
      info.classes.push('hibi-lp-gap')
      info.margin = number === first
      const height = info.margin ? gap : 28
      info.style.push(`height: ${height}px`, `line-height: ${height}px`)
    }
  }
  const visit = (parent: SyntaxNode, range: { from: number; to: number }) => {
    let node = parent.childBefore(range.from + 1)
    while (node && !isBlock(node)) node = node.prevSibling
    if (!node) node = blockChild(parent, false)
    if (!node) return
    const before = blockSibling(node, false)
    if (before) node = before
    for (
      let previous: SyntaxNode | null = null;
      node;
      node = blockSibling(node, true)
    ) {
      if (previous) place(previous, node, range)
      if (isContainer(node) && node.to >= range.from && node.from <= range.to)
        visit(node, range)
      if (node.from > range.to) break
      previous = node
    }
  }
  for (const range of view.visibleRanges) visit(tree.topNode, range)
  return ending(view, tree, line)
}

/**
 * Blank lines after the last block, as the rich view shows them: an empty
 * line with another line break after it is the margin above an empty
 * paragraph, which shows on the next line, and other blank lines hold the
 * margin below what comes before them. Laid out while the view draws the
 * last block's end; returns the space below the last line, outside every
 * block.
 */
function ending(view: EditorView, tree: Tree, line: (pos: number) => LineInfo) {
  const doc = view.state.doc
  const last = blockChild(tree.topNode, true)
  if (!last) return 0
  const end = doc.lineAt(last.to)
  const { viewport } = view
  // Text after the last block that is not parsed yet may hold more blocks.
  if (
    end.to < viewport.from ||
    end.to > viewport.to ||
    uncovered(tree, end.to, doc.length)
  )
    return 0
  const paragraph = blockSpace('Paragraph')
  let margin = bottomMargin(last),
    below = margin,
    shown = false
  const gaps: [number, number][] = []
  for (let number = end.number + 1; number <= doc.lines; number++) {
    const blank = doc.line(number)
    if (blank.from > viewport.to) {
      below = 0
      break
    }
    if (blank.text.trim()) return 0
    if (shown) {
      shown = false
      margin = below = paragraph.bottom
    } else if (!blank.text && number < doc.lines) {
      gaps.push([blank.from, Math.max(margin, paragraph.top)])
      shown = true
    } else {
      gaps.push([blank.from, margin])
      below = 0
    }
  }
  for (const [at, height] of gaps) {
    const info = line(at)
    info.classes.push('hibi-lp-gap')
    info.style.push(`height: ${height}px`, `line-height: ${height}px`)
  }
  return below
}

/** Layout decorations for one parsed chunk, relative to the chunk start. */
function chunkLayout(
  state: EditorState,
  tree: Tree,
  from: number,
  covered: readonly { from: number; to: number }[],
  reveal: readonly Revealed[],
) {
  const doc = state.doc
  const views = formattedNodeViews(state)
  const literal = new Set(state.facet(formattedLiteral))
  const legacy = state.facet(formattedLegacyLiteral)
  const out: Range<Decoration>[] = []
  /** A contributed layout view ran, so the chunk's layout can follow the selection. */
  let sensitive = false
  const sink: FormattedLayout = {
    replace(rangeFrom, rangeTo, widget, options) {
      if (rangeTo < rangeFrom) return
      out.push(
        Decoration.replace({
          ...(widget ? { widget } : {}),
          ...(options?.block ? { block: true } : {}),
        }).range(rangeFrom - from, rangeTo - from),
      )
    },
    widget(at, widget, options) {
      out.push(
        Decoration.widget({
          widget,
          side: options?.side ?? 1,
          ...(options?.block ? { block: true } : {}),
        }).range(at - from),
      )
    },
  }
  /** Where definitions hidden from a list marker end. */
  let itemDefinitions = -1
  for (const range of covered) {
    let legacyParent:
      | { to: number; views: ReadonlySet<FormattedNodeView> }
      | undefined
    /** The leaf block whose line breaks flow as spaces, except hard breaks and hidden link destinations. */
    let leaf: {
      from: number
      to: number
      hard: Set<number>
      hidden: { from: number; to: number }[]
    } | null = null
    const starts = (pos: number) => pos >= range.from && pos < range.to
    tree.iterate({
      from: range.from,
      to: range.to,
      mode: IterMode.IgnoreMounts,
      enter(ref) {
        if (ref.to <= range.from || ref.from >= range.to) return false
        if (legacyParent && legacyParent.to <= ref.from)
          legacyParent = undefined
        const owned = legacyParent?.views ?? legacy.get(ref.name)
        if (!legacyParent && owned?.size)
          legacyParent = { to: ref.to, views: owned }
        if (
          legacy.has(ref.name) ? !owned?.size : literalText(ref.node, literal)
        )
          return false
        const matched = views(ref.type).views
        const contributed = owned
          ? matched.filter((view) => owned.has(view))
          : matched
        if (contributed.some((view) => view.layout)) {
          sensitive = true
          // A node spanning covered ranges is laid out once, where it starts.
          if (!starts(ref.from)) return
          const context = {
            state,
            revealed: reveal.some(
              (selection) =>
                selection.from <= ref.to && selection.to >= ref.from,
            ),
            visible: null,
          }
          let skip = false
          for (const view of contributed)
            if (view.layout?.(ref, sink, context) === false) skip = true
          if (skip) return false
        }
        if (owned) return
        switch (ref.name) {
          case 'FencedCode': {
            const first = doc.lineAt(ref.from)
            if (starts(first.from))
              out.push(hiddenLine.range(first.from - from, first.to - from))
            const closing = ref.node.lastChild
            const last = doc.lineAt(ref.to)
            if (
              closing?.name === 'CodeMark' &&
              closing.from >= last.from &&
              last.number > first.number &&
              starts(last.from)
            )
              out.push(hiddenLine.range(last.from - from, last.to - from))
            return false
          }
          case 'SetextHeading1':
          case 'SetextHeading2': {
            const last = doc.lineAt(ref.to)
            if (last.from <= ref.from) return false
            if (starts(last.from))
              out.push(hiddenLine.range(last.from - from, last.to - from))
            leaf = {
              from: ref.from,
              to: last.from - 1,
              hard: new Set(),
              hidden: [],
            }
            return
          }
          case 'Paragraph':
          case 'Task':
            leaf = { from: ref.from, to: ref.to, hard: new Set(), hidden: [] }
            return
          case 'ListItem': {
            const lone = loneMarker(doc, ref.node)
            if (lone && starts(lone.from))
              out.push(hiddenLine.range(lone.from - from, lone.to - from))
            return
          }
          case 'HardBreak':
            leaf?.hard.add(doc.lineAt(ref.from).to)
            return false
          case 'Link': {
            const close = ref.node
              .getChildren('LinkMark')
              .find((mark) => doc.sliceString(mark.from, mark.to) === ']')
            if (
              !leaf ||
              !close ||
              doc.lineAt(close.from).number === doc.lineAt(ref.to).number
            )
              return
            // A destination, or the label of a defined reference, on later
            // lines is hidden with its line breaks.
            const reference =
              doc.sliceString(close.to, close.to + 1) !== '(' &&
              referenceLink(doc, ref.node)
            if (
              reference === false ||
              (reference && knownReference(state, reference.label))
            ) {
              leaf.hidden.push({ from: close.from, to: ref.to })
              if (starts(close.from))
                out.push(hide.range(close.from - from, ref.to - from))
            }
            return
          }
          case 'LinkReference': {
            // Definitions after one on a list marker hide with it.
            if (ref.from < itemDefinitions) return false
            const lines = definitionLines(doc, ref.node)
            if (lines.item) itemDefinitions = lines.to
            if (starts(ref.from))
              out.push(
                (lines.item ? hiddenItemDefinition : hiddenDefinition).range(
                  lines.from - from,
                  lines.to - from,
                ),
              )
            return false
          }
          case 'CodeBlock':
          case 'HTMLBlock':
          case 'CommentBlock':
          case 'ProcessingInstructionBlock':
          case 'Table':
            return false
        }
      },
      leave(ref) {
        if (
          !leaf ||
          (ref.name !== 'Paragraph' &&
            ref.name !== 'Task' &&
            !ref.name.startsWith('SetextHeading'))
        )
          return
        const { hard, hidden } = leaf
        const a = Math.max(leaf.from, range.from),
          b = Math.min(leaf.to, range.to)
        for (
          let current = doc.lineAt(a);
          current.to < b;
          current = doc.line(current.number + 1)
        )
          if (
            !hard.has(current.to) &&
            !hidden.some(
              (link) => link.from <= current.to && current.to < link.to,
            )
          )
            out.push(space.range(current.to - from, current.to + 1 - from))
        leaf = null
      },
    })
  }
  return { ranges: out, sensitive, doc: sensitive ? doc : null }
}

type ChunkLayout = ReturnType<typeof chunkLayout>
/**
 * Layout per chunk tree, set of views and set of nodes shown as written:
 * reused chunks keep their decorations, shifted to their position. A chunk
 * with contributed views refreshes its document snapshot after an edit, and
 * is laid out again with its reveal state under the selection.
 */
const chunkCache = new WeakMap<
  readonly FormattedNodeView[],
  WeakMap<
    readonly string[],
    WeakMap<object, WeakMap<readonly unknown[], WeakMap<Tree, ChunkLayout>>>
  >
>()
function cacheFor(state: EditorState) {
  const views = state.facet(formattedViews),
    literal = state.facet(formattedLiteral),
    // Contributed layouts may show the note's files and media, and read
    // other state, such as the labels footnote references resolve against.
    document = state.facet(formattedDocument),
    inputs = state.facet(formattedRenderInputs)
  let byLiteral = chunkCache.get(views)
  if (!byLiteral) {
    byLiteral = new WeakMap()
    chunkCache.set(views, byLiteral)
  }
  let byDocument = byLiteral.get(literal)
  if (!byDocument) {
    byDocument = new WeakMap()
    byLiteral.set(literal, byDocument)
  }
  let byInputs = byDocument.get(document)
  if (!byInputs) {
    byInputs = new WeakMap()
    byDocument.set(document, byInputs)
  }
  let cache = byInputs.get(inputs)
  if (!cache) {
    cache = new WeakMap()
    byInputs.set(inputs, cache)
  }
  return cache
}
const intersects = (reveal: readonly Revealed[], from: number, to: number) =>
  reveal.some((range) => range.from <= to && range.to >= from)
function layoutDecorations(
  state: EditorState,
  tree: Tree,
  reveal: readonly Revealed[],
): DecorationSet {
  const cache = cacheFor(state)
  const out: Range<Decoration>[] = []
  for (const { from, chunk, covered } of parsedChunks(tree)) {
    let layout = cache.get(chunk)
    if (!layout || (layout.sensitive && layout.doc !== state.doc)) {
      layout = chunkLayout(state, tree, from, covered, [])
      cache.set(chunk, layout)
    }
    if (layout.sensitive && intersects(reveal, from, from + chunk.length))
      layout = chunkLayout(state, tree, from, covered, reveal)
    for (const range of layout.ranges)
      out.push(range.value.range(range.from + from, range.to + from))
  }
  return Decoration.set(out, true)
}

/** Whether moving the reveal ranges can change a contributed layout. */
function revealMatters(
  state: EditorState,
  tree: Tree,
  reveal: readonly Revealed[],
) {
  // Only contributed layout views follow the selection, in the chunks
  // around it.
  if (
    !reveal.length ||
    !state.facet(formattedViews).some((view) => view.layout)
  )
    return false
  const cache = cacheFor(state)
  return reveal.some((range) =>
    parsedChunks(tree, range).some(
      ({ chunk }) => cache.get(chunk)?.sensitive ?? true,
    ),
  )
}

const setFocus = StateEffect.define<boolean>()
/** Whether the formatted editor has focus, for reveal decisions made in state. */
const focused = StateField.define<boolean>({
  create: () => false,
  update(value, transaction) {
    for (const effect of transaction.effects)
      if (effect.is(setFocus)) return effect.value
    return value
  },
  provide: () =>
    EditorView.focusChangeEffect.of((_, focusing) => setFocus.of(focusing)),
})

/**
 * Selection ranges inside one block. As in the rich editor, a selection
 * across blocks, such as select all, shows no markers, nor does the block a
 * note opened with selected.
 */
function inBlocks(state: EditorState, tree: Tree): readonly Revealed[] {
  const ranges: Revealed[] = []
  for (const { from, to } of state.selection.ranges) {
    let block: SyntaxNode | null = from < to ? tree.resolve(from, 1) : null
    while (block && !block.type.is('LeafBlock')) block = block.parent
    if (
      (from === to || (block && block.to >= to)) &&
      !openedBlock(state, from, to)
    )
      ranges.push({ from, to })
  }
  return ranges
}

/**
 * Whether the selection was placed since the editor last lost focus, so a
 * definition it is in shows. Placing it before focusing keeps it there:
 * focusing draws it in the shown text rather than beside a hidden line.
 */
const placed = StateField.define<boolean>({
  create: () => false,
  update(value, transaction) {
    for (const effect of transaction.effects)
      if (effect.is(setFocus) && !effect.value) return false
    return transaction.selection ? true : value
  },
})

/** Whether a contributed layout draws a node in place of its text while it is not revealed. */
function replacedWhole(state: EditorState, node: SyntaxNode) {
  let whole = false
  const sink = {
    replace(from: number, to: number) {
      if (from <= node.from && to >= node.to) whole = true
    },
    widget() {},
  }
  for (const view of formattedNodeViews(state)(node.type).views)
    view.layout?.(node, sink, { state, revealed: false, visible: null })
  return whole
}

/** The selection while the focused editor shows markers. */
function revealedIn(state: EditorState, tree: Tree): readonly Revealed[] {
  if (!state.field(focused, false) || !state.facet(showMarkdownMarkers))
    return []
  return inBlocks(state, tree)
}

const sameRanges = (a: readonly Revealed[], b: readonly Revealed[]) =>
  a.length === b.length &&
  a.every(
    (range, index) =>
      range.from === b[index]?.from && range.to === b[index]?.to,
  )

/** Ranges whose markers show: the selection while the focused editor shows markers. */
function revealed(view: EditorView, tree: Tree): readonly Revealed[] {
  if (!view.hasFocus || !view.state.facet(showMarkdownMarkers)) return []
  return inBlocks(view.state, tree)
}

/**
 * Decorations mapped through an update, without the replacements it put a
 * line break into, which a view plugin may not draw.
 */
function mapLines(set: DecorationSet, update: ViewUpdate) {
  const doc = update.state.doc
  return set.map(update.changes).update({
    filter: (from, to, value) =>
      !value.point || from === to || doc.lineAt(from).to >= to,
  })
}

/**
 * A link destination on later lines shows while the selection touches it:
 * input beside a range that hides line breaks would not map to the text.
 * A definition shows while a selection placed since the editor last lost
 * focus is inside it, so text typed into one stays in view: a caret past
 * its start, before the paragraph a list item's definition hides up to, or
 * a selection it holds whole.
 */
function revealDestinations(set: DecorationSet, state: EditorState) {
  const shown = state.field(placed, false)
  for (const { from, to } of state.selection.ranges)
    set = set.update({
      filterFrom: from,
      filterTo: to,
      filter: (a, b, value) => {
        if (value !== hiddenDefinition && value !== hiddenItemDefinition)
          return value !== hide || b < from || a > to
        const inside =
          from === to
            ? a < from &&
              (from < b || (from === b && value === hiddenDefinition))
            : a <= from && to <= b
        return !shown || !inside
      },
    })
  return set
}

/** The formatted view's rendering over its chunked Markdown syntax tree. */
export function livePreview(
  syntax: FormattedSyntax,
  options: { flavors?: readonly string[] | undefined } = {},
): Extension {
  const layout = StateField.define<DecorationSet>({
    create: (state) =>
      layoutDecorations(
        state,
        syntax.tree(state),
        revealedIn(state, syntax.tree(state)),
      ),
    update(value, transaction) {
      const { state, startState } = transaction
      const tree = syntax.tree(state),
        reveal = revealedIn(state, tree)
      // An edit's unfinished reparse keeps the layout it replaces, mapped.
      if (
        syntax.settling(state) ||
        (!transaction.docChanged &&
          !syntax.settling(startState) &&
          tree === syntax.tree(startState) &&
          state.facet(formattedViews) === startState.facet(formattedViews) &&
          state.facet(formattedLiteral) ===
            startState.facet(formattedLiteral) &&
          state.facet(formattedDocument) ===
            startState.facet(formattedDocument) &&
          state.facet(formattedRenderInputs) ===
            startState.facet(formattedRenderInputs) &&
          (sameRanges(reveal, revealedIn(startState, tree)) ||
            (!revealMatters(state, tree, reveal) &&
              !revealMatters(state, tree, revealedIn(startState, tree)))))
      )
        return value.map(transaction.changes)
      return layoutDecorations(state, tree, reveal)
    },
  })
  const preview = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      groupMarks: DecorationSet
      atomic: DecorationSet
      /** Touching hidden delimiters, each crossed in one step. */
      runs: DecorationSet
      margins: number[]
      outer: DecorationSet
      wrappers: RangeSet<BlockWrapper>
      /** Space below the last line, in px. */
      end: number
      reveal: readonly Revealed[]
      /** Decorated columns of long code lines by line start; null where a line wraps. */
      columns = new Map<number, Revealed | null>()
      long: readonly LongLine[] = []
      destroyed = false
      readonly measure = {
        key: this,
        read: (view: EditorView) =>
          measureColumns(view, this.long, this.columns),
        write: (
          measured: ReturnType<typeof measureColumns>,
          view: EditorView,
        ) => {
          this.columns = measured.next
          if (measured.changed)
            queueMicrotask(() => {
              if (!this.destroyed)
                view.dispatch({ effects: measuredColumns.of(null) })
            })
        },
      }
      /**
       * How far code blocks are scrolled sideways, by block start: the
       * editor may draw a block's box again, which starts unscrolled.
       */
      readonly scrolls = new Map<number, number>()
      /** The block each drawn box showed when its scroll was last set. */
      boxes = new WeakMap<Element, number | null>()
      /** The start of the code block around `pos`. */
      blockAt(pos: number) {
        for (
          let node: SyntaxNode | null = syntax
            .tree(this.view.state)
            .resolve(pos, 1);
          node;
          node = node.parent
        )
          if (node.name === 'FencedCode' || node.name === 'CodeBlock')
            return node.from
        return null
      }
      /** Code blocks scrolled sideways show other columns. */
      readonly scrolled = (event: Event) => {
        const box = event.target
        if (
          !(box instanceof HTMLElement) ||
          !box.classList.contains('hibi-lp-codescroll')
        )
          return
        const at = this.blockAt(this.view.posAtDOM(box))
        if (at !== null)
          if (box.scrollLeft) this.scrolls.set(at, box.scrollLeft)
          else this.scrolls.delete(at)
        if (this.long.length) this.view.requestMeasure(this.measure)
      }
      /**
       * A scrolled box the coming redraw replaces fires no scroll event
       * when the editor measures on the note's own scroll first: read the
       * boxes before the redraw. Unscrolled boxes may be new ones.
       */
      keepScrolls(update: ViewUpdate) {
        for (const box of update.view.contentDOM.querySelectorAll(
          '.hibi-lp-codescroll',
        )) {
          if (!box.scrollLeft) continue
          const at = this.blockAt(
            update.changes.mapPos(update.view.posAtDOM(box)),
          )
          if (at !== null) this.scrolls.set(at, box.scrollLeft)
        }
      }
      constructor(readonly view: EditorView) {
        this.reveal = revealed(view, syntax.tree(view.state))
        ;({
          decorations: this.decorations,
          groupMarks: this.groupMarks,
          atomic: this.atomic,
          runs: this.runs,
          margins: this.margins,
          outer: this.outer,
          wrappers: this.wrappers,
          end: this.end,
          long: this.long,
        } = inline(
          view,
          syntax.tree(view.state),
          this.reveal,
          view.state.field(layout),
          this.columns,
        ))
        if (this.long.length) view.requestMeasure(this.measure)
        // Scroll events do not bubble; capturing sees the code blocks'.
        view.contentDOM.addEventListener('scroll', this.scrolled, {
          capture: true,
          passive: true,
        })
      }
      destroy() {
        this.destroyed = true
        this.view.contentDOM.removeEventListener('scroll', this.scrolled, {
          capture: true,
        })
      }
      docViewUpdate(view: EditorView) {
        nameHeadings(view)
        // A new box, or one the editor reused for another block, gets its
        // block's scroll before the next paint.
        if (this.scrolls.size)
          for (const box of view.contentDOM.querySelectorAll(
            '.hibi-lp-codescroll',
          )) {
            const at = this.blockAt(view.posAtDOM(box))
            if (this.boxes.get(box) === at) continue
            this.boxes.set(box, at)
            box.scrollLeft = this.scrolls.get(at ?? -1) ?? 0
          }
      }
      update(update: ViewUpdate) {
        const tree = syntax.tree(update.state)
        // Candidate text keeps its markers while an input method composes.
        const reveal = update.view.composing
          ? this.reveal.map((range) => ({
              from: update.changes.mapPos(range.from, -1),
              to: update.changes.mapPos(range.to, 1),
            }))
          : revealed(update.view, tree)
        const changedReveal =
          reveal.length !== this.reveal.length ||
          reveal.some(
            (range, index) =>
              range.from !== this.reveal[index]?.from ||
              range.to !== this.reveal[index]?.to,
          )
        this.reveal = reveal
        if (update.docChanged && this.scrolls.size) {
          const scrolls = [...this.scrolls]
          this.scrolls.clear()
          for (const [at, left] of scrolls)
            this.scrolls.set(update.changes.mapPos(at), left)
        }
        if (update.viewportChanged) this.keepScrolls(update)
        if (update.docChanged && this.columns.size)
          this.columns = new Map(
            [...this.columns].map(([at, shown]): [number, Revealed | null] => [
              update.changes.mapPos(at),
              shown && {
                from: update.changes.mapPos(shown.from, -1),
                to: update.changes.mapPos(shown.to, 1),
              },
            ]),
          )
        // An edit's unfinished reparse keeps what was drawn, mapped through it.
        if (syntax.settling(update.state)) {
          this.decorations = mapLines(this.decorations, update)
          this.groupMarks = this.groupMarks.map(update.changes)
          this.atomic = mapLines(this.atomic, update)
          this.runs = mapLines(this.runs, update)
          this.margins = this.margins.map((at) => update.changes.mapPos(at))
          this.outer = this.outer.map(update.changes)
          this.wrappers = this.wrappers.map(update.changes)
        } else if (
          update.docChanged ||
          update.viewportChanged ||
          update.state.facet(formattedBlockEdges) !==
            update.startState.facet(formattedBlockEdges) ||
          changedReveal ||
          tree !== syntax.tree(update.startState) ||
          update.state.field(layout) !== update.startState.field(layout) ||
          update.state.facet(formattedViews) !==
            update.startState.facet(formattedViews) ||
          update.state.facet(formattedLiteral) !==
            update.startState.facet(formattedLiteral) ||
          update.state.facet(formattedDocument) !==
            update.startState.facet(formattedDocument) ||
          update.transactions.some((transaction) =>
            transaction.effects.some(
              (effect) =>
                effect.is(formattedRefresh) || effect.is(measuredColumns),
            ),
          )
        ) {
          ;({
            decorations: this.decorations,
            groupMarks: this.groupMarks,
            atomic: this.atomic,
            runs: this.runs,
            margins: this.margins,
            outer: this.outer,
            wrappers: this.wrappers,
            end: this.end,
            long: this.long,
          } = inline(
            update.view,
            tree,
            reveal,
            update.state.field(layout),
            this.columns,
          ))
          if (this.long.length) update.view.requestMeasure(this.measure)
        } else if (update.geometryChanged && this.long.length)
          update.view.requestMeasure(this.measure)
      }
    },
    { decorations: (plugin) => plugin.decorations },
  )
  const hidden = (view: EditorView) =>
    view.plugin(preview)?.atomic ?? Decoration.none
  const runs = (view: EditorView) =>
    view.plugin(preview)?.runs ?? Decoration.none
  /**
   * Arrows move as in the rich view, one visible step at a time: over hidden
   * delimiters, the space between blocks and the hidden syntax at the start
   * of a line. Formatting is left without moving only at the end of the note.
   */
  const arrow = (right: boolean) => (view: EditorView) => {
    const { state } = view
    const range = state.selection.main
    const plugin = view.plugin(preview)
    if (!plugin || state.selection.ranges.length > 1 || !range.empty)
      return false
    const end = syntax.tree(state).topNode.lastChild?.to ?? 0
    const covered = (set: DecorationSet, from: number, to: number) => {
      let found = false
      set.between(from, to, (a, b, value) => {
        if (a <= from && b >= to && !value.spec.widget) found = true
      })
      return found
    }
    /** Whether the caret, moved from `from` to `to`, rests where nothing visible changed. */
    const through = (from: number, to: number, first: boolean) => {
      const line = state.doc.lineAt(to)
      if (
        first &&
        from !== end &&
        to !== end &&
        covered(plugin.runs, Math.min(from, to), Math.max(from, to))
      )
        return true
      if (to === line.to && to < end) {
        let after = false
        plugin.runs.between(to, to, (a, b) => {
          if (a < to && b === to) after = true
        })
        if (after) return true
      }
      if (plugin.margins.includes(line.from)) return true
      if (to !== line.from || to === line.to) return false
      let prefix = false
      plugin.atomic.between(to, to, (a, b, value) => {
        if (a === to && b > to && !value.spec.widget) prefix = true
      })
      return prefix
    }
    const forward =
      right === (view.textDirectionAt(range.head) === Direction.LTR)
    let at = range.head
    let next = view.moveByChar(range, forward)
    if (next.head === at || !through(at, next.head, true)) return false
    while (next.head !== at && through(at, next.head, at === range.head)) {
      at = next.head
      next = view.moveByChar(next, forward)
    }
    // Nothing visible is left in that direction.
    if (next.head === at) return true
    view.dispatch({
      selection: next,
      scrollIntoView: true,
      userEvent: 'select',
    })
    return true
  }
  const run =
    (command: (view: EditorView) => TransactionSpec | null) =>
    (view: EditorView) => {
      const spec = command(view)
      if (!spec) return false
      view.dispatch(
        view.state.update(spec, { scrollIntoView: true, userEvent: 'input' }),
      )
      return true
    }
  const tab = (outdent: boolean) => (view: EditorView) => {
    const tree = syntax.tree(view.state)
    let item = false
    for (
      let node: SyntaxNode | null = tree.resolveInner(
        view.state.selection.main.head,
        -1,
      );
      node;
      node = node.parent
    )
      if (node.name === 'ListItem') item = true
    const enabled = view.state.facet(formattedTabIndents)
    if (!item && !enabled) return false
    return run((current) =>
      indent(current.state, tree, outdent, hidden(current), enabled),
    )(view)
  }
  // Registered features and their syntax settings reconfigure the view.
  const contributions = new Compartment()
  const follow = ViewPlugin.fromClass(
    class {
      private version = formattedContributions.version()
      private unsubscribe: () => void
      private destroyed = false
      constructor(view: EditorView) {
        this.unsubscribe = formattedContributions.subscribe(() =>
          queueMicrotask(() => {
            const version = formattedContributions.version()
            if (this.destroyed || version === this.version) return
            this.version = version
            view.dispatch({
              effects: contributions.reconfigure(
                formattedContributions.extension(options.flavors),
              ),
            })
          }),
        )
      }
      destroy() {
        this.destroyed = true
        this.unsubscribe()
      }
    },
  )
  return [
    nativeDOMSelection,
    contributions.of(formattedContributions.extension(options.flavors)),
    formattedTree.of(syntax.tree),
    follow,
    syntax.extension,
    codeIndent,
    focused,
    placed,
    openSelection({ tree: syntax.tree, replaced: replacedWhole }),
    layout,
    EditorView.decorations.compute([layout, placed, 'selection'], (state) =>
      revealDestinations(state.field(layout), state),
    ),
    // Hidden layout syntax is atomic too.
    EditorView.atomicRanges.of((view) =>
      revealDestinations(view.state.field(layout), view.state),
    ),
    // A source of higher precedence than the preview's own: the editor
    // draws its marks inside the preview's.
    EditorView.decorations.of(
      (view) => view.plugin(preview)?.groupMarks ?? Decoration.none,
    ),
    preview,
    // After the preview, whose drawing collects the labels it asks about.
    referenceLinks,
    EditorView.outerDecorations.of(
      (view) => view.plugin(preview)?.outer ?? Decoration.none,
    ),
    EditorView.blockWrappers.of(
      (view) => view.plugin(preview)?.wrappers ?? RangeSet.empty,
    ),
    // The space after the last block lies outside every block's paint.
    EditorView.contentAttributes.of((view) => {
      const end = view.plugin(preview)?.end
      return end ? { style: `--hibi-end: ${end}px` } : null
    }),
    EditorView.atomicRanges.of(hidden),
    EditorView.atomicRanges.of(runs),
    // Lines the layout hides whole, with the line breaks around them, so the
    // caret never rests on one.
    EditorView.atomicRanges.of((view) => {
      const { doc } = view.state
      const lines: Range<Decoration>[] = []
      const shown = revealDestinations(view.state.field(layout), view.state)
      for (const { from, to } of view.visibleRanges)
        shown.between(from, to, (a, b, value) => {
          if (value === hiddenLine || value === hiddenDefinition)
            lines.push(
              hide.range(Math.max(0, a - 1), Math.min(doc.length, b + 1)),
            )
        })
      return Decoration.set(lines, true)
    }),
    // A caret those ranges leave on a hidden line at the start or end of the
    // note moves to the visible line beside it.
    EditorState.transactionFilter.of((transaction) => {
      if (transaction.docChanged || !transaction.selection) return transaction
      const { doc } = transaction.startState
      const before = transaction.startState.selection.ranges
      const lines = transaction.startState.field(layout)
      let moved = false
      const ranges = transaction.selection.ranges.map((range, index) => {
        // Selecting the whole note, or all its text after its metadata,
        // includes the hidden lines at its ends.
        if (selectsWholeNote(transaction.startState, range)) return range
        let head = range.head
        lines.between(head, head, (from, to, value) => {
          const was = before[index]?.head ?? head,
            back = head < was
          if (definitionRange(value)) {
            // Arrow keys and clicks step over a definition they were not in;
            // a selection placed in one, or moving inside a shown one, stays.
            const block = value === hiddenDefinition,
              end = block ? to : to - 1
            if (
              !range.empty ||
              !transaction.isUserEvent('select') ||
              head < (block ? from : from + 1) ||
              head > end ||
              (was > from && was <= end)
            )
              return
            if (value === hiddenItemDefinition) {
              head = back ? from : to
              return
            }
          } else if (value !== hiddenLine || head < from || head > to) return
          head =
            (back && from > 0) || to >= doc.length
              ? Math.max(0, from - 1)
              : to + 1
        })
        if (head === range.head) return range
        moved = true
        return range.empty
          ? EditorSelection.cursor(head)
          : EditorSelection.range(range.anchor, head)
      })
      return moved
        ? [
            transaction,
            {
              selection: EditorSelection.create(
                ranges,
                transaction.selection.mainIndex,
              ),
            },
          ]
        : transaction
    }),
    Prec.high(
      keymap.of([
        {
          key: 'Enter',
          run: run((view) => blockBreak(view.state, syntax.tree(view.state))),
        },
        {
          key: 'Shift-Enter',
          run: run((view) => lineBreak(view.state, syntax.tree(view.state))),
        },
        {
          key: 'Backspace',
          run: run((view) =>
            deleteBackward(view.state, syntax.tree(view.state), hidden(view)),
          ),
        },
        {
          key: 'Delete',
          run: run((view) =>
            deleteForward(view.state, syntax.tree(view.state), hidden(view)),
          ),
        },
        {
          key: 'Mod-Enter',
          run: run((view) => exitBlock(view.state, syntax.tree(view.state))),
        },
        { key: 'Tab', run: tab(false), shift: tab(true) },
        { key: 'ArrowLeft', run: arrow(false) },
        { key: 'ArrowRight', run: arrow(true) },
      ]),
    ),
    // A triple-click selects the clicked block's text, as in the rich editor:
    // not its markers or the line break after it, and not extended from the
    // selection with Shift. Dragging on does not extend it either. A block the
    // rich editor draws as one node, or an image, formula or diagram widget,
    // selects its source, as the rich editor node-selects it. The widget is
    // the one first pressed: the caret the first click places can show the
    // source in its place.
    EditorView.mouseSelectionStyle.of((view, event) => {
      if (event.button !== 0) return null
      const target = event.target instanceof Element ? event.target : null
      const widget = target?.closest('[contenteditable="false"]')
      const under =
        widget && view.contentDOM.contains(widget)
          ? view.posAtDOM(widget)
          : null
      if (event.detail === 1) pressedWidget.set(view, under)
      if (event.detail !== 3) return null
      let drawn = pressedWidget.get(view) ?? under
      let at = view.posAtCoords({ x: event.clientX, y: event.clientY })
      const text = () => {
        const tree = syntax.tree(view.state)
        const pos = drawn ?? at
        if (pos === null) return null
        return (
          blockAtom(view.state, tree, pos, drawn !== null) ??
          (at === null ? null : blockText(view.state, tree, at))
        )
      }
      const block = text()
      if (!block) return null
      return {
        get: () => {
          const { from, to } = text() ?? block
          return EditorSelection.single(from, to)
        },
        update: (update) => {
          if (at !== null) at = update.changes.mapPos(at)
          if (drawn !== null) drawn = update.changes.mapPos(drawn)
        },
      }
    }),
    shiftDoubleClick,
    // The page cannot select hidden lines at the note's ends, so a key typed
    // over the whole note would replace only what shows: replace it all, with
    // input handlers seeing the whole range as for any typed text. Text with
    // line breaks keeps the native multi-line input path.
    EditorView.domEventHandlers({
      // A pointer can still focus a code block's scrolling box, as when it
      // drags a selection; the text keeps the focus.
      focusin(event, view) {
        if (
          event.target instanceof HTMLElement &&
          event.target.classList.contains('hibi-lp-codescroll')
        )
          view.contentDOM.focus({ preventScroll: true })
        return false
      },
      beforeinput(event, view) {
        const { selection, readOnly } = view.state
        const hidden = (at: number) => {
          let found = false
          view.state.field(layout).between(at, at, (from, to, value) => {
            if (value === hiddenLine && from <= at && at <= to) found = true
          })
          return found
        }
        if (
          event.inputType !== 'insertText' ||
          !event.data ||
          event.data.includes('\n') ||
          view.composing ||
          readOnly ||
          selection.ranges.length !== 1 ||
          !selectsWholeNote(view.state, selection.main) ||
          !(hidden(selection.main.from) || hidden(selection.main.to))
        )
          return false
        event.preventDefault()
        const { from, to } = selection.main
        const text = event.data
        const insert = () =>
          view.state.update(
            {
              changes: { from, to, insert: text },
              selection: { anchor: from + text.length },
              userEvent: 'input.type',
            },
            { scrollIntoView: true },
          )
        if (
          !view.state
            .facet(EditorView.inputHandler)
            .some((handler) => handler(view, from, to, text, insert))
        )
          view.dispatch(insert())
        // Listeners such as typing state get the input the browser would have sent.
        view.contentDOM.dispatchEvent(
          new InputEvent('input', {
            inputType: 'insertText',
            data: text,
            bubbles: true,
          }),
        )
        return true
      },
    }),
    EditorView.inputHandler.of((view, from, to, text) => {
      if (view.composing) return false
      const tree = syntax.tree(view.state)
      const spec =
        (/[\r\n]/.test(text) && lineInput(view.state, tree, from, to, text)) ||
        gapInput(view.state, tree, from, to, text)
      if (!spec) return false
      view.dispatch(view.state.update(spec, { scrollIntoView: true }))
      return true
    }),
    // A caret or selection in a code block scrolls the block sideways to
    // show it, all of a selection on one line where it fits and its head
    // otherwise, once the editor may read its layout.
    EditorView.scrollHandler.of((view, range, { xMargin }) => {
      view.requestMeasure({
        key: revealCaret,
        read() {
          const { doc } = view.state
          if (Math.max(range.anchor, range.head) > doc.length) return null
          const { node } = view.domAtPos(range.head)
          const box = (
            node instanceof Element ? node : node.parentElement
          )?.closest('.hibi-lp-codescroll')
          const caret = box && view.coordsAtPos(range.head)
          if (!box || !caret) return null
          const left = box.getBoundingClientRect().left + xMargin
          const right = left + box.clientWidth - 2 * xMargin
          const other =
            !range.empty &&
            doc.lineAt(range.anchor).from === doc.lineAt(range.head).from
              ? view.coordsAtPos(range.anchor)
              : null
          let start = caret.left
          let end = caret.right
          if (
            other &&
            Math.max(end, other.right) - Math.min(start, other.left) <=
              right - left
          ) {
            start = Math.min(start, other.left)
            end = Math.max(end, other.right)
          }
          const by = start < left ? start - left : end > right ? end - right : 0
          return by ? { box, by } : null
        },
        write(move) {
          if (move) move.box.scrollLeft += move.by
        },
      })
      return false
    }),
    codePlaceholders,
    EditorView.lineWrapping,
    EditorView.editorAttributes.of({ class: 'hibi-formatted' }),
  ]
}
