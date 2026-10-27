import { isolateHistory } from '@codemirror/commands'
import {
  Annotation,
  ChangeSet,
  EditorSelection,
  EditorState,
  Prec,
  type StateEffect,
  Text,
  Transaction,
  type TransactionSpec,
} from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import {
  type SourceEdit,
  validateSourceEdits,
} from '../../shared/document-edits.ts'
import type { DocumentSession } from '../../shared/document-session.ts'
import type { SourceSnapshot } from '../../shared/source-buffer.ts'
import {
  registerSourceHistory,
  rememberSourceHistory,
} from '../../shared/source-history.ts'
import type { RawEdit } from '../../shared/source-operations.ts'
import {
  editorChangesFromSource,
  normalizedChunks,
  preferredLineBreak,
  sourceChangesFromEditor,
} from '../../shared/source-projection.ts'
import type { SourceSelection } from '../../shared/source-selection.ts'

const sourceOperationEcho = Annotation.define<string>()

export type SourceEditorTextTask = Readonly<{
  sourceUnits: number
  chunks: number
  appends: number
  maxLines: number
}>

/** Build only bounded native Text pieces before yielding to another browser task. */
export async function sourceEditorTextCooperatively(
  source: SourceSnapshot,
  {
    signal,
    isCurrent = () => true,
    yieldTask,
    onTask,
  }: {
    signal: AbortSignal
    isCurrent?: () => boolean
    yieldTask?: () => Promise<void>
    onTask?: (work: SourceEditorTextTask) => void
  },
): Promise<Text | null> {
  let text = Text.empty,
    channel: MessageChannel | undefined
  const current = () => !signal.aborted && isCurrent()
  const pause =
    yieldTask ??
    (() =>
      new Promise<void>((resolve) => {
        channel ??= new MessageChannel()
        channel.port1.onmessage = () => resolve()
        channel.port2.postMessage(null)
      }))
  try {
    for (let from = 0; from < source.utf16Length; ) {
      if (!current()) return null
      let to = Math.min(from + 16384, source.utf16Length)
      if (!source.isEditBoundary(to)) to--
      let lines = [''],
        chunks = 0,
        appends = 0,
        maxLines = 1
      const append = () => {
        maxLines = Math.max(maxLines, lines.length)
        text = text.append(Text.of(lines))
        appends++
        lines = ['']
      }
      for (const chunk of normalizedChunks(source, from, to)) {
        chunks++
        let start = 0
        for (
          let end = chunk.indexOf('\n');
          end >= 0;
          end = chunk.indexOf('\n', start)
        ) {
          lines[lines.length - 1] += chunk.slice(start, end)
          lines.push('')
          if (lines.length === 512) append()
          start = end + 1
        }
        lines[lines.length - 1] += chunk.slice(start)
      }
      append()
      onTask?.({ sourceUnits: to - from, chunks, appends, maxLines })
      from = to
      if (from < source.utf16Length) await pause()
    }
    return current() ? text : null
  } finally {
    channel?.port1.close()
    channel?.port2.close()
  }
}

/** Compare only native changed ranges after extension/filter admission. */
export function sourceEditTransaction(
  state: EditorState,
  snapshot: SourceSnapshot,
  changes: readonly SourceEdit[],
  maximumBytes = Infinity,
): Transaction | null {
  if (state.doc.length !== snapshot.normalizedLength)
    throw new Error('The source editor is synchronizing.')
  const validation = validateSourceEdits(snapshot, changes, maximumBytes)
  if (validation.status !== 'valid') throw new Error(validation.message)
  if (!validation.changed) return null
  const intended = state.changes(editorChangesFromSource(snapshot, changes))
  if (intended.empty)
    throw new Error(
      'Edits must keep line-ending pairs intact. Use a whole-source transform to change only line endings.',
    )
  const transaction = state.update({
    changes: intended,
    annotations: [
      isolateHistory.of('full'),
      Transaction.userEvent.of('input.addon'),
    ],
  })
  const expected: { from: number; to: number; insert: Text }[] = []
  intended.iterChanges((from, to, _fromB, _toB, insert) => {
    expected.push({ from, to, insert })
  })
  let index = 0,
    matches = true
  transaction.changes.iterChanges((from, to, _fromB, _toB, insert) => {
    const change = expected[index++]
    if (
      !change ||
      change.from !== from ||
      change.to !== to ||
      !insert.eq(change.insert)
    )
      matches = false
  })
  if (!matches || index !== expected.length)
    throw new Error('An editor extension changed this edit.')
  return transaction
}

