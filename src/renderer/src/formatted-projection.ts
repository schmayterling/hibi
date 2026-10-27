import {
  EditorSelection,
  EditorState,
  type Extension,
  Prec,
  StateField,
  Transaction,
} from '@codemirror/state'
import { Decoration, EditorView, keymap } from '@codemirror/view'
import type { MarkdownExtension } from '../../addons/api'
import type { SourceSnapshot } from '../../shared/source-buffer.ts'
import { formattedPrefix } from './formatted-contributions.ts'
import { projectMarkdown } from './markdown-projection.ts'

type Body = { from: number; to: number; readOnly: boolean }

/** Legacy verbatim projections keep their exact source outside the editable body. */
export function formattedProjection(
  adapters: readonly MarkdownExtension[],
  source: () => SourceSnapshot | undefined,
): Extension {
  const read = (state: EditorState): Body => {
    const snapshot = source()
    if (!snapshot || snapshot.normalizedLength !== state.doc.length)
      return { from: 0, to: state.doc.length, readOnly: true }
    const projection = projectMarkdown(snapshot.materialize(), adapters)
    const offset = projection.sourceOffset
    const from = offset === undefined ? null : snapshot.rawToEditor(offset)
    const to =
      offset === undefined
        ? null
        : snapshot.rawToEditor(offset + projection.content.length)
    return from === null || to === null || projection.readOnly
      ? { from: 0, to: state.doc.length, readOnly: true }
      : { from, to, readOnly: false }
  }
  const body = StateField.define<Body>({
    create: read,
    update(value, transaction) {
      if (!transaction.docChanged) return value
      let inside = true
      transaction.changes.iterChangedRanges((from, to) => {
        if (from < value.from || to > value.to) inside = false
      })
      // Legacy parsers consume whole source on installation or a protected-region
      // change. Proven body edits only map bounds, including canonical undo echoes.
      const unknown =
        value.from === 0 && value.to === transaction.startState.doc.length
      return inside &&
        !(unknown && transaction.annotation(Transaction.addToHistory) === false)
        ? { ...value, to: transaction.changes.mapPos(value.to, 1) }
        : read(transaction.state)
    },
  })
  const hidden = Decoration.replace({ block: true })
  return [
    body,
    formattedPrefix.of((state) => state.field(body).from),
    EditorState.readOnly.from(body, (value) => value.readOnly),
    Prec.high(
      EditorView.contentAttributes.compute([EditorState.readOnly], (state) => ({
        'aria-readonly': String(state.readOnly),
      })),
    ),
    Prec.high(
      EditorView.editable.compute(
        [EditorState.readOnly],
        (state) => !state.readOnly,
      ),
    ),
    EditorView.decorations.compute([body], (state) => {
      const { from, to } = state.field(body)
      const prefix =
        from && state.sliceDoc(from - 1, from) === '\n' ? from - 1 : from
      return Decoration.set([
        ...(prefix ? [hidden.range(0, prefix)] : []),
        ...(to < state.doc.length ? [hidden.range(to, state.doc.length)] : []),
      ])
    }),
    EditorState.transactionFilter.of((transaction) => {
      const current = transaction.startState.field(body, false)
      if (!current) return transaction
      let outside = current.readOnly && transaction.docChanged
      transaction.changes.iterChangedRanges((from, to) => {
        if (from < current.from || to > current.to) outside = true
      })
      if (outside) return []
      const next = transaction.docChanged
        ? transaction.state.field(body)
        : current
      const clamp = (position: number) =>
        Math.max(next.from, Math.min(next.to, position))
      const selection = transaction.newSelection
      if (
        selection.ranges.every(
          (range) => range.from >= next.from && range.to <= next.to,
        )
      )
        return transaction
      return [
        transaction,
        {
          selection: EditorSelection.create(
            selection.ranges.map((range) =>
              EditorSelection.range(clamp(range.anchor), clamp(range.head)),
            ),
            selection.mainIndex,
          ),
          sequential: true,
        },
      ]
    }),
    Prec.highest(
      keymap.of([
        {
          key: 'Mod-a',
          run(view) {
            const { from, to } = view.state.field(body)
            view.dispatch({
              selection: EditorSelection.range(from, to),
              userEvent: 'select',
            })
            return true
          },
        },
      ]),
    ),
  ]
}
