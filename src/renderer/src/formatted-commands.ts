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
      const indent = /^[ \t]*/.exec(line.text)?.[0] ?? ''
      return insert(`\n${indent}`)
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
      // An empty item leaves the list, as in the rich editor.
      if (mark && markerLine?.number === line.number && !content.trim())
        return insert('\n', markerLine.from, markerLine.to)
      const marker = nextMarker(state, item)
      if (marker) return insert(`\n${marker}`)
    }
    const quote = around(tree, pos, ['Blockquote'])
    if (quote) {
      const prefix = continuation(state, tree, pos)
      if (blank(line.text.replace(/^(\s*>)+/, '')))
        return insert('\n', line.from, line.to)
      return insert(`\n${prefix}`)
    }
    // A blank line between blocks gains another empty line.
    if (blank(line.text)) return insert('\n')
    return insert('\n\n')
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
      if (item && mark && state.doc.lineAt(mark.from).number === line.number)
        return remove(line.from, start)
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
  if (around(tree, range.head, ['FencedCode', 'CodeBlock'])) {
    if (outdent) return { selection: range }
    return {
      changes: { from: range.from, to: range.to, insert: '\t' },
      selection: EditorSelection.cursor(range.from + 1),
      userEvent: 'input.indent',
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
  from: number,
  to: number,
  text: string,
): TransactionSpec | null {
  if (from !== to || !text || text.startsWith('\n')) return null
  const line = state.doc.lineAt(from)
  if (!blank(line.text) || line.number === 1 || line.number === state.doc.lines)
    return null
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
