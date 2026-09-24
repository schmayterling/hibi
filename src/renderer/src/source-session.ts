import { isolateHistory } from '@codemirror/commands'
import {
  Annotation,
  EditorSelection,
  type EditorState,
  Text,
  Transaction,
} from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
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

export const sourceOperationEcho = Annotation.define<string>()

/** Construct CM's native Text once without flattening the canonical source. */
export function sourceEditorText(source: SourceSnapshot): Text {
  const lines: string[] = [],
    parts: string[] = []
  for (const chunk of normalizedChunks(source)) {
    let start = 0
    for (
      let end = chunk.indexOf('\n');
      end >= 0;
      end = chunk.indexOf('\n', start)
    ) {
      parts.push(chunk.slice(start, end))
      lines.push(parts.join(''))
      parts.length = 0
      start = end + 1
    }
    parts.push(chunk.slice(start))
  }
  lines.push(parts.join(''))
  return Text.of(lines)
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
  const dispatch = (
    transactions: readonly Transaction[],
    view: Pick<EditorView, 'state' | 'update'> & {
      readonly composing?: boolean
    },
    exactChanges?: readonly RawEdit[],
  ) => {
    if (!transactions.length) return
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
      if (transactions.some((transaction) => transaction.selection)) {
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
    snapshot: () => snapshot,
    selection: () => editorSelection(snapshot, session.selection(viewId)),
    dispatch,
    attach(view: Pick<EditorView, 'state' | 'update'>) {
      if (!session.ownsCurrentSnapshot(snapshot))
        throw new Error('The source editor is synchronizing.')
      snapshot = session.snapshot()
      const unregister = registerSourceHistory(view, {
        undo: () => !!session.undo(),
        redo: () => !!session.redo(),
      })
      rememberSourceHistory(view.state, session.historyDepth())
      const unsubscribe = session.subscribeOperations((prepared) => {
        if (snapshot === prepared.after) return
        if (snapshot !== prepared.before)
          throw new Error('The source replica missed an operation.')
        const selection = editorSelection(
          prepared.after,
          session.selection(viewId),
        )
        const transaction = view.state.update({
          changes: editorChangesFromSource(
            prepared.before,
            prepared.operation.changes,
          ),
          ...(selection ? { selection } : {}),
          annotations: [
            sourceOperationEcho.of(prepared.operation.operationId),
            Transaction.addToHistory.of(false),
          ],
          filter: false,
        })
        snapshot = prepared.after
        group = ''
        rememberSourceHistory(transaction.state, session.historyDepth())
        view.update([transaction])
      })
      const unsubscribeStorage = session.subscribeStorage((change) => {
        if (snapshot !== change.before)
          throw new Error('The source replica missed an operation.')
        snapshot = change.after
      })
      return () => {
        unregister()
        unsubscribe()
        unsubscribeStorage()
      }
    },
    undo: () => !!session.undo(),
    redo: () => !!session.redo(),
  }
}
