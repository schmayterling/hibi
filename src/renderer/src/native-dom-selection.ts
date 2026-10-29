import { EditorSelection, type EditorState } from '@codemirror/state'
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'

/** A rendered widget's native DOM positions, in its owning document now. */
type DOMPositions = {
  view: EditorView
  read: (node: Node, offset: number) => number | null
}
const positions = new WeakMap<Node, DOMPositions>()

/** A widget keeps its source positions current and removes them when destroyed. */
export function registerDOMPositions(
  view: EditorView,
  root: Node,
  read: DOMPositions['read'],
) {
  const entry = { view, read }
  positions.set(root, entry)
  return () => {
    if (positions.get(root) === entry) positions.delete(root)
  }
}

export function readDOMPosition(view: EditorView, node: Node, offset: number) {
  if (!view.contentDOM.contains(node)) return null
  for (let root: Node | null = node; root; root = root.parentNode) {
    const entry = positions.get(root)
    if (entry?.view === view) {
      const at = entry.read(node, offset)
      return at !== null &&
        Number.isSafeInteger(at) &&
        at >= 0 &&
        at <= view.state.doc.length
        ? { at, mapped: true }
        : null
    }
    if (root === view.contentDOM) break
  }
  try {
    return { at: view.posAtDOM(node, offset), mapped: false }
  } catch {
    return null
  }
}

type Points = Pick<
  Selection,
  'anchorNode' | 'anchorOffset' | 'focusNode' | 'focusOffset'
>

type Point = { node: Node; offset: number }

/**
 * Make CodeMirror's record of the page selection match the page, which
 * shows a pick inside a widget where CodeMirror would draw it at the
 * widget's edges. Otherwise its next DOM read takes the pick for a new
 * selection at those edges or, just after text input the view did not
 * take, for that text typed over it.
 */
export function recordPageSelection(view: EditorView) {
  const page = view.dom.ownerDocument.getSelection()
  if (!page?.anchorNode || !page.focusNode) return
  // ponytail: CodeMirror has no public API for this record; the pinned
  // @codemirror/view keeps it on the view's internal DOM observer.
  const { observer } = view as unknown as {
    observer: { setSelectionRange(anchor: Point, head: Point): void }
  }
  observer.setSelectionRange(
    { node: page.anchorNode, offset: page.anchorOffset },
    { node: page.focusNode, offset: page.focusOffset },
  )
}

const pointsOf = (selection: Selection | null): Points | null =>
  selection && {
    anchorNode: selection.anchorNode,
    anchorOffset: selection.anchorOffset,
    focusNode: selection.focusNode,
    focusOffset: selection.focusOffset,
  }

const samePoints = (a: Points | null, b: Points | null) =>
  a?.anchorNode === b?.anchorNode &&
  a?.anchorOffset === b?.anchorOffset &&
  a?.focusNode === b?.focusNode &&
  a?.focusOffset === b?.focusOffset

const writable = (state: EditorState) =>
  !state.readOnly && state.facet(EditorView.editable)

/**
 * A read-only widget can hold a browser selection without editable DOM.
 * Keep that pick in the document too, so other views and a later unlock
 * read its positions. Native selections outside mapped widgets stay with
 * CodeMirror, and a newer interaction outside the view keeps its focus.
 */
