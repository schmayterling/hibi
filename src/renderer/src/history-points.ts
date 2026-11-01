import type {
  DocumentSession,
  HistoryGroup,
} from '../../shared/document-session.ts'
import {
  composeSourceBatches,
  type RawEdit,
} from '../../shared/source-operations.ts'

/** A note's undo steps, parents first. Index -1 is the oldest state. */
export type HistoryTree = Readonly<{
  steps: readonly Readonly<{ group: HistoryGroup; parent: number }>[]
  /** The step whose state the note shows. */
  current: number
  /** By parent index + 1, oldest first. */
  children: readonly (readonly number[])[]
  /** When saves kept a state's text as a saved version, by step. */
  versioned: ReadonlyMap<number, number>
}>
export type HistoryPoint = Readonly<{
  step: number
  time: number
  reason:
    | 'oldest'
    | 'stopped'
    | 'branched'
    | 'paused'
    | 'before-large'
    | 'typing'
}>

// Points are where a writer would go back to, not every step: where
// editing stopped or paused, before large edits, where undo branched, and
// every few minutes of steady typing. Points a few characters apart merge,
// and older ones thin out to one an hour, then one a day.
const PAUSE = 5000,
  LARGE = 200,
  TYPING = 3 * 60 * 1000,
  TINY = 20,
  HOUR = 60 * 60 * 1000,
  DAY = 24 * HOUR,
  POINTS = 200

export function historyOf(
  session: Pick<DocumentSession, 'historyTree'>,
): HistoryTree {
  const { root, current, steps, versioned } = session.historyTree()
  const sorted = [...steps].sort(([a], [b]) => a.order - b.order)
  const index = new Map(sorted.map(([group], at) => [group.step, at]))
  const at = (step: object) => (step === root ? -1 : index.get(step)!)
  const children = Array.from(
    { length: sorted.length + 1 },
    () => [] as number[],
  )
  // A state's text is a saved version when a save kept its identity: a
  // step's by the identity it leads to, the oldest state's by the one its
  // first steps leave from.
  const saved = new Map<number, number>()
  const mark = (state: number, identity: object) => {
    const time = versioned.get(identity)
    if (time !== undefined) saved.set(state, time)
  }
  for (const [step, [group, from]] of sorted.entries()) {
    children[at(from) + 1]!.push(step)
    mark(step, group.afterIdentity)
    if (from === root) mark(-1, group.beforeIdentity)
  }
  return {
    steps: sorted.map(([group, from]) => ({ group, parent: at(from) })),
    current: at(current),
    children,
    versioned: saved,
  }
}

/** UTF-16 units a step inserts and removes. */
export const changed = (group: HistoryGroup) =>
  group.forward.reduce(
    (sum, edit) => sum + edit.insert.length + edit.to - edit.from,
    0,
  )
const after = (group: HistoryGroup) =>
  group.forward.reduce(
    (length, edit) => length + edit.insert.length - (edit.to - edit.from),
    group.beforeLength,
  )

/**
 * The points a note's history can go back to, newest first. States saved
 * since `versionsSince`, the oldest saved version still kept, are listed as
 * those versions: other points merge into them, and they are not listed.
 */
