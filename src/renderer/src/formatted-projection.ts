import {
  Annotation,
  EditorSelection,
  EditorState,
  type Extension,
  Prec,
  StateEffect,
  StateField,
  Transaction,
} from '@codemirror/state'
import { Decoration, EditorView, keymap } from '@codemirror/view'
import type { MarkdownExtension } from '../../addons/api'
import type { SourceSnapshot } from '../../shared/source-buffer.ts'
import { normalizedSource } from '../../shared/source-projection.ts'
import { formattedPrefix } from './formatted-contributions.ts'
import { projectMarkdown } from './markdown-projection.ts'

type Body = {
  from: number
  to: number
  readOnly: boolean
  stale: boolean
  watchStart: boolean
  watchEnd: boolean
}
/** Whole-source changes from the projection's properties editor. */
export const formattedProjectionSource = Annotation.define<string>()
const refreshProjection = StateEffect.define<null>()

/** Legacy verbatim projections keep their exact source outside the editable body. */
export function formattedProjection(
  adapters: readonly MarkdownExtension[],
  source: () => SourceSnapshot | undefined,
): Extension {
  const read = (state: EditorState, replacement?: string): Body => {
    const snapshot = source()
    const fallback = {
      from: 0,
      to: state.doc.length,
      readOnly: true,
      stale: false,
      watchStart: false,
      watchEnd: false,
    }
    if (
      !snapshot ||
      (replacement === undefined &&
        snapshot.normalizedLength !== state.doc.length)
    )
      return fallback
    const projection = projectMarkdown(
      replacement ?? snapshot.materialize(),
      adapters,
    )
    const offset = projection.sourceOffset
    const position = (at: number) =>
      replacement === undefined
        ? snapshot.rawToEditor(at)
        : normalizedSource(replacement.slice(0, at)).length
    const from = offset === undefined ? null : position(offset)
    const to =
      offset === undefined ? null : position(offset + projection.content.length)
    return from === null || to === null || projection.readOnly
      ? fallback
      : {
          from,
          to,
          readOnly: false,
          stale: false,
          watchStart: from > 0,
          watchEnd: to < state.doc.length,
        }
  }
  const body = StateField.define<Body>({
    create: read,
    update(value, transaction) {
      if (transaction.effects.some((effect) => effect.is(refreshProjection)))
        return read(transaction.state)
      if (!transaction.docChanged) return value
      const replacement = transaction.annotation(formattedProjectionSource)
      if (replacement !== undefined) return read(transaction.state, replacement)
      const echo = transaction.annotation(Transaction.addToHistory) === false
      let reprove = value.readOnly && echo
      transaction.changes.iterChangedRanges((from, to) => {
        if (
          from < value.from ||
          to > value.to ||
          (echo &&
            ((value.watchStart && from === 0) ||
              (value.watchEnd && to === transaction.startState.doc.length)))
        )
          reprove = true
      })
      if (reprove) {
        const next = read(transaction.state)
        return {
          ...next,
          watchStart: next.watchStart || value.watchStart,
          watchEnd: next.watchEnd || value.watchEnd,
        }
      }
      // A negative proof is still a body proof. Echoes and history map it;
      // focus rechecks legacy adapters once before an inactive pane accepts input.
      return {
        ...value,
        stale: true,
        to: transaction.changes.mapPos(value.to, 1),
      }
    },
  })
  const hidden = Decoration.replace({ block: true })
  return [
    body,
    EditorView.domEventHandlers({
      focus(_event, view) {
        if (view.state.field(body).stale)
          view.dispatch({ effects: refreshProjection.of(null) })
      },
    }),
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
      if (
        outside &&
        transaction.annotation(formattedProjectionSource) === undefined
      )
        return []
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
