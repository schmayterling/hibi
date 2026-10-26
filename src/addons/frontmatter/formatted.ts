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
import { readFrontmatter } from '../../shared/frontmatter.ts'

/*
 * The formatted view hides frontmatter: the properties editor above the note
 * edits it, so typing, deleting and selecting all stop at its end. Finding it
 * reads only the lines up to its closing line, and an edit after that line
 * reads none.
 */

const opening = /^\uFEFF?---[ \t]*$/
const closing = /^(?:---|\.\.\.)[ \t]*$/

type Frontmatter = {
  /** Line 1 opens frontmatter. */
  open: boolean
  /** The first later line that could close it, or 0. */
  closing: number
  /** The text through the closing line's break, as the shared reader last read it. */
  source: string
  /** The shared reader takes `source` as frontmatter. */
  valid: boolean
  /** End of the hidden range: the frontmatter, its last line break and one blank line after it. */
  end: number
}
const none: Frontmatter = {
  open: false,
  closing: 0,
  source: '',
  valid: false,
  end: 0,
}

/** Lines read and YAML parses while finding frontmatter, for scale tests. */
export const frontmatterProbe = { lines: 0, parses: 0 }

function findClosing(doc: Text, from: number) {
  if (from > doc.lines) return 0
  let number = from
  for (const iter = doc.iterLines(from); !iter.next().done; number++) {
    frontmatterProbe.lines++
    if (closing.test(iter.value)) return number
  }
  return 0
}

/** The hidden range's end for a closing line: through its line break and one blank line. */
function hiddenEnd(doc: Text, closingLine: number) {
  const close = doc.line(closingLine)
  if (closingLine === doc.lines) return close.to
  const next = doc.line(closingLine + 1)
  return /^[ \t]*$/.test(next.text) && closingLine + 1 < doc.lines
    ? next.to + 1
    : close.to + 1
}

/** The shared reader decides, as for the properties editor and the rich view; unchanged text keeps its answer. */
function evaluate(
  doc: Text,
  closingLine: number,
  previous: Frontmatter | null,
): Frontmatter {
  if (!closingLine) return { ...none, open: true }
  const close = doc.line(closingLine)
  const source = doc.sliceString(0, Math.min(doc.length, close.to + 1))
  let valid = previous?.valid ?? false
  if (source !== previous?.source) {
    frontmatterProbe.parses++
    valid = !!readFrontmatter(source)
  }
  return {
    open: true,
    closing: closingLine,
    source,
    valid,
    end: valid ? hiddenEnd(doc, closingLine) : 0,
  }
}

/** Frontmatter at the start of `doc`. */
export function frontmatterOf(doc: Text): Frontmatter {
  return opening.test(doc.line(1).text)
    ? evaluate(doc, findClosing(doc, 2), null)
    : none
}

export const frontmatterField = StateField.define<Frontmatter>({
  create: (state) => frontmatterOf(state.doc),
  update(value, transaction) {
    if (!transaction.docChanged) return value
    const doc = transaction.state.doc
    if (!opening.test(doc.line(1).text)) return none
    if (!value.open) return frontmatterOf(doc)
    let from = Number.POSITIVE_INFINITY
    transaction.changes.iterChangedRanges((fromA) => {
      from = Math.min(from, fromA)
    })
    if (value.closing) {
      // Edits after the closing line keep the frontmatter; only the blank line after it can change.
      if (from > transaction.startState.doc.line(value.closing).to)
        return {
          ...value,
          end: value.valid ? hiddenEnd(doc, value.closing) : 0,
        }
      return evaluate(doc, findClosing(doc, 2), value)
    }
    // Nothing closed it before, so only the edited lines can.
    let found = 0
    transaction.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
      for (
        let number = Math.max(2, doc.lineAt(fromB).number);
        number <= doc.lineAt(toB).number;
        number++
      ) {
        frontmatterProbe.lines++
        if (closing.test(doc.line(number).text)) {
          if (!found || number < found) found = number
          break
        }
      }
    })
    return evaluate(doc, found, value)
  },
})

const hiddenDecoration = Decoration.replace({ block: true })
const hidden = StateField.define<DecorationSet>({
  create: (state) => hide(state),
  update: (value, transaction) =>
    transaction.state.field(frontmatterField).end ===
      transaction.startState.field(frontmatterField).end &&
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
  const end = transaction.docChanged
    ? transaction.state.field(frontmatterField).end
    : start
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
