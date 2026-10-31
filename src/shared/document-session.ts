import {
  type PreparedSourceOperation,
  type SourceBufferOptions,
  type SourceSnapshot,
  type SourceStorageChange,
  SourceStore,
} from './source-buffer.ts'
import { SourceMaintenance } from './source-maintenance.ts'
import {
  composeSourceChanges,
  type DocumentKey,
  editBytes,
  type RawEdit,
  type SourceOperation,
} from './source-operations.ts'
import {
  mapSourceSelection,
  type SourceSelection,
  sourceSelection,
} from './source-selection.ts'

export type HistoryGroup = Readonly<{
  id: string
  origin: SourceOperation['origin']
  forward: readonly RawEdit[]
  inverse: readonly RawEdit[]
  beforeLength: number
  beforeIdentity: object
  afterIdentity: object
  bytes: number
  operations: number
  beforeSelection: SourceSelection | null
  afterSelection: SourceSelection | null
  viewId: string
  /** The state the step leads to; a renamed view's steps keep it. */
  step: object
  /** Steps are numbered in the order they were made. */
  order: number
  started: number
  time: number
}>
/** A state as a snapshot held it: its step, how many steps were made by then, and the step's edit. */
type StepAt = Readonly<{ step: object; order: number; after: object | null }>
export type SessionState = Readonly<{
  document: DocumentKey
  contentVersion: number
  dirty: boolean
  canUndo: boolean
  canRedo: boolean
}>
type SessionOptions = SourceBufferOptions & {
  historyBytes?: number
  historyGroups?: number
  /** The clock history steps are timed with. */
  now?: () => number
  /** Reject saturation before source/history/view commit; no accepted edit is dropped. */
  admit?: (operation: SourceOperation) => void
  /** Must synchronously enqueue recovery. It must not wait for acknowledgement. */
  enqueue: (operation: SourceOperation) => void
  onError: (error: unknown) => void
}
export type AcceptedSourceEdit = Readonly<{
  prepared: PreparedSourceOperation
  /** Finish after the accepted native editor transaction updates its view. */
  finish: () => void
}>
/** A step's caret, or none where the text it returns to cannot hold it. */
const restorable = (
  snapshot: SourceSnapshot,
  selection: SourceSelection | null,
) => {
  try {
    return selection && sourceSelection(snapshot, selection)
  } catch {
    return null
  }
}

/** Source authority and history live outside UI frameworks and editing widgets. */
export class DocumentSession {
  readonly #store: SourceStore
  readonly #options: SessionOptions
  readonly #listeners = new Set<() => void>()
  readonly #operationListeners = new Set<
    (operation: PreparedSourceOperation) => void
  >()
  readonly #selectionListeners = new Set<() => void>()
  readonly #storageListeners = new Set<(change: SourceStorageChange) => void>()
  readonly #maintenance: SourceMaintenance
  readonly #identities = new WeakMap<SourceSnapshot, object>()
  #undo: HistoryGroup[] = []
  #redo: HistoryGroup[] = []
  /** Redo stacks that edits replaced, by the state they leave from. */
  readonly #branches = new Map<object, HistoryGroup[][]>()
  /** The oldest state history reaches. */
  #root: object = {}
  readonly #opening = this.#root
  readonly #openingLength: number
  #restored = false
  #order = 0
  readonly #steps = new WeakMap<SourceSnapshot, StepAt>()
  /** The state the last save wrote, with how many steps were made by then. */
  #savedAt: StepAt | null = null
  /** Edits no longer merge into the step leading to the state a save took. */
  #sealed: object | null = null
  #saved: SourceSnapshot
  #contentIdentity: object = {}
  #savedIdentity = this.#contentIdentity
  readonly #openingIdentity = this.#contentIdentity
  #state: SessionState
  #dispatching = false
  #disposed = false
  #verification = 0
  #verificationTimer: ReturnType<typeof setTimeout> | undefined
  #cancelVerification: (() => void) | undefined
  #settled: Promise<void> = Promise.resolve()
  #selection: SourceSelection | null = null
  readonly #viewSelections = new Map<string, SourceSelection | null>()
  /** How far above a source pane's kept top line its scroll position was, by view id. */
  readonly keptMargins = new Map<string, number>()