export function historyPoints(
  tree: HistoryTree,
  now: number,
  versionsSince = Number.POSITIVE_INFINITY,
): HistoryPoint[] {
  const { steps, children } = tree
  if (!steps.length) return []
  const saved = new Set(
    [...tree.versioned].flatMap(([step, time]) =>
      time >= versionsSince ? [step] : [],
    ),
  )
  const kids = (step: number) => children[step + 1]!
  const time = (step: number) =>
    step === -1 ? steps[kids(-1)[0]!]!.group.started : steps[step]!.group.time
  const reasons = reasonsOf(tree)
  // From the newest, a point a few characters from the one after it merges
  // into it; a point with more than one after it stays.
  const kept = new Set<number>()
  for (let step = steps.length - 1; step >= -1; step--) {
    if (saved.has(step)) kept.add(step)
    if (!reasons.has(step) || kept.has(step)) continue
    // An undone tip a few characters from the point before it merges into it.
    if (step !== tree.current && !kids(step).length) {
      let units = 0
      for (let from = step; ; from = steps[from]!.parent) {
        units += changed(steps[from]!.group)
        const parent = steps[from]!.parent
        if (reasons.has(parent) || saved.has(parent)) break
      }
      if (units < TINY) continue
    }
    const after: number[] = []
    let distance = 0
    const walk = (from: number, units: number) => {
      for (const child of kids(from)) {
        const total = units + changed(steps[child]!.group)
        if (kept.has(child)) {
          after.push(child)
          distance = total
        } else walk(child, total)
      }
    }
    walk(step, 0)
    if (after.length !== 1 || distance >= TINY) kept.add(step)
  }
  const points = [...kept]
    .filter((step) => step !== tree.current && !saved.has(step))
    .map((step) => ({ step, time: time(step), reason: reasons.get(step)! }))
    .sort((a, b) => b.time - a.time || b.step - a.step)
  // Past a day, the newest point an hour; past a week, the newest a day.
  const keep = thinning(now)
  return points.filter(({ time }) => keep(time)).slice(0, POINTS)
}

/** Why each state of a tree with steps is a point, before points merge. */
function reasonsOf({ steps, children }: HistoryTree) {
  const kids = (step: number) => children[step + 1]!
  const time = (step: number) =>
    step === -1 ? steps[kids(-1)[0]!]!.group.started : steps[step]!.group.time
  const reasons = new Map<number, HistoryPoint['reason']>([[-1, 'oldest']])
  for (let step = 0; step < steps.length; step++) {
    const next = kids(step).map((child) => steps[child]!.group)
    if (!next.length) reasons.set(step, 'stopped')
    else if (next.length > 1) reasons.set(step, 'branched')
    else if (next[0]!.started - time(step) >= PAUSE) reasons.set(step, 'paused')
  }
  // The state before a large edit, as a paste or a replace: one edit, not
  // a step of steady typing.
  for (const { group, parent } of steps)
    if (
      group.operations === 1 &&
      changed(group) >= LARGE &&
      !reasons.has(parent)
    )
      reasons.set(parent, 'before-large')
  // Steady typing gets a point every few minutes.
  const last = new Map<number, number>([[-1, time(-1)]])
  for (const [step, { parent }] of steps.entries()) {
    if (!reasons.has(step) && time(step) - last.get(parent)! >= TYPING)
      reasons.set(step, 'typing')
    last.set(step, reasons.has(step) ? time(step) : last.get(parent)!)
  }
  return reasons
}

/**
 * Past a day, the newest an hour; past a week, the newest a day, in the
 * hours and days of the local clock and calendar. Ask newest first.
 */
function thinning(now: number) {
  const buckets = new Set<string>()
  return (time: number) => {
    const age = now - time
    if (age <= DAY) return true
    const date = new Date(time)
    const bucket =
      age > 7 * DAY
        ? date.toDateString()
        : `${date.toDateString()} ${date.getHours()}`
    if (buckets.has(bucket)) return false
    buckets.add(bucket)
    return true
  }
}

/**
 * The saved versions the list shows, newest first. Every save the user asked
 * for shows; autosaved versions thin as points do: one less than a pause
 * before the next save merges into it, and past a day the newest an hour
 * stays, past a week the newest a day. The files themselves stay.
 */
export function shownVersions<
  Version extends Readonly<{ savedAt: number; automatic?: true }>,
>(
  versions: readonly Version[],
  now: number,
  tree: HistoryTree | null = null,
): Version[] {
  const sorted = [...versions].sort((a, b) => b.savedAt - a.savedAt)
  // A state saved as a version is not listed as a point (historyPoints), so
  // a version holding a point of its own does not merge: the newest saved
  // before the session marked the state, as main records it first. The
  // oldest text kept a version of its own before this session's saves.
  const reasons = tree?.steps.length ? reasonsOf(tree) : new Map()
  const holding = new Set(
    [...(tree?.versioned ?? [])].flatMap(([step, time]) =>
      step >= 0 && reasons.has(step)
        ? [sorted.find(({ savedAt }) => savedAt <= time)]
        : [],
    ),
  )
  const keep = thinning(now)
  return sorted.filter((version, index) => {
    if (!version.automatic) return true
    const newer = sorted[index - 1]
    if (
      newer &&
      newer.savedAt - version.savedAt < PAUSE &&
      !holding.has(version)
    )
      return false
    return keep(version.savedAt)
  })
}

