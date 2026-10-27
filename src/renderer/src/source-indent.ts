// Kept apart from indentation.ts so settings and the rich editor never load CodeMirror.
import { indentUnit } from '@codemirror/language'
import { StateField, type Text } from '@codemirror/state'
import { detectIndentUnit } from './indentation.ts'

type Indented = { unit: string; from: number; to: number } | null
const firstIndented = (doc: Text, pos = 0, end = doc.length): Indented => {
  while (pos <= end) {
    const line = doc.lineAt(pos)
    const unit = detectIndentUnit(line.text)
    if (unit) return { unit, from: line.from, to: line.to }
    pos = line.to + 1
  }
  return null
}
/** Source view's first indented line, rescanned only when an edit reaches it. */
export const sourceIndent = StateField.define<Indented>({
  create: (state) => firstIndented(state.doc),
  update(found, { changes, docChanged, newDoc }) {
    if (!docChanged) return found
    if (found && changes.touchesRange(found.from, found.to))
      return firstIndented(newDoc)
    // Untouched lines keep their indentation, so only edited lines can precede it.
    let next = found && {
      ...found,
      from: changes.mapPos(found.from),
      to: changes.mapPos(found.to),
    }
    changes.iterChangedRanges((_fromA, _toA, from, to) => {
      next =
        firstIndented(newDoc, from, next ? Math.min(to, next.from - 1) : to) ??
        next
    })
    return next
  },
})

/** Source Tab and toolbar indentation: the file's own style, else the preferred unit. */
export const sourceIndentation = (preferred: string) => [
  sourceIndent,
  indentUnit.compute(
    [sourceIndent],
    (state) => state.field(sourceIndent)?.unit ?? preferred,
  ),
]
