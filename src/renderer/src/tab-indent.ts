import { Extension } from '@tiptap/core'
import { Plugin, TextSelection } from '@tiptap/pm/state'
import { codeIndentLines, detectIndentUnit, tabIndent } from './indentation.ts'

/** Rich-text Tab: lists and tables first, then code indentation, then a mid-line tab. */
export const TabIndent = Extension.create({
  name: 'tabIndent',
  // After list and table keymaps, which keep their own Tab behavior.
  priority: 50,
  addProseMirrorPlugins() {
    // Like CodeMirror: an Escape no menu used lets the next Tab move focus. Untimed,
    // so nobody has to hurry; another key or leaving the editor disarms it.
    let armed = false
    return [
      new Plugin({
        props: {
          handleKeyDown: (_view, event) => {
            if (event.key === 'Escape') armed = true
            return false
          },
          handleDOMEvents: {
            keydown: (_view, event) => {
              const escaped = event.key === 'Tab' && armed
              if (
                !['Escape', 'Shift', 'Control', 'Alt', 'Meta'].includes(
                  event.key,
                )
              )
                armed = false
              return escaped
            },
            blur: () => {
              armed = false
              return false
            },
          },
        },
      }),
    ]
  },
  addKeyboardShortcuts() {
    const press = (outdent: boolean) => () => {
      if (!this.editor.isEditable) return false
      const { state, view } = this.editor
      const { $from, $to, from, to } = state.selection
      const code = $from.parent.type.name === 'codeBlock'
      const { enabled } = tabIndent.snapshot()
      // Code indents its own lines; otherwise, and with indenting off, items keep Tab.
      if (!code || !enabled)
        for (let depth = $from.depth; depth > 0; depth--)
          if (['listItem', 'taskItem'].includes($from.node(depth).type.name))
            // Keep focus when an item cannot move farther.
            return true
      if (!enabled) return false
      if (!$from.sameParent($to) || !$from.parent.isTextblock) return true
      const tr = state.tr
      if (code) {
        const start = $from.start()
        const text = $from.parent.textContent
        const unit =
          detectIndentUnit(text, codeIndentLines) ?? tabIndent.snapshot().unit
        if (!outdent && from === to) tr.insertText(unit, from)
        else {
          // One replacement for every line: per-line steps would each keep a whole-block copy.
          const head =
            from === start ? 0 : text.lastIndexOf('\n', from - start - 1) + 1
          let end = text.indexOf('\n', Math.max(head, to - start - 1))
          if (end < 0) end = text.length
          const width = unit === '\t' ? 4 : unit.length
          const leading = new RegExp(`^(?:\t| {1,${width}})`)
          // Characters each line gains, negative when outdenting.
          const lines = text
            .slice(head, end)
            .split('\n')
            .map((line) => ({
              line,
              delta: outdent
                ? -(leading.exec(line)?.[0].length ?? 0)
                : unit.length,
            }))
          if (lines.every(({ delta }) => !delta)) return true
          // Shift a position by the lines before it; never past its own line start.
          const map = (pos: number) => {
            let at = start + head,
              moved = pos
            for (const { line, delta } of lines) {
              if (pos < at) break
              moved += Math.max(delta, at - pos)
              at += line.length + 1
            }
            return moved
          }
          const { anchor, head: caret } = state.selection
          tr.insertText(
            lines
              .map(({ line, delta }) =>
                outdent ? line.slice(-delta) : unit + line,
              )
              .join('\n'),
            start + head,
            start + end,
          ).setSelection(TextSelection.create(tr.doc, map(anchor), map(caret)))
        }
      } else {
        // Leading whitespace would turn into an indented code block on save.
        const line = $from.parent
          .textBetween(0, $from.parentOffset, undefined, (leaf) =>
            leaf.type.name === 'hardBreak' ? '\n' : '\ufffc',
          )
          .split('\n')
          .at(-1)
        if (outdent || !/\S/.test(line ?? '')) return true
        tr.insertText('\t', from, to)
      }
      // A UI event is its own undo step, apart from typing and other Tabs.
      if (tr.docChanged)
        view.dispatch(tr.setMeta('uiEvent', 'indent').scrollIntoView())
      return true
    }
    return { Tab: press(false), 'Shift-Tab': press(true) }
  },
})