/** The steps to undo from `from` and redo to `to`, in the order to take them. */
export function historyPath(tree: HistoryTree, from: number, to: number) {
  const ancestors = new Set<number>()
  for (let step = from; step !== -1; step = tree.steps[step]!.parent)
    ancestors.add(step)
  const redo: number[] = []
  let shared = to
  for (
    ;
    shared !== -1 && !ancestors.has(shared);
    shared = tree.steps[shared]!.parent
  )
    redo.unshift(shared)
  const undo: number[] = []
  for (let step = from; step !== shared; step = tree.steps[step]!.parent)
    undo.push(step)
  return { undo, redo }
}

/** One edit list that takes the text of state `from` to that of state `to`. */
export function historyChanges(
  tree: HistoryTree,
  from: number,
  to: number,
): readonly RawEdit[] {
  const { undo, redo } = historyPath(tree, from, to)
  return composeSourceBatches([
    ...undo.map((step) => {
      const { group } = tree.steps[step]!
      return { changes: group.inverse, length: after(group) }
    }),
    ...redo.map((step) => {
      const { group } = tree.steps[step]!
      return { changes: group.forward, length: group.beforeLength }
    }),
  ])
}

/**
 * Takes the session to state `to` along its history, as undo and redo
 * would. Returns whether it got there.
 */
export function goToStep(
  session: Pick<DocumentSession, 'undo' | 'redo' | 'followBranch'>,
  tree: HistoryTree,
  to: number,
) {
  const { undo, redo } = historyPath(tree, tree.current, to)
  for (let step = 0; step < undo.length; step++)
    if (!session.undo()) return false
  for (const step of redo)
    if (!session.followBranch(tree.steps[step]!.group.step) || !session.redo())
      return false
  return true
}

const words = (text: string) => text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0
/** Words a span of steps added and removed, and the first line it changed. */
export function historySummary(tree: HistoryTree, from: number, to: number) {
  const { undo, redo } = historyPath(tree, from, to)
  let added = 0,
    removed = 0,
    line = ''
  const count = (inserted: readonly RawEdit[], deleted: readonly RawEdit[]) => {
    for (const edit of inserted) {
      added += words(edit.insert)
      line ||= edit.insert
        .trim()
        .split(/\r?\n|\r/)[0]!
        .trim()
    }
    for (const edit of deleted) removed += words(edit.insert)
  }
  for (const step of undo) {
    const { group } = tree.steps[step]!
    count(group.inverse, group.forward)
  }
  for (const step of redo) {
    const { group } = tree.steps[step]!
    count(group.forward, group.inverse)
  }
  return { added, removed, line }
}

// ponytail: a preview part shows its first 10,000 characters; a streamed
// viewport would show all of a whole-note change.
const shown = (part: string) =>
  part.length > 10_000 ? `${part.slice(0, 10_000)}…` : part
/**
 * Each change with the line before it and after it, 300 characters of each
 * at most: a change beside a long line (a pasted image, minified data)
 * shows only the text nearest it.
 */
export function changeLines(text: string, changes: readonly RawEdit[]) {
  const start = (at: number) => text.lastIndexOf('\n', at - 1) + 1
  const end = (at: number) => {
    const found = text.indexOf('\n', at)
    return found < 0 ? text.length : found
  }
  return (
    changes
      // Two branches that made the same edit replace a span with itself.
      .filter(({ from, to, insert }) => text.slice(from, to) !== insert)
      .map(({ from, to, insert }) => {
        const before = start(Math.max(0, start(from) - 1)),
          after = end(Math.min(text.length, end(to) + 1))
        return {
          before:
            from - before > 300
              ? `…${text.slice(from - 300, from)}`
              : text.slice(before, from),
          removed: shown(text.slice(from, to)),
          added: shown(insert),
          after:
            after - to > 300
              ? `${text.slice(to, to + 300)}…`
              : text.slice(to, after),
        }
      })
  )
}
