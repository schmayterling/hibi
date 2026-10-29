import {
  type EditorState,
  Facet,
  Prec,
  StateEffect,
  StateField,
  type Text,
  type TransactionSpec,
} from '@codemirror/state'
import { type EditorView, keymap, ViewPlugin } from '@codemirror/view'
import type { SyntaxNode, Tree } from '@lezer/common'
import { parseRow } from '../../shared/markdown-table-source.ts'
import { uncovered } from './chunked-markdown.ts'
import { prefixOf } from './formatted-commands.ts'
import { sourceHistoryEffects } from './source-session.ts'

/** Blocks the rich editor reads; it drops link reference definitions. */
const isBlock = (node: SyntaxNode) =>
  node.type.is('Block') && node.name !== 'LinkReference'

function lastBlock(node: SyntaxNode) {
  for (let child = node.lastChild; child; child = child.prevSibling)
    if (isBlock(child)) return child
  return null
}

/** The end of the text before `at`, past whitespace. */
function trimmed(doc: Text, at: number, from = 0) {
  while (at > from && /\s/.test(doc.sliceString(at - 1, at))) at--
  return at
}

/**
 * The end of a table's last cell's text. The rich editor's rows have every
 * column, so its last cell is the last column's; a row with fewer cells has
 * no text for it, and ends in its last written cell here.
 */
function tableEnd(doc: Text, table: SyntaxNode) {
  let header = table.firstChild,
    row = table.lastChild
  while (header && header.name !== 'TableHeader') header = header.nextSibling
  while (row && row.name !== 'TableRow' && row.name !== 'TableHeader')
    row = row.prevSibling
  if (!header || !row) return trimmed(doc, table.to)
  const columns = parseRow(doc.sliceString(header.from, header.to)).cells.length
  const { cells } = parseRow(doc.sliceString(row.from, row.to), row.from)
  return (cells[columns - 1] ?? cells.at(-1))?.to ?? trimmed(doc, row.to)
}

/** Blocks the rich editor draws as one node, which its Selection.atEnd selects whole. */
const atoms = new Set([
  'HTMLBlock',
  'CommentBlock',
  'ProcessingInstructionBlock',
  'BlockMath',
  'HorizontalRule',
])

type Opening = { anchor: number; head: number }

/**
 * The source of `node` when the rich editor draws it as one node: from its
 * first character to its last.
 */
function atomRange(
  doc: Text,
  node: SyntaxNode,
  replaced: (node: SyntaxNode) => boolean,
) {
  const to = trimmed(doc, node.to, node.from)
  const image = node.firstChild
  return atoms.has(node.name) ||
    (node.name === 'FencedCode' && replaced(node)) ||
    (node.name === 'Paragraph' &&
      image?.name === 'Image' &&
      image.from === node.from &&
      image.to === to)
    ? { from: node.from, to }
    : null
}

/**
 * Where the rich editor's Selection.atEnd puts the selection, in the
 * formatted view's text: the end of the last text block, inside quotes and
 * lists. In a table that is its last cell's text, which the table's cell
 * editor takes; in code, the code's end before its closing fence. Blank
 * lines after the last block that show an empty paragraph hold it instead.
 * A last block the rich editor draws as one node, such as a divider, a
 * block image or a fence `replaced` says a renderer draws in place of its
 * text, is selected whole, so typing replaces it. Null while the syntax tree
 * does not reach the note's end.
 */