const rawSelection = (
  source: SourceSnapshot,
  selection: EditorSelection,
): SourceSelection => ({
  ranges: selection.ranges.map((range) => {
    const association = range.assoc < 0 ? -1 : 1
    const raw = (position: number) => {
      const result = source.editorToRaw(position)
      if (result === null)
        throw new Error('Selection is outside the source replica.')
      return source.isEditBoundary(result) ? result : result + association
    }
    return { anchor: raw(range.anchor), head: raw(range.head), association }
  }),
  mainIndex: selection.mainIndex,
})
const editorSelection = (
  source: SourceSnapshot,
  selection: SourceSelection | null,
) =>
  selection &&
  EditorSelection.create(
    selection.ranges.map((range) => {
      const anchor = source.rawToEditor(range.anchor),
        head = source.rawToEditor(range.head)
      if (anchor === null || head === null)
        throw new Error('Selection is outside the source replica.')
      return anchor === head
        ? EditorSelection.cursor(anchor, range.association)
        : EditorSelection.range(anchor, head)
    }),
    selection.mainIndex,
  )

/**
 * A view whose update throws, as when an extension fails while it draws, may
 * hold the new text while its DOM keeps the old, and would read the next
 * input from that DOM twice. It is redrawn at the state the update reached.
 */
function update(
  view: Pick<EditorView, 'state' | 'update' | 'setState'>,
  transactions: readonly Transaction[],
) {
  // A state an extension failed on never reaches the view.
  for (const transaction of transactions) reachedState(transaction)
  try {
    view.update(transactions)
  } catch (error) {
    view.setState(transactions.at(-1)?.state ?? view.state)
    throw error
  }
}

/** CodeMirror keeps the part of a state it reached when an extension failed, and returns it on later reads. */
const failedStates = new WeakMap<Transaction, unknown>()

/**
 * Keeps an extension's failure on the transaction: every later read throws it,
 * and the transaction's own `state` reads as its start, so extensions that read
 * it later never get the half-built state.
 */
function recordFailure(transaction: Transaction, error: unknown) {
  if (failedStates.has(transaction)) return
  failedStates.set(transaction, error)
  Object.defineProperty(transaction, 'state', { value: transaction.startState })
}

/** Transactions whose state was checked complete. */
const completeStates = new WeakSet<Transaction>()

/**
 * The state a transaction reaches. When an extension fails on it, every read
 * throws that error. A state CodeMirror left with a slot it never finished
 * (its per-slot status, an internal) failed too, even if every throw on the
 * way was caught.
 */
function reachedState(transaction: Transaction): EditorState {
  if (failedStates.has(transaction)) throw failedStates.get(transaction)
  let state: EditorState
  try {
    state = transaction.state
  } catch (error) {
    recordFailure(transaction, error)
    throw error
  }
  if (completeStates.has(transaction)) return state
  // 2 marks a computed slot.
  if (
    (state as unknown as { status: number[] }).status.some(
      (slot) => !(slot & 2),
    )
  ) {
    const error = new Error(
      'An editor extension failed while this edit was made.',
    )
    recordFailure(transaction, error)
    throw error
  }
  completeStates.add(transaction)
  return state
}

/**
 * Reads each new state before any change filter can, so a failure is kept on
 * its transaction before addon code could read it and catch it. It goes first.
 */
export const firstStateRead = Prec.highest(
  EditorState.changeFilter.of((transaction) => {
    transactionState(transaction)
    return true
  }),
)

