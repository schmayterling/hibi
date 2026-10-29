import {
  countColumn,
  EditorSelection,
  type EditorState,
  findClusterBreak,
  findColumn,
  type Line,
  type RangeSet,
  type RangeValue,
  StateEffect,
  StateField,
  type TransactionSpec,
} from '@codemirror/state'
import type { SyntaxNode, Tree } from '@lezer/common'
import {
  markdownLineStarts as escapeLineStarts,
  markdownLiteral as literal,
} from '../../shared/markdown-literal.ts'
import { uncovered } from './chunked-markdown.ts'
import { formattedFormatting } from './formatted-contributions.ts'
import { codeIndentLines, detectIndentUnit, tabIndent } from './indentation.ts'
import { sourceWhitespace } from './source-whitespace.ts'

/*
 * Structure keys for the formatted view. They edit the Markdown source the
 * way the rich editor edited its document: Enter splits blocks and continues
 * lists and quotes, Backspace at the start of a block removes its marker or
 * joins it to the previous block, and hidden syntax is never half-deleted.
 */

type Hidden = RangeSet<RangeValue>

/** A hidden range that shows a widget in place of its text, which is deleted whole. */
const shown = (value: RangeValue) =>
  (value as { spec?: { widget?: unknown } }).spec?.widget !== undefined

const blank = (text: string) => /^[ \t]*$/.test(text)

/** The innermost node of one of `names` around `pos`. */
function around(tree: Tree, pos: number, names: readonly string[]) {
  for (
    let node: SyntaxNode | null = tree.resolveInner(pos, -1);
    node;
    node = node.parent
  )
    if (names.includes(node.name)) return node
  return null
}

/** Quote markers and list indentation that continue the block on a new line. */
function continuation(state: EditorState, tree: Tree, pos: number) {
  let prefix = ''
  for (
    let node: SyntaxNode | null = tree.resolveInner(pos, -1);
    node;
    node = node.parent
  ) {
    if (node.name === 'Blockquote') prefix = `> ${prefix}`
    else if (node.name === 'ListItem') {
      const mark = node.getChild('ListMark')
      const line = state.doc.lineAt(node.from)
      if (mark) {
        const after = /^[ \t]*/.exec(state.sliceDoc(mark.to, line.to))?.[0]
        prefix = `${' '.repeat(mark.to - line.from + Math.max(1, after?.length ?? 1))}${prefix}`
        break
      }
    }
  }
  return prefix
}

/**
 * Inline formatting around `pos` to close before a break and open again
 * after it, innermost first, so a split keeps its formatting.
 */
function formatting(state: EditorState, tree: Tree, pos: number) {
  const out: { node: SyntaxNode; first: SyntaxNode; last: SyntaxNode }[] = []
  for (
    let node: SyntaxNode | null = tree.resolveInner(pos, -1);
    node && !node.type.is('Block');
    node = node.parent
  ) {
    const first = node.firstChild
    let last = node.lastChild
    if (node.name === 'Link')
      last =
        node
          .getChildren('LinkMark')
          .find((mark) => state.sliceDoc(mark.from, mark.to) === ']') ?? null
    else if (
      !['Emphasis', 'StrongEmphasis', 'Strikethrough', 'InlineCode'].includes(
        node.name,
      ) &&
      !state.facet(formattedFormatting).includes(node.name)
    )
      continue
    if (first && last && first !== last) out.push({ node, first, last })
  }
  return out
}

type Formatting = ReturnType<typeof formatting>[number]

/** The marker that closes formatting before a break. */
const closer = (state: EditorState, { node, last }: Formatting) =>
  state.sliceDoc(last.from, node.name === 'Link' ? node.to : last.to)

/** The marker that opens formatting again after a break. */
const opener = (state: EditorState, { first }: Formatting) =>
  state.sliceDoc(first.from, first.to)

/**
 * For a selection replaced by a break: formatting with text kept before the
 * selection closes before the break, and formatting with text kept after it
 * opens again after the break. Markers of formatting whose text the
 * selection takes from one side are replaced with it.
 */
export function spanned(
  state: EditorState,
  tree: Tree,
  from: number,
  to: number,
) {
  let close = '',
    open = '',
    at = from,
    end = to
  for (const found of formatting(state, tree, from)) {
    const { node, first, last } = found
    if (at < first.to || at > last.from) continue
    if (at === first.to) at = node.from
    else close += closer(state, found)
  }
  for (const found of formatting(state, tree, to)) {
    const { node, first, last } = found
    if (end < first.to || end > last.from) continue
    if (end === last.from) end = node.to
    else open = opener(state, found) + open
  }
  return { close, open, at, end }
}

export function reopened(state: EditorState, tree: Tree, pos: number) {
  let close = '',
    open = '',
    at = pos
  for (const found of formatting(state, tree, pos)) {
    const { node, first, last } = found
    if (at < first.to || at > last.from) continue
    // At either end of its text the break moves outside it, so no empty
    // formatting is left behind.
    if (at === first.to) at = node.from
    else if (at === last.from) at = node.to
    else {
      close += closer(state, found)
      open = opener(state, found) + open
    }
  }
  return { close, open, at, end: at }
}

/**
 * Numbered items after `item` count on from `marker`, past items replaced
 * up to `end`, and their lines follow markers that changed width.
 */
function renumbered(
  state: EditorState,
  item: SyntaxNode,
  marker: string,
  end: number,
) {
  const changes: { from: number; to?: number; insert?: string }[] = []
  // The marker may follow quote markers and end with a task box.
  let number = Number(/(\d+)[.)][^\d]*$/.exec(marker)?.[1])
  for (
    let next = nextItem(item);
    Number.isFinite(number) && next;
    next = nextItem(next)
  ) {
    const mark = next.getChild('ListMark')
    if (mark && mark.from < end) continue
    const current =
      mark && Number.parseInt(state.sliceDoc(mark.from, mark.to), 10)
    if (!mark || !(current! <= number)) break
    number++
    const digits = String(number)
    const old = state.sliceDoc(mark.from, mark.to).length - 1
    changes.push({ from: mark.from, to: mark.to - 1, insert: digits })
    changes.push(
      ...shiftContent(
        state,
        next,
        state.doc.lineAt(next.from).number,
        itemWidth(state, next),
        digits.length - old,
      ),
    )
  }
  return changes
}

/**
 * What a new line of an item beside `item` starts with: the indentation and
 * quote markers before its marker, or, where an outer item's marker shares
 * that line, its containers' continuation.
 */
function itemIndent(state: EditorState, item: SyntaxNode, mark: SyntaxNode) {
  const before = state.sliceDoc(state.doc.lineAt(mark.from).from, mark.from)
  if (/^[ \t>]*$/.test(before)) return before
  const prefix = prefixOf(state, item.parent)
  return prefix == null
    ? before
    : prefix + ' '.repeat(Math.max(0, before.length - prefix.length))
}

/** The markers that start a line of `item` for the quotes it is in. */
function quoteMarkers(item: SyntaxNode, text: string) {
  let quotes = 0
  for (let node = item.parent; node; node = node.parent)
    if (node.name === 'Blockquote') quotes++
  return quotes
    ? (new RegExp(`^(?:[ \\t]*>[ \\t]?){${quotes}}`).exec(text)?.[0] ?? '')
    : ''
}

/** The content column of a list item's first line, as its marker sets it. */
function itemWidth(state: EditorState, item: SyntaxNode) {
  const marker = itemMarker(state, item)
  return marker ? marker.mark.from - marker.line.from + marker.width : 0
}

/**
 * Indent or outdent the lines of an item after line `after` that belong to
 * its content, so they follow a marker that changed width.
 */
function shiftContent(
  state: EditorState,
  item: SyntaxNode,
  after: number,
  width: number,
  by: number,
) {
  const changes: { from: number; to?: number; insert?: string }[] = []
  if (!by) return changes
  const end = state.doc.lineAt(item.to).number
  for (let number = after + 1; number <= end; number++) {
    const line = state.doc.line(number)
    // Inside quotes, the indentation follows their markers.
    const from = line.from + quoteMarkers(item, line.text).length
    const text = state.sliceDoc(from, line.to)
    const leading = /^ */.exec(text)![0].length
    if (blank(text) || from - line.from + leading < width) continue
    if (by > 0) changes.push({ from, insert: ' '.repeat(by) })
    else changes.push({ from, to: from - by })
  }
  return changes
}