export function formattedOpenSelection(
  doc: Text,
  tree: Tree | null,
  replaced: (node: SyntaxNode) => boolean = () => false,
): Opening | null {
  const end = trimmed(doc, doc.length)
  const caret = (at: number) => ({ anchor: at, head: at })
  if (!tree || uncovered(tree, Math.max(0, end - 1), doc.length)) return null
  let node = lastBlock(tree.topNode)
  if (!node) return caret(end)
  // As the formatted view lays out blank lines after the last block: an empty
  // line with a line break after it is the margin above an empty paragraph,
  // which shows on the next line.
  let shown = false,
    paragraph = -1
  for (let number = doc.lineAt(node.to).number + 1; number <= doc.lines; ) {
    const line = doc.line(number++)
    if (line.text.trim()) {
      paragraph = -1
      break
    }
    if (shown) {
      shown = false
      paragraph = line.from
    } else if (!line.text && number <= doc.lines) shown = true
  }
  if (paragraph >= 0) return caret(paragraph)
  for (let inner = lastBlock(node); inner; inner = lastBlock(inner))
    node = inner
  const whole = atomRange(doc, node, replaced)
  if (whole) return { anchor: whole.from, head: whole.to }
  if (node.name === 'Table') return caret(tableEnd(doc, node))
  if (node.name === 'FencedCode' || node.name === 'CodeBlock') {
    let text = node.lastChild
    while (text && text.name !== 'CodeText') text = text.prevSibling
    // The view draws no lines for an empty fence.
    if (!text) return caret(end)
    // An unclosed fence's text holds the note's last line breaks.
    let at = text.to
    while (at > text.from && /[\r\n]/.test(doc.sliceString(at - 1, at))) at--
    return caret(at)
  }
  // A heading's text ends before its closing marks or setext underline.
  const mark = node.lastChild
  const at =
    mark?.name === 'HeaderMark' && mark.from > node.from
      ? node.name.startsWith('Setext')
        ? doc.lineAt(mark.from).from
        : mark.from
      : node.to
  return caret(trimmed(doc, at, node.from))
}

type OpenSyntax = {
  tree: (state: EditorState) => Tree | null
  /** Whether a renderer draws a block in place of its text while it is not revealed. */
  replaced: (state: EditorState, node: SyntaxNode) => boolean
}
const openSyntax = Facet.define<OpenSyntax, OpenSyntax | undefined>({
  combine: (values) => values[0],
})

const select = StateEffect.define<Selected | null>()

/**
 * The selection a note opened with, or a block a press on its drawing
 * selected whole, until the user moves the selection or edits.
 */
type Selected = Opening & { opened?: boolean }
const selected = StateField.define<Selected | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects)
      if (effect.is(select)) return effect.value
    const main = transaction.selection?.main
    if (
      main &&
      main.from < main.to &&
      !transaction.docChanged &&
      transaction.isUserEvent('select.pointer')
    ) {
      const block = atomBlockAt(transaction.startState, main.from)
      if (block?.from === main.from && block.to === main.to)
        return { anchor: main.anchor, head: main.head }
    }
    return !value ||
      transaction.docChanged ||
      (main && (main.anchor !== value.anchor || main.head !== value.head))
      ? null
      : value
  },
})

/**
 * The block selected whole, which stands for the rich editor's node
 * selection: it shows without its source, takes no inline formatting, and
 * Backspace removes it with the blank lines that part it from the next block.
 */
export function selectedBlock(state: EditorState) {
  const value = state.field(selected, false)
  return value && value.anchor !== value.head
    ? {
        from: Math.min(value.anchor, value.head),
        to: Math.max(value.anchor, value.head),
      }
    : null
}

export const blockSelected = (state: EditorState, from: number, to: number) => {
  const block = selectedBlock(state)
  return block?.from === from && block.to === to
}

/** Selects a block whole, as the rich editor's node selection. */
export const selectBlock = (from: number, to: number) => ({
  selection: { anchor: from, head: to },
  effects: select.of({ anchor: from, head: to }),
})

/** The source of a block the rich editor draws as one node that starts or ends at `pos`. */
export function atomBlockAt(state: EditorState, pos: number) {
  const syntax = state.facet(openSyntax)
  const tree = syntax?.tree(state)
  if (!syntax || !tree) return null
  for (const side of [1, -1] as const)
    for (
      let node: SyntaxNode | null = tree.resolveInner(pos, side);
      node;
      node = node.parent
    ) {
      if (!node.type.is('Block')) continue
      const block = atomRange(state.doc, node, (node) =>
        syntax.replaced(state, node),
      )
      if (block && (block.from === pos || block.to === pos)) return block
    }
  return null
}

/** The syntax node of a block selected whole. */
function blockNode(tree: Tree, block: { from: number }) {
  let node = tree.resolveInner(block.from, 1)
  while (node.parent && !(node.type.is('Block') && node.from === block.from))
    node = node.parent
  return node
}

/**
 * A divider or an empty paragraph after a block selected whole, as the rich
 * editor inserts a node after its node selection. The caret goes into the
 * paragraph, or after the divider to the next block's start, or to a new
 * paragraph at the note's end.
 */
