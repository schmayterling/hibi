import { type Editor, Extension } from '@tiptap/core'
import type { Mark, Node } from '@tiptap/pm/model'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

const delimiters: Record<string, string> = {
  bold: '**',
  italic: '*',
  strike: '~~',
  code: '`',
}

/** Leave final inline formatting without adding a character to the document. */
export const MarkdownMarkExit = Extension.create({
  name: 'markdownMarkExit',
  priority: 1100,
  addKeyboardShortcuts() {
    const move = (forward: boolean) => {
      const { state, view, isEditable } = this.editor
      const { selection, storedMarks } = state
      if (
        !isEditable ||
        !(selection instanceof TextSelection) ||
        !selection.empty ||
        !selection.eq(TextSelection.atEnd(state.doc)) ||
        !selection.$from.marks().some((mark) => delimiters[mark.type.name])
      )
        return false
      const marks = storedMarks ?? selection.$from.marks()
      if (forward) {
        if (marks.some((mark) => delimiters[mark.type.name]))
          view.dispatch(
            state.tr.setStoredMarks(
              marks.filter((mark) => !delimiters[mark.type.name]),
            ),
          )
        return true
      }
      if (!storedMarks || marks.some((mark) => delimiters[mark.type.name]))
        return false
      view.dispatch(state.tr.setStoredMarks(null))
      return true
    }
    return { ArrowRight: () => move(true), ArrowLeft: () => move(false) }
  },
  addProseMirrorPlugins() {
    // Like ProseMirror's composition mark cursor: an unmarked placeholder moves
    // the DOM selection out of the formatted element, so the caret draws after it.
    return [
      new Plugin({
        props: {
          decorations({ doc, selection, storedMarks }) {
            if (
              !storedMarks ||
              !(selection instanceof TextSelection) ||
              !selection.eq(TextSelection.atEnd(doc)) ||
              !selection.$from
                .marks()
                .some(
                  (mark) =>
                    delimiters[mark.type.name] && !mark.isInSet(storedMarks),
                )
            )
              return DecorationSet.empty
            return DecorationSet.create(doc, [
              Decoration.widget(
                selection.head,
                (view) => {
                  const placeholder =
                    view.dom.ownerDocument.createElement('span')
                  placeholder.className = 'mark-exit'
                  return placeholder
                },
                { side: -1, marks: [], key: 'mark-exit' },
              ),
            ])
          },
        },
      }),
    ]
  },
})

/** Formatting hints use canonical delimiters; they never become document text. */
export function blockMarkdownMarkers(block: Node, start: number) {
  const hints: { pos: number; text: string; side: number }[] = []
  if (!block.isTextblock || block.type.spec.code) return hints
  if (block.type.name === 'heading')
    hints.push({
      pos: start,
      text: `${'#'.repeat(block.attrs.level)} `,
      side: -10,
    })
  let previous: readonly Mark[] = []
  const transition = (marks: readonly Mark[], pos: number) => {
    const next = marks.filter((mark) => delimiters[mark.type.name])
    let shared = 0
    for (const mark of previous) {
      const other = next[shared]
      if (!other || !mark.eq(other)) break
      shared++
    }
    const close = previous
      .slice(shared)
      .reverse()
      .map((mark) => delimiters[mark.type.name])
      .join('')
    const open = next
      .slice(shared)
      .map((mark) => delimiters[mark.type.name])
      .join('')
    if (close || open)
      hints.push({ pos, text: close + open, side: close ? (open ? 0 : 1) : -1 })
    previous = next
  }
  block.forEach((node, offset) => {
    transition(node.marks, start + offset)
  })
  transition([], start + block.content.size)
  return hints
}

export function observeMarkdownMarkers(editor: Editor) {
  const key = new PluginKey('markdownMarkers')
  let document: Node | null = null
  let block: Node | null = null
  let start = -1
  let outside = -1
  let decorations = DecorationSet.empty
  editor.registerPlugin(
    new Plugin({
      key,
      props: {
        decorations(state) {
          const selection = state.selection
          if (
            !editor.isFocused ||
            !editor.isEditable ||
            !(selection instanceof TextSelection) ||
            !selection.$from.sameParent(selection.$to)
          )
            return DecorationSet.empty
          const current = selection.$head.parent
          const position = selection.$head.start()
          const after =
            selection.empty &&
            state.storedMarks &&
            !state.storedMarks.some((mark) => delimiters[mark.type.name])
              ? selection.head
              : -1
          if (
            document === state.doc &&
            block === current &&
            start === position &&
            outside === after
          )
            return decorations
          document = state.doc
          block = current
          start = position
          outside = after
          decorations = DecorationSet.create(
            state.doc,
            blockMarkdownMarkers(current, position).map(
              ({ pos, text, side }) => {
                if (side === 1 && pos === outside) side = -2
                return Decoration.widget(
                  pos,
                  (view) => {
                    const hint = view.dom.ownerDocument.createElement('span')
                    hint.className = 'markdown-marker'
                    hint.dataset.marker = text
                    hint.setAttribute('aria-hidden', 'true')
                    hint.contentEditable = 'false'
                    return hint
                  },
                  {
                    side,
                    marks: [],
                    ignoreSelection: true,
                    key: `${pos}:${side}:${text}`,
                  },
                )
              },
            ),
          )
          return decorations
        },
      },
    }),
  )
  return () => {
    if (!editor.isDestroyed) editor.unregisterPlugin(key)
  }
}