/** The next list marker: same bullet, next number, unchecked task. */
function nextMarker(state: EditorState, item: SyntaxNode) {
  const mark = item.getChild('ListMark')
  if (!mark) return null
  const indent = itemIndent(state, item, mark)
  const text = state.sliceDoc(mark.from, mark.to)
  const ordered = /^(\d+)([.)])$/.exec(text)
  const task = item.getChild('Task')
  return `${indent}${ordered ? `${Number(ordered[1]) + 1}${ordered[2]}` : text} ${task ? '[ ] ' : ''}`
}

/** Longest unparsed suffix read outside an indexed source session. */
const unparsedLimit = 4096

/** Enter: split paragraphs and headings, continue or leave lists and quotes, newline in code. */
export function blockBreak(
  state: EditorState,
  tree: Tree,
): TransactionSpec | null {
  if (state.readOnly) return null
  return state.changeByRange((range) => {
    const pos = range.from
    const line = state.doc.lineAt(pos)
    const insert = (text: string, from = range.from, to = range.to) => ({
      changes: { from, to, insert: text },
      range: EditorSelection.cursor(from + text.length),
    })
    if (around(tree, pos, ['FencedCode', 'CodeBlock'])) {
      // The markers of the quotes around the code, then the line's
      // indentation, continue on the new line; a `>` in the code is text.
      let quotes = 0
      for (
        let node: SyntaxNode | null = tree.resolveInner(pos, -1);
        node;
        node = node.parent
      )
        if (node.name === 'Blockquote') quotes++
      const markers =
        new RegExp(`^(?:[ \\t]*>[ \\t]?){${quotes}}`).exec(line.text)?.[0] ?? ''
      const indent = /^[ \t]*/.exec(line.text.slice(markers.length))![0]
      return insert(`\n${markers}${indent}`)
    }
    const item = around(tree, pos, ['ListItem'])
    if (item) {
      const mark = item.getChild('ListMark')
      const markerLine = mark && state.doc.lineAt(mark.from)
      const content = mark
        ? state
            .sliceDoc(mark.to, markerLine!.to)
            .replace(/^\s*(\[[ xX]\]\s*)?/, '')
        : ''
      // An empty item moves up a level, and leaves the list at the top, as
      // in the rich editor.
      if (mark && markerLine?.number === line.number && !content.trim()) {
        const parent = item.parent?.parent
        const outer =
          range.empty && parent?.name === 'ListItem'
            ? nextMarker(state, parent)
            : null
        if (outer)
          return {
            changes: [
              { from: markerLine.from, to: markerLine.to, insert: outer },
              ...renumbered(state, parent!, outer, markerLine.to),
            ],
            range: EditorSelection.cursor(markerLine.from + outer.length),
          }
        return insert('\n', markerLine.from, Math.max(markerLine.to, range.to))
      }
      const marker = nextMarker(state, item)
      const { close, open, at, end } = range.empty
        ? reopened(state, tree, pos)
        : spanned(state, tree, range.from, range.to)
      if (marker) {
        const text = `${close}\n${marker}${open}`
        const width = itemWidth(state, item)
        // The item's lines after the break follow the new marker's width;
        // replaced lines and items are gone.
        const changes = [
          { from: at, to: end, insert: text },
          ...shiftContent(
            state,
            item,
            state.doc.lineAt(end).number,
            width,
            marker.replace(/\[ \] $/, '').length - width,
          ),
        ]
        // Numbered items after it count on from the new one.
        changes.push(...renumbered(state, item, marker, end))
        return {
          changes,
          range: EditorSelection.cursor(at + text.length),
        }
      }
    }
    const quote = around(tree, pos, ['Blockquote'])
    if (quote) {
      const prefix = continuation(state, tree, pos)
      if (blank(line.text.replace(/^(\s*>)+/, '')))
        return insert('\n', line.from, line.to)
      const { close, open, at, end } = range.empty
        ? reopened(state, tree, pos)
        : spanned(state, tree, range.from, range.to)
      return insert(`${close}\n${prefix}${open}`, at, end)
    }
    // A blank line between blocks gains another empty line. After the last
    // block, blank lines show in pairs as empty paragraphs, as in the rich
    // view, so it gains a pair. The tree says whether a block ends after the
    // selection. Line counts prove newline-only suffixes; source counts
    // prove mixed whitespace without reading the tail.
    if (blank(line.text)) {
      let last = tree.topNode.lastChild
      while (last && !last.type.is('Block')) last = last.prevSibling
      const rest = state.doc.length - range.to
      const unparsed =
        tree.length < state.doc.length ||
        uncovered(tree, range.to, state.doc.length)
      const after =
        (!last || last.to <= range.to) &&
        (!unparsed ||
          rest === state.doc.lines - state.doc.lineAt(range.to).number ||
          (sourceWhitespace(state.doc, range.to) ??
            (rest <= unparsedLimit &&
              !/\S/.test(state.sliceDoc(range.to, state.doc.length)))))
      return insert(after ? '\n\n' : '\n')
    }
    const { close, open, at, end } = range.empty
      ? reopened(state, tree, pos)
      : spanned(state, tree, range.from, range.to)
    return insert(`${close}\n\n${open}`, at, end)
  })
}

/** Shift-Enter: a hard line break that stays in its list item or quote. */
export function lineBreak(
  state: EditorState,
  tree: Tree,
): TransactionSpec | null {
  if (state.readOnly) return null
  return state.changeByRange((range) => {
    const text = `  \n${continuation(state, tree, range.from)}`
    return {
      changes: { from: range.from, to: range.to, insert: text },
      range: EditorSelection.cursor(range.from + text.length),
    }
  })
}

/** Formatting the browser carries to the lines after a break, as styles. */
const styles = ['Emphasis', 'StrongEmphasis', 'Strikethrough']
const spanNames = [...styles, 'InlineCode', 'Link']
/** Delimiters a format action leaves around an empty caret, waiting for text. */
const pending = ['**', '__', '~~', '*', '_', '~', '`']

/** The leaf block holding `pos`, or null on a blank line or in an empty list item. */
function leafAt(tree: Tree, pos: number) {
  for (const side of [-1, 1] as const)
    for (
      let node: SyntaxNode | null = tree.resolveInner(pos, side);
      node;
      node = node.parent
    )
      if (node.type.is('LeafBlock') && node.from <= pos && pos <= node.to)
        return node
  return null
}

/** The list item or quote holding `pos`. */
function containerAt(tree: Tree, pos: number) {
  for (const side of [-1, 1] as const)
    for (
      let node: SyntaxNode | null = tree.resolveInner(pos, side);
      node;
      node = node.parent
    )
      if (
        (node.name === 'ListItem' || node.name === 'Blockquote') &&
        node.from <= pos &&
        pos <= node.to
      )
        return node
  return null
}

/** Longest run of spaces read around the caret; past it, input is left to the default. */
const spaceLimit = 256

/**
 * How many spaces (and tabs, with `tabs`) start the text from `from` to
 * `to`, or -1 past `limit`.
 */
function blankRun(
  state: EditorState,
  from: number,
  to: number,
  tabs = true,
  limit = spaceLimit,
) {
  const end = Math.min(to, from + limit + 1)
  const count = (tabs ? /^[ \t]*/ : /^ */).exec(state.sliceDoc(from, end))![0]
    .length
  return count > limit ? -1 : count
}

/** Where the text of a paragraph, task or ATX heading starts; null for other blocks. */
function textStart(state: EditorState, leaf: SyntaxNode) {
  if (leaf.name === 'Paragraph' || /^SetextHeading\d$/.test(leaf.name))
    return leaf.from
  if (leaf.name !== 'Task' && !/^ATXHeading\d$/.test(leaf.name)) return null
  const mark = leaf.firstChild
  if (mark?.name !== (leaf.name === 'Task' ? 'TaskMarker' : 'HeaderMark'))
    return null
  const spaces = blankRun(state, mark.to, leaf.to)
  return spaces < 0 ? null : mark.to + spaces
}

/**
 * The text of the paragraph, task, heading or code block at `pos`, which the
 * rich editor's triple-click selects: without markers, a heading's closing
 * sequence or the line break after it. Null for other blocks.
 */
