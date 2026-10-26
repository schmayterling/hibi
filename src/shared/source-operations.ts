import { ownSourceText } from './source-text.ts'

/** Coordinates are raw UTF-16 offsets in one immutable pre-state. */
export type RawEdit = Readonly<{ from: number; to: number; insert: string }>
export type DocumentKey = Readonly<{ tabId: string; revision: number }>
export type SourceOperation = Readonly<{
  document: DocumentKey
  operationId: string
  baseVersion: number
  contentVersion: number
  origin: 'source' | 'visual' | 'composition' | 'addon' | 'undo' | 'redo'
  historyGroup: string
  changes: readonly RawEdit[]
}>

export const sourceOperationLimits = {
  changes: 100_000,
  insertedUnits: 16 * 1024 * 1024,
} as const
const identity = (value: unknown): value is string =>
  typeof value === 'string' && /^[\w.:-]{1,128}$/.test(value)
export const safePosition = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0
const parsedOperations = new WeakSet<SourceOperation>()
const origins = [
  'source',
  'visual',
  'composition',
  'addon',
  'undo',
  'redo',
] as const

/** Publish owned, immutable payloads; private brands avoid copying validated messages again. */
export function parseSourceOperation(value: unknown): SourceOperation {
  if (!value || typeof value !== 'object')
    throw new Error('Invalid source operation.')
  if (parsedOperations.has(value as SourceOperation))
    return value as SourceOperation
  const input = value as Partial<SourceOperation>
  const origin = origins.find((origin) => origin === input.origin)
  if (
    !input.document ||
    !identity(input.document.tabId) ||
    !safePosition(input.document.revision) ||
    !identity(input.operationId) ||
    !identity(input.historyGroup) ||
    !safePosition(input.baseVersion) ||
    !safePosition(input.contentVersion) ||
    input.contentVersion !== input.baseVersion + 1 ||
    !origin ||
    !Array.isArray(input.changes) ||
    input.changes.length === 0 ||
    input.changes.length > sourceOperationLimits.changes
  )
    throw new Error(
      'Invalid source operation identity, version, or change count.',
    )
  let previous: RawEdit | undefined,
    insertedUnits = 0
  const changes = input.changes.map((change) => {
    if (
      !change ||
      !safePosition(change.from) ||
      !safePosition(change.to) ||
      change.to < change.from ||
      typeof change.insert !== 'string' ||
      /[\uD800-\uDFFF]/u.test(change.insert)
    )
      throw new Error('Invalid source operation range or Unicode text.')
    if (
      previous &&
      (change.from < previous.to ||
        (change.from === previous.to &&
          (change.from === change.to || previous.from === previous.to)))
    )
      throw new Error(
        'Source operations must have sorted, disjoint ranges without shared insertion boundaries.',
      )
    insertedUnits += change.insert.length
    if (insertedUnits > sourceOperationLimits.insertedUnits)
      throw new Error('Source operation insertion exceeds its limit.')
    previous = change
    return Object.freeze({
      from: change.from,
      to: change.to,
      insert: ownSourceText(change.insert),
    })
  })
  const parsed = Object.freeze({
    document: Object.freeze({
      tabId: ownSourceText(input.document.tabId),
      revision: input.document.revision,
    }),
    operationId: ownSourceText(input.operationId),
    baseVersion: input.baseVersion,
    contentVersion: input.contentVersion,
    origin,
    historyGroup: ownSourceText(input.historyGroup),
    changes: Object.freeze(changes),
  })
  parsedOperations.add(parsed)
  return parsed
}

/** Map a boundary through an atomic operation; association chooses its insertion side. */
export function mapSourcePosition(
  position: number,
  changes: readonly RawEdit[],
  association: -1 | 1 = 1,
) {
  if (!safePosition(position)) throw new Error('Invalid source position.')
  let shift = 0
  for (const change of changes) {
    if (position < change.from) break
    if (position <= change.to)
      return (
        change.from +
        shift +
        ((position === change.to && change.to !== change.from) ||
        association === 1
          ? change.insert.length
          : 0)
      )
    shift += change.insert.length - (change.to - change.from)
  }
  return position + shift
}

/** Composes consecutive edit batches, each with the length of the source it
 * applies to, in neighbouring pairs level by level. Each edit and its inserted
 * text is copied once per level, not once per later batch. */
export function composeSourceBatches(
  batches: readonly Readonly<{ changes: readonly RawEdit[]; length: number }>[],
): readonly RawEdit[] {
  let level = batches
  while (level.length > 1) {
    const next: { changes: readonly RawEdit[]; length: number }[] = []
    for (let index = 0; index < level.length; index += 2) {
      const first = level[index]!,
        second = level[index + 1]
      next.push(
        second
          ? {
              changes: composeSourceChanges(
                first.changes,
                second.changes,
                first.length,
              ),
              length: first.length,
            }
          : first,
      )
    }
    level = next
  }
  return level[0]?.changes ?? []
}
/** Compose two pre-state edit batches without reading or diffing the document. */
export function composeSourceChanges(
  first: readonly RawEdit[],
  second: readonly RawEdit[],
  originalLength: number,
): readonly RawEdit[] {
  type Segment = { from: number; to: number } | { insert: string }
  const segments: Segment[] = []
  let end = 0
  for (const edit of first) {
    if (edit.from < end || edit.to > originalLength)
      throw new Error('Invalid composed source range.')
    if (edit.from > end) segments.push({ from: end, to: edit.from })
    if (edit.insert) segments.push({ insert: edit.insert })
    end = edit.to
  }
  if (end < originalLength) segments.push({ from: end, to: originalLength })
  const output: Segment[] = []
  let segmentIndex = 0,
    consumed = 0,
    position = 0
  const take = (to: number, keep: boolean) => {
    if (!safePosition(to) || to < position)
      throw new Error('Invalid composed source range.')
    while (position < to) {
      const segment = segments[segmentIndex]
      if (!segment)
        throw new Error('Composed source range exceeds its pre-state.')
      const size =
        'insert' in segment ? segment.insert.length : segment.to - segment.from
      const length = Math.min(size - consumed, to - position)
      if (keep)
        output.push(
          'insert' in segment
            ? { insert: segment.insert.slice(consumed, consumed + length) }
            : {
                from: segment.from + consumed,
                to: segment.from + consumed + length,
              },
        )
      consumed += length
      position += length
      if (consumed === size) {
        segmentIndex++
        consumed = 0
      }
    }
  }
  for (const edit of second) {
    take(edit.from, true)
    take(edit.to, false)
    if (edit.insert) output.push({ insert: edit.insert })
  }
  while (segmentIndex < segments.length) {
    const segment = segments[segmentIndex]!
    const size =
      'insert' in segment ? segment.insert.length : segment.to - segment.from
    take(position + size - consumed, true)
  }
  const changes: RawEdit[] = []
  let original = 0,
    insert = ''
  for (const segment of output) {
    if ('insert' in segment) insert += segment.insert
    else {
      if (segment.from > original || insert)
        changes.push(
          Object.freeze({
            from: original,
            to: segment.from,
            insert: ownSourceText(insert),
          }),
        )
      original = segment.to
      insert = ''
    }
  }
  if (original < originalLength || insert)
    changes.push(
      Object.freeze({
        from: original,
        to: originalLength,
        insert: ownSourceText(insert),
      }),
    )
  return Object.freeze(changes)
}
