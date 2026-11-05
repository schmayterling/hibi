import type { SourceSnapshot } from './source-buffer.ts'
import { mapSourcePosition, type RawEdit } from './source-operations.ts'

/** Host selection uses raw source boundaries, independent of a mounted editor. */
export type SourceSelection = Readonly<{
  ranges: readonly Readonly<{
    anchor: number
    head: number
    association: -1 | 1
  }>[]
  mainIndex: number
}>
/** The memory undo history counts for a step's carets, as `editBytes` does for its edits. */
export const selectionBytes = (selection: SourceSelection | null) =>
  (selection?.ranges.length ?? 0) * 48

export function sourceSelection(
  snapshot: SourceSnapshot,
  value: SourceSelection,
): SourceSelection {
  if (
    !value ||
    !Array.isArray(value.ranges) ||
    !value.ranges.length ||
    value.ranges.length > 10_000 ||
    !Number.isSafeInteger(value.mainIndex) ||
    value.mainIndex < 0 ||
    value.mainIndex >= value.ranges.length
  )
    throw new Error('Invalid source selection.')
  const ranges = value.ranges.map((range) => {
    if (
      !range ||
      !snapshot.isEditBoundary(range.anchor) ||
      !snapshot.isEditBoundary(range.head) ||
      (range.association !== -1 && range.association !== 1)
    )
      throw new Error('Source selection splits a character or line ending.')
    return Object.freeze({
      anchor: range.anchor,
      head: range.head,
      association: range.association,
    })
  })
  return Object.freeze({
    ranges: Object.freeze(ranges),
    mainIndex: value.mainIndex,
  })
}

export function mapSourceSelection(
  snapshot: SourceSnapshot,
  selection: SourceSelection | null,
  changes: readonly RawEdit[],
): SourceSelection | null {
  if (!selection) return null
  const boundary = (position: number, association: -1 | 1) => {
    const mapped = mapSourcePosition(position, changes, association)
    // A deletion can join a CRLF/surrogate pair around an unchanged caret.
    return snapshot.isEditBoundary(mapped) ? mapped : mapped + association
  }
  return sourceSelection(snapshot, {
    ranges: selection.ranges.map(({ anchor, head, association }) => ({
      anchor: boundary(
        anchor,
        anchor === head ? association : anchor < head ? -1 : 1,
      ),
      head: boundary(
        head,
        anchor === head ? association : anchor < head ? 1 : -1,
      ),
      association,
    })),
    mainIndex: selection.mainIndex,
  })
}
