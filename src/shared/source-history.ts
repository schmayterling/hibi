/** Compatibility routing for SDK commands operating on host-owned CM views. */
type SourceHistory = { undo: () => boolean; redo: () => boolean }
const views = new WeakMap<object, SourceHistory>()
const states = new WeakMap<
  object,
  { undo: number; redo: number; history: SourceHistory }
>()
export function registerSourceHistory(view: object, history: SourceHistory) {
  views.set(view, history)
  return () => {
    views.delete(view)
  }
}
export function rememberSourceHistory(
  state: object,
  depth: { undo: number; redo: number },
  history: SourceHistory,
) {
  states.set(state, Object.freeze({ ...depth, history }))
}
/** A host view's history, for the view or a `{ state, dispatch }` target over one of its states. */
export const runSourceHistory = (
  target: object,
  direction: 'undo' | 'redo',
) => {
  const state = (target as { state?: object }).state
  return (views.get(target) ?? (state && states.get(state)?.history))?.[
    direction
  ]()
}
export const sourceHistoryDepth = (state: object, direction: 'undo' | 'redo') =>
  states.get(state)?.[direction]
