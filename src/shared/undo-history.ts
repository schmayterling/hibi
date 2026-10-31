import type { DocumentSession, HistoryGroup } from './document-session.ts'
import { editBytes, type RawEdit, safePosition } from './source-operations.ts'
import type { SourceSelection } from './source-selection.ts'

export const UNDO_HISTORY_CHANNELS = {
  store: 'undo-history:store',
  read: 'undo-history:read',
  flush: 'undo-history:flush',
  flushed: 'undo-history:flushed',
  keep: 'undo-history:keep',
  setKeep: 'undo-history:set-keep',
  clear: 'undo-history:clear',
} as const

/** A kept undo step: its edit from its parent's state and back, and the carets around it. */
export type UndoHistoryStep = Readonly<{
  /** The step whose state this one leaves, earlier in the list; -1 is the oldest state. */
  parent: number
  origin: 'source' | 'visual' | 'composition' | 'addon'
  forward: readonly RawEdit[]
  inverse: readonly RawEdit[]
  beforeLength: number
  before: SourceSelection | null
  after: SourceSelection | null
  operations: number
  started: number
  time: number
}>
/** The undo steps made up to a save, from the state that save wrote. */
export type UndoHistory = Readonly<{
  /** The step whose state the save wrote; -1 is the oldest state. */
  saved: number
  /** The saved state's length in UTF-16 units. */
  units: number
  /** The saved state's content version. */
  version: number
  steps: readonly UndoHistoryStep[]
}>

const origins = ['source', 'visual', 'composition', 'addon'] as const
const invalid = () => new Error('Saved undo history is invalid.')
const record = (value: unknown) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

/** Sorted, disjoint edits inside a source of `length` units, as source operations take them; returns the length after them. */
function edits(value: unknown, length: number) {
  if (!Array.isArray(value) || !value.length || value.length > 100_000)
    throw invalid()
  let previous: RawEdit | undefined,
    after = length
  for (const edit of value as RawEdit[]) {
    if (
      !record(edit) ||
      !safePosition(edit.from) ||
      !safePosition(edit.to) ||
      edit.to < edit.from ||
      edit.to > length ||
      typeof edit.insert !== 'string' ||
      /[\uD800-\uDFFF]/u.test(edit.insert) ||
      (previous &&
        (edit.from < previous.to ||
          (edit.from === previous.to &&
            (edit.from === edit.to || previous.from === previous.to))))
    )
      throw invalid()
    after += edit.insert.length - (edit.to - edit.from)
    previous = edit
  }
  return after
}

function selection(value: unknown, length: number) {
  if (value === null) return
  const parsed = record(value)
  if (
    !parsed ||
    !Array.isArray(parsed.ranges) ||
    !parsed.ranges.length ||
    parsed.ranges.length > 10_000 ||
    !Number.isSafeInteger(parsed.mainIndex) ||
    (parsed.mainIndex as number) < 0 ||
    (parsed.mainIndex as number) >= parsed.ranges.length ||
    parsed.ranges.some((item: unknown) => {
      const range = record(item)
      return (
        !range ||
        !safePosition(range.anchor) ||
        !safePosition(range.head) ||
        range.anchor > length ||
        range.head > length ||
        (range.association !== 1 && range.association !== -1)
      )
    })
  )
    throw invalid()
}

/**
 * Checks that a stored history is a tree of edits whose lengths line up from
 * the oldest state to the saved one. Text is checked when steps are applied.
 */
export function parseUndoHistory(value: unknown): UndoHistory {
  const history = record(value)
  if (
    !history ||
    !Array.isArray(history.steps) ||
    !safePosition(history.units) ||
    !safePosition(history.version) ||
    !Number.isSafeInteger(history.saved) ||
    (history.saved as number) < -1 ||
    (history.saved as number) >= history.steps.length
  )
    throw invalid()
  const lengths: number[] = []
  let root: number | undefined
  for (const [index, value] of (history.steps as unknown[]).entries()) {
    const step = record(value)
    if (
      !step ||
      !Number.isSafeInteger(step.parent) ||
      (step.parent as number) < -1 ||
      (step.parent as number) >= index ||
      !origins.includes(step.origin as (typeof origins)[number]) ||
      !Number.isSafeInteger(step.operations) ||
      (step.operations as number) < 1 ||
      ![step.started, step.time].every(
        (time) => typeof time === 'number' && Number.isFinite(time),
      ) ||
      !safePosition(step.beforeLength)
    )
      throw invalid()
    const before = step.beforeLength as number
    if (step.parent === -1) root ??= before
    if (before !== (step.parent === -1 ? root : lengths[step.parent as number]))
      throw invalid()
    const after = edits(step.forward, before)
    if (edits(step.inverse, after) !== before) throw invalid()
    selection(step.before, before)
    selection(step.after, after)
    lengths.push(after)
  }
  const saved = history.saved === -1 ? root : lengths[history.saved as number]
  if (saved !== undefined && saved !== history.units) throw invalid()
  return history as UndoHistory
}

