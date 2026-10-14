import type { Editor } from '@tiptap/core'
import { closeHistory } from '@tiptap/pm/history'
import type { Node } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import type { AddonContext } from '../api'
import { maximumSlashQueryUnits, slashQuery } from './commands'
import { createSlashMenu } from './menu'

/** Count text across marks and inline containers, stopping once a match is impossible. */
function impossiblePrefix(parent: Node, to: number) {
  let units = 0
  function scan(node: Node, end: number): boolean {
    for (let index = 0, position = 0; position < end; index++) {
      const child = node.child(index)
      if (child.isText) units += Math.min(child.nodeSize, end - position)
      else if (child.isLeaf) return true
      else if (scan(child, Math.min(child.content.size, end - position - 1)))
        return true
      if (units > maximumSlashQueryUnits) return true
      position += child.nodeSize
    }
    return false
  }
  return scan(parent, to)
}

export function attachRich(editor: Editor, context: AddonContext) {
  const key = new PluginKey('slashCommands')
  let menu: ReturnType<typeof createSlashMenu> | null = null
  let view: EditorView | null = null
  let frame = 0
  const current = () => {
    if (!view || view.isDestroyed) return null
    const { selection } = view.state
    const { $from } = selection
    if (
      !view.editable ||
      !view.hasFocus() ||
      !selection.empty ||
      !$from.parent.isTextblock ||
      $from.parent.type.spec.code ||
      $from.marks().some((mark) => mark.type.name === 'code')
    )
      return null
    if (
      $from.parentOffset > maximumSlashQueryUnits &&
      impossiblePrefix($from.parent, $from.parentOffset)
    )
      return null
    const query = slashQuery(
      $from.parent.textBetween(0, $from.parentOffset, '\n', '\ufffc'),
    )
    return query === null ? null : { from: $from.start(), to: $from.pos, query }
  }
  const refresh = () => {
    if (!menu || !view || view.isDestroyed || view.composing) return
    const match = current()
    menu.update(
      match
        ? {
            ...match,
            rect: view.coordsAtPos(match.to),
            run(command) {
              const latest = current()
              if (
                !latest ||
                latest.from !== match.from ||
                latest.to !== match.to ||
                latest.query !== match.query
              )
                return
              if ('transform' in command) {
                const draft = editor.state.tr.deleteRange(match.from, match.to)
                const body = editor.storage.markdown.manager.serialize(
                  draft.doc.toJSON(),
                )
                context.editor.updateMarkdown(command.transform, { body })
                return
              }
              if (!command.rich) return
              command
                .rich(
                  editor
                    .chain()
                    .focus()
                    .command(({ tr }) => {
                      closeHistory(tr)
                      return true
                    })
                    .deleteRange({ from: match.from, to: match.to }),
                )
                .run()
            },
          }
        : null,
    )
  }
  const schedule = () => {
    const match = current()
    menu?.observe(match)
    if (!match) menu?.update(null)
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(refresh)
  }
  editor.registerPlugin(
    new Plugin({
      key,
      props: {
        handleKeyDown: (_view, event) => {
          if (event.key === 'Enter' || event.key === 'Tab') refresh()
          return menu?.keydown(event) ?? false
        },
        handleDOMEvents: {
          focus: () => {
            schedule()
            return false
          },
        },
      },
      view: (mountedView) => {
        view = mountedView
        menu = createSlashMenu(view.dom, schedule, context, (command) => {
          if ('transform' in command) return true
          if (!command.rich) return false
          try {
            // Keep supported no-ops, such as plain text in a paragraph: selecting
            // them still removes the slash query. Missing flavor commands throw.
            command.rich(editor.can().chain())
            return true
          } catch {
            return false
          }
        })
        schedule()
        return {
          update: schedule,
          destroy() {
            cancelAnimationFrame(frame)
            menu?.destroy()
            menu = null
            view = null
          },
        }
      },
    }),
    (plugin, plugins) => [plugin, ...plugins],
  )
  schedule()
  return () => {
    if (!editor.isDestroyed) editor.unregisterPlugin(key)
  }
}
