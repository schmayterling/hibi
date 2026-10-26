import { StateField, type Text } from '@codemirror/state'
import { Decoration, EditorView } from '@codemirror/view'
import { formattedPrefix } from './formatted-contributions'

/** The first line, after a byte order mark the source keeps. */
const opening = /^\uFEFF?---[ \t]*$/
const closing = /^(?:---|\.\.\.)[ \t]*$/

/** The end of the first closing line from line `from` on, or 0. */
function closingEnd(doc: Text, from: number, to = doc.lines) {
  for (let number = from; number <= to; number++) {
    const line = doc.line(number)
    if (closing.test(line.text)) return line.to
  }
  return 0
}

/**
 * Where frontmatter at the start of the note ends, after its closing line,
 * or 0. Edits after it keep it; without one, only edited lines can close it.
 */
const frontmatter = StateField.define<number>({
  create: (state) =>
    state.doc.lines > 1 && opening.test(state.doc.line(1).text)
      ? closingEnd(state.doc, 2)
      : 0,
  update(end, transaction) {
    if (!transaction.docChanged) return end
    const { doc } = transaction.state
    if (doc.lines < 2 || !opening.test(doc.line(1).text)) return 0
    let first = Number.POSITIVE_INFINITY
    transaction.changes.iterChangedRanges((from) => {
      first = Math.min(first, from)
    })
    if (end && first > end) return transaction.changes.mapPos(end)
    if (end) return closingEnd(doc, 2)
    let found = 0
    transaction.changes.iterChangedRanges((_fromA, _toA, from, to) => {
      const start = Math.max(2, doc.lineAt(from).number),
        stop = doc.lineAt(to).number
      const at = start <= stop ? closingEnd(doc, start, stop) : 0
      if (at && (!found || at < found)) found = at
    })
    return found
  },
})

const hidden = Decoration.replace({ block: true })

/**
 * With a properties editor above the formatted view, frontmatter is one node
 * there, not Markdown, and its lines collapse.
 */
export const formattedFrontmatter = [
  frontmatter,
  formattedPrefix.of((state) => state.field(frontmatter)),
  EditorView.decorations.compute([frontmatter], (state) => {
    const end = state.field(frontmatter)
    return end ? Decoration.set(hidden.range(0, end)) : Decoration.none
  }),
  EditorView.atomicRanges.of((view) => {
    const end = view.state.field(frontmatter)
    return end
      ? Decoration.set(
          hidden.range(0, Math.min(view.state.doc.length, end + 1)),
        )
      : Decoration.none
  }),
]
