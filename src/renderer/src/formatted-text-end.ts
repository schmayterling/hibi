import {
  type EditorState,
  Facet,
  Prec,
  StateEffect,
  StateField,
  type Text,
} from '@codemirror/state'
import { type EditorView, keymap, ViewPlugin } from '@codemirror/view'
import type { SyntaxNode, Tree } from '@lezer/common'
import { parseRow } from '../../shared/markdown-table-source.ts'
import { uncovered } from './chunked-markdown.ts'

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
  const whole = { anchor: node.from, head: trimmed(doc, node.to, node.from) }
  const image = node.firstChild
  if (
    atoms.has(node.name) ||
    (node.name === 'FencedCode' && replaced(node)) ||
    (node.name === 'Paragraph' &&
      image?.name === 'Image' &&
      image.from === node.from &&
      image.to === whole.head)
  )
    return whole
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

const open = StateEffect.define<Opening>()

/** The selection a note opened with, until the user moves it or edits. */
const opened = StateField.define<Opening | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects)
      if (effect.is(open)) return effect.value
    const main = transaction.selection?.main
    return !value ||
      transaction.docChanged ||
      (main && (main.anchor !== value.anchor || main.head !== value.head))
      ? null
      : value
  },
})

/** Whether a range is the block a note opened with selected, which shows as the rich editor's node selection: without its source. */
export const openedBlock = (state: EditorState, from: number, to: number) => {
  const value = state.field(opened, false)
  return (
    !!value &&
    from < to &&
    from === Math.min(value.anchor, value.head) &&
    to === Math.max(value.anchor, value.head)
  )
}

type OpenSyntax = {
  tree: (state: EditorState) => Tree | null
  /** Whether a renderer draws a block in place of its text while it is not revealed. */
  replaced: (state: EditorState, node: SyntaxNode) => boolean
}
const openSyntax = Facet.define<OpenSyntax, OpenSyntax | undefined>({
  combine: (values) => values[0],
})

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
  const value = state.field(opened, false)
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
    effects: open.of(at),
  })
}

export const openSelection = (syntax: OpenSyntax) => [
  openSyntax.of(syntax),
  opened,
  ViewPlugin.define((view) => ({
    update(update) {
      const value = update.state.field(opened, false)
      if (
        !value ||
        (syntax.tree(update.state) === syntax.tree(update.startState) &&
          !update.transactions.some((transaction) => transaction.reconfigured))
      )
        return
      // A view cannot dispatch during its update.
      queueMicrotask(() => {
        if (view.state.field(opened, false) === value) openAtEnd(view, true)
      })
    },
  })),
  // As the rich editor's Enter on a selected block: a new paragraph after it.
  Prec.highest(
    keymap.of([
      {
        key: 'Enter',
        run(view) {
          const value = view.state.field(opened, false)
          if (value && value.anchor !== value.head)
            view.dispatch({
              selection: { anchor: Math.max(value.anchor, value.head) },
            })
          return false
        },
      },
    ]),
  ),
]