  constructor(
    source: string | SourceStore,
    document: DocumentKey,
    version: number,
    options: SessionOptions,
  ) {
    this.#options = Object.freeze({ ...options })
    this.#store =
      source instanceof SourceStore
        ? options.maximumBytes === undefined
          ? source
          : SourceStore.fromSnapshot(source.snapshot(), document, version, {
              maximumBytes: options.maximumBytes,
            })
        : new SourceStore(source, document, version, options)
    const initial = this.#store.snapshot()
    if (
      initial.document.tabId !== document.tabId ||
      initial.document.revision !== document.revision ||
      initial.version !== version
    )
      throw new Error('Source operation is stale.')
    this.#saved = this.#store.snapshot()
    this.#identities.set(this.#saved, this.#contentIdentity)
    this.#openingLength = initial.utf16Length
    this.#savedAt = this.#at()
    this.#steps.set(this.#saved, this.#savedAt)
    this.#state = Object.freeze({
      document: this.#saved.document,
      contentVersion: version,
      dirty: false,
      canUndo: false,
      canRedo: false,
    })
    this.#maintenance = new SourceMaintenance(
      this.#store,
      this.#adoptStorage,
      options.onError,
    )
  }
  snapshot = () => this.#store.snapshot()
  savedSnapshot = () => this.#saved
  ownsCurrentSnapshot = (snapshot: SourceSnapshot) =>
    !this.#disposed && this.#store.ownsCurrentSnapshot(snapshot)
  subscribeStorage = (listener: (change: SourceStorageChange) => void) => {
    this.#storageListeners.add(listener)
    return () => {
      this.#storageListeners.delete(listener)
    }
  }
  maintainStorage() {
    if (this.#dispatching)
      throw new Error('Document session is dispatching another operation.')
    return this.#maintenance.request()
  }
  #adoptStorage = (change: SourceStorageChange) => {
    if (this.#disposed || this.#dispatching)
      throw new Error('Document session is disposed or busy.')
    this.#dispatching = true
    try {
      this.#store.commitCompaction(change)
      this.#identities.set(change.after, this.#contentIdentity)
      const at = this.#steps.get(change.before)
      if (at) this.#steps.set(change.after, at)
      if (this.#saved === change.before) this.#saved = change.after
      for (const listener of [...this.#storageListeners]) {
        try {
          listener(change)
        } catch (error) {
          this.#options.onError(error)
        }
      }
    } finally {
      this.#dispatching = false
      this.#verifySaved()
    }
  }
  state = () => this.#state
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }
  subscribeOperations = (
    listener: (operation: PreparedSourceOperation) => void,
  ) => {
    this.#operationListeners.add(listener)
    return () => {
      this.#operationListeners.delete(listener)
    }
  }
  selection = (viewId = 'default') =>
    viewId === 'default'
      ? this.#selection
      : (this.#viewSelections.get(viewId) ?? null)
  releaseView(viewId: string) {
    if (viewId !== 'default') this.#viewSelections.delete(viewId)
  }
  /**
   * A view's selections and history steps follow it to a new id, as a pane's
   * do when a split opens or closes, so its steps stay its own. The ids of
   * the views it hosts, `${id}:…`, follow with it, with the places they keep.
   * Not for 'default': its selection is the session's own.
   */
  renameView(from: string, to: string) {
    const renamed = (id: string) =>
      id === from || id.startsWith(`${from}:`) ? to + id.slice(from.length) : id
    const follow = (groups: HistoryGroup[]) =>
      groups.map((group) => {
        const viewId = renamed(group.viewId)
        return viewId === group.viewId
          ? group
          : Object.freeze({ ...group, viewId })
      })
    this.#undo = follow(this.#undo)
    this.#redo = follow(this.#redo)
    for (const [from, chains] of this.#branches)
      this.#branches.set(from, chains.map(follow))
    const kept: Map<string, unknown>[] = [
      this.#viewSelections,
      this.keptMargins,
    ]
    for (const values of kept)
      for (const [id, value] of [...values])
        if (renamed(id) !== id) {
          values.delete(id)
          values.set(renamed(id), value)
        }
  }
  subscribeSelection = (listener: () => void) => {
    this.#selectionListeners.add(listener)
    return () => {
      this.#selectionListeners.delete(listener)
    }
  }
  select(
    selection: SourceSelection,
    version = this.snapshot().version,
    viewId = 'default',
  ) {
    if (
      this.#disposed ||
      this.#dispatching ||
      version !== this.snapshot().version
    )
      throw new Error('Source selection is stale or the session is busy.')
    const next = sourceSelection(this.snapshot(), selection)
    if (JSON.stringify(next) === JSON.stringify(this.selection(viewId))) return
    if (viewId === 'default') this.#selection = next
    else this.#viewSelections.set(viewId, next)
    this.#notifySelection()
  }
  reidentify(document: DocumentKey) {
    if (this.#disposed || this.#dispatching)
      throw new Error('Document session is disposed or busy.')
    this.#maintenance.cancel()
    const at = this.#steps.get(this.snapshot())
    const current = this.#store.reidentify(document)
    this.#identities.set(current, this.#contentIdentity)
    if (at) this.#steps.set(current, at)
    this.#publish()
  }
  counters(reset = false) {
    return this.#store.counters(reset)
  }
  historySize() {
    let groups = 0,
      bytes = 0
    for (const [group] of this.#kept()) {
      groups++
      bytes += group.bytes
    }
    return { groups, bytes }
  }
  /** Every kept step with the state it leaves from: undo, redo, then branches. */
  *#kept(): Generator<readonly [HistoryGroup, object]> {
    let from = this.#root
    for (const group of this.#undo) {
      yield [group, from]
      from = group.step
    }
    for (let index = this.#redo.length - 1; index >= 0; index--) {
      yield [this.#redo[index]!, from]
      from = this.#redo[index]!.step
    }
    for (const [start, chains] of this.#branches)
      for (const chain of chains)
        for (let index = chain.length - 1; index >= 0; index--)
          yield [chain[index]!, chain[index + 1]?.step ?? start]
  }
  #at(): StepAt {
    const group = this.#undo.at(-1)
    return {
      step: group?.step ?? this.#root,
      order: this.#order,
      after: group?.afterIdentity ?? null,
    }
  }
  /** Whether a kept step still leads to the state a snapshot held. */
  #holds({ step, after }: StepAt) {
    if (step === this.#root) return true
    for (const [group] of this.#kept())
      if (group.step === step) return !after || group.afterIdentity === after
    return false
  }
  /** Opaque content identity retained by undo/redo and storage compaction. */
  historyIdentity = () => this.#contentIdentity
  historyDepth() {
    return { undo: this.#undo.length, redo: this.#redo.length }
  }
  /** The view whose selection the next undo or redo restores: the one that made its edit. */
  historyView(direction: 'undo' | 'redo') {
    return (direction === 'undo' ? this.#undo : this.#redo).at(-1)?.viewId
  }
  /** Release older history without changing source, selection or saved identity. */
  limitHistory(
    bytes: number,
    groups: number,
    retained?: (usage: { bytes: number; groups: number }) => void,
  ) {
    if (
      this.#disposed ||
      ![bytes, groups].every(
        (value) => Number.isSafeInteger(value) && value >= 0,
      )
    )
      throw new Error(
        'Document history limits are invalid or the session is disposed.',
      )
    this.#trim(bytes, groups)
    // Update the owner's accounting before history observers can run again.
    retained?.(this.historySize())
    // An accepted native edit will notify after its view finishes reconciliation.
    this.#publish(!this.#dispatching)
  }

  #publish(notify = true) {
    const current = this.snapshot()
    const next = {
      document: current.document,
      contentVersion: current.version,
      dirty: this.#contentIdentity !== this.#savedIdentity,
      canUndo: this.#undo.length > 0,
      canRedo: this.#redo.length > 0,
    }
    if (
      Object.keys(next).every(
        (key) =>
          next[key as keyof SessionState] ===
          this.#state[key as keyof SessionState],
      )
    )
      return false
    this.#state = Object.freeze(next)
    if (notify) this.#notify()
    return true
  }
  #notify() {
    for (const listener of [...this.#listeners]) {
      try {
        listener()
      } catch (error) {
        this.#options.onError(error)
      }
    }
  }
  #notifySelection() {
    for (const listener of [...this.#selectionListeners]) {
      try {
        listener()
      } catch (error) {
        this.#options.onError(error)
      }
    }
  }
  #trim(
    maximumBytes = this.#options.historyBytes ?? 8 * 1024 * 1024,
    maximumGroups = this.#options.historyGroups ?? 128,
  ) {
    let { bytes, groups } = this.historySize()
    // Branches go first, oldest first: undo and redo never reach them.
    while (
      this.#branches.size &&
      (bytes > maximumBytes || groups > maximumGroups)
    ) {
      let oldest: readonly [object, HistoryGroup[]] | undefined
      for (const [from, chains] of this.#branches)
        for (const chain of chains)
          if (!oldest || chain.at(-1)!.order < oldest[1].at(-1)!.order)
            oldest = [from, chain]
      const dropped = this.#dropBranch(...oldest!)
      bytes -= dropped.bytes
      groups -= dropped.groups
    }
    while (
      this.#undo.length &&
      (bytes > maximumBytes ||
        this.#undo.length + this.#redo.length > maximumGroups)
    ) {
      const dropped = this.#undo.shift()!
      bytes -= dropped.bytes
      this.#root = dropped.step
    }
    while (
      this.#redo.length &&
      (bytes > maximumBytes || this.#redo.length > maximumGroups)
    )
      bytes -= this.#redo.shift()!.bytes
  }
  #dropBranch(from: object, chain: readonly HistoryGroup[]) {
    const chains = this.#branches.get(from)!.filter((kept) => kept !== chain)
    if (chains.length) this.#branches.set(from, chains)
    else this.#branches.delete(from)
    let bytes = 0,
      groups = 0
    for (const group of chain) {
      bytes += group.bytes
      groups++
      for (const nested of this.#branches.get(group.step) ?? []) {
        const dropped = this.#dropBranch(group.step, nested)
        bytes += dropped.bytes
        groups += dropped.groups
      }
    }
    return { bytes, groups }
  }
  #record(
    prepared: PreparedSourceOperation,
    beforeSelection: SourceSelection | null,
    viewId: string,
  ) {
    const previous = this.#undo.at(-1),
      operation = prepared.operation
    const afterIdentity = {},
      time = this.#options.now?.() ?? Date.now()
    let forward = operation.changes,
      inverse = prepared.inverse
    const merge =
      previous?.id === operation.historyGroup &&
      previous.viewId === viewId &&
      previous.origin === operation.origin &&
      previous.operations < 256 &&
      previous.bytes + editBytes(forward) + editBytes(inverse) < 128 * 1024 &&
      // A merge changes the state its step leads to: never one a save took
      // or other steps leave from.
      previous.step !== this.#sealed &&
      !this.#redo.length &&
      !this.#branches.has(previous.step)
    if (merge) {
      forward = composeSourceChanges(
        previous.forward,
        forward,
        previous.beforeLength,
      )
      inverse = composeSourceChanges(
        inverse,
        previous.inverse,
        prepared.after.utf16Length,
      )
      this.#undo.pop()
      if (
        inverse.every(
          (edit) => prepared.after.sliceRaw(edit.from, edit.to) === edit.insert,
        )
      ) {
        this.#contentIdentity = previous.beforeIdentity
        return
      }
    } else if (this.#redo.length) {
      // An edit after undo keeps the steps it replaces as a branch.
      const from = previous?.step ?? this.#root
      this.#branches.set(from, [
        ...(this.#branches.get(from) ?? []),
        this.#redo,
      ])
    }
    this.#undo.push(
      Object.freeze({
        id: operation.historyGroup,
        origin: operation.origin,
        forward,
        inverse,
        beforeLength: merge
          ? previous.beforeLength
          : prepared.before.utf16Length,
        beforeIdentity: merge ? previous.beforeIdentity : this.#contentIdentity,
        afterIdentity,
        bytes: editBytes(forward) + editBytes(inverse),
        operations: merge ? previous.operations + 1 : 1,
        beforeSelection: merge ? previous.beforeSelection : beforeSelection,
        afterSelection: this.selection(viewId),
        viewId,
        step: merge ? previous.step : {},
        order: merge ? previous.order : ++this.#order,
        started: merge ? previous.started : time,
        time,
      }),
    )
    this.#contentIdentity = afterIdentity
    this.#redo = []
    this.#trim()
  }
  #operation(
    changes: readonly RawEdit[],
    origin: SourceOperation['origin'],
    group: string,
  ): SourceOperation {
    const before = this.snapshot()
    return {
      document: before.document,
      operationId: crypto.randomUUID(),
      baseVersion: before.version,
      contentVersion: before.version + 1,
      origin,
      historyGroup: group,
      changes,
    }
  }
  #begin(
    operation: SourceOperation,
    history: (
      prepared: PreparedSourceOperation,
      beforeSelection: SourceSelection | null,
    ) => void,
    selection?: (prepared: PreparedSourceOperation) => SourceSelection | null,
    viewId = 'default',
  ): AcceptedSourceEdit {
    if (this.#disposed || this.#dispatching)
      throw new Error(
        'Document session is disposed or dispatching another operation.',
      )
    this.#dispatching = true
    this.#maintenance.cancel()
    let prepared: PreparedSourceOperation | undefined
    try {
      prepared = this.#store.prepare(operation)
      const accepted = prepared,
        beforeSelection = this.selection(viewId)
      const requested = selection?.(prepared)
      const afterSelection = selection
        ? requested
          ? sourceSelection(prepared.after, requested)
          : null
        : mapSourceSelection(prepared.after, beforeSelection, operation.changes)
      this.#options.admit?.(prepared.operation)
      this.#store.commit(prepared)
      if (viewId === 'default') this.#selection = afterSelection
      else this.#viewSelections.set(viewId, afterSelection)
      if (viewId !== 'default')
        this.#selection = mapSourceSelection(
          prepared.after,
          this.#selection,
          operation.changes,
        )
      for (const [otherId, otherSelection] of this.#viewSelections)
        if (otherId !== viewId)
          this.#viewSelections.set(
            otherId,
            mapSourceSelection(
              prepared.after,
              otherSelection,
              operation.changes,
            ),
          )
      history(prepared, beforeSelection)
      this.#identities.set(prepared.after, this.#contentIdentity)
      this.#steps.set(prepared.after, this.#at())
      const changed = this.#publish(false)
      // Source is already savable when enqueue/reconcile or an observer runs.
      // Failures preserve accepted source and are reported, never rolled back.
      const errors: unknown[] = []
      try {
        this.#options.enqueue(prepared.operation)
      } catch (error) {
        errors.push(error)
      }
      let finished = false
      return Object.freeze({
        prepared: accepted,
        finish: () => {
          if (finished) return
          finished = true
          try {
            for (const listener of [...this.#operationListeners]) {
              try {
                listener(accepted)
              } catch (error) {
                errors.push(error)
              }
            }
            if (changed) this.#notify()
            if (beforeSelection !== afterSelection) this.#notifySelection()
            for (const error of errors) this.#options.onError(error)
          } finally {
            this.#dispatching = false
            this.#verifySaved()
            this.#maintenance.changed(
              accepted.operation.changes.reduce(
                (sum, edit) => sum + edit.to - edit.from + edit.insert.length,
                0,
              ),
            )
          }
        },
      })
    } catch (error) {
      if (prepared) this.#store.abort(prepared)
      this.#dispatching = false
      throw error
    }
  }
  #accept(
    operation: SourceOperation,
    history: (
      prepared: PreparedSourceOperation,
      beforeSelection: SourceSelection | null,
    ) => void,
    reconcile?: (prepared: PreparedSourceOperation) => void,
    selection?: (prepared: PreparedSourceOperation) => SourceSelection | null,
    viewId = 'default',
  ) {
    const accepted = this.#begin(operation, history, selection, viewId)
    try {
      reconcile?.(accepted.prepared)
    } catch (error) {
      this.#options.onError(error)
    } finally {
      accepted.finish()
    }
    return accepted.prepared
  }
  beginEdit(
    changes: readonly RawEdit[],
    origin: SourceOperation['origin'],
    historyGroup: string,
    selection?: (prepared: PreparedSourceOperation) => SourceSelection | null,
    viewId = 'default',
  ): AcceptedSourceEdit {
    if (origin === 'undo' || origin === 'redo')
      throw new Error('Use session history for undo and redo.')
    return this.#begin(
      this.#operation(changes, origin, historyGroup),
      (prepared, beforeSelection) =>
        this.#record(prepared, beforeSelection, viewId),
      selection,
      viewId,
    )
  }
  edit(
    changes: readonly RawEdit[],
    origin: SourceOperation['origin'],
    historyGroup: string,
    reconcile?: (prepared: PreparedSourceOperation) => void,
    selection?: (prepared: PreparedSourceOperation) => SourceSelection | null,
    viewId = 'default',
  ) {
    if (origin === 'undo' || origin === 'redo')
      throw new Error('Use session history for undo and redo.')
    return this.#accept(
      this.#operation(changes, origin, historyGroup),
      (prepared, beforeSelection) =>
        this.#record(prepared, beforeSelection, viewId),
      reconcile,
      selection,
      viewId,
    )
  }
  undo(reconcile?: (prepared: PreparedSourceOperation) => void) {
    const group = this.#undo.at(-1)
    if (!group) return null
    return this.#accept(
      this.#operation(group.inverse, 'undo', group.id),
      () => {
        this.#undo.pop()
        this.#redo.push(group)
        this.#contentIdentity = group.beforeIdentity
      },
      reconcile,
      (prepared) => restorable(prepared.after, group.beforeSelection),
      group.viewId,
    )
  }
  redo(reconcile?: (prepared: PreparedSourceOperation) => void) {
    const group = this.#redo.at(-1)
    if (!group) return null
    return this.#accept(
      this.#operation(group.forward, 'redo', group.id),
      () => {
        this.#redo.pop()
        this.#undo.push(group)
        this.#contentIdentity = group.afterIdentity
      },
      reconcile,
      (prepared) => restorable(prepared.after, group.afterSelection),
      group.viewId,
    )
  }
  markSaved(snapshot: SourceSnapshot) {
    const current = this.#store.ownsCurrentSnapshot(snapshot)
    const identity = current
      ? this.#contentIdentity
      : this.#identities.get(snapshot)
    if (!identity)
      throw new Error('Saved snapshot does not belong to this session.')
    this.#saved = current ? this.snapshot() : snapshot
    this.#savedIdentity = identity
    this.#savedAt = this.#steps.get(this.#saved) ?? null
    this.#sealed = this.#savedAt?.step ?? this.#sealed
    this.#publish()
    this.#verifySaved()
  }
  /** A save takes the current state: later edits start a new step, so a step still leads to it. */
  sealHistory() {
    this.#sealed = this.#at().step
  }
  /**
   * The steps made up to the last save, each with the state it leaves from,
   * and the state that save wrote; null when no kept step leads there. Later
   * edits, saved or discarded, are not in them.
   */
  historyToSave() {
    const saved = this.#savedAt
    if (this.#disposed || !saved || !this.#holds(saved)) return null
    return {
      root: this.#root,
      saved: saved.step,
      snapshot: this.#saved,
      steps: [...this.#kept()].filter(([group]) => group.order <= saved.order),
    }
  }
  /** Every kept step with the state it leaves from, the oldest state and the current one. */
  historyTree() {
    return {
      root: this.#root,
      current: this.#at().step,
      steps: [...this.#kept()],
    }
  }
  /**
   * Redo follows the branch whose first step is `step`, from the current
   * state; the steps redo followed become a branch. Returns whether it could.
   */
  followBranch(step: object) {
    if (this.#redo.at(-1)?.step === step) return true
    const from = this.#at().step
    const chains = this.#branches.get(from) ?? []
    const chain = chains.find((kept) => kept.at(-1)?.step === step)
    if (this.#disposed || this.#dispatching || !chain) return false
    const rest = chains.filter((kept) => kept !== chain)
    if (this.#redo.length) rest.push(this.#redo)
    if (rest.length) this.#branches.set(from, rest)
    else this.#branches.delete(from)
    this.#redo = chain
    this.#publish()
    return true
  }
  /**
   * Takes steps kept from an earlier session that end at this session's
   * opening state, while no trimming has moved past it: `build` makes them
   * lead to its step and identity. Their redo steps become a branch once this
   * session has edited. Returns whether it took them.
   */
  restoreHistory(
    units: number,
    build: (opening: Readonly<{ step: object; identity: object }>) => Readonly<{
      root: object
      undo: readonly HistoryGroup[]
      redo: readonly HistoryGroup[]
      branches: readonly (readonly [object, HistoryGroup[]])[]
    }>,
  ) {
    if (
      this.#disposed ||
      this.#dispatching ||
      this.#restored ||
      this.#root !== this.#opening ||
      units !== this.#openingLength
    )
      return false
    this.#restored = true
    const editing = this.#undo.length > 0 || this.#redo.length > 0
    const restored = build({
      step: this.#opening,
      identity: this.#openingIdentity,
    })
    const branches = [...restored.branches]
    if (!editing) this.#redo = [...restored.redo]
    else if (restored.redo.length)
      branches.push([this.#opening, [...restored.redo]])
    for (const [from, chain] of branches)
      this.#branches.set(from, [...(this.#branches.get(from) ?? []), chain])
    this.#undo = [...restored.undo, ...this.#undo]
    this.#root = restored.root
    this.#trim()
    this.#publish()
    return true
  }
  /** Explicit native save/bootstrap boundary, never called for ordinary input. */
  importSaved(source: string | SourceSnapshot) {
    const current = this.snapshot()
    if (typeof source !== 'string') {
      if (current.sharesRoot(source)) {
        this.markSaved(current)
        return
      }
      this.#saved = source
      this.#savedIdentity = {}
      this.#savedAt = null
      this.#publish()
      this.#verifySaved()
      return
    }
    if (current.materialize() === source) {
      this.markSaved(current)
      return
    }
    this.#saved = new SourceStore(
      source,
      current.document,
      0,
      this.#options,
    ).snapshot()
    this.#savedIdentity = {}
    this.#savedAt = null
    this.#publish()
    this.#verifySaved()
  }
  // Exact equality is deferred only for a different edit path that may return
  // to saved text. Normal commits never compare or hash the complete source.
  #verifySaved() {
    clearTimeout(this.#verificationTimer)
    this.#cancelVerification?.()
    this.#verificationTimer = undefined
    this.#cancelVerification = undefined
    const generation = ++this.#verification,
      current = this.snapshot(),
      saved = this.#saved
    if (
      this.#contentIdentity === this.#savedIdentity ||
      current.utf16Length !== saved.utf16Length ||
      current.utf8Bytes !== saved.utf8Bytes
    )
      return
    this.#settled = new Promise((resolve) => {
      this.#cancelVerification = resolve
      const comparison = current.compare(saved)
      const step = () => {
        if (this.#disposed || generation !== this.#verification) {
          resolve()
          return
        }
        const start = performance.now()
        do {
          const next = comparison.next()
          if (next.done) {
            if (next.value) {
              this.#contentIdentity = this.#savedIdentity
              this.#identities.set(current, this.#savedIdentity)
              this.#publish()
            }
            resolve()
            return
          }
        } while (performance.now() - start < 1)
        this.#verificationTimer = setTimeout(step, 0)
      }
      this.#verificationTimer = setTimeout(step, 0)
    })
  }
  settled() {
    return this.#settled
  }
  dispose() {
    this.#disposed = true
    this.#maintenance.dispose()
    this.#verification++
    clearTimeout(this.#verificationTimer)
    this.#cancelVerification?.()
    this.#verificationTimer = undefined
    this.#cancelVerification = undefined
    this.#listeners.clear()
    this.#operationListeners.clear()
    this.#selectionListeners.clear()
    this.#viewSelections.clear()
    this.#storageListeners.clear()
    this.#undo = []
    this.#redo = []
    this.#branches.clear()
  }
}
