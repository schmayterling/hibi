import {
  EditorSelection,
  EditorState,
  StateField,
  type Text,
} from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view'
import {
  type FormattedContribution,
  formattedPrefix,
} from '../../renderer/src/formatted-contributions.ts'
import {
  frontmatterBounds,
  frontmatterProbe,
} from '../../renderer/src/formatted-frontmatter.ts'
import { transactionState } from '../../renderer/src/source-session.ts'

/*
 * The formatted view hides frontmatter: the properties editor above the note
 * edits it, so typing, deleting and selecting all stop at its end. The
 * formatted view's frontmatter search finds it, a bounded part of the note
 * at a time.
 */

export { frontmatterProbe }

type Frontmatter = {
  /** Line 1 opens frontmatter. */
  open: boolean
  /** The line that closes it, or 0. */
  closing: number
  /** The shared reader takes the lines up to it as frontmatter. */
  valid: boolean
  /** End of the hidden range: the frontmatter, its last line break and one blank line after it. */
  end: number
}
const none: Frontmatter = { open: false, closing: 0, valid: false, end: 0 }

/** The hidden range's end for a closing line: through its line break and one blank line. */
function hiddenEnd(doc: Text, closingLine: number) {
  const close = doc.line(closingLine)
  if (closingLine === doc.lines) return close.to
  const next = doc.line(closingLine + 1)
  return /^[ \t]*$/.test(next.text) && closingLine + 1 < doc.lines
    ? next.to + 1
    : close.to + 1
}

function fromBounds(state: EditorState): Frontmatter {
  const { open, closer, end } = state.field(frontmatterBounds)
  if (!open) return none
  const closing = closer ? state.doc.lineAt(closer).number : 0
  return {
    open,
    closing,
    valid: end > 0,
    end: end ? hiddenEnd(state.doc, closing) : 0,
  }
}

export const frontmatterField: StateField<Frontmatter> =
  StateField.define<Frontmatter>({
    create: fromBounds,
    update: (value, transaction) =>
      transaction.docChanged ||
      transaction.state.field(frontmatterBounds) !==
        transaction.startState.field(frontmatterBounds, false)
        ? fromBounds(transaction.state)
        : value,
    provide: () => frontmatterBounds,
  })

/** Frontmatter at the start of `doc`. */
export function frontmatterOf(doc: Text): Frontmatter {
  return EditorState.create({ doc, extensions: frontmatterField }).field(
    frontmatterField,
  )
}

const hiddenDecoration = Decoration.replace({ block: true })
const hidden = StateField.define<DecorationSet>({
  create: (state) => hide(state),
  update: (value, transaction) =>
    transaction.state.field(frontmatterField).end ===
      transaction.startState.field(frontmatterField, false)?.end &&
    !transaction.docChanged
      ? value
      : hide(transaction.state),
  provide: (field) => [
    EditorView.decorations.from(field),
    EditorView.atomicRanges.of((view) => view.state.field(field)),
  ],
})
function hide(state: EditorState): DecorationSet {
  const { end } = state.field(frontmatterField)
  if (!end) return Decoration.none
  // Block replacements end at a line end.
  const to = state.sliceDoc(end - 1, end) === '\n' ? end - 1 : end
  return Decoration.set(hiddenDecoration.range(0, to))
}

/**
 * Typing, deleting and dropping stop at the frontmatter. Addon edits, such
 * as the properties editor's, pass; history and other views' edits do not
 * run filters.
 */
const protect = EditorState.transactionFilter.of((transaction) => {
  const start = transaction.startState.field(frontmatterField).end
  if (transaction.isUserEvent('input.addon')) return transaction
  let inside = false
  transaction.changes.iterChangedRanges((fromA) => {
    if (fromA < start) inside = true
  })
  if (inside) return []
  // Selections end at the note's text, also when an edit just closed the frontmatter.
  let end = start
  if (transaction.docChanged) {
    const state = transactionState(transaction)
    if (!state) return transaction
    end = state.field(frontmatterField, false)?.end ?? 0
  }
  const selection =
    transaction.selection ??
    (end !== start ? transaction.state.selection : undefined)
  if (end && selection?.ranges.some((range) => range.from < end))
    return [
      transaction,
      {
        selection: EditorSelection.create(
          selection.ranges.map((range) =>
            EditorSelection.range(
              Math.max(end, range.anchor),
              Math.max(end, range.head),
            ),
          ),
          selection.mainIndex,
        ),
        sequential: true,
      },
    ]
  // A note that ends on its closing line gets a line break before typed text.
  const doc = transaction.startState.doc
  if (
    start &&
    transaction.docChanged &&
    start === doc.length &&
    doc.sliceString(start - 1, start) !== '\n'
  )
    return [
      transaction,
      { changes: { from: start, insert: '\n' }, sequential: true },
    ]
  return transaction
})

/** Frontmatter in the formatted view: hidden and protected, with select-all covering the note's text. */
export const contribution: FormattedContribution = {
  id: 'frontmatter.metadata',
  keys: [
    {
      key: 'Mod-a',
      run(view) {
        const { end } = view.state.field(frontmatterField)
        if (!end) return false
        view.dispatch({
          selection: EditorSelection.range(end, view.state.doc.length),
          userEvent: 'select',
        })
        return true
      },
    },
  ],
  extension: [
    frontmatterField,
    // The formatted syntax starts after it, so the note's first block starts the document.
    formattedPrefix.of((state) => state.field(frontmatterField).end),
    hidden,
    protect,
  ],
}
