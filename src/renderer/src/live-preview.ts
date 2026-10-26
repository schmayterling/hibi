import {
  type EditorState,
  type Extension,
  type Range,
  StateField,
  type Text,
} from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
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
import { listWindow, parsedChunks } from './chunked-markdown'
import { codeHighlighter } from './code-languages'
import type { FormattedSyntax } from './formatted-syntax'
import './live-preview.css'

/*
 * Live preview renders Markdown in place: syntax the formatted view shows as
 * formatting is hidden, block structure becomes line styles and widgets, and
 * the source text stays the only document. Work is bounded by the visible
 * ranges (inline styles) and by parsed chunks (layout), never the document.
 */

const hide = Decoration.replace({})

class RuleWidget extends WidgetType {
  override eq() {
    return true
  }
  toDOM() {
    const rule = document.createElement('span')
    rule.className = 'hibi-lp-rule'
    rule.setAttribute('aria-hidden', 'true')
    return rule
  }
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
/** Inline, so the rule's line keeps the indent, quote bars and spacing of the blocks around it. */
const rule = Decoration.replace({ widget: new RuleWidget() })
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

const isBlock = (node: SyntaxNode) => node.type.is('Block')
const isList = (node: SyntaxNode) =>
  node.name === 'BulletList' || node.name === 'OrderedList'
/** Containers without vertical padding: their first and last children's margins collapse through them. */
const isContainer = (node: SyntaxNode) =>
  node.name === 'Blockquote' || node.name === 'ListItem' || isList(node)

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
  const parent = node.parent
  // Items and nested lists sit 0.3em apart; blocks after the first in an item one line apart.
  if (parent?.name === 'ListItem')
    return {
      top: isList(node) ? 4.8 : blockSibling(node, false) ? 16 : 0,
      bottom: 0,
    }
  if (parent && isList(parent))
    return { top: blockSibling(node, false) ? 4.8 : 0, bottom: 0 }
  const space = blockSpace(node.name)
  // A quote's last block has no bottom margin.
  return parent?.name === 'Blockquote' && !blockSibling(node, true)
    ? { top: space.top, bottom: 0 }
    : space
}

/** The collapsed top margin of a block and its first descendants. */
function topMargin(node: SyntaxNode): number {
  const first = isContainer(node) && blockChild(node, false)
  return Math.max(margins(node).top, first ? topMargin(first) : 0)
}

