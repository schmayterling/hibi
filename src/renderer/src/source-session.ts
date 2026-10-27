import { isolateHistory } from '@codemirror/commands'
import {
  Annotation,
  ChangeSet,
  EditorSelection,
  type EditorState,
  Text,
  Transaction,
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
    failed = false
  const undo = () => !failed && !!session.undo()
  const redo = () => !failed && !!session.redo()
  const dispatch = (
    transactions: readonly Transaction[],
    view: Pick<EditorView, 'state' | 'update'> & {
      readonly composing?: boolean
    },
    exactChanges?: readonly RawEdit[],
  ) => {
    if (!transactions.length) return
    if (failed) {
      if (transactions.some((transaction) => transaction.docChanged))
        throw new Error('The source editor is synchronizing.')
      // Its text can still be selected and copied.
      view.update(transactions)
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
      state = transaction.state
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
      rememberSourceHistory(state, session.historyDepth())
      view.update(transactions)
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
        rememberSourceHistory(state, session.historyDepth())
        view.update(transactions)
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
      view: Pick<EditorView, 'state' | 'update'>,
      reject: (error: unknown) => void = () => {},
    ) {
      if (!session.ownsCurrentSnapshot(snapshot))
        throw new Error('The source editor is synchronizing.')
      snapshot = session.snapshot()
      const unregister = registerSourceHistory(view, { undo, redo })
      rememberSourceHistory(view.state, session.historyDepth())
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
          rememberSourceHistory(transaction.state, session.historyDepth())
          view.update([transaction])
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