export const nativeDOMSelection = ViewPlugin.fromClass(
  class {
    private armed = false
    private picked = false
    /** The page points of the pick read last. */
    private taken: Points | null = null
    private destroyed = false
    private document: Document
    private view: EditorView
    constructor(view: EditorView) {
      this.view = view
      this.document = view.dom.ownerDocument
      for (const type of ['pointerdown', 'keydown'])
        view.dom.addEventListener(type, this.arm, true)
    }
    private clear() {
      if (!this.armed && !this.picked) return
      this.armed = this.picked = false
      this.document.removeEventListener('selectionchange', this.selection)
      this.document.defaultView?.removeEventListener('blur', this.intent)
      for (const type of ['pointerdown', 'keydown', 'focusin'])
        this.document.removeEventListener(type, this.intent, true)
    }
    private arm = () => {
      if (writable(this.view.state)) return this.clear()
      if (this.armed) return
      this.armed = true
      this.document.addEventListener('selectionchange', this.selection)
      this.document.defaultView?.addEventListener('blur', this.intent)
      for (const type of ['pointerdown', 'keydown', 'focusin'])
        this.document.addEventListener(type, this.intent, true)
    }
    private intent = (event: Event) => {
      if (event.type === 'focusin' && event.target === this.document.body)
        return
      if (
        !(event.target instanceof Node) ||
        !this.view.dom.contains(event.target)
      )
        this.clear()
    }
    private selection = () => this.read(pointsOf(this.document.getSelection()))
    /** Keep a pick's points, as the page shows them now or showed them before an update. */
    private read(selection: Points | null) {
      const { view } = this
      if (!this.armed || writable(view.state)) return
      const active = this.document.activeElement
      if (active !== this.document.body && !view.dom.contains(active)) return
      if (!selection?.anchorNode || !selection.focusNode) return
      const anchor = readDOMPosition(
        view,
        selection.anchorNode,
        selection.anchorOffset,
      )
      const head = readDOMPosition(
        view,
        selection.focusNode,
        selection.focusOffset,
      )
      if (!anchor || !head || !(anchor.mapped || head.mapped)) return
      this.picked = true
      this.taken = selection
      const current = view.state.selection.main
      if (current.anchor !== anchor.at || current.head !== head.at)
        view.dispatch({
          selection: EditorSelection.single(anchor.at, head.at),
          userEvent: 'select.pointer',
        })
      // The page keeps showing the pick, as the rich editor does.
      const page = this.document.getSelection()
      if (!samePoints(page, selection)) {
        page?.setBaseAndExtent(
          selection.anchorNode,
          selection.anchorOffset,
          selection.focusNode,
          selection.focusOffset,
        )
        recordPageSelection(view)
      }
    }
    update(update: ViewUpdate) {
      // CodeMirror writes its own selection to the page after this update,
      // over a pick whose selection change has not arrived yet. A measure
      // can also read that pick first, as a selection at the widget's edge.
      if (this.armed && !writable(update.state)) {
        const points = pointsOf(this.document.getSelection())
        if (!update.selectionSet || !samePoints(points, this.taken))
          queueMicrotask(() => {
            if (!this.destroyed) this.read(points)
          })
      }
      if (!this.armed || !writable(update.state) || writable(update.startState))
        return
      if (!this.picked) return this.clear()
      queueMicrotask(() => {
        if (this.destroyed || !this.picked) return
        this.clear()
        const { view } = this
        const active = this.document.activeElement
        if (
          writable(view.state) &&
          view.dom.isConnected &&
          view.dom.checkVisibility({ visibilityProperty: true }) &&
          !view.dom.closest('[inert]') &&
          (active === this.document.body ||
            active === view.scrollDOM ||
            active === view.contentDOM)
        )
          view.focus()
      })
    }
    destroy() {
      this.destroyed = true
      this.clear()
      for (const type of ['pointerdown', 'keydown'])
        this.view.dom.removeEventListener(type, this.arm, true)
    }
  },
)

/**
 * A shift-double-click extends the selection to the click, not by words, as
 * in the rich editor, and dragging on follows the pointer.
 */
export const shiftDoubleClick = EditorView.mouseSelectionStyle.of(
  (view, event) => {
    if (event.button !== 0 || event.detail !== 2 || !event.shiftKey) return null
    let start = view.state.selection
    return {
      get: (event) => {
        const head = view.posAtCoords(
          { x: event.clientX, y: event.clientY },
          false,
        )
        return start.replaceRange(start.main.extend(head))
      },
      update: (update) => {
        start = start.map(update.changes)
      },
    }
  },
)
