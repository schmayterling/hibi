import type { Transaction } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

/**
 * Where hibi's own corrections leave a pane's scroll: an editor keeping its
 * place as its layout changes, or a split view lining up its panes. Their
 * scroll events then tell them from the reader's, a script's or a reveal.
 */
const announced = new WeakMap<Element, number>()
/** Panes whose scroll events a split view tells apart; others read no layout. */
const watched = new WeakSet<Element>()

export function announceScroll(pane: Element) {
  if (watched.has(pane)) announced.set(pane, pane.scrollTop)
}

/** Has corrections announced for the pane until the returned stop. */
export function watchScrolls(pane: Element) {
  watched.add(pane)
  return () => {
    watched.delete(pane)
    announced.delete(pane)
  }
}

/** Whether a pane is where the last correction announced for it left it. */
export function announcedScroll(pane: Element) {
  const top = announced.get(pane)
  return top !== undefined && Math.abs(pane.scrollTop - top) < 1
}

// ponytail: CodeMirror exports no type for its scroll command's effect; its
// value's class names it. A public effect type would replace this.
export const scrollTarget = (EditorView.scrollIntoView(0).value as object)
  .constructor

/** A scroll command that doesn't move the caret: a reveal, not a correction. */
const reveals = (transaction: Transaction) =>
  !transaction.selection &&
  (transaction.scrollIntoView ||
    transaction.effects.some((effect) => effect.value instanceof scrollTarget))

/**
 * Announces where each of the editor's measures leaves its pane: it keeps the
 * text at the top in place when heights above change, and scrolls the caret
 * a transaction moved into view. A measure carrying out a reveal announces
 * nothing.
 */
export function layoutScrolls(scroller: (view: EditorView) => Element) {
  const revealing = new WeakSet<EditorView>()
  return EditorView.updateListener.of((update) => {
    if (update.transactions.length) {
      if (update.transactions.some(reveals)) revealing.add(update.view)
      return
    }
    if (revealing.delete(update.view)) return
    announceScroll(scroller(update.view))
  })
}
