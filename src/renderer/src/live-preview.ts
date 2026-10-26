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
import type { SyntaxNode, SyntaxNodeRef, Tree } from '@lezer/common'
import { highlightTree } from '@lezer/highlight'
import { parsedChunks } from './chunked-markdown'
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
    const rule = document.createElement('div')
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
const rule = Decoration.replace({ widget: new RuleWidget(), block: true })
const space = Decoration.replace({ widget: new SpaceWidget() })
const hiddenLine = Decoration.replace({ block: true })

/** Space around top-level blocks in px, matching the formatted view's collapsed margins. */
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

type LineInfo = { classes: string[]; style: string[] }

/** Inline formatting, hidden markers and line styles for the visible ranges. */
function inline(view: EditorView, tree: Tree): DecorationSet {
  const { state } = view
  const doc = state.doc
  const decorations: Range<Decoration>[] = []
  const lines = new Map<number, LineInfo>()
  const line = (pos: number) => {
    let info = lines.get(pos)
    if (!info) {
      info = { classes: [], style: [] }
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
  const quoteDepth = new Map<number, number>()
  const items = new Map<number, { depth: number; item: SyntaxNode }>()

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
      // Indented code shows its text without the four columns of indentation.
      let start = current.from
      if (!fenced) {
        const indent = /^(?: {4}|\t| {1,3}\t)/.exec(current.text)
        if (indent) {
          start += indent[0].length
          hideRange(current.from, start)
        }
      }
      // Code text is smaller than the block's line box, as in a pre element.
      mark('hibi-lp-codetext', start, current.to)
    }
    // Nested code languages use the shared token classes.
    const text = node.getChild('CodeText')
    if (text)
      highlightTree(
        tree,
        codeHighlighter,
        (from, to, classes) => mark(classes, from, to),
        Math.max(text.from, range.from),
        Math.min(text.to, range.to),
      )
  }

  for (const range of view.visibleRanges) {
    tree.iterate({
      from: range.from,
      to: range.to,
      enter(ref: SyntaxNodeRef) {
        const name = ref.name
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
            // The opening mark hides with its space, a closing mark with the space before it.
            if (ref.from === parent.from) {
              // Indentation before the opening mark is hidden with it.
              const after = doc.sliceString(
                ref.to,
                Math.min(parent.to, ref.to + 1),
              )
              hideRange(
                doc.lineAt(ref.from).from,
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
          case 'Escape':
            hideRange(ref.from, ref.from + 1)
            return
          case 'HardBreak':
            if (doc.sliceString(ref.from, ref.from + 1) === '\\')
              hideRange(ref.from, ref.from + 1)
            return
          case 'Blockquote':
            eachLine(doc, ref.from, ref.to, range, (current) => {
              quoteDepth.set(
                current.from,
                (quoteDepth.get(current.from) ?? 0) + 1,
              )
            })
            return
          case 'QuoteMark': {
            const after = doc.sliceString(
              ref.to,
              Math.min(doc.length, ref.to + 1),
            )
            hideRange(
              ref.from,
              ref.to + (after === ' ' || after === '\t' ? 1 : 0),
            )
            return
          }
          case 'ListItem': {
            let depth = 0
            for (let parent = ref.node.parent; parent; parent = parent.parent)
              if (parent.name === 'BulletList' || parent.name === 'OrderedList')
                depth++
            eachLine(doc, ref.from, ref.to, range, (current) => {
              items.set(current.from, { depth, item: ref.node })
            })
            return
          }
          case 'FencedCode':
          case 'CodeBlock':
            code(ref.node, range)
            return false
        }
      },
    })
  }
  for (const [at, depth] of quoteDepth) {
    const info = line(at)
    info.classes.push('hibi-lp-quote')
    info.style.push(`--hibi-quote-depth: ${depth}`)
  }
  listLines(doc, items, line, hideRange)
  spacing(view, tree, line)
  for (const [at, info] of lines)
    decorations.push(
      Decoration.line({
        attributes: {
          ...(info.classes.length ? { class: info.classes.join(' ') } : {}),
          ...(info.style.length ? { style: info.style.join('; ') } : {}),
        },
      }).range(at),
    )
  return Decoration.set(decorations, true)
}

/** List lines: native list markers in the indentation, source markers hidden. */
function listLines(
  doc: Text,
  items: Map<number, { depth: number; item: SyntaxNode }>,
  line: (pos: number) => LineInfo,
  hideRange: (from: number, to: number) => void,
) {
  const content = new Map<SyntaxNode, number>()
  const numbers = new Map<SyntaxNode, number>()
  for (const [at, { depth, item }] of items) {
    const current = doc.lineAt(at)
    const info = line(at)
    info.classes.push('hibi-lp-list')
    info.style.push(`--hibi-list-depth: ${depth}`)
    const marker = item.getChild('ListMark')
    if (marker && current.from <= item.from && item.from <= current.to) {
      // The marker, its indentation and up to four following spaces are hidden.
      const after = doc.sliceString(marker.to, current.to)
      const gap = /^[ \t]{0,4}/.exec(after)?.[0].length ?? 0
      const end =
        marker.to +
        (gap === after.length ? after.length : Math.max(Math.min(gap, 4), 0))
      content.set(item, end - current.from)
      hideRange(current.from, end)
      info.classes.push('hibi-lp-list-item')
      const list = item.parent
      // Items sit 0.3em apart, and a nested list 0.3em below its parent's text.
      if (item.prevSibling?.name === 'ListItem' || depth > 1)
        info.style.push('padding-top: 0.3em')
      if (list?.name === 'OrderedList') {
        let index = numbers.get(item)
        if (index === undefined) {
          index = 0
          for (
            let sibling = item.prevSibling;
            sibling;
            sibling = sibling.prevSibling
          )
            if (sibling.name === 'ListItem') index++
        }
        const next = item.nextSibling
        if (next?.name === 'ListItem') numbers.set(next, index + 1)
        const first = list.getChild('ListItem')?.getChild('ListMark')
        const start = first
          ? Number.parseInt(doc.sliceString(first.from, first.to), 10)
          : 1
        info.classes.push('hibi-lp-list-ordered')
        info.style.push(
          `counter-set: list-item ${(Number.isFinite(start) ? start : 1) + index}`,
        )
      } else
        info.style.push(
          `list-style-type: ${['disc', 'circle', 'square'][Math.min(depth, 3) - 1]}`,
        )
    } else {
      // Continuation lines align with the item's content.
      const column = content.get(item) ?? 2
      const indent = /^[ \t]*/.exec(current.text)?.[0].length ?? 0
      hideRange(current.from, current.from + Math.min(indent, column))
    }
  }
}

/** Collapsed margins between top-level blocks become blank-line heights or first-line padding. */
function spacing(
  view: EditorView,
  tree: Tree,
  line: (pos: number) => LineInfo,
) {
  const doc = view.state.doc
  for (const range of view.visibleRanges) {
    const top = tree.topNode
    let node: SyntaxNode | null = top.childBefore(range.from) ?? top.firstChild
    if (node?.prevSibling) node = node.prevSibling
    const blocks: SyntaxNode[] = []
    for (; node && node.from <= range.to; node = node.nextSibling)
      blocks.push(node)
    const after = blocks.at(-1)?.nextSibling
    if (after) blocks.push(after)
    for (let index = 0; index < blocks.length; index++) {
      const block = blocks[index]!
      const previous = index ? blocks[index - 1]! : block.prevSibling
      const start = doc.lineAt(block.from)
      if (!previous) continue
      const gap = Math.max(
        blockSpace(previous.name).bottom,
        blockSpace(block.name).top,
      )
      const end = doc.lineAt(previous.to)
      if (end.number + 1 >= start.number) {
        if (start.from >= range.from && start.from <= range.to)
          line(start.from).style.push(`padding-top: ${gap}px`)
        continue
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
  }
}

/** Layout decorations for one parsed chunk, relative to the chunk start. */
function chunkLayout(doc: Text, tree: Tree, from: number, to: number) {
  const out: Range<Decoration>[] = []
  const softBreaks = (node: SyntaxNode, start: number, end: number) => {
    const hard = new Set(
      node.getChildren('HardBreak').map((child) => doc.lineAt(child.from).to),
    )
    for (
      let current = doc.lineAt(start);
      current.to < end;
      current = doc.line(current.number + 1)
    )
      if (!hard.has(current.to))
        out.push(space.range(current.to - from, current.to + 1 - from))
  }
  tree.iterate({
    from,
    to,
    enter(ref) {
      if (ref.to <= from || ref.from >= to) return false
      switch (ref.name) {
        case 'FencedCode': {
          const first = doc.lineAt(ref.from)
          out.push(hiddenLine.range(first.from - from, first.to - from))
          const closing = ref.node.lastChild
          const last = doc.lineAt(ref.to)
          if (
            closing?.name === 'CodeMark' &&
            closing.from >= last.from &&
            last.number > first.number
          )
            out.push(hiddenLine.range(last.from - from, last.to - from))
          return false
        }
        case 'HorizontalRule': {
          const current = doc.lineAt(ref.from)
          out.push(rule.range(current.from - from, current.to - from))
          return false
        }
        case 'SetextHeading1':
        case 'SetextHeading2': {
          const last = doc.lineAt(ref.to)
          if (last.from > ref.from) {
            out.push(hiddenLine.range(last.from - from, last.to - from))
            softBreaks(ref.node, ref.from, last.from - 1)
          }
          return false
        }
        case 'Paragraph':
          softBreaks(ref.node, ref.from, ref.to)
          return false
        case 'CodeBlock':
        case 'HTMLBlock':
        case 'CommentBlock':
        case 'ProcessingInstructionBlock':
        case 'Table':
        case 'LinkReference':
          return false
      }
    },
  })
  return out
}

/** Layout per chunk tree: reused chunks keep their decorations, shifted to their position. */
const chunkCache = new WeakMap<Tree, Range<Decoration>[]>()
function layoutDecorations(state: EditorState, tree: Tree): DecorationSet {
  const out: Range<Decoration>[] = []
  for (const { from, chunk } of parsedChunks(tree)) {
    let ranges = chunkCache.get(chunk)
    if (!ranges) {
      ranges = chunkLayout(state.doc, tree, from, from + chunk.length)
      chunkCache.set(chunk, ranges)
    }
    for (const range of ranges)
      out.push(range.value.range(range.from + from, range.to + from))
  }
  return Decoration.set(out, true)
}

/** The formatted view's rendering over its chunked Markdown syntax tree. */
export function livePreview(syntax: FormattedSyntax): Extension {
  const layout = StateField.define<DecorationSet>({
    create: (state) => layoutDecorations(state, syntax.tree(state)),
    update(value, transaction) {
      const tree = syntax.tree(transaction.state)
      return tree === syntax.tree(transaction.startState)
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
        if (
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