export function insertAfterBlock(
  state: EditorState,
  tree: Tree,
  block: { from: number; to: number },
  divider: boolean,
): TransactionSpec {
  const node = blockNode(tree, block)
  const prefix = prefixOf(state, node.parent) ?? ''
  let item = false
  for (let parent = node.parent; parent; parent = parent.parent)
    if (parent.name === 'ListItem') item = true
  let next = node.nextSibling
  while (next && !next.type.is('Block')) next = next.nextSibling
  const rest = state.sliceDoc(block.to)
  const at = next?.from ?? block.to + rest.length - rest.trimStart().length
  const end = at === state.doc.length
  // The rich editor writes an empty last paragraph as one more line break.
  if (!divider && end && !prefix && rest === '\n')
    return {
      changes: { from: state.doc.length, insert: '\n' },
      selection: { anchor: state.doc.length + 1 },
    }
  const parted = `${item ? '' : `\n${prefix.includes('>') ? prefix.trimEnd() : ''}`}\n${prefix}`
  let insert = parted
  if (divider) insert += end ? `---${parted}` : '---'
  return {
    changes: { from: block.to, insert },
    selection: {
      anchor: (divider && !end ? at : block.to) + insert.length,
    },
  }
}

/**
 * As the rich editor deletes a selected block: with the blank lines that
 * part it from the next block, where the caret goes, or from the block
 * before it when it is the last.
 */
export function removeBlock(
  tree: Tree,
  block: { from: number; to: number },
): TransactionSpec {
  const node = blockNode(tree, block)
  let next = node.nextSibling,
    previous = node.prevSibling
  while (next && !next.type.is('Block')) next = next.nextSibling
  while (previous && !previous.type.is('Block')) previous = previous.prevSibling
  const from = next ? block.from : (previous?.to ?? block.from)
  return {
    changes: { from, to: next ? next.from : block.to },
    selection: { anchor: from },
  }
}

function deleteBlock(view: EditorView) {
  const block = selectedBlock(view.state)
  const tree = view.state.facet(openSyntax)?.tree(view.state)
  if (!block || !tree) return false
  view.dispatch({
    ...removeBlock(tree, block),
    userEvent: 'delete.selection',
    scrollIntoView: true,
  })
  return true
}

/**
 * Selects where the rich editor's Selection.atEnd puts a note's selection.
 * A long note whose end the first paint does not parse opens at its source
 * end. Until the user moves the selection or edits, it moves where the
 * rich editor puts it once the parse reaches the end or a renderer that
 * draws the last block loads.
 */
export function openAtEnd(view: EditorView, later = false) {
  const { state } = view
  const syntax = state.facet(openSyntax)
  if (!syntax) return
  const selection = formattedOpenSelection(
    state.doc,
    syntax.tree(state),
    (node) => syntax.replaced(state, node),
  )
  const value = state.field(selected, false)
  if (
    later &&
    (!selection ||
      (selection.anchor === value?.anchor && selection.head === value.head))
  )
    return
  const end = trimmed(state.doc, state.doc.length)
  const at = selection ?? { anchor: end, head: end }
  view.dispatch({
    selection: at,
    effects: select.of({ ...at, opened: true }),
  })
}

export const openSelection = (syntax: OpenSyntax) => [
  openSyntax.of(syntax),
  selected,
  sourceHistoryEffects.of((state) => [select.of(state.field(selected))]),
  ViewPlugin.define((view) => ({
    update(update) {
      const value = update.state.field(selected, false)
      if (
        !value?.opened ||
        (syntax.tree(update.state) === syntax.tree(update.startState) &&
          !update.transactions.some((transaction) => transaction.reconfigured))
      )
        return
      // A view cannot dispatch during its update.
      queueMicrotask(() => {
        if (view.state.field(selected, false) === value) openAtEnd(view, true)
      })
    },
  })),
  Prec.highest(
    keymap.of([
      // As the rich editor's Enter on a selected block: a new paragraph after it.
      {
        key: 'Enter',
        run(view) {
          const block = selectedBlock(view.state)
          const tree = view.state.facet(openSyntax)?.tree(view.state)
          if (!block || !tree) return false
          view.dispatch({
            ...insertAfterBlock(view.state, tree, block, false),
            userEvent: 'input',
            scrollIntoView: true,
          })
          return true
        },
      },
      { key: 'Backspace', run: deleteBlock },
      { key: 'Delete', run: deleteBlock },
    ]),
  ),
]