export function blockText(state: EditorState, tree: Tree, pos: number) {
  for (const side of [1, -1] as const)
    for (let node: SyntaxNode | null = tree.resolveInner(pos, side); node; ) {
      if (node.name === 'FencedCode' || node.name === 'CodeBlock') {
        const text = node.getChildren('CodeText')
        const first = text[0],
          last = text.at(-1)
        if (!first || !last) return null
        let to = last.to
        while (to > first.from && /[\r\n]/.test(state.sliceDoc(to - 1, to)))
          to--
        return { from: first.from, to }
      }
      const from = textStart(state, node)
      if (from !== null) {
        const closing = node.lastChild
        let to =
          closing?.name === 'HeaderMark' && closing.from >= from
            ? node.name.startsWith('Setext')
              ? state.doc.lineAt(closing.from).from - 1
              : closing.from
            : node.to
        while (to > from && /\s/.test(state.sliceDoc(to - 1, to))) to--
        return { from, to }
      }
      node = node.parent
    }
  return null
}

/** The first or last leaf block in `node`. */
function edgeLeaf(node: SyntaxNode | null, last: boolean) {
  while (node && !node.type.is('LeafBlock')) {
    let child = last ? node.lastChild : node.firstChild
    while (child && !child.type.is('Block'))
      child = last ? child.prevSibling : child.nextSibling
    node = child
  }
  return node
}

/** The block children of `node`. */
function blocksOf(node: SyntaxNode) {
  const blocks: SyntaxNode[] = []
  for (let child = node.firstChild; child; child = child.nextSibling)
    if (child.type.is('Block')) blocks.push(child)
  return blocks
}

/** The item after `item` in its list; quote markers between them are not blocks. */
function nextItem(item: SyntaxNode) {
  let next = item.nextSibling
  while (next && !next.type.is('Block')) next = next.nextSibling
  return next?.name === 'ListItem' ? next : null
}

/** A list item's marker, its line, and the width from the marker to the item's text. */
function itemMarker(state: EditorState, item: SyntaxNode) {
  const mark = item.getChild('ListMark')
  if (!mark) return null
  const line = state.doc.lineAt(mark.from)
  // Only up to five spaces after the marker count.
  const spaces = blankRun(state, mark.to, line.to, false, 5)
  const width =
    mark.to -
    mark.from +
    (!spaces || spaces < 0 || spaces > 4 || mark.to + spaces === line.to
      ? 1
      : spaces)
  return { mark, line, width }
}

/** Quote markers and list indentation that put a line inside `node`, outermost first. */
export function prefixOf(state: EditorState, node: SyntaxNode | null) {
  const containers: SyntaxNode[] = []
  for (; node; node = node.parent)
    if (node.name === 'Blockquote' || node.name === 'ListItem')
      containers.unshift(node)
  let prefix = ''
  for (const container of containers) {
    if (container.name === 'Blockquote') prefix += '> '
    else {
      const marker = itemMarker(state, container)
      if (!marker) return null
      const column = marker.mark.from - marker.line.from + marker.width
      prefix += ' '.repeat(Math.max(marker.width, column - prefix.length))
    }
  }
  return prefix
}

/** A typed line as literal Markdown; at a block's start, its indentation stays text. */
function literalLine(text: string, verbatim: boolean, start: boolean) {
  const value = verbatim ? text : escapeLineStarts(literal(text))
  return start && /^(?: {4}| {0,3}\t)/.test(value)
    ? (value[0] === ' ' ? '&#32;' : '&#9;') + value.slice(1)
    : value
}

/** Whether the text from `from` to `to` is only spaces and line breaks, read in growing slices. */
function blankText(state: EditorState, from: number, to: number) {
  for (let size = 64; from < to; from += size, size *= 2)
    if (/\S/.test(state.sliceDoc(from, Math.min(to, from + size)))) return false
  return true
}

/** How many spaces and tabs end the text from `from` to `to`, or -1 past the limit. */
function blankBefore(state: EditorState, to: number, from: number) {
  const start = Math.max(from, to - spaceLimit - 1)
  const count = /[ \t]*$/.exec(state.sliceDoc(start, to))![0].length
  return count > spaceLimit ? -1 : count
}

/** Literal text split into its leading spaces, the rest, and its trailing spaces. */
function spaced(text: string): [string, string, string] {
  const lead = /^(?:&#(?:32|9);)?[ \t]*/.exec(text)![0].length
  const trail = lead === text.length ? 0 : /[ \t]*$/.exec(text)![0].length
  return [
    text.slice(0, lead),
    text.slice(lead, text.length - trail),
    text.slice(text.length - trail),
  ]
}

/** The number in an ordered list marker. */
const ordinal = (state: EditorState, mark: SyntaxNode | null) =>
  mark && /^(\d+)([.)])$/.exec(state.sliceDoc(mark.from, mark.to))

/**
 * Text input with line breaks, such as dictation or a text service, as the
 * browser typed it into the rich editor, in one source change. The selection
 * goes first: the text after it joins the block it starts in, and the list
 * item it ends in keeps its other blocks. The text is literal. Each break
 * starts a block like the one it is in: a paragraph, a heading (a paragraph
 * after a heading's end) or a new item after the list item; a break in an
 * empty item moves it up a level or out of the list. Formatting goes on to
 * later lines where the text after the caret has it, and styles (bold, italic,
 * strikethrough) always do; a link takes no text at its edge. Null leaves
 * code, tables and other input as it is.
 */
