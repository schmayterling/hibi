import type { EditorView } from '@codemirror/view'
import type { Editor } from '@tiptap/core'
import { codemirrorFormattedView } from '../../renderer/src/formatted-engine'
import { formattedRegistry } from '../../renderer/src/formatted-registry'
import { defineAddon } from '../api'
import manifest from './manifest'
import css from './style.css?inline'

// The Tiptap editor loads only when it is the selected engine.
const rich = codemirrorFormattedView ? undefined : await import('./rich')

let stopFormatted: (() => void) | undefined
export default defineAddon({
  manifest,
  stop: () => {
    stopFormatted?.()
    stopFormatted = undefined
  },
  start(context) {
    context.styles.register('handle', css)
    let active: Editor | null = null
    // The CodeMirror formatted view loads its handle when one mounts.
    let formatted: EditorView | null = null
    let step: ((view: EditorView, direction: -1 | 1) => boolean) | null = null
    stopFormatted = formattedRegistry.register({
      id: 'block-drag.handle',
      load: () =>
        import('./formatted').then((module) => {
          step = module.formattedStep
          return module.blockDragContribution({
            menus: context.menus,
            focus(view) {
              formatted = view
            },
            close(view) {
              if (formatted === view) formatted = null
            },
          })
        }),
    })
    for (const direction of [-1, 1] as const)
      context.commands.register({
        id: direction < 0 ? 'up' : 'down',
        label: direction < 0 ? 'Move block up' : 'Move block down',
        keywords: 'reorder drag paragraph list',
        run() {
          if (formatted && step) {
            if (!formatted.dom.closest('[inert], [hidden]'))
              step(formatted, direction)
            return
          }
          if (
            !active ||
            active.isDestroyed ||
            active.view.dom.closest('[inert], [hidden]')
          )
            return
          rich?.moveSelection(active, direction)
        },
      })
    if (rich)
      context.editor.registerRich(
        rich.blockHandle(context.menus, (editor) => {
          active = editor
          return () => {
            if (active === editor) active = null
          }
        }),
      )
  },
})
