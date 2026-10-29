import {
  type EditorState,
  Prec,
  StateEffect,
  StateField,
  type Text,
} from '@codemirror/state'
import { EditorView, keymap, ViewPlugin } from '@codemirror/view'
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
 * block image or a fence a renderer draws in place of its text, is selected
 * whole, so typing replaces it. Null while the syntax tree does not reach
 * the note's end, or `drawn` cannot tell yet whether a fence shows its text.
 */
export function formattedOpenSelection(
  doc: Text,
  tree: Tree | null,
  /** Whether the view draws a position's text; undefined while it is not drawn. */
  drawn: (pos: number) => boolean | undefined = () => true,
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
    if (node.name === 'CodeBlock') return caret(at)
    const shown = drawn(at)
    return shown === undefined ? null : shown ? caret(at) : whole
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

/**
 * Whether the view draws a position's text, not a widget that replaces it,
 * such as a rendered fence's; undefined outside the drawn ranges.
 */
const drawsText = (view: EditorView, pos: number) =>
  !view.visibleRanges.some(({ from, to }) => from <= pos && pos <= to)
    ? undefined
    : view.state.facet(EditorView.decorations).every((source) => {
        let replaced = false
        ;(typeof source === 'function' ? source(view) : source).between(
          pos,
          pos,
          (from, to, value) => {
            if (value.point && from < pos && pos < to) replaced = true
          },
        )
        return !replaced
      })

const open = StateEffect.define<Opening & { known: boolean }>()

/**
 * The selection a note opened with, until the user moves it or edits.
 * `known` once it is where the rich editor puts it, not the source end it
 * held while the tree or the view did not reach the note's end.
 */
const opened = StateField.define<(Opening & { known: boolean }) | null>({
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

/**
 * Selects where the rich editor's Selection.atEnd puts a note's selection.
 * A long note whose end the first paint does not parse or draw opens at its
 * source end, and moves there once the view reaches it, while the user has
 * neither moved the selection nor edited.
 */
export function openAtEnd(
  view: EditorView,
  tree: (state: EditorState) => Tree | null,
  later = false,
) {
  const { state } = view
  const selection = formattedOpenSelection(state.doc, tree(state), (pos) =>
    drawsText(view, pos),
  )
  if (!selection && later) return
  const end = trimmed(state.doc, state.doc.length)
  const at = selection ?? { anchor: end, head: end }
  view.dispatch({
    selection: at,
    effects: open.of({ ...at, known: !!selection }),
  })
}

export const openSelection = (tree: (state: EditorState) => Tree | null) => [
  opened,
  ViewPlugin.define((view) => ({
    update(update) {
      const value = update.state.field(opened, false)
      if (
        !value ||
        value.known ||
        !(
          update.viewportChanged ||
          tree(update.state) !== tree(update.startState)
        )
      )
        return
      // The drawn decorations are read after the update.
      queueMicrotask(() => {
        if (view.state.field(opened, false) === value)
          openAtEnd(view, tree, true)
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
