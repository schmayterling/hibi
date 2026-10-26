import {
  Compartment,
  EditorSelection,
  EditorState,
  type Extension,
  Facet,
  Prec,
  type Range,
  StateEffect,
  StateField,
  type Text,
  type TransactionSpec,
} from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view'
import {
  IterMode,
  type SyntaxNode,
  type SyntaxNodeRef,
  type Tree,
} from '@lezer/common'
import { highlightTree } from '@lezer/highlight'
import { listWindow, parsedChunks, uncovered } from './chunked-markdown'
import { codeHighlighter } from './code-languages'
import {
  blockBreak,
  deleteBackward,
  deleteForward,
  exitBlock,
  gapInput,
  indent,
  lineBreak,
} from './formatted-commands'
import {
  type FormattedContainer,
  type FormattedDecorations,
  type FormattedLayout,
  type FormattedNodeView,
  formattedContributions,
  formattedDocument,
  formattedLiteral,
  formattedRefresh,
  formattedRenderInputs,
  formattedTree,
  formattedViews,
  showMarkdownMarkers,
} from './formatted-contributions'
import type { FormattedSyntax } from './formatted-syntax'
import './formatted'
import './live-preview.css'

/*
 * Live preview renders Markdown in place: syntax the formatted view shows as
 * formatting is hidden, block structure becomes line styles and widgets, and
 * the source text stays the only document. Work is bounded by the visible
 * ranges (inline styles) and by parsed chunks (layout), never the document.
 */

const hide = Decoration.replace({})

/** Whether Tab indents formatted text; list items and code always take Tab. */
export const formattedTabIndents = Facet.define<boolean, boolean>({
  combine: (values) => values.at(-1) ?? true,
})

type Revealed = { from: number; to: number }

/** Contributed node views by node name, per set of views. */
const viewsByName = new WeakMap<
  readonly FormattedNodeView[],
  Map<string, FormattedNodeView[]>
