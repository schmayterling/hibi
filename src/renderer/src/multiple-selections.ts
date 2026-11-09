import {
  deleteCharBackward,
  deleteCharForward,
  indentLess,
  indentMore,
  insertNewlineAndIndent,
} from '@codemirror/commands'
import { indentUnit } from '@codemirror/language'
import { selectNextOccurrence } from '@codemirror/search'
import {
  EditorSelection,
  EditorState,
  type Extension,
  Prec,
  type SelectionRange,
} from '@codemirror/state'
import {
  type Command,
  EditorView,
  keymap,
  layer,
  RectangleMarker,
  rectangularSelection,
  type ViewUpdate,
} from '@codemirror/view'

/*
 * Several cursors in the source and formatted views. Alt-click adds a cursor,
 * Alt-Shift-drag selects a rectangle, Mod-d adds the next occurrence and
 * Mod-Alt-Up/Down (in the default keymap) add a cursor above or below. The
 * native selection draws the main range; layers here draw the others.
 *
 * Hibi's formatting rules for typing, Enter, deletion, Tab and the clipboard
 * read one range. With several, those take CodeMirror's plain edit at every
 * range instead; commands such as toolbar formatting act on the main range.
 */

const several = (state: EditorState) => state.selection.ranges.length > 1
/** Vim draws every range itself. */
const drawsOwn = (view: EditorView) => view.dom.hasAttribute('data-vim-plugin')
const others = (view: EditorView): readonly SelectionRange[] => {
  const { ranges, mainIndex } = view.state.selection
  return drawsOwn(view) ? [] : ranges.filter((_, index) => index !== mainIndex)
}
const redraw = (update: ViewUpdate) =>
  update.docChanged ||
  update.selectionSet ||
  update.viewportChanged ||
  update.geometryChanged

/** Runs only with several ranges, leaving one range to Hibi's own keys. */
const each =
  (command: Command): Command =>
  (target) =>
    several(target.state) && command(target)

const tab: Command = (target) => {
  const { state } = target
  if (!several(state) || state.readOnly) return false
  if (state.selection.ranges.some((range) => !range.empty))
    return indentMore(target)
  target.dispatch(
    state.update(state.replaceSelection(state.facet(indentUnit)), {
      scrollIntoView: true,
      userEvent: 'input',
    }),
  )
  return true
}

const clipboard = (event: ClipboardEvent, view: EditorView, cut: boolean) => {
  const { state } = view
  if (!several(state) || !event.clipboardData) return false
  const ranges = state.selection.ranges.filter((range) => !range.empty)
  if (!ranges.length) return false
  event.preventDefault()
  event.clipboardData.setData(
    'text/plain',
    ranges.map((range) => state.sliceDoc(range.from, range.to)).join('\n'),
  )
  if (cut && !state.readOnly)
    view.dispatch({
      changes: ranges.map(({ from, to }) => ({ from, to })),
      userEvent: 'delete.cut',
      scrollIntoView: true,
    })
  return true
}

export const multipleSelections: Extension = [
  EditorState.allowMultipleSelections.of(true),
  Prec.low(EditorView.clickAddsSelectionRange.of((event) => event.altKey)),
  rectangularSelection({
    eventFilter: (event) => event.altKey && event.shiftKey,
  }),
  layer({
    above: false,
    class: 'hibi-other-selections',
    update: redraw,
    markers: (view) =>
      others(view)
        .filter((range) => !range.empty)
        .flatMap((range) =>
          RectangleMarker.forRange(view, 'hibi-other-selection', range),
        ),
  }),
  layer({
    above: true,
    class: 'hibi-other-cursors',
    update: redraw,
    markers: (view) =>
      others(view).flatMap((range) =>
        RectangleMarker.forRange(
          view,
          'hibi-other-cursor',
          EditorSelection.cursor(range.head),
        ),
      ),
  }),
  keymap.of([
    { key: 'Mod-d', run: selectNextOccurrence, preventDefault: true },
  ]),
  Prec.highest([
    keymap.of([
      { key: 'Enter', run: each(insertNewlineAndIndent) },
      { key: 'Backspace', run: each(deleteCharBackward) },
      { key: 'Delete', run: each(deleteCharForward) },
      { key: 'Tab', run: tab, shift: each(indentLess) },
    ]),
    EditorView.inputHandler.of((view, _from, _to, _text, insert) => {
      if (!several(view.state) || view.composing) return false
      view.dispatch(insert())
      return true
    }),
    EditorView.domEventHandlers({
      copy: (event, view) => clipboard(event, view, false),
      cut: (event, view) => clipboard(event, view, true),
      paste(event, view) {
        const { state } = view
        const text = event.clipboardData?.getData('text/plain')
        if (!several(state) || state.readOnly || !text) return false
        event.preventDefault()
        view.dispatch(
          state.update(state.replaceSelection(text), {
            scrollIntoView: true,
            userEvent: 'input.paste',
          }),
        )
        return true
      },
    }),
  ]),
  EditorView.baseTheme({
    '.hibi-other-selection': { background: 'var(--selection)' },
    '.hibi-other-cursor': {
      borderLeft: '2px solid var(--caret)',
      marginLeft: '-1px',
    },
  }),
]
