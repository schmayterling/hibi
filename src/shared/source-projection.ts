import type { ChangedRange } from '@lezer/common'
import type { SourceSnapshot } from './source-buffer.ts'
import type { RawEdit } from './source-operations.ts'

export const normalizedSource = (source: string) =>
  source.replace(/\r\n?/g, '\n')

/** Shift an unparsed prefix only when every normalized edit stays inside it. */
export function mappedPrefix(prefix: number, changes: readonly ChangedRange[]) {
  if (!prefix) return null
  let next = prefix
  for (const change of changes) {
    if (change.fromA >= prefix || change.toA > prefix) return null
    next += change.toB - change.fromB - (change.toA - change.fromA)
  }
  return next
}

/** Capture once when opening a source surface; keep its insertion convention. */
export function preferredLineBreak(source: SourceSnapshot): string {
  const nextLine = source.lineStart(2)
  if (nextLine === null) return '\n'
  const ending = source.sliceRaw(Math.max(0, nextLine - 2), nextLine)
  return ending.endsWith('\r\n') ? '\r\n' : ending.slice(-1)
}

/** Accepted CodeMirror changes use normalized pre-state coordinates. */
export function sourceChangesFromEditor(
  source: SourceSnapshot,
  changes: readonly RawEdit[],
  lineBreak = preferredLineBreak(source),
): readonly RawEdit[] {
  if (!['\n', '\r', '\r\n'].includes(lineBreak))
    throw new Error('Invalid line-ending convention.')
  return changes.map((change) => {
    const from = source.editorToRaw(change.from),
      to = source.editorToRaw(change.to)
    if (from === null || to === null)
      throw new Error('Editor change is outside its source snapshot.')
    return {
      from,
      to,
      insert: normalizedSource(change.insert).replaceAll('\n', lineBreak),
    }
  })
}

/** Project source operations locally, including a newly joined CRLF seam. */
export function editorChangesFromSource(
  source: SourceSnapshot,
  changes: readonly RawEdit[],
): readonly RawEdit[] {
  const result: RawEdit[] = []
  let group: RawEdit[] = [],
    from = 0,
    to = 0
  const flush = () => {
    if (!group.length) return
    const parts: string[] = []
    let end = from
    for (const change of group) {
      parts.push(source.sliceRaw(end, change.from), change.insert)
      end = change.to
    }
    parts.push(source.sliceRaw(end, to))
    const insert = normalizedSource(parts.join(''))
    if (normalizedSource(source.sliceRaw(from, to)) === insert) return
    const editorFrom = source.rawToEditor(from),
      editorTo = source.rawToEditor(to)
    if (editorFrom === null || editorTo === null)
      throw new Error('Source projection splits a line ending.')
    result.push({ from: editorFrom, to: editorTo, insert })
  }
  for (const change of changes) {
    if (
      !source.isEditBoundary(change.from) ||
      !source.isEditBoundary(change.to)
    )
      throw new Error('Source projection requires exact edit boundaries.')
    const start =
      change.from > 0 && source.sliceRaw(change.from - 1, change.from) === '\r'
        ? change.from - 1
        : change.from
    const end =
      change.to < source.utf16Length &&
      source.sliceRaw(change.to, change.to + 1) === '\n'
        ? change.to + 1
        : change.to
    if (group.length && start > to) {
      flush()
      group = []
    }
    if (!group.length) {
      from = start
      to = end
    } else to = Math.max(to, end)
    group.push(change)
  }
  flush()
  return result
}

/** Normalize a snapshot in chunks when initially constructing a native Text replica. */
export function* normalizedChunks(
  source: SourceSnapshot,
  from = 0,
  to = source.utf16Length,
): Iterable<string> {
  if (!source.isEditBoundary(from) || !source.isEditBoundary(to) || to < from)
    throw new Error(
      'Normalized source range splits a character or line ending.',
    )
  let carry = ''
  for (const chunk of source.chunks(from, to)) {
    let value = carry + chunk
    carry = ''
    if (value.endsWith('\r')) {
      carry = '\r'
      value = value.slice(0, -1)
    }
    if (value) yield normalizedSource(value)
  }
  if (carry) yield '\n'
}