export function lineInput(
  state: EditorState,
  tree: Tree,
  from: number,
  to: number,
  text: string,
): TransactionSpec | null {
  const { main } = state.selection
  const lines = text.split(/\r\n?|\n/)
  if (
    state.readOnly ||
    state.selection.ranges.length > 1 ||
    main.from !== from ||
    main.to !== to ||
    lines.length < 2
  )
    return null
  const { doc } = state
  const last = lines.length - 1
  // Line breaks alone that the browser turns into exactly one new block are
  // read back as a single line break, as the rich editor reads them.
  const breaks = /^[\r\n]+$/.test(text)
  const single = () => lineInput(state, tree, main.from, main.to, '\n')
  // Select-all keeps the first block's kind and replaces everything from its
  // text on, whatever the parser has reached; the note's first line keeps the
  // first block's markers. Elsewhere, unparsed text is left to the default.
  const all = from === 0 && to === doc.length && to > 0
  let lineStart = 0
  if (all) {
    const first = edgeLeaf(tree.topNode, false)
    if (!first) return null
    lineStart = doc.lineAt(first.from).from
    if (
      !blankText(state, 0, lineStart) ||
      !/^(?:[ \t>]|(?:[-+*]|\d{1,9}[.)])(?=[ \t]))*$/.test(
        state.sliceDoc(lineStart, first.from),
      )
    )
      return null
    // A first code block takes literal text; a typed fence must not close it.
    const fence =
      first.name === 'FencedCode' &&
      /^ {0,3}(`{3,}|~{3,})/.exec(doc.lineAt(first.from).text)
    if (fence) {
      let marker = fence[1]!
      for (const line of lines) {
        const run = /^ {0,3}(`+|~+)/.exec(line)?.[1]
        if (run && run[0] === marker[0] && run.length >= marker.length)
          marker = marker[0]!.repeat(run.length + 1)
      }
      const open = doc.lineAt(first.from).text.replace(fence[1]!, marker)
      const code = `${open}\n${lines.join('\n')}`
      return {
        changes: { from: 0, to: doc.length, insert: `${code}\n${marker}` },
        selection: EditorSelection.cursor(code.length),
        userEvent: 'input.type',
      }
    }
    const start = textStart(state, first)
    if (start == null) return null
    from = start
    // The typed text takes the formatting the note's text starts with.
    for (let moved = true; moved; ) {
      moved = false
      for (
        let node: SyntaxNode | null = tree.resolveInner(from, 1);
        node && !node.type.is('Block');
        node = node.parent
      )
        if (
          node.from === from &&
          node.name !== 'Link' &&
          spanNames.includes(node.name) &&
          node.firstChild?.from === from
        ) {
          from = node.firstChild.to
          moved = true
          break
        }
    }
  } else if (uncovered(tree, from, to)) return null
  // A format waiting at the caret (Bold with nothing selected writes `****`)
  // is not one the browser types with.
  let waiting = false
  const inner = tree.resolveInner(from, 0).name
  if (from === to && /^(?:Paragraph|HorizontalRule|ATXHeading\d)$/.test(inner))
    for (let found = true; found; ) {
      found = false
      for (const mark of pending)
        if (
          state.sliceDoc(from - mark.length, from) === mark &&
          state.sliceDoc(to, to + mark.length) === mark
        ) {
          from -= mark.length
          to += mark.length
          found = waiting = true
          break
        }
    }
  // A range touching only a format's markers leaves its text and markers
  // together. A caret still types inside the format at its content edge.
  let beforeStyle = false,
    afterStyle = false
  if (from < to && !all && !waiting) {
    for (const { node, last } of formatting(state, tree, from))
      if (spanNames.includes(node.name) && from === last.from) {
        from = node.to
        beforeStyle ||= styles.includes(node.name)
      }
    for (const { node, first } of formatting(state, tree, to))
      if (spanNames.includes(node.name) && to === first.to) {
        to = node.from
        afterStyle ||= styles.includes(node.name)
      }
    // A range of only whole or partial markers has no native text selection.
    if (from >= to) return null
  }
  let start = leafAt(tree, from)
  if (start?.name === 'HorizontalRule' && waiting && start.from >= from)
    start = null
  const startText = start && textStart(state, start)
  if (start && (startText == null || from < startText)) return null
  let end = start
  if (to > from && !waiting && !all) {
    end = leafAt(tree, to)
    const endText = end && textStart(state, end)
    if (!start || !end || endText == null || to < endText) return null
  }
  const across = !!start && !!end && start.from !== end.from
  // A tail of several lines keeps its line prefixes, so the blocks must
  // share their container.
  if (
    across &&
    doc.lineAt(to).number !== doc.lineAt(end!.to).number &&
    start!.parent?.from !== end!.parent?.from
  )
    return null

  // Formatting around the selection, innermost first: around all of it
  // (`spans`), cut by its start (`ended`: the text before the selection keeps
  // it, up to the caret) or cut by its end (`started`: the text after keeps
  // it). A selection end inside formatting markers is not modelled.
  let spans: Formatting[] = []
  const ended: Formatting[] = []
  const started: Formatting[] = []
  const seen = new Set<string>()
  for (const found of [
    ...formatting(state, tree, from),
    ...formatting(state, tree, to),
  ]) {
    const { node, first, last: close } = found
    const key = `${node.name}:${node.from}`
    if (seen.has(key)) continue
    seen.add(key)
    if (node.to <= from || node.from >= to) continue
    if (from <= node.from && node.to <= to) continue
    if (!spanNames.includes(node.name)) return null
    if (node.from < from && to < node.to) {
      if (from < first.to || to > close.from) return null
      spans.push(found)
    } else if (node.from < from) {
      if (from < first.to || from > close.from || node.name === 'Link')
        return null
      ended.push(found)
    } else {
      if (to < first.to || to > close.from) return null
      started.push(found)
    }
  }
  // Inline syntax that is not formatting, such as an escape, takes no text.
  for (const pos of [from, to])
    for (
      let node: SyntaxNode | null = tree.resolveInner(pos, 0);
      node && !node.type.is('Block');
      node = node.parent
    )
      if (!spanNames.includes(node.name)) return null
  let at = from
  // Formatting that loses all its text after the caret loses its closing marker.
  const gone = started.filter(({ last: close }) => to === close.from),
    opened = started.filter((span) => !gone.includes(span))
  // A link takes text only inside it: at its edge, the text goes beside it.
  for (let index = 0; index < spans.length; index++) {
    const { node, first, last: close } = spans[index]!
    if (node.name !== 'Link' || (at > first.to && at < close.from)) continue
    if (from !== to || first.to === close.from) return null
    at = to = at === first.to ? node.from : node.to
    spans = spans.slice(index + 1)
    index = -1
  }
  const inside = spans.filter(({ last: close }) => to < close.from),
    edge = spans.filter(({ last: close }) => to === close.from)
  if (gone.length && edge.length) return null
  const skip =
    edge.at(-1)?.node.to ?? Math.max(to, ...gone.map(({ node }) => node.to))
  const replaceEnd = all ? doc.length : end ? end.to : to
  // The text after the caret stays in place: only whether there is any is read.
  const after = skip < replaceEnd
  // As the browser types, later lines take the formatting of the text after
  // the caret (but no link) once the first line has text, and otherwise the
  // formatting around the caret and the styles it ends: bold, italic and
  // strikethrough.
  const following = after ? [...opened, ...inside] : []
  const kept =
    after && lines[0]
      ? following.filter(({ node }) => node.name !== 'Link')
      : [...ended, ...edge, ...inside].filter(
          (span) =>
            styles.includes(span.node.name) ||
            (inside.includes(span) && span.node.name !== 'Link'),
        )
  // The last line closes kept formatting the text after does not have, and
  // opens what that text has but the line does not, which must nest inside
  // the kept formatting.
  const closed = kept.filter((span) => !following.includes(span)),
    dropped = following.filter((span) => !kept.includes(span))
  if (
    dropped.some(({ node }) =>
      kept.some(
        (span) =>
          following.includes(span) &&
          (node.from < span.node.from || node.to > span.node.to),
      ),
    )
  )
    return null
  const code = (list: Formatting[]) =>
    list.some(({ node }) => node.name === 'InlineCode')
  const verbatim = code(kept),
    verbatimFirst = code([...spans, ...ended])
  // Re-fence only code spans receiving backticks. Each resulting line must
  // include its retained text when choosing delimiters and padding.
  const codeMarkers = new Map<Formatting, { open: string; close: string }[]>()
  const codeEdges: { from: number; to: number; insert: string }[] = []
  for (const span of [...ended, ...spans, ...started]) {
    if (span.node.name !== 'InlineCode') continue
    const first = [...ended, ...spans].includes(span)
    const later = kept.includes(span) || following.includes(span)
    if (
      !(first && lines[0]!.includes('`')) &&
      !(later && lines.slice(1).some((line) => line.includes('`')))
    )
      continue
    const raw = all ? '' : state.sliceDoc(span.first.to, span.last.from)
    const normalized = raw.replace(/\n/g, ' ')
    const padded =
      normalized.startsWith(' ') &&
      normalized.endsWith(' ') &&
      /[^ ]/.test(normalized)
    const start = span.first.to + Number(padded)
    const end = span.last.from - Number(padded)
    const before = first ? raw.slice(Number(padded), from - span.first.to) : ''
    const after = following.includes(span)
      ? raw.slice(to - span.first.to, raw.length - Number(padded))
      : ''
    const markers = lines.map((line, index) => {
      const content =
        `${index === 0 ? before : ''}${line}${index === last ? after : ''}`.replace(
          /\n/g,
          ' ',
        )
      const widths = new Set(
        Array.from(content.matchAll(/`+/g), (run) => run[0].length),
      )
      let width = 1
      while (widths.has(width)) width++
      const fence = '`'.repeat(width)
      const pad =
        content.startsWith('`') ||
        content.endsWith('`') ||
        (content.startsWith(' ') &&
          content.endsWith(' ') &&
          /[^ ]/.test(content))
          ? ' '
          : ''
      return { open: fence + pad, close: pad + fence }
    })
    codeMarkers.set(span, markers)
    if (first)
      codeEdges.push({
        from: span.first.from,
        to: start,
        insert: markers[0]!.open,
      })
    if (following.includes(span))
      codeEdges.push({
        from: end,
        to: span.last.to,
        insert: markers[last]!.close,
      })
  }
  const open = (list: Formatting[], index = 0) =>
    list
      .map(
        (span) => codeMarkers.get(span)?.[index]?.open ?? opener(state, span),
      )
      .reverse()
      .join('')
  const close = (list: Formatting[], index = 0) =>
    list
      .map(
        (span) => codeMarkers.get(span)?.[index]?.close ?? closer(state, span),
      )
      .join('')
  const heading = start && /^(?:ATX|Setext)Heading(\d)$/.exec(start.name)
  const setext = !!heading && start!.name.startsWith('Setext')
  if (across && end!.name.startsWith('Setext')) return null
  // At a heading's end, later lines are paragraphs after its closing sequence.
  let headingEnd = false
  if (heading) {
    const block = end ?? start!
    const closing = block.lastChild
    const textEnd =
      closing?.name === 'HeaderMark' && closing.from > textStart(state, block)!
        ? block.name.startsWith('Setext')
          ? doc.lineAt(closing.from).from - 1
          : closing.from
        : block.to
    headingEnd =
      skip >= textEnd || blankRun(state, skip, textEnd) === textEnd - skip
  }
  const recodedFirst = [...ended, ...spans].some((span) =>
    codeMarkers.has(span),
  )
  let firstText = literalLine(lines[0]!, verbatimFirst, at === startText)
  // References keep retained style delimiters valid beside literal letters.
  if (beforeStyle && !verbatimFirst)
    firstText = firstText.replace(
      /^[^\s\p{P}\p{S}]/u,
      (char) => `&#${char.codePointAt(0)};`,
    )
  const [lead, core, trail] = recodedFirst
    ? ['', firstText, '']
    : spaced(firstText)
  // Formatting whose text starts at the caret takes the first line after the
  // spaces it starts with; with no text typed into it, its opening marker
  // goes, so no empty markers remain.
  const around = [...ended, ...edge, ...inside]
  const starting = around.filter(({ first }) => at === first.to)
  const ending = core
    ? around
    : around.filter((span) => !starting.includes(span))
  const openFrom = Math.min(at, ...starting.map(({ node }) => node.from))
  let openers = ''
  if (starting.length && (!core || lead)) {
    openers = core ? state.sliceDoc(openFrom, at) : ''
    at = openFrom
  }
  // The first line closes formatting the caret ends. Spaces in typed text
  // stay outside the markers; existing trailing spaces keep their marks.
  const closing = close(ending)
  let closeAt = -1,
    escapedSpace = ''
  if (closing && !core && !recodedFirst) {
    const innermost = ending[0]!
    if (code(ending)) {
      const spaces = blankBefore(state, at, innermost.first.to)
      if (spaces < 0) return null
      if (spaces && spaces < at - innermost.first.to) closeAt = at - spaces
    } else {
      // Keep trailing whitespace in its marks. Escaping its last character
      // lets Markdown close them without reading or moving the space run.
      const previous = state.sliceDoc(Math.max(innermost.first.to, at - 1), at)
      if (previous === ' ' || previous === '\t') {
        at--
        escapedSpace = previous === ' ' ? '&#32;' : '&#9;'
      }
    }
  }
  // A setext heading's underline stays with its last part, so the first
  // part, or all of it when the underline goes, is written as ATX.
  const atx =
    setext && (!headingEnd || all || across)
      ? `${'#'.repeat(Number(heading![1]))} `
      : ''
  const first =
    (atx && at === start!.from ? atx : '') +
    escapedSpace +
    (core
      ? lead + openers + core + closing + trail
      : (closeAt < 0 ? closing : '') + lead + trail)
  /** Line `index` (from 1) with the caret's offset in it; the last line ends with `rest`. */
  const line = (index: number, rest = '') => {
    let value = literalLine(lines[index]!, verbatim, true)
    if (index === last && afterStyle && !verbatim)
      value = value.replace(
        /[^\s\p{P}\p{S}]$/u,
        (char) => `&#${char.codePointAt(0)};`,
      )
    const [lead, core, trail] = kept.some((span) => codeMarkers.has(span))
      ? ['', value, '']
      : spaced(value)
    if (index === last && after) {
      const typed = lead + open(kept, index) + core
      const text = core
        ? typed + close(closed, index) + trail
        : lead +
          open(
            kept.filter((span) => following.includes(span)),
            index,
          )
      return {
        text: text + open(dropped, index) + rest,
        caret: core && !trail ? typed.length : text.length,
      }
    }
    if (!core) return { text: value, caret: value.length }
    // With nothing typed after them, the caret stays inside the styles.
    const typed = lead + open(kept, index) + core
    const text = typed + close(kept, index) + trail
    return { text, caret: trail ? text.length : typed.length }
  }
  const changes: { from: number; to?: number; insert?: string }[] =
    closeAt < 0 ? [] : [{ from: closeAt, insert: closing }]
  if (atx && at !== start!.from)
    changes.push({ from: start!.from, insert: atx })

  // A list item the selection ends in keeps its other blocks as an item.
  if (across)
    for (let node = end!.parent; node; node = node.parent) {
      if (node.name !== 'ListItem' || node.from <= from || node.to <= end!.to)
        continue
      const marker = itemMarker(state, node)
      const next = blocksOf(node).find((block) => block.from >= end!.to)
      if (!marker || !next || changes.length) return null
      const target =
        doc.lineAt(next.from).from + marker.mark.from - marker.line.from
      if (state.sliceDoc(target, target + marker.width).trim()) return null
      changes.push({
        from: target,
        to: target + marker.width,
        insert: state
          .sliceDoc(marker.mark.from, marker.mark.from + marker.width)
          .padEnd(marker.width),
      })
    }

  let insert: string,
    replaceFrom = at,
    replaceTo = replaceEnd,
    offset: number
  let container = start ? start.parent : containerAt(tree, at)
  // In a quote that is part of a list item, a break starts a new item of
  // that list, outside the quote.
  if (
    container?.name === 'Blockquote' &&
    container.parent?.name === 'ListItem'
  ) {
    // The text after the caret goes with the new item, so it must end on
    // the caret's line.
    if (after && doc.lineAt(skip).number !== doc.lineAt(replaceEnd).number)
      return null
    container = container.parent
  }
  if (container?.name !== 'ListItem') {
    // Paragraphs and headings, quoted or not.
    if (start && !heading && start.name !== 'Paragraph') return null
    if (breaks && last === 1 && text !== '\n') return single()
    const prefix = prefixOf(state, container)
    if (prefix == null) return null
    const blank = prefix.trimEnd(),
      lead = heading && !headingEnd ? `${'#'.repeat(Number(heading[1]))} ` : ''
    let added = ''
    offset = 0
    for (let index = 1; index <= last; index++) {
      const { text, caret } = line(index)
      // The last line holds the text after the caret, which stays in place.
      added += `\n${blank}\n${text || (index === last && after) ? prefix + (setext && index === last ? '' : lead) : blank}`
      offset = added.length + caret
      added += text
    }
    if (headingEnd && after) {
      // The heading keeps its closing sequence; the paragraphs follow it.
      changes.push({ from: at, to: skip, insert: first })
      replaceFrom = replaceTo = replaceEnd
      insert = added
    } else {
      replaceTo = skip
      insert = first + added
      offset += first.length
    }
    // On a blank line beside a block, the text is a paragraph of its own.
    if (!start && !container) {
      const { number } = doc.lineAt(at)
      const shows = (line: Line) =>
        blankRun(state, line.from, line.to) !== line.length
      if (number > 1 && shows(doc.line(number - 1))) {
        insert = `\n${insert}`
        offset++
      }
      if (number < doc.lines && shows(doc.line(number + 1))) insert += '\n'
    }
  } else {
    const item = container
    const marker = itemMarker(state, item)
    const blocks = blocksOf(item)
    if (
      !marker ||
      (start && start.name !== 'Paragraph' && start.name !== 'Task') ||
      (!start &&
        (marker.line.number !== doc.lineAt(at).number ||
          at < Math.min(marker.line.to, marker.mark.from + marker.width) ||
          blocks.length))
    )
      return null
    // The item, and the items its list is nested in.
    const levels = [item]
    for (
      let up = item.parent?.parent;
      up?.name === 'ListItem';
      up = up.parent?.parent
    )
      levels.push(up)
    // Across blocks, the selection ends after this item: in a later item of
    // its list, whose next items follow, or after the list.
    let restAfter: SyntaxNode | null = all ? null : item
    if (across) {
      restAfter = null
      for (let node = end!.parent; node; node = node.parent)
        if (node.name === 'ListItem' && node.parent?.from === item.parent?.from)
          restAfter = node
      // Or it ends in a block nested in this item, when nothing follows it there.
      const nested = restAfter?.from === item.from
      if (
        levels.length > 1 ||
        (nested ? item.to > end!.to : end!.from < item.to) ||
        (!restAfter && end!.from < item.parent!.to)
      )
        return null
    }
    const others = blocks.filter(
      (block) =>
        block.from !== start?.from && (!(across || all) || block.to <= from),
    )
    const headEmpty = startText == null || startText === at
    if (headEmpty && !lines[0] && after) {
      // At an item's start, the new items come before its text.
      if (
        spans.length ||
        ended.length ||
        started.length ||
        across ||
        (start && blocks[0]!.from !== start.from)
      )
        return null
      const markers = markersOf(state, levels)
      insert = first
      offset = 0
      for (let index = 1; index <= last; index++) {
        const { text, caret } = line(index)
        insert += `\n${markers[0]!.next()}`
        offset = insert.length + caret
        insert += text
      }
      replaceTo = at
      changes.push(...markers[0]!.renumber(item, at))
    } else {
      // Where each break leaves the text after it: in a new item at a level,
      // or a paragraph after the list. A break in an empty item takes the
      // item up a level, or out of the list.
      type Block = { level: number; paragraph: boolean; index: number }
      const original: Block = { level: 0, paragraph: false, index: 0 }
      const made: Block[] = []
      let current = original
      for (let index = 1; index <= last; index++) {
        const empty =
          !after &&
          (index === 1
            ? headEmpty && !lines[0] && !others.length
            : !lines[index - 1])
        const level = levels[current.level]!
        // The browser never takes the original task item, with its
        // checkbox, out of the list; items it adds leave when empty.
        if (
          current.paragraph ||
          !empty ||
          (current === original && level.getChild('Task'))
        ) {
          current = { ...current, index }
          made.push(current)
          continue
        }
        if (current.level + 1 < levels.length) {
          // Up a level: the item must end its list, and the list its parent item.
          const parent = levels[current.level + 1]!
          if (
            nextItem(level) ||
            blocksOf(parent).at(-1)?.from !== level.parent!.from
          )
            return null
          current.level++
        } else current.paragraph = true
        current.index = index
      }
      if (breaks && made.length === 1 && text !== '\n') return single()
      const moved = original.index > 0
      if (moved && first) return null
      const top = levels.at(-1)!.parent!
      const outside = prefixOf(state, top.parent)
      if (outside == null) return null
      const blank = outside.trimEnd()
      const markers = markersOf(state, levels)
      let out = '',
        caretAt = 0
      for (const block of moved ? [original, ...made] : made) {
        const { text, caret } = line(block.index)
        out += block.paragraph
          ? `\n${blank}\n${text ? outside : blank}`
          : `\n${markers[block.level]!.next()}`
        if (block.index === last) caretAt = out.length + caret
        out += text
      }
      const final = made.at(-1) ?? original
      const insertAt = across || all ? replaceEnd : Math.max(item.to, at)
      if (final.paragraph) {
        const outer = all
          ? null
          : levels.length > 1
            ? levels.at(-1)!
            : restAfter
        const rest = outer && nextItem(outer)
        if (rest) {
          out += `\n${blank}`
          changes.push(...restartList(state, top, rest))
        }
      } else if (!all && (restAfter || final.level))
        changes.push(
          ...markers[final.level]!.renumber(
            final.level ? levels[final.level]! : restAfter!,
            insertAt,
          ),
        )
      if (moved) {
        // The empty item itself becomes the first block.
        replaceFrom = marker.line.from
        replaceTo = insertAt
        if (replaceFrom > lineStart) replaceFrom--
        else {
          const separator = /^\n(?:[^\n]*\n)?/.exec(out)![0]
          out = out.slice(original.paragraph ? separator.length : 1)
          caretAt -= original.paragraph ? separator.length : 1
        }
        insert = out
        offset = caretAt
      } else if (!across && !all && start && start.to < insertAt) {
        // The item's other blocks stay in it, before the new items, which
        // take the text after the caret.
        changes.push({ from: at, to: start.to, insert: first })
        replaceFrom = replaceTo = insertAt
        insert = out + state.sliceDoc(skip, start.to)
        offset = caretAt
      } else {
        replaceTo = skip
        insert = first + out
        offset = first.length + caretAt
      }
    }
  }
  if (all) {
    // One change of the whole note, its leading blank lines included.
    if (changes.length || replaceFrom < lineStart) return null
    let kept = doc.sliceString(
      lineStart,
      Math.max(replaceFrom, ...codeEdges.map((edge) => edge.to)),
    )
    for (const edge of codeEdges.toReversed())
      kept =
        kept.slice(0, edge.from - lineStart) +
        edge.insert +
        kept.slice(edge.to - lineStart)
    insert = kept + insert
    offset += kept.length
    replaceFrom = 0
    replaceTo = doc.length
  }
  changes.push({ from: replaceFrom, to: replaceTo, insert })
  changes.push(
    ...codeEdges.filter(
      (edge) => edge.to <= replaceFrom || edge.from >= replaceTo,
    ),
  )
  const set = state.changes(changes)
  return {
    changes: set,
    selection: EditorSelection.cursor(set.mapPos(replaceFrom, -1) + offset),
    userEvent: 'input.type',
  }
}

/** New markers for the list at each level, counting on from its item, and renumbering after. */
function markersOf(state: EditorState, levels: readonly SyntaxNode[]) {
  return levels.map((item) => {
    const mark = item.getChild('ListMark')!
    const text = state.sliceDoc(mark.from, mark.to)
    const number = ordinal(state, mark)
    const indent = itemIndent(state, item, mark)
    const task = item.getChild('Task') ? '[ ] ' : ''
    let count = 0
    const value = () =>
      number ? `${Number(number[1]) + count}${number[2]}` : text
    return {
      next: () => {
        count++
        return `${indent}${value()} ${task}`
      },
      /** Numbered items after `after` count on from the last new marker. */
      renumber: (after: SyntaxNode, end: number) =>
        count ? renumbered(state, after, value(), end) : [],
    }
  })
}

/** The items from `rest` on, as a list of their own numbered from `list`'s start. */
function restartList(state: EditorState, list: SyntaxNode, rest: SyntaxNode) {
  const changes: { from: number; to?: number; insert?: string }[] = []
  const start = ordinal(
    state,
    list.getChild('ListItem')?.getChild('ListMark') ?? null,
  )
  if (!start) return changes
  let number = Number(start[1])
  for (
    let item: SyntaxNode | null = rest;
    item;
    item = nextItem(item), number++
  ) {
    const mark = item.getChild('ListMark')
    if (!mark) break
    const digits = String(number),
      old = state.sliceDoc(mark.from, mark.to - 1)
    if (digits === old) continue
    changes.push(
      { from: mark.from, to: mark.to - 1, insert: digits },
      ...shiftContent(
        state,
        item,
        state.doc.lineAt(item.from).number,
        itemWidth(state, item),
        digits.length - old.length,
      ),
    )
  }
  return changes
}

/** Whether a line opens or closes a fenced code block, or underlines a heading. */
function delimiterLine(state: EditorState, tree: Tree, line: Line) {
  const heading = around(tree, line.to, ['SetextHeading1', 'SetextHeading2'])
  if (heading)
    return (
      state.doc.lineAt(heading.to).number === line.number &&
      state.doc.lineAt(heading.from).number < line.number
    )
  const code = around(tree, line.to, ['FencedCode'])
  if (!code) return false
  const first = state.doc.lineAt(code.from)
  if (first.number === line.number) return true
  const closing = code.lastChild
  return (
    closing?.name === 'CodeMark' &&
    state.doc.lineAt(closing.from).number === line.number
  )
}

type CodeIndent = {
  from: number
  to: number
  prefix: string
  scan: number
  /** The first indented line, or the last sampled line when none is (unit null). */
  first: { from: number; to: number; unit: string | null } | null
}
const rememberCodeIndent = StateEffect.define<CodeIndent>()

/** One active code block's first indent, independent of its parsed fragments. */
export const codeIndent = StateField.define<CodeIndent | null>({
  create: () => null,
  update(found, { changes, docChanged, effects, newDoc }) {
    for (const effect of effects)
      if (effect.is(rememberCodeIndent)) found = effect.value
    if (!found || !docChanged) return found
    if (changes.touchesRange(found.from)) return null
    // Keep the checked prefix; only changed lines can introduce an earlier indent.
    // A scan past the last line stays past it.
    let scan =
      found.scan > changes.length
        ? newDoc.length + 1
        : changes.mapPos(found.scan)
    changes.iterChangedRanges((from, to, next) => {
      if (from <= found.scan && to >= found.from)
        scan = Math.min(scan, newDoc.lineAt(next).from)
    })
    return {
      ...found,
      from: changes.mapPos(found.from),
      to: changes.mapPos(found.to),
      scan,
      first:
        found.first && !changes.touchesRange(found.from, found.first.to)
          ? {
              ...found.first,
              from: changes.mapPos(found.first.from),
              to: changes.mapPos(found.first.to),
            }
          : null,
    }
  },
})

/**
 * A quote (null), or a list item or footnote definition whose content starts
 * `width` columns after `from`, where its parent's content starts.
 */
type Container = { from: number; width: number; bullet: boolean } | null

const spaces = /[ \t]*/y

/** The containers around code, outermost first. */
function codeContainers(state: EditorState, code: SyntaxNode) {
  const containers: Container[] = []
  for (let parent = code.parent; parent; parent = parent.parent)
    if (parent.name === 'Blockquote') containers.unshift(null)
    else if (parent.name === 'FootnoteDefinition')
      containers.unshift({ from: parent.from, width: 4, bullet: false })
    else if (parent.name === 'ListItem') {
      const mark = parent.getChild('ListMark')
      if (!mark) continue
      // Content starts after the marker's spaces, or one column after a
      // marker followed by five or more columns or nothing.
      const { text, from } = state.doc.lineAt(parent.from)
      spaces.lastIndex = mark.to - from
      spaces.test(text)
      const item = text.slice(parent.from - from, spaces.lastIndex)
      const marked = countColumn(item, 4, mark.to - parent.from)
      const spaced = countColumn(item, 4)
      containers.unshift({
        from: parent.from,
        width:
          spaced >= marked + 5 || spaces.lastIndex === text.length
            ? marked + 1
            : spaced,
        bullet: mark.to - mark.from === 1,
      })
    }
  return containers
}

const leading = /[ \t>]*/y
/** A line's whitespace and quote markers from `from`, and the character after them. */
function lineHead(text: string, from = 0) {
  leading.lastIndex = from
  leading.test(text)
  return text.slice(from, leading.lastIndex + 1)
}

/**
 * A code line's head without its containers' prefixes, as the rich editor's
 * markdown parser strips them: a quote's marker; a bullet item's columns,
 * after reading its leading tabs as spaces; other items' and footnotes'
 * columns.
 */
function contained(head: string, containers: readonly Container[]) {
  let column = 0
  for (const container of containers)
    if (!container) {
      const prefix = /^ {0,3}>[ \t]?/.exec(head)?.[0]
      if (!prefix) continue
      column += prefix.length
      // A quote consumes one column of its optional tab, leaving the rest.
      const rest = prefix.endsWith('\t') ? 3 - ((column - 1) % 4) : 0
      head = ' '.repeat(rest) + head.slice(prefix.length)
    } else {
      if (container.bullet) {
        spaces.lastIndex = 0
        spaces.test(head)
        const columns = countColumn(head, 4, spaces.lastIndex) - container.width
        head = ' '.repeat(Math.max(0, columns)) + head.slice(spaces.lastIndex)
      } else head = head.slice(findColumn(head, container.width, 4))
      column += container.width
    }
  return head
}

/**
 * Code indents like its first indented source line among its first
 * `codeIndentLines` lines, even outside the parsed chunk.
 */
function codeIndentUnit(state: EditorState, code: SyntaxNode) {
  const opening = state.doc.lineAt(code.from)
  const containers = codeContainers(state, code)
  const prefix = `${code.name}:${containers.map((container) => (container ? `${container.bullet ? '-' : ''}${container.width}` : '>')).join(' ')}`
  const fenced = code.name === 'FencedCode'
  let found = state.field(codeIndent, false)
  if (
    found?.from !== opening.from ||
    found.to !== code.to ||
    found.prefix !== prefix
  )
    found = {
      from: opening.from,
      to: code.to,
      prefix,
      scan: fenced ? opening.to + 1 : opening.from,
      first: null,
    }
  if (!found.first) {
    const closing = code.lastChild
    const end =
      fenced && closing?.name === 'CodeMark' && closing.from > opening.to
        ? state.doc.lineAt(closing.from).from
        : code.to + 1
    const last = opening.number + (fenced ? 1 : 0) + codeIndentLines - 1
    found = { ...found }
    for (
      let pos = Math.max(found.scan, fenced ? opening.to + 1 : opening.from);
      pos < end;
    ) {
      const line = state.doc.lineAt(pos)
      let text: string
      // Indented code on its item's marker line starts where the parser puts it.
      if (
        !fenced &&
        line.number === opening.number &&
        containers.some((container) => container && container.from >= line.from)
      )
        text = lineHead(line.text, code.from - line.from)
      else {
        text = contained(lineHead(line.text), containers)
        if (!fenced) text = text.replace(/^(?: {0,3}\t| {1,4})/, '')
      }
      // Indented-code parsing discards blank whitespace; fenced code preserves it.
      const unit = !fenced && blank(text) ? undefined : detectIndentUnit(text)
      pos = found.scan = line.to + 1
      // Lines after the sampled ones are not read until an edit among those.
      if (unit || line.number >= last) {
        found.first = { from: line.from, to: line.to, unit: unit ?? null }
        break
      }
    }
  }
  return {
    unit: found.first?.unit ?? tabIndent.snapshot().unit,
    effects: rememberCodeIndent.of(found),
  }
}

/** Where a line's visible content starts: after hidden prefixes such as markers. */
function contentStart(line: Line, hidden: Hidden) {
  let start = line.from
  for (let moved = true; moved; ) {
    moved = false
    hidden.between(start, start, (from, to) => {
      if (from <= start && to > start && to <= line.to) {
        start = to
        moved = true
      }
    })
  }
  return start
}

/** Backspace in formatted text. Null leaves the key to the default command. */
export function deleteBackward(
  state: EditorState,
  tree: Tree,
  hidden: Hidden,
): TransactionSpec | null {
  const range = state.selection.main
  if (state.readOnly || !range.empty || state.selection.ranges.length > 1)
    return null
  const pos = range.head
  const line = state.doc.lineAt(pos)
  const start = contentStart(line, hidden)
  const remove = (from: number, to: number, cursor = from) => ({
    changes: { from, to },
    selection: EditorSelection.cursor(cursor),
    userEvent: 'delete.backward',
  })
  if (blank(line.text) && pos === line.from) {
    if (line.number === 1) return null
    const previous = state.doc.line(line.number - 1)
    // A single blank line separates blocks; the caret moves instead of joining them.
    if (!blank(previous.text))
      return { selection: EditorSelection.cursor(previous.to) }
    return remove(previous.to, line.from, previous.to)
  }
  if (pos === start) {
    const heading = around(tree, pos, [
      'ATXHeading1',
      'ATXHeading2',
      'ATXHeading3',
      'ATXHeading4',
      'ATXHeading5',
      'ATXHeading6',
    ])
    const item = around(tree, pos, ['ListItem'])
    const quote = around(tree, pos, ['Blockquote'])
    // The first Backspace turns the block into plain text, as in the rich editor.
    if (start > line.from && (heading || item || quote)) {
      const mark = item?.getChild('ListMark')
      if (item && mark && state.doc.lineAt(mark.from).number === line.number) {
        // A nested item moves up a level, as in the rich editor.
        if (item.parent?.parent?.name === 'ListItem')
          return indent(state, tree, true, hidden)
        // A top-level item becomes a paragraph of its own, not lazy text of
        // the block above or the start of one with the items after it.
        const before =
          line.number > 1 && !blank(state.doc.line(line.number - 1).text)
        const next = item.nextSibling
        const changes = [
          { from: line.from, to: start, insert: before ? '\n' : '' },
          ...(next?.name === 'ListItem'
            ? [{ from: state.doc.lineAt(next.from).from, insert: '\n' }]
            : []),
        ]
        return {
          changes,
          selection: EditorSelection.cursor(line.from + (before ? 1 : 0)),
          userEvent: 'delete.backward',
        }
      }
      if (heading && state.doc.lineAt(heading.from).number === line.number)
        return remove(line.from, start)
      if (quote) {
        const marker = /^\s*>[ \t]?/.exec(line.text)
        if (marker)
          return remove(line.from, line.from + marker[0].length, line.from)
      }
    }
    if (line.number === 1) return null
    // At the start of a paragraph, join it to the previous text block.
    let previous = state.doc.line(line.number - 1)
    while (blank(previous.text) && previous.number > 1)
      previous = state.doc.line(previous.number - 1)
    if (blank(previous.text)) return remove(previous.from, line.from)
    // A hidden definition before the paragraph stays apart from it.
    const before = around(tree, previous.to, [
      'FencedCode',
      'CodeBlock',
      'HorizontalRule',
      'Table',
      'HTMLBlock',
      'SetextHeading1',
      'SetextHeading2',
      'LinkReference',
    ])
    if (before) return remove(previous.to + 1, line.from, previous.to + 1)
    return remove(previous.to, line.from, previous.to)
  }
  // Skip hidden syntax so the visible character before it is the one
  // deleted; a widget shown before it is deleted with the text it shows.
  let end = pos,
    widget = null as { from: number; to: number } | null
  for (let moved = true; moved && !widget; ) {
    moved = false
    hidden.between(end, end, (from, to, value) => {
      if (from >= end || to < end || widget) return
      if (shown(value)) widget = { from, to }
      else {
        end = from
        moved = true
      }
    })
  }
  if (widget) return remove(widget.from, widget.to)
  if (end === pos) return null
  const at = state.doc.lineAt(end)
  if (end === at.from) return null
  const from = findClusterBreak(at.text, end - at.from, false) + at.from
  return remove(from, end)
}

/** Delete at the end of a text block joins the next block, the mirror of Backspace. */
export function deleteForward(
  state: EditorState,
  tree: Tree,
  hidden: Hidden,
): TransactionSpec | null {
  const range = state.selection.main
  if (state.readOnly || !range.empty || state.selection.ranges.length > 1)
    return null
  const pos = range.head
  const line = state.doc.lineAt(pos)
  // Joining a fence line or underline into this one would end or open a
  // block elsewhere.
  if (
    pos === line.to &&
    line.number < state.doc.lines &&
    delimiterLine(state, tree, state.doc.line(line.number + 1))
  )
    return { selection: range }
  if (pos !== line.to || line.number === state.doc.lines) {
    let end = pos,
      widget = null as { from: number; to: number } | null
    for (let moved = true; moved && !widget; ) {
      moved = false
      hidden.between(end, end, (from, to, value) => {
        if (from > end || to <= end || widget) return
        if (shown(value)) widget = { from, to }
        else {
          end = to
          moved = true
        }
      })
    }
    if (widget)
      return {
        changes: widget,
        selection: EditorSelection.cursor(pos),
        userEvent: 'delete.forward',
      }
    if (end === pos || end === state.doc.lineAt(end).to) return null
    const next = state.doc.lineAt(end)
    return {
      changes: {
        from: end,
        to: findClusterBreak(next.text, end - next.from, true) + next.from,
      },
      selection: EditorSelection.cursor(pos),
      userEvent: 'delete.forward',
    }
  }
  let next = state.doc.line(line.number + 1)
  while (blank(next.text) && next.number < state.doc.lines)
    next = state.doc.line(next.number + 1)
  if (blank(next.text) || blank(line.text)) return null
  if (
    around(tree, next.from, [
      'FencedCode',
      'CodeBlock',
      'HorizontalRule',
      'Table',
      'HTMLBlock',
    ])
  )
    return null
  const start = contentStart(next, hidden)
  return {
    changes: { from: pos, to: start },
    selection: EditorSelection.cursor(pos),
    userEvent: 'delete.forward',
  }
}

/**
 * Tab and Shift-Tab: nest list items, indent code, or insert a tab after
 * text. With `codeTabs`, code in an item that cannot nest indents instead.
 */
export function indent(
  state: EditorState,
  tree: Tree,
  outdent: boolean,
  hidden: Hidden,
  codeTabs = true,
): TransactionSpec | null {
  if (state.readOnly) return null
  const range = state.selection.main
  const item = around(tree, range.head, ['ListItem'])
  const code = around(tree, range.head, ['FencedCode', 'CodeBlock'])
  // Code in an item after no sibling indents its own lines, as in the rich editor.
  if (
    item &&
    !(code && codeTabs && !outdent && item.prevSibling?.name !== 'ListItem')
  ) {
    const mark = item.getChild('ListMark')
    const first = state.doc.lineAt(item.from)
    const previous = item.prevSibling
    const parentItem = item.parent?.parent
    const width = (node: SyntaxNode | null | undefined) => {
      const marker = node?.getChild('ListMark')
      if (!node || !marker) return 2
      const line = state.doc.lineAt(node.from)
      const after =
        /^[ \t]*/.exec(state.sliceDoc(marker.to, line.to))?.[0].length ?? 1
      return marker.to - marker.from + Math.max(1, Math.min(after, 4))
    }
    if (!mark) return { selection: range }
    const lines: number[] = []
    for (
      let number = first.number;
      number <= state.doc.lineAt(item.to).number;
      number++
    )
      lines.push(number)
    if (!outdent) {
      // Only an item after a sibling can nest under it.
      if (previous?.name !== 'ListItem') return { selection: range }
      const space = ' '.repeat(width(previous))
      return {
        changes: lines.map((number) => ({
          from: state.doc.line(number).from,
          insert: space,
        })),
        userEvent: 'input.indent',
      }
    }
    if (parentItem?.name !== 'ListItem') return { selection: range }
    const size = width(parentItem)
    return {
      changes: lines.flatMap((number) => {
        const line = state.doc.line(number)
        const leading = /^ */.exec(line.text)?.[0].length ?? 0
        const removed = Math.min(leading, size)
        return removed ? [{ from: line.from, to: line.from + removed }] : []
      }),
      userEvent: 'delete.dedent',
    }
  }
  if (code) {
    const { unit, effects } = codeIndentUnit(state, code)
    if (range.empty && !outdent)
      return {
        effects,
        changes: { from: range.from, insert: unit },
        selection: EditorSelection.cursor(range.from + unit.length),
        userEvent: 'input.indent',
      }
    // Otherwise each code line the selection covers is indented or
    // outdented after its container prefix, never a fence line.
    const fenced = code.name === 'FencedCode'
    const closing = code.lastChild
    const opening = state.doc.lineAt(code.from).number
    const closed =
      fenced &&
      closing?.name === 'CodeMark' &&
      state.doc.lineAt(closing.from).number > opening
    const end = state.doc.lineAt(range.to)
    const last =
      !range.empty && range.to === end.from && end.from > range.from
        ? end.number - 1
        : end.number
    const changes: { from: number; to?: number; insert?: string }[] = []
    const leading = new RegExp(
      `^(?:\t| {1,${unit === '\t' ? 4 : unit.length}})`,
    )
    for (
      let number = Math.max(
        state.doc.lineAt(range.from).number,
        fenced ? opening + 1 : opening,
      );
      number <=
      Math.min(last, state.doc.lineAt(code.to).number - (closed ? 1 : 0));
      number++
    ) {
      const line = state.doc.line(number)
      const start = contentStart(line, hidden)
      if (!outdent) changes.push({ from: start, insert: unit })
      else {
        const lead = leading.exec(state.sliceDoc(start, line.to))
        if (lead) changes.push({ from: start, to: start + lead[0].length })
      }
    }
    const set = state.changes(changes)
    return {
      effects,
      changes: set,
      selection: state.selection.map(set, 1),
      userEvent: outdent ? 'delete.dedent' : 'input.indent',
    }
  }
  const line = state.doc.lineAt(range.head)
  // A tab at the start of a line would make the paragraph indented code.
  if (outdent || blank(state.sliceDoc(line.from, range.from)))
    return { selection: range }
  return {
    changes: { from: range.from, to: range.to, insert: '\t' },
    selection: EditorSelection.cursor(range.from + 1),
    userEvent: 'input',
  }
}

/** Mod-Enter after a final list, quote, table or code block starts a paragraph below it. */
export function exitBlock(
  state: EditorState,
  tree: Tree,
): TransactionSpec | null {
  if (state.readOnly) return null
  const last = tree.topNode.lastChild
  if (
    !last ||
    ![
      'BulletList',
      'OrderedList',
      'Blockquote',
      'FencedCode',
      'CodeBlock',
      'Table',
    ].includes(last.name) ||
    state.selection.main.head < last.from
  )
    return null
  const end = state.doc.length
  const text = state.doc.lineAt(end).text ? '\n\n' : '\n'
  return {
    changes: { from: end, insert: text },
    selection: EditorSelection.cursor(end + text.length),
    scrollIntoView: true,
    userEvent: 'input',
  }
}

/** Text typed on the single blank line between two blocks becomes its own paragraph. */
export function gapInput(
  state: EditorState,
  tree: Tree,
  from: number,
  to: number,
  text: string,
): TransactionSpec | null {
  if (from !== to || !text || text.startsWith('\n')) return null
  const line = state.doc.lineAt(from)
  if (!blank(line.text) || line.number === 1 || line.number === state.doc.lines)
    return null
  // A blank line inside a leaf block, such as a fence, is that block's text.
  for (
    let node: SyntaxNode | null = tree.resolveInner(from, 1);
    node;
    node = node.parent
  )
    if (node.type.is('LeafBlock')) return null
  const previous = state.doc.line(line.number - 1)
  const next = state.doc.line(line.number + 1)
  if (blank(previous.text) || blank(next.text)) return null
  const insert = `\n${text}\n`
  return {
    changes: { from: line.from, to: line.to, insert },
    selection: EditorSelection.cursor(line.from + 1 + text.length),
    userEvent: 'input.type',
  }
}
