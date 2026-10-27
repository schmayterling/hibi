import * as nativeCommands from '@codemirror/commands'
import type { Transaction } from '@codemirror/state'
import {
  runSourceHistory,
  sourceHistoryDepth,
} from '../shared/source-history.ts'

const undo: typeof nativeCommands.undo = (view) =>
  runSourceHistory(view, 'undo') ?? nativeCommands.undo(view)
const redo: typeof nativeCommands.redo = (view) =>
  runSourceHistory(view, 'redo') ?? nativeCommands.redo(view)
/** A host view keeps native selection steps; its text history is its session's. */
const selectionHistory =
  (
    direction: 'undo' | 'redo',
    native: typeof nativeCommands.undoSelection,
  ): typeof native =>
  (target) => {
    let step: Transaction | undefined
    native({
      state: target.state,
      dispatch: (transaction) => {
        step = transaction
      },
    })
    if (!step || step.docChanged) {
      const done = runSourceHistory(target, direction)
      if (done !== undefined) return done
    }
    if (!step) return false
    target.dispatch(step)
    return true
  }
const undoSelection = selectionHistory('undo', nativeCommands.undoSelection)
const redoSelection = selectionHistory('redo', nativeCommands.redoSelection)
const hosted = new Map<unknown, typeof undo>([
  [nativeCommands.undo, undo],
  [nativeCommands.redo, redo],
  [nativeCommands.undoSelection, undoSelection],
  [nativeCommands.redoSelection, redoSelection],
])
export const commands = {
  ...nativeCommands,
  undo,
  redo,
  undoSelection,
  redoSelection,
  undoDepth: (state: Parameters<typeof nativeCommands.undoDepth>[0]) =>
    sourceHistoryDepth(state, 'undo') ?? nativeCommands.undoDepth(state),
  redoDepth: (state: Parameters<typeof nativeCommands.redoDepth>[0]) =>
    sourceHistoryDepth(state, 'redo') ?? nativeCommands.redoDepth(state),
  historyKeymap: nativeCommands.historyKeymap.map((binding) => ({
    ...binding,
    run: (binding.run && hosted.get(binding.run)) ?? binding.run,
    shift: (binding.shift && hosted.get(binding.shift)) ?? binding.shift,
  })),
}
export * as language from '@codemirror/language'
export * as state from '@codemirror/state'
export * as view from '@codemirror/view'
export * as highlight from '@lezer/highlight'