/**
 * Reads each new state before other filters and extenders can, so a failure
 * is kept on its transaction before any of them reads it, and dispatch
 * rejects that transaction. Both run from the last one, so these go last.
 */
export const failedEditGuard = [
  Prec.lowest(
    EditorState.transactionFilter.of((transaction) => {
      transactionState(transaction)
      return transaction
    }),
  ),
  Prec.lowest(
    EditorState.transactionExtender.of((transaction) => {
      transactionState(transaction)
      return null
    }),
  ),
]

/**
 * The state a transaction reaches, or null when an extension fails on it.
 * Filters pass such a transaction on: dispatch rejects it and reports the
 * extension's owner.
 */
export function transactionState(transaction: Transaction) {
  try {
    return reachedState(transaction)
  } catch {
    return null
  }
}

/**
 * A transaction that only reconfigures. Taking an extension out runs its own
 * filters and extenders first, which may read fields it takes along, so this
 * skips them, with CodeMirror's internal constructor.
 */
export function reconfiguration(
  state: EditorState,
  effect: StateEffect<unknown>,
): Transaction {
  const { create } = Transaction as unknown as {
    create: (
      startState: EditorState,
      changes: ChangeSet,
      selection: undefined,
      effects: readonly StateEffect<unknown>[],
      annotations: readonly Annotation<unknown>[],
      scrollIntoView: boolean,
    ) => Transaction
  }
  return create(
    state,
    ChangeSet.empty(state.doc.length),
    undefined,
    [effect],
    [],
    false,
  )
}

/** A spec that makes a transaction's edit again, with everything it carries. */
export function editSpec(transaction: Transaction): TransactionSpec {
  return {
    changes: transaction.changes,
    ...(transaction.selection ? { selection: transaction.selection } : {}),
    effects: transaction.effects,
    // CodeMirror keeps these internal; an extension may fail on its own.
    annotations: (
      transaction as unknown as { annotations: readonly Annotation<unknown>[] }
    ).annotations,
    scrollIntoView: transaction.scrollIntoView,
  }
}

/**
 * The parts of a configuration that an edit fails with, and their errors.
 * From `start` with none of them, each is installed in turn while the edit
 * is replayed; one it fails with is left out of the rest. An edit that fails
 * without any of them names none. The edit is the transactions it made, or
 * the specs it failed to make one from.
 */
export function failingParts<Part>(
  start: EditorState,
  edit: readonly Transaction[] | readonly TransactionSpec[],
  parts: readonly Part[],
  install: (parts: readonly Part[]) => StateEffect<unknown>,
) {
  const replay = (installed: readonly Part[]) => {
    let state = reachedState(reconfiguration(start, install(installed)))
    if (edit.every((part) => part instanceof Transaction))
      for (const transaction of edit as readonly Transaction[])
        state = reachedState(state.update(editSpec(transaction)))
    else reachedState(state.update(...(edit as readonly TransactionSpec[])))
  }
  const accepted: Part[] = []
  const failing: { part: Part; error: unknown }[] = []
  try {
    replay(accepted)
  } catch {
    return failing
  }
  for (const part of parts)
    try {
      replay([...accepted, part])
      accepted.push(part)
    } catch (error) {
      failing.push({ part, error })
    }
  return failing
}

/** How far above a pane's kept top line its scroll position was, per session and view. */
const keptMargins = new WeakMap<DocumentSession, Map<string, number>>()

