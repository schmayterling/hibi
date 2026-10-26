import type { Editor } from '@tiptap/core'
import {
  DragHandlePlugin,
  normalizeNestedOptions,
} from '@tiptap/extension-drag-handle'
import { NodeSelection, PluginKey } from '@tiptap/pm/state'
import { defineAddon } from '../api'
import manifest from './manifest'
import { blockMove } from './move'
import css from './style.css?inline'

export default defineAddon({
  manifest,
  start(context) {
    context.styles.register('handle', css)
    let active: Editor | null = null
    for (const direction of [-1, 1] as const)
      context.commands.register({
        id: direction < 0 ? 'up' : 'down',
        label: direction < 0 ? 'Move block up' : 'Move block down',
        keywords: 'reorder drag paragraph list',
        run() {
          if (
            !active ||
            active.isDestroyed ||
            active.view.dom.closest('[inert], [hidden]')
          )
            return
          const { selection } = active.state
          const positions =
            selection instanceof NodeSelection
              ? [selection.from]
              : Array.from({ length: selection.$from.depth }, (_, i) =>
                  selection.$from.before(selection.$from.depth - i),
                )
          for (const position of positions) {
            const transaction = blockMove(active, position, direction)
            if (!transaction) continue
            active.view.dispatch(transaction)
            active.view.focus()
            break
          }
        },
      })
    context.editor.registerRich({
      id: 'handle',
      preview: 'deferred',
      attach(editor) {
        active = editor
        const element = document.createElement('button')
        element.type = 'button'
        element.className = 'block-drag-handle'
        element.setAttribute('aria-label', 'Drag block or open block actions')
        element.dataset.tooltip = 'Drag to move · click for block actions'
        element.innerHTML =
          '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="5" r="1.5"/><circle cx="15" cy="5" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="19" r="1.5"/><circle cx="15" cy="19" r="1.5"/></svg>'
        let pos = -1
        let menu: { close: () => void } | undefined
        const key = new PluginKey('hibiBlockDrag')
        const handle = DragHandlePlugin({
          editor,
          element,
          pluginKey: key,
          nestedOptions: normalizeNestedOptions(true),
          computePositionConfig: { placement: 'left-start' },
          onNodeChange(change) {
            pos = change.pos
          },
        })
        const open = () => {
          if (!editor.isEditable || pos < 0) return
          const selectedPos = pos
          menu?.close()
          menu = context.menus.open({
            label: 'Block actions',
            anchor: element,
            items: ([-1, 1] as const).map((direction) => ({
              id: direction < 0 ? 'up' : 'down',
              label: direction < 0 ? 'Move block up' : 'Move block down',
              disabled: !blockMove(editor, selectedPos, direction),
              onSelect() {
                const transaction = blockMove(editor, selectedPos, direction)
                if (transaction) {
                  editor.view.dispatch(transaction)
                  editor.view.focus()
                }
              },
            })),
          })
        }
        element.addEventListener('click', open)
        editor.registerPlugin(handle.plugin)
        return () => {
          if (active === editor) active = null
          menu?.close()
          element.removeEventListener('click', open)
          handle.unbind()
          editor.unregisterPlugin(key)
        }
      },
    })
  },
})