function bottomMargin(node: SyntaxNode): number {
  const last = isContainer(node) && blockChild(node, true)
  return Math.max(margins(node).bottom, last ? bottomMargin(last) : 0)
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
  /** Quotes and lists around the line, outermost first. */
  containers: SyntaxNode[]
  /** The innermost list item around the line. */
  item: SyntaxNode | null
  /** Where the hidden quote markers at the line start end. */
  quoteEnd: number | null
  /** Where the line's first block starts, when one starts on it. */
  leaf: number | null
  /** Where a code line's text starts. */
  code: number | null
  /** The layout field hides the whole line. */
  hidden: boolean
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
function inline(view: EditorView, tree: Tree): DecorationSet {
  const { state } = view
  const doc = state.doc
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
        hidden: false,
        gap: 0,
      }
      lines.set(pos, info)
    }
    return info
  }
  const hideRange = (from: number, to: number) => {
    if (to > from) decorations.push(hide.range(from, to))
  }
  const mark = (className: string, from: number, to: number) => {
    if (to > from)
      decorations.push(Decoration.mark({ class: className }).range(from, to))
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
    hideRange(node.from, open.to)
    // A destination on later lines is hidden with its line breaks by the layout field.
    if (doc.lineAt(close.from).number === doc.lineAt(node.to).number)
      hideRange(close.from, node.to)
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
    // Fence lines are hidden by the layout field.
    if (fenced && first.from >= range.from) line(first.from).hidden = true
    if (closed && last.from <= range.to) line(last.from).hidden = true
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

  for (const range of view.visibleRanges) {
    tree.iterate({
      from: range.from,
      to: range.to,
      mode: IterMode.IgnoreMounts,
      enter(ref: SyntaxNodeRef) {
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
            ) {
              line(current.from).hidden = true
              return
            }
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
            // The opening mark hides with its space, a closing mark with the space before it.
            if (ref.from === parent.from) {
              const after = doc.sliceString(
                ref.to,
                Math.min(parent.to, ref.to + 1),
              )
              hideRange(
                ref.from,
                ref.to + (after === ' ' || after === '\t' ? 1 : 0),
              )
            } else {
              const before = doc.sliceString(
                Math.max(parent.from, ref.from - 1),
                ref.from,
              )
              hideRange(
                ref.from - (before === ' ' || before === '\t' ? 1 : 0),
                ref.to,
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
          case 'Strikethrough':
            mark('hibi-lp-strike', ref.from, ref.to)
            return
          case 'EmphasisMark':
          case 'StrikethroughMark':
            hideRange(ref.from, ref.to)
            return
          case 'InlineCode': {
            const open = ref.node.firstChild,
              close = ref.node.lastChild
            if (
              open?.name !== 'CodeMark' ||
              close?.name !== 'CodeMark' ||
              open.from === close.from
            )
              return false
            hideRange(open.from, open.to)
            hideRange(close.from, close.to)
            mark('hibi-lp-code', open.to, close.from)
            return false
          }
          case 'Link':
            return link(ref.node)
          case 'Autolink': {
            const url = ref.node.getChild('URL')
            if (!url) return false
            hideRange(ref.from, url.from)
            hideRange(url.to, ref.to)
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
          case 'HorizontalRule': {
            line(doc.lineAt(ref.from).from).classes.push('hibi-lp-rule-line')
            decorations.push(rule.range(ref.from, ref.to))
            return false
          }
          case 'Escape':
            hideRange(ref.from, ref.from + 1)
            return
          case 'HardBreak':
            if (doc.sliceString(ref.from, ref.from + 1) === '\\')
              hideRange(ref.from, ref.from + 1)
            return
          case 'Blockquote':
          case 'BulletList':
          case 'OrderedList':
            eachLine(doc, ref.from, ref.to, range, (current) => {
              line(current.from).containers.push(ref.node)
            })
            return
          case 'QuoteMark': {
            const after = doc.sliceString(
              ref.to,
              Math.min(doc.length, ref.to + 1),
            )
            const info = line(doc.lineAt(ref.from).from)
            info.quoteEnd = Math.max(
              info.quoteEnd ?? 0,
              ref.to + (after === ' ' || after === '\t' ? 1 : 0),
            )
            return
          }
          case 'ListItem': {
            eachLine(doc, ref.from, ref.to, range, (current) => {
              line(current.from).item = ref.node
            })
            // The layout field hides a lone marker's line.
            const lone = loneMarker(doc, ref.node)
            if (lone && lone.from >= range.from && lone.from <= range.to)
              line(lone.from).hidden = true
            return
          }
          case 'FencedCode':
          case 'CodeBlock':
            code(ref.node, range)
            // Quote markers inside the block are hidden with the line prefix.
            return
        }
      },
    })
  }
  spacing(view, tree, line)
  const ordinals = new Map<number, number[]>()
  for (const [at, info] of lines) {
    const current = doc.lineAt(at)
    containers(doc, at, info)
    let prefix = info.quoteEnd ?? at
    if (info.code !== null) prefix = info.code
    else if (info.item) prefix = itemLine(doc, current, info, prefix, ordinals)
    else if (info.leaf !== null) prefix = info.leaf
    // Quote markers, list markers and indentation before the line's content.
    if (!info.hidden) hideRange(at, Math.min(prefix, current.to))
    if (info.gap) info.style.push(`padding-top: ${info.gap}px`)
    decorations.push(
      Decoration.line({
        attributes: {
          ...(info.classes.length ? { class: info.classes.join(' ') } : {}),
          ...(info.style.length ? { style: info.style.join('; ') } : {}),
        },
      }).range(at),
    )
  }
  return Decoration.set(decorations, true)
}

/**
 * Quotes and lists indent a line by their widths: a quote's 20px padding and
 * 1px bar, a list's 1.5em. Bars are drawn in the indentation; a quote's bar
 * starts below the space above its first line, which lies outside it.
 */
function containers(doc: Text, at: number, info: LineInfo) {
  if (!info.containers.length) return
  const widths: string[] = []
  const bars: string[] = []
  for (const container of info.containers) {
    const left = widths.length ? `calc(${widths.join(' + ')})` : '0px'
    if (container.name === 'Blockquote') {
      const top = shownLine(doc, container).from === at ? info.gap : 0
      bars.push(
        `linear-gradient(var(--border), var(--border)) ${left} ${top}px / 1px calc(100% - ${top}px) no-repeat`,
      )
      widths.push('21px')
    } else widths.push('1.5 * var(--text-editor)')
  }
  info.classes.push('hibi-lp-nested')
  info.style.push(`--hibi-indent: calc(${widths.join(' + ')})`)
  if (bars.length) {
    info.classes.push('hibi-lp-quote')
    info.style.push(`--hibi-bars: ${bars.join(', ')}`)
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
  const depth = info.containers.filter(isList).length
  const marker = item.getChild('ListMark')
  // Continuation lines start at the item's content.
  const content = () =>
    info.leaf ??
    prefix + /^[ \t]*/.exec(doc.sliceString(prefix, current.to))![0].length
  // A lone marker is drawn on the line after its own.
  const lone = marker && loneMarker(doc, item)
  if (
    !marker ||
    current.number !== (lone ? lone.number + 1 : doc.lineAt(item.from).number)
  )
    return content()
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
  if (lone) return content()
  // The marker and up to four following spaces are hidden.
  const after = doc.sliceString(marker.to, current.to)
  const gap = /^[ \t]{0,4}/.exec(after)![0].length
  return Math.max(
    info.leaf ?? 0,
    marker.to + (gap === after.length ? after.length : gap),
  )
}

/**
 * Collapsed margins between sibling blocks, at every level of quotes and
 * lists near the visible ranges, become blank-line heights or first-line
 * padding.
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
}

/** Layout decorations for one parsed chunk, relative to the chunk start. */
function chunkLayout(
  doc: Text,
  tree: Tree,
  from: number,
  covered: readonly { from: number; to: number }[],
) {
  const out: Range<Decoration>[] = []
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
          (ref.name !== 'Paragraph' && !ref.name.startsWith('SetextHeading'))
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
  return out
}

/** Layout per chunk tree: reused chunks keep their decorations, shifted to their position. */
const chunkCache = new WeakMap<Tree, Range<Decoration>[]>()
function layoutDecorations(state: EditorState, tree: Tree): DecorationSet {
  const out: Range<Decoration>[] = []
  for (const { from, chunk, covered } of parsedChunks(tree)) {
    let ranges = chunkCache.get(chunk)
    if (!ranges) {
      ranges = chunkLayout(state.doc, tree, from, covered)
      chunkCache.set(chunk, ranges)
    }
    for (const range of ranges)
      out.push(range.value.range(range.from + from, range.to + from))
  }
  return Decoration.set(out, true)
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

/** The formatted view's rendering over its chunked Markdown syntax tree. */
export function livePreview(syntax: FormattedSyntax): Extension {
  const layout = StateField.define<DecorationSet>({
    create: (state) => layoutDecorations(state, syntax.tree(state)),
    update(value, transaction) {
      const tree = syntax.tree(transaction.state)
      // An edit's unfinished reparse keeps the layout it replaces, mapped.
      return tree === syntax.tree(transaction.startState) ||
        syntax.settling(transaction.state)
        ? value.map(transaction.changes)
        : layoutDecorations(transaction.state, tree)
    },
    provide: (field) => EditorView.decorations.from(field),
  })
  const preview = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = inline(view, syntax.tree(view.state))
      }
      update(update: ViewUpdate) {
        const tree = syntax.tree(update.state)
        // An edit's unfinished reparse keeps what was drawn, mapped through it.
        if (syntax.settling(update.state))
          this.decorations = mapLines(this.decorations, update)
        else if (
          update.docChanged ||
          update.viewportChanged ||
          tree !== syntax.tree(update.startState)
        )
          this.decorations = inline(update.view, tree)
      }
    },
    { decorations: (plugin) => plugin.decorations },
  )
  return [
    syntax.extension,
    layout,
    preview,
    EditorView.lineWrapping,
    EditorView.editorAttributes.of({ class: 'hibi-formatted' }),
  ]
}
