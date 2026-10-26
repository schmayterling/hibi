import {
  EditorSelection,
  type EditorState,
  findClusterBreak,
  type Line,
  type RangeSet,
  type RangeValue,
  type TransactionSpec,
} from '@codemirror/state'
import type { SyntaxNode, Tree } from '@lezer/common'
import { formattedFormatting } from './formatted-contributions.ts'

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
function spanned(state: EditorState, tree: Tree, from: number, to: number) {
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

function reopened(state: EditorState, tree: Tree, pos: number) {
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
  let number = Number(/^\s*(\d+)/.exec(marker)?.[1])
  for (
    let next = item.nextSibling;
    Number.isFinite(number) && next?.name === 'ListItem';
    next = next.nextSibling
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

/** The content column of a list item's first line, as its marker sets it. */
export function itemWidth(state: EditorState, item: SyntaxNode) {
  const line = state.doc.lineAt(item.from)
  const match = /^([ \t]*(?:\d+[.)]|[-+*]))( *)(.?)/.exec(line.text)
  if (!match) return 0
  const spaces = match[2]!.length
  return match[1]!.length + (!match[3] || spaces > 4 ? 1 : spaces)
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
    const leading = /^ */.exec(line.text)![0].length
    if (blank(line.text) || leading < width) continue
    if (by > 0) changes.push({ from: line.from, insert: ' '.repeat(by) })
    else changes.push({ from: line.from, to: line.from - by })
  }
  return changes
}

/** The next list marker: same bullet, next number, unchecked task. */
function nextMarker(state: EditorState, item: SyntaxNode) {
  const mark = item.getChild('ListMark')
  if (!mark) return null
  const line = state.doc.lineAt(item.from)
  const indent = state.sliceDoc(line.from, mark.from)
  const text = state.sliceDoc(mark.from, mark.to)
  const ordered = /^(\d+)([.)])$/.exec(text)
  const task = item.getChild('Task')
  return `${indent}${ordered ? `${Number(ordered[1]) + 1}${ordered[2]}` : text} ${task ? '[ ] ' : ''}`
}

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
    // A blank line between blocks gains another empty line.
    if (blank(line.text)) return insert('\n')
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
    const before = around(tree, previous.to, [
      'FencedCode',
      'CodeBlock',
      'HorizontalRule',
      'Table',
      'HTMLBlock',
      'SetextHeading1',
      'SetextHeading2',
    ])
    if (before) return remove(previous.to + 1, line.from, line.from)
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

/** Tab and Shift-Tab: nest list items, indent code, or insert a tab after text. */
export function indent(
  state: EditorState,
  tree: Tree,
  outdent: boolean,
  hidden: Hidden,
): TransactionSpec | null {
  if (state.readOnly) return null
  const range = state.selection.main
  const item = around(tree, range.head, ['ListItem'])
  if (item) {
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
  const code = around(tree, range.head, ['FencedCode', 'CodeBlock'])
  if (code) {
    if (range.empty && !outdent)
      return {
        changes: { from: range.from, insert: '\t' },
        selection: EditorSelection.cursor(range.from + 1),
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
      if (!outdent) changes.push({ from: start, insert: '\t' })
      else {
        const lead = /^(?:\t| {1,4})/.exec(state.sliceDoc(start, line.to))
        if (lead) changes.push({ from: start, to: start + lead[0].length })
      }
    }
    const set = state.changes(changes)
    return {
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
