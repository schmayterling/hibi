import { StateField, type Text } from '@codemirror/state'
import { Decoration, EditorView } from '@codemirror/view'
import { readFrontmatter } from '../../shared/frontmatter'
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

/** The closing line's end when the lines before it are frontmatter as the properties read it: a metadata mapping. */
const recognized = (doc: Text, closer: number) =>
  closer && readFrontmatter(doc.sliceString(0, closer)) ? closer : 0

/**
 * The end of the first closing line after an opening one, and where
 * frontmatter ends: there when the lines between are a metadata mapping,
 * else 0. Edits after the closing line keep both; without one, only edited
 * lines can close it.
 */
const frontmatter = StateField.define<{ closer: number; end: number }>({
  create(state) {
    const closer =
      state.doc.lines > 1 && opening.test(state.doc.line(1).text)
        ? closingEnd(state.doc, 2)
        : 0
    return { closer, end: recognized(state.doc, closer) }
  },
  update(value, transaction) {
    if (!transaction.docChanged) return value
    const { doc } = transaction.state
    if (doc.lines < 2 || !opening.test(doc.line(1).text))
      return { closer: 0, end: 0 }
    let first = Number.POSITIVE_INFINITY
    transaction.changes.iterChangedRanges((_fromA, _toA, from) => {
      first = Math.min(first, from)
    })
    if (value.closer && first > value.closer) {
      const closer = transaction.changes.mapPos(value.closer)
      return { closer, end: value.end ? closer : 0 }
    }
    let closer = 0
    // An edit to the opening line or the block may move the closing line.
    if (value.closer || first <= doc.line(1).to) closer = closingEnd(doc, 2)
    else
      transaction.changes.iterChangedRanges((_fromA, _toA, from, to) => {
        const start = Math.max(2, doc.lineAt(from).number),
          stop = doc.lineAt(to).number
        const at = start <= stop ? closingEnd(doc, start, stop) : 0
        if (at && (!closer || at < closer)) closer = at
      })
    return { closer, end: recognized(doc, closer) }
  },
})

const hidden = Decoration.replace({ block: true })

/**
 * With a properties editor above the formatted view, frontmatter is one node
 * there, not Markdown, and its lines collapse.
 */
export const formattedFrontmatter = [
  frontmatter,
  formattedPrefix.of((state) => state.field(frontmatter).end),
  EditorView.decorations.compute([frontmatter], (state) => {
    const { end } = state.field(frontmatter)
    return end ? Decoration.set(hidden.range(0, end)) : Decoration.none
  }),
  EditorView.atomicRanges.of((view) => {
    const { end } = view.state.field(frontmatter)
    return end
      ? Decoration.set(
          hidden.range(0, Math.min(view.state.doc.length, end + 1)),
        )
      : Decoration.none
  }),
]