>()
function namedViews(state: EditorState) {
  const views = state.facet(formattedViews)
  let named = viewsByName.get(views)
  if (!named) {
    named = new Map()
    for (const view of views)
      for (const name of view.nodes) {
        const list = named.get(name)
        if (list) list.push(view)
        else named.set(name, [view])
      }
    viewsByName.set(views, named)
  }
  return named
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

/** Margins of a block in px, as in the formatted view's document styles. */
function blockSpace(name: string): { top: number; bottom: number } {
  const heading = /^(?:ATX|Setext)Heading(\d)$/.exec(name)
  if (heading) {
    const size = [30, 24, 20, 17, 17, 17][Number(heading[1]) - 1]!
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
  views: Map<string, FormattedNodeView[]>
  shapes: (node: SyntaxNode) => FormattedContainer | undefined
}
const noBlocks: Blocks = {
  literal: new Set(),
  views: new Map(),
  shapes: () => undefined,
}
let blocks = noBlocks

const isBlock = (node: SyntaxNode) => node.type.is('Block')
const isList = (node: SyntaxNode) =>
  node.name === 'BulletList' || node.name === 'OrderedList'
/** Blocks that hold blocks; unless padded, their first and last children's margins collapse through them. */
const isContainer = (node: SyntaxNode) =>
  !blocks.literal.has(node.name) &&
  (node.name === 'Blockquote' ||
    node.name === 'ListItem' ||
    isList(node) ||
    !!blocks.views.get(node.name)?.some((view) => view.container))

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
  if (blocks.literal.has(node.name)) return { top: 16, bottom: 16 }
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
    blocks.views.get(node.name)?.find((view) => view.space)?.space ??
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
): { decorations: DecorationSet; atomic: DecorationSet; end: number } {
  const { state } = view
  const doc = state.doc
  const views = namedViews(state)
  const literal = new Set(state.facet(formattedLiteral))
  const atomic: Range<Decoration>[] = []
  const touched = (from: number, to: number) =>
    reveal.some((range) => range.from <= to && range.to >= from)
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
    for (const nodeView of views.get(node.name) ?? []) {
      shape = nodeView.container?.(node, context)
      if (shape) break
    }
    shapeCache.set(key, shape)
    return shape
  }
  blocks = { literal, views, shapes }
  const decorations: Range<Decoration>[] = []
  const lines = new Map<number, LineInfo>()
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
  /** Markers of formatting under the selection stay visible and editable. */
  const syntax = (from: number, to: number, revealed: boolean) => {
    if (revealed) mark('hibi-lp-marker', from, to)
    else hideRange(from, to)
  }

  function link(node: SyntaxNode) {
    const linkMarks = node.getChildren('LinkMark')
    const open = linkMarks[0]
    const close = linkMarks.find(
      (current) => doc.sliceString(current.from, current.to) === ']',
    )
    const target = close && doc.sliceString(close.to, close.to + 1)
    // Reference links need the note's definitions, so they stay literal for now.
    if (
      !open ||
      !close ||
      doc.sliceString(open.from, open.to) !== '[' ||
      target !== '('
    )
      return false
    const revealed = touched(node.from, node.to)
    syntax(node.from, open.to, revealed)
    // A destination on later lines is hidden with its line breaks by the layout field.
    if (doc.lineAt(close.from).number === doc.lineAt(node.to).number)
      syntax(close.from, node.to, revealed)
    mark('hibi-lp-link', open.to, close.from)
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
    const texts = node.getChildren('CodeText')
    let text = 0
    for (
      let number = Math.max(from, visibleFrom);
      number <= Math.min(to, visibleTo);
      number++
    ) {
      const current = doc.line(number)
      const info = line(current.from)
      info.classes.push('hibi-lp-codeblock')
      if (number === from) info.classes.push('hibi-lp-codeblock-first')
      if (number === to) info.classes.push('hibi-lp-codeblock-last')
      // The line's text starts at its code text: quote markers, list
      // indentation and the four columns of indented code before it are hidden.
      while (text < texts.length && texts[text]!.to <= current.from) text++
      const next = texts[text]
      const start =
        next && next.from <= current.to
          ? Math.max(next.from, current.from)
          : current.to
      info.code = start
      // Code text is smaller than the block's line box, as in a pre element.
      mark('hibi-lp-codetext', start, current.to)
    }
    // Nested code languages use the shared token classes.
    for (const piece of texts)
      if (piece.to > range.from && piece.from < range.to)
        highlightTree(
          tree,
          codeHighlighter,
          (from, to, classes) => mark(classes, from, to),
          Math.max(piece.from, range.from),
          Math.min(piece.to, range.to),
        )
  }

  /** Decorations from a contributed view for one node, revealed while the selection touches it. */
  const sink = (revealed: boolean): FormattedDecorations => ({
    mark(from, to, attributes) {
      if (to > from)
        decorations.push(Decoration.mark({ attributes }).range(from, to))
    },
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
      if (to <= from || doc.lineAt(from).to < to) return
      const range = Decoration.replace(widget ? { widget } : {}).range(from, to)
      decorations.push(range)
      atomic.push(range)
    },
  })

  for (const range of view.visibleRanges) {
    tree.iterate({
      from: range.from,
      to: range.to,
      mode: IterMode.IgnoreMounts,
      enter(ref: SyntaxNodeRef) {
        const name = ref.name
        // Syntax whose setting is off shows as written, its children too.
        if (literal.has(name)) return false
        const contributed = views.get(name)
        let skip = false
        if (contributed) {
          const out = sink(touched(ref.from, ref.to))
          const context = {
            state,
            revealed: touched(ref.from, ref.to),
            visible: range,
          }
          for (const nodeView of contributed)
            if (nodeView.decorate?.(ref, out, context) === false) skip = true
          // Other blocks with a container hook hold their lines like quotes.
          if (
            name !== 'Blockquote' &&
            name !== 'ListItem' &&
            contributed.some((nodeView) => nodeView.container)
          ) {
            const node = ref.node
            eachLine(doc, ref.from, ref.to, range, (current) => {
              line(current.from).containers.push(node)
            })
          }
        }
        const result = builtIn(ref, range)
        return skip ? false : result
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
      eachLine(doc, ref.from, ref.to, range, (current) => {
        // A setext underline line is hidden by the layout field.
        if (
          heading[1] === 'Setext' &&
          current.to >= ref.to &&
          current.from > ref.from
        )
          return
        line(current.from).classes.push(
          'hibi-lp-heading',
          `hibi-lp-h${heading[2]}`,
        )
      })
      return
    }
    switch (name) {
      case 'HeaderMark': {
        const parent = ref.node.parent
        if (!parent?.name.startsWith('ATX')) return
        const current = doc.lineAt(ref.from)
        const revealed = touched(current.from, current.to)
        // The opening mark hides with its space, a closing mark with the space before it.
        if (ref.from === parent.from) {
          const after = doc.sliceString(ref.to, Math.min(parent.to, ref.to + 1))
          syntax(
            ref.from,
            ref.to + (after === ' ' || after === '\t' ? 1 : 0),
            revealed,
          )
        } else {
          const before = doc.sliceString(
            Math.max(parent.from, ref.from - 1),
            ref.from,
          )
          syntax(
            ref.from - (before === ' ' || before === '\t' ? 1 : 0),
            ref.to,
            revealed,
          )
        }
        return
      }
      case 'Emphasis':
        mark('hibi-lp-em', ref.from, ref.to)
        return
      case 'StrongEmphasis':
        mark('hibi-lp-strong', ref.from, ref.to)
        return
      case 'EmphasisMark': {
        const parent = ref.node.parent
        syntax(ref.from, ref.to, !!parent && touched(parent.from, parent.to))
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
        const revealed = touched(ref.from, ref.to)
        syntax(open.from, open.to, revealed)
        syntax(close.from, close.to, revealed)
        mark('hibi-lp-code', open.to, close.from)
        return false
      }
      case 'Link':
        return link(ref.node)
      case 'Autolink': {
        const url = ref.node.getChild('URL')
        if (!url) return false
        const revealed = touched(ref.from, ref.to)
        syntax(ref.from, url.from, revealed)
        syntax(url.to, ref.to, revealed)
        mark('hibi-lp-link', url.from, url.to)
        return false
      }
      case 'URL': {
        const parent = ref.node.parent?.name
        if (
          parent !== 'Link' &&
          parent !== 'Image' &&
          parent !== 'LinkReference'
        )
          mark('hibi-lp-link', ref.from, ref.to)
        return
      }
      case 'Image':
      case 'LinkReference':
      case 'HTMLBlock':
      case 'HTMLTag':
      case 'CommentBlock':
      case 'ProcessingInstructionBlock':
      case 'Table':
      case 'Entity':
        // Rendered by later formatted-view slices; shown as source text for now.
        return false
      case 'Escape':
        syntax(ref.from, ref.from + 1, touched(ref.from, ref.to))
        return
      case 'HardBreak':
        if (doc.sliceString(ref.from, ref.from + 1) === '\\')
          hideRange(ref.from, ref.from + 1)
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
  const end = spacing(view, tree, line)
  const ordinals = new Map<number, number[]>()
  for (const [at, info] of lines) {
    const current = doc.lineAt(at)
    containers(doc, at, info, layout)
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
  return {
    decorations: Decoration.set(decorations, true),
    atomic: Decoration.set(atomic, true),
    end,
  }
}

/** Where a container's last line that the layout does not hide starts. */
function lastLine(doc: Text, node: SyntaxNode, layout: DecorationSet) {
  let last = doc.lineAt(node.to)
  while (last.from > node.from && replacedLine(layout, last))
    last = doc.line(last.number - 1)
  return last.from
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
) {
  if (!info.containers.length) return
  const widths: string[] = []
  const paint: string[] = []
  let top = 0,
    bottom = 0,
    right = 0
  for (const container of info.containers) {
    const left = widths.length ? `calc(${widths.join(' + ')})` : '0px'
    const shape = blocks.shapes(container)
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
    const after = doc.sliceString(marker.to, current.to)
    const gap = /^[ \t]{0,4}/.exec(after)![0].length
    content = Math.max(
      info.leaf ?? 0,
      marker.to + (gap === after.length ? after.length : gap),
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
    const start = doc.lineAt(block.from),
      end = doc.lineAt(previous.to)
    if (end.number + 1 >= start.number) {
      const shown = shownLine(doc, block)
      if (shown.from >= range.from && shown.from <= range.to)
        line(shown.from).gap = gap
      return
    }
    for (let number = end.number + 1; number < start.number; number++) {
      const blank = doc.line(number)
      if (blank.from < range.from || blank.from > range.to) continue
      const info = line(blank.from)
      info.classes.push('hibi-lp-gap')
      const height = number === end.number + 1 ? gap : 28
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
  const views = namedViews(state)
  const literal = new Set(state.facet(formattedLiteral))
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
  for (const range of covered) {
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
        if (literal.has(ref.name)) return false
        const contributed = views.get(ref.name)
        if (contributed?.some((view) => view.layout)) {
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
            // A destination on later lines is hidden with its line breaks.
            if (
              leaf &&
              close &&
              doc.sliceString(close.to, close.to + 1) === '(' &&
              doc.lineAt(close.from).number !== doc.lineAt(ref.to).number
            ) {
              leaf.hidden.push({ from: close.from, to: ref.to })
              if (starts(close.from))
                out.push(hide.range(close.from - from, ref.to - from))
            }
            return
          }
          case 'CodeBlock':
          case 'HTMLBlock':
          case 'CommentBlock':
          case 'ProcessingInstructionBlock':
          case 'Table':
          case 'LinkReference':
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
  return { ranges: out, sensitive }
}

type ChunkLayout = ReturnType<typeof chunkLayout>
/**
 * Layout per chunk tree, set of views and set of nodes shown as written:
 * reused chunks keep their decorations, shifted to their position. A chunk
 * under the selection whose layout comes from contributed views is laid out
 * again with its reveal state.
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
    if (!layout) {
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

/** The selection while the focused editor shows markers. */
function revealedIn(state: EditorState): readonly Revealed[] {
  if (!state.field(focused, false) || !state.facet(showMarkdownMarkers))
    return []
  return state.selection.ranges.map(({ from, to }) => ({ from, to }))
}

const sameRanges = (a: readonly Revealed[], b: readonly Revealed[]) =>
  a.length === b.length &&
  a.every(
    (range, index) =>
      range.from === b[index]?.from && range.to === b[index]?.to,
  )

/** Ranges whose markers show: the selection while the focused editor shows markers. */
function revealed(view: EditorView): readonly Revealed[] {
  if (!view.hasFocus || !view.state.facet(showMarkdownMarkers)) return []
  return view.state.selection.ranges.map(({ from, to }) => ({ from, to }))
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
 */
function revealDestinations(set: DecorationSet, state: EditorState) {
  for (const { from, to } of state.selection.ranges)
    set = set.update({
      filterFrom: from,
      filterTo: to,
      filter: (a, b, value) => value !== hide || b < from || a > to,
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
      layoutDecorations(state, syntax.tree(state), revealedIn(state)),
    update(value, transaction) {
      const { state, startState } = transaction
      const tree = syntax.tree(state),
        reveal = revealedIn(state)
      // An edit's unfinished reparse keeps the layout it replaces, mapped.
      if (
        syntax.settling(state) ||
        (tree === syntax.tree(startState) &&
          state.facet(formattedViews) === startState.facet(formattedViews) &&
          state.facet(formattedLiteral) ===
            startState.facet(formattedLiteral) &&
          state.facet(formattedDocument) ===
            startState.facet(formattedDocument) &&
          state.facet(formattedRenderInputs) ===
            startState.facet(formattedRenderInputs) &&
          (sameRanges(reveal, revealedIn(startState)) ||
            (!revealMatters(state, tree, reveal) &&
              !revealMatters(state, tree, revealedIn(startState)))))
      )
        return value.map(transaction.changes)
      return layoutDecorations(state, tree, reveal)
    },
  })
  const preview = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      atomic: DecorationSet
      /** Space below the last line, in px. */
      end: number
      reveal: readonly Revealed[]
      constructor(view: EditorView) {
        this.reveal = revealed(view)
        ;({
          decorations: this.decorations,
          atomic: this.atomic,
          end: this.end,
        } = inline(
          view,
          syntax.tree(view.state),
          this.reveal,
          view.state.field(layout),
        ))
      }
      update(update: ViewUpdate) {
        const tree = syntax.tree(update.state)
        // Candidate text keeps its markers while an input method composes.
        const reveal = update.view.composing
          ? this.reveal.map((range) => ({
              from: update.changes.mapPos(range.from, -1),
              to: update.changes.mapPos(range.to, 1),
            }))
          : revealed(update.view)
        const changedReveal =
          reveal.length !== this.reveal.length ||
          reveal.some(
            (range, index) =>
              range.from !== this.reveal[index]?.from ||
              range.to !== this.reveal[index]?.to,
          )
        this.reveal = reveal
        // An edit's unfinished reparse keeps what was drawn, mapped through it.
        if (syntax.settling(update.state)) {
          this.decorations = mapLines(this.decorations, update)
          this.atomic = mapLines(this.atomic, update)
        } else if (
          update.docChanged ||
          update.viewportChanged ||
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
            transaction.effects.some((effect) => effect.is(formattedRefresh)),
          )
        )
          ({
            decorations: this.decorations,
            atomic: this.atomic,
            end: this.end,
          } = inline(update.view, tree, reveal, update.state.field(layout)))
      }
    },
    { decorations: (plugin) => plugin.decorations },
  )
  const hidden = (view: EditorView) =>
    view.plugin(preview)?.atomic ?? Decoration.none
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
    let structured = false
    for (
      let node: SyntaxNode | null = tree.resolveInner(
        view.state.selection.main.head,
        -1,
      );
      node;
      node = node.parent
    )
      if (['ListItem', 'FencedCode', 'CodeBlock'].includes(node.name))
        structured = true
    if (!structured && !view.state.facet(formattedTabIndents)) return false
    return run((current) =>
      indent(current.state, tree, outdent, hidden(current)),
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
    contributions.of(formattedContributions.extension(options.flavors)),
    formattedTree.of(syntax.tree),
    follow,
    syntax.extension,
    focused,
    layout,
    EditorView.decorations.compute([layout, 'selection'], (state) =>
      revealDestinations(state.field(layout), state),
    ),
    // Hidden layout syntax is atomic too.
    EditorView.atomicRanges.of((view) =>
      revealDestinations(view.state.field(layout), view.state),
    ),
    preview,
    // The space after the last block lies outside every block's paint.
    EditorView.contentAttributes.of((view) => {
      const end = view.plugin(preview)?.end
      return end ? { style: `--hibi-end: ${end}px` } : null
    }),
    EditorView.atomicRanges.of(hidden),
    // Lines the layout hides whole, with the line breaks around them, so the
    // caret never rests on one.
    EditorView.atomicRanges.of((view) => {
      const { doc } = view.state
      const lines: Range<Decoration>[] = []
      for (const { from, to } of view.visibleRanges)
        view.state.field(layout).between(from, to, (a, b, value) => {
          if (value === hiddenLine)
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
        let head = range.head
        lines.between(head, head, (from, to, value) => {
          if (value !== hiddenLine || head < from || head > to) return
          const back = head < (before[index]?.head ?? head)
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
      ]),
    ),
    EditorView.inputHandler.of((view, from, to, text) => {
      if (view.composing) return false
      const spec = gapInput(view.state, syntax.tree(view.state), from, to, text)
      if (!spec) return false
      view.dispatch(view.state.update(spec, { scrollIntoView: true }))
      return true
    }),
    EditorView.lineWrapping,
    EditorView.editorAttributes.of({ class: 'hibi-formatted' }),
  ]
}