/** A session's steps up to its last save, as they are stored; null when no kept step leads there. */
export function keptHistory(
  session: Pick<DocumentSession, 'historyToSave'>,
): UndoHistory | null {
  const kept = session.historyToSave()
  if (!kept) return null
  // Parents come first: a step is made after the one it leaves from.
  const steps = [...kept.steps].sort(([a], [b]) => a.order - b.order)
  const index = new Map(steps.map(([group], at) => [group.step, at]))
  const at = (step: object) => (step === kept.root ? -1 : index.get(step)!)
  return {
    saved: at(kept.saved),
    units: kept.snapshot.utf16Length,
    version: kept.snapshot.version,
    steps: steps.map(([group, from]) => ({
      parent: at(from),
      origin: group.origin as UndoHistoryStep['origin'],
      forward: group.forward,
      inverse: group.inverse,
      beforeLength: group.beforeLength,
      before: group.beforeSelection,
      after: group.afterSelection,
      operations: group.operations,
      started: group.started,
      time: group.time,
    })),
  }
}

/**
 * Builds a stored history's steps for `DocumentSession.restoreHistory`,
 * leading to the session's opening state, the one `saved` names. Redo leads
 * to it, and past it follows the newest step, as undo leaves them; every
 * other step starts a branch.
 */
export const restoredHistory =
  ({ steps, saved }: UndoHistory, viewId = 'default') =>
  (opening: Readonly<{ step: object; identity: object }>) => {
    const keys = steps.map((_, index) => (index === saved ? opening.step : {}))
    const identities = steps.map((_, index) =>
      index === saved ? opening.identity : {},
    )
    const root = saved === -1 ? opening.step : {},
      rootIdentity = saved === -1 ? opening.identity : {}
    const groups = steps.map(
      (step, index): HistoryGroup =>
        Object.freeze({
          id: crypto.randomUUID(),
          origin: step.origin,
          forward: step.forward,
          inverse: step.inverse,
          beforeLength: step.beforeLength,
          beforeIdentity:
            step.parent === -1 ? rootIdentity : identities[step.parent]!,
          afterIdentity: identities[index]!,
          bytes: editBytes(step.forward) + editBytes(step.inverse),
          operations: step.operations,
          beforeSelection: step.before,
          afterSelection: step.after,
          viewId,
          step: keys[index]!,
          // Older than any step the session makes.
          order: index - steps.length,
          started: step.started,
          time: step.time,
        }),
    )
    const children = steps.map(() => [] as number[])
    const top: number[] = []
    for (const [index, step] of steps.entries())
      (step.parent === -1 ? top : children[step.parent]!).push(index)
    const path: number[] = []
    for (let index = saved; index !== -1; index = steps[index]!.parent)
      path.push(index)
    path.reverse()
    const onPath = new Set(path)
    // By state index + 1, the step its chain goes on with.
    const next = [top, ...children].map(
      (choices) => choices.find((child) => onPath.has(child)) ?? choices.at(-1),
    )
    // A redo stack from `start` on.
    const chain = (start: number | undefined) => {
      const redo: HistoryGroup[] = []
      for (let index = start; index !== undefined; index = next[index + 1])
        redo.push(groups[index]!)
      return redo.reverse()
    }
    const branches: (readonly [object, HistoryGroup[]])[] = []
    for (let parent = -1; parent < steps.length; parent++)
      for (const child of parent === -1 ? top : children[parent]!)
        if (child !== next[parent + 1])
          branches.push([parent === -1 ? root : keys[parent]!, chain(child)])
    return {
      root,
      undo: path.map((index) => groups[index]!),
      redo: chain(next[saved + 1]),
      branches,
    }
  }
