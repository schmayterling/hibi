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
  type RawEdit,
  type SourceOperation,
} from './source-operations.ts'
import {
  mapSourceSelection,
  type SourceSelection,
  sourceSelection,
} from './source-selection.ts'

type HistoryGroup = Readonly<{
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
}>
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
const editBytes = (changes: readonly RawEdit[]) =>
  changes.reduce((sum, change) => sum + change.insert.length * 2 + 48, 0)

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
  #saved: SourceSnapshot
  #contentIdentity: object = {}
  #savedIdentity = this.#contentIdentity
  #state: SessionState
  #dispatching = false
  #disposed = false
  #verification = 0
  #verificationTimer: ReturnType<typeof setTimeout> | undefined
  #cancelVerification: (() => void) | undefined
  #settled: Promise<void> = Promise.resolve()
  #selection: SourceSelection | null = null
  readonly #viewSelections = new Map<string, SourceSelection | null>()

  constructor(
    source: string,
    document: DocumentKey,
    version: number,
    options: SessionOptions,
  ) {
    this.#options = Object.freeze({ ...options })
    this.#store = new SourceStore(source, document, version, options)
    this.#saved = this.#store.snapshot()
    this.#identities.set(this.#saved, this.#contentIdentity)
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
    const current = this.#store.reidentify(document)
    this.#identities.set(current, this.#contentIdentity)
    this.#publish()
  }
  counters(reset = false) {
    return this.#store.counters(reset)
  }
  historySize() {
    return {
      groups: this.#undo.length + this.#redo.length,
      bytes: [...this.#undo, ...this.#redo].reduce(
        (sum, group) => sum + group.bytes,
        0,
      ),
    }
  }
  historyDepth() {
    return { undo: this.#undo.length, redo: this.#redo.length }
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
    let bytes = this.historySize().bytes
    while (
      this.#undo.length &&
      (bytes > maximumBytes ||
        this.#undo.length + this.#redo.length > maximumGroups)
    )
      bytes -= this.#undo.shift()!.bytes
    while (
      this.#redo.length &&
      (bytes > maximumBytes || this.#redo.length > maximumGroups)
    )
      bytes -= this.#redo.shift()!.bytes
  }
  #record(
    prepared: PreparedSourceOperation,
    beforeSelection: SourceSelection | null,
    viewId: string,
  ) {
    const previous = this.#undo.at(-1),
      operation = prepared.operation
    const afterIdentity = {}
    let forward = operation.changes,
      inverse = prepared.inverse
    const merge =
      previous?.id === operation.historyGroup &&
      previous.viewId === viewId &&
      previous.origin === operation.origin &&
      previous.operations < 256 &&
      previous.bytes + editBytes(forward) + editBytes(inverse) < 128 * 1024
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
        this.#redo = []
        return
      }
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
      () => group.beforeSelection,
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
      () => group.afterSelection,
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
    this.#publish()
    this.#verifySaved()
  }
  /** Explicit native save/bootstrap boundary, never called for ordinary input. */
  importSaved(source: string) {
    const current = this.snapshot()
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
  }
}