/** Accepted CM transactions enter the same source/history/recovery authority as visual edits. */
export function createSourceSession(
  session: DocumentSession,
  viewId = 'default',
) {
  let snapshot = session.snapshot()
  const lineBreak = preferredLineBreak(snapshot)
  let group = '',
    lastEvent = '',
    lastTime = -Infinity
  // A hidden view keeps one composed echo until it is shown or read.
  let visible = true,
    pending: ChangeSet | null = null,
    flush = () => {},
    // A view that could not show an echo takes no edits until it is rebuilt.
    failed = false,
    // Only an attached view that is not read-only undoes or redoes, by any route.
    attached: Pick<EditorView, 'state'> | null = null
  const writable = () => !failed && !!attached && !attached.state.readOnly
  const history = {
    undo: () => writable() && !!session.undo(),
    redo: () => writable() && !!session.redo(),
  }
  const { undo, redo } = history
  const dispatch = (
    transactions: readonly Transaction[],
    view: Pick<EditorView, 'state' | 'update' | 'setState'> & {
      readonly composing?: boolean
    },
    exactChanges?: readonly RawEdit[],
  ) => {
    if (!transactions.length) return
    if (failed) {
      if (transactions.some((transaction) => transaction.docChanged))
        throw new Error('The source editor is synchronizing.')
      // Its text can still be selected and copied.
      update(view, transactions)
      return
    }
    if (snapshot !== session.snapshot())
      throw new Error('The source editor is synchronizing.')
    let state: EditorState = view.state
    let combined = state.changes([])
    for (const transaction of transactions) {
      if (transaction.startState !== state)
        throw new Error('Source transaction is stale.')
      if (transaction.annotation(sourceOperationEcho))
        throw new Error('Source echoes must bypass input dispatch.')
      combined = combined.compose(transaction.changes)
      state = reachedState(transaction)
    }
    const changes: RawEdit[] = []
    combined.iterChanges((from, to, _fromB, _toB, inserted) => {
      const insert = inserted.toString()
      if (view.state.sliceDoc(from, to) !== insert)
        changes.push({ from, to, insert })
    })
    const isolated = transactions.some((transaction) =>
      transaction.annotation(isolateHistory),
    )
    if (!changes.length) {
      // Positions in a replica that is behind cannot become session selections.
      if (
        !pending &&
        transactions.some((transaction) => transaction.selection)
      ) {
        if (!view.composing || isolated) group = ''
        session.select(
          rawSelection(snapshot, state.selection),
          snapshot.version,
          viewId,
        )
      }
      rememberSourceHistory(state, session.historyDepth(), history)
      update(view, transactions)
      return
    }
    if (pending) {
      flush()
      throw new Error('The source editor is synchronizing.')
    }
    const last = transactions.at(-1)!
    const event = last.annotation(Transaction.userEvent) ?? 'input'
    const time = last.annotation(Transaction.time) ?? Date.now()
    const typing = /^(input\.type|delete\.(backward|forward))(\.|$)/.test(event)
    const compositionStart = event === 'input.type.compose.start'
    const composing = compositionStart || event === 'input.type.compose'
    // Candidate changes belong to one composition, even across long pauses.
    const eventGroup = composing ? 'input.type.compose' : event
    if (
      !group ||
      isolated ||
      !typing ||
      compositionStart ||
      eventGroup !== lastEvent ||
      (!composing && time - lastTime > 500)
    )
      group = crypto.randomUUID()
    session.select(
      rawSelection(snapshot, view.state.selection),
      snapshot.version,
      viewId,
    )
    session.edit(
      exactChanges ?? sourceChangesFromEditor(snapshot, changes, lineBreak),
      event.includes('compose')
        ? 'composition'
        : event === 'input.addon'
          ? 'addon'
          : 'source',
      group,
      (prepared) => {
        snapshot = prepared.after
        rememberSourceHistory(state, session.historyDepth(), history)
        update(view, transactions)
      },
      (prepared) => rawSelection(prepared.after, state.selection),
      viewId,
    )
    lastEvent = eventGroup
    lastTime = time
    if (isolated || !typing) group = ''
  }
  return {
    /** Reading the replica's snapshot first brings a hidden view up to date. */
    snapshot: () => {
      flush()
      return snapshot
    },
    selection: () => editorSelection(snapshot, session.selection(viewId)),
    /** Whether the view has echoed canonical edits, without flushing a hidden view. */
    isCurrent: () => !failed && !pending && snapshot === session.snapshot(),
    dispatch,
    setVisible(next: boolean) {
      visible = next
      if (visible) flush()
    },
    /** `reject` hears once that an echo could not be shown. */
    attach(
      view: Pick<EditorView, 'state' | 'update' | 'setState'>,
      reject: (error: unknown) => void = () => {},
    ) {
      if (!session.ownsCurrentSnapshot(snapshot))
        throw new Error('The source editor is synchronizing.')
      snapshot = session.snapshot()
      attached = view
      const unregister = registerSourceHistory(view, history)
      rememberSourceHistory(view.state, session.historyDepth(), history)
      // A waiting view gets the caret immediate echoes would have left: the
      // session selection, or its own caret mapped through each operation.
      let echo = '',
        selection: EditorSelection | null = null
      flush = () => {
        if (!pending || failed) return
        try {
          const transaction = view.state.update({
            changes: pending,
            ...(selection ? { selection } : {}),
            annotations: [
              sourceOperationEcho.of(echo),
              Transaction.addToHistory.of(false),
            ],
            filter: false,
          })
          pending = selection = null
          rememberSourceHistory(
            reachedState(transaction),
            session.historyDepth(),
            history,
          )
          update(view, [transaction])
        } catch (error) {
          // Like a failed rich synchronization: the view stays, read-only.
          pending = selection = null
          failed = true
          reject(error)
        }
      }
      const unsubscribe = session.subscribeOperations((prepared) => {
        if (snapshot === prepared.after) return
        if (snapshot !== prepared.before)
          throw new Error('The source replica missed an operation.')
        if (failed) {
          snapshot = prepared.after
          return
        }
        const changes = ChangeSet.of(
          editorChangesFromSource(prepared.before, prepared.operation.changes),
          prepared.before.normalizedLength,
        )
        const selected = editorSelection(
          prepared.after,
          session.selection(viewId),
        )
        if (selected) selection = selected
        else if (pending)
          selection = (selection ?? view.state.selection.map(pending)).map(
            changes,
          )
        pending = pending ? pending.compose(changes) : changes
        echo = prepared.operation.operationId
        snapshot = prepared.after
        group = ''
        if (visible) flush()
      })
      const unsubscribeStorage = session.subscribeStorage((change) => {
        if (snapshot !== change.before)
          throw new Error('The source replica missed an operation.')
        snapshot = change.after
      })
      return () => {
        flush = () => {}
        pending = null
        attached = null
        unregister()
        unsubscribe()
        unsubscribeStorage()
      }
    },
    /**
     * Keep the view's selection and the line at its top for this pane's next
     * view, which `place` returns. The session maps both through the edits
     * made meanwhile, like any view's selection.
     */
    keepPlace(
      view: Pick<EditorView, 'state' | 'update'>,
      top: number,
      margin: number,
    ) {
      flush()
      if (failed) return
      try {
        session.select(
          rawSelection(snapshot, view.state.selection),
          snapshot.version,
          `${viewId}\0selection`,
        )
        session.select(
          rawSelection(snapshot, EditorSelection.single(top)),
          snapshot.version,
          `${viewId}\0top`,
        )
      } catch {
        // A closing or synchronizing session keeps no place.
        return
      }
      let margins = keptMargins.get(session)
      if (!margins) {
        margins = new Map()
        keptMargins.set(session, margins)
      }
      margins.set(viewId, margin)
    },
    /** The place this pane kept, in this replica's positions; taking it forgets it. */
    place() {
      const selection = session.selection(`${viewId}\0selection`),
        top = session.selection(`${viewId}\0top`),
        margin = keptMargins.get(session)?.get(viewId)
      session.releaseView(`${viewId}\0selection`)
      session.releaseView(`${viewId}\0top`)
      keptMargins.get(session)?.delete(viewId)
      if (margin === undefined) return null
      try {
        const kept = editorSelection(snapshot, selection),
          line = editorSelection(snapshot, top)
        return kept && line
          ? { selection: kept, top: line.main.head, margin }
          : null
      } catch {
        // Positions the replica no longer holds, as after a reload, are not restored.
        return null
      }
    },
    undo,
    redo,
  }
}
