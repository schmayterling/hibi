import type { EditorView } from '@codemirror/view'
import { formattedRegistry } from '../../renderer/src/formatted-registry'
import { defineAddon } from '../api'
import manifest from './manifest'
import css from './style.css?inline'

let stopFormatted: (() => void) | undefined
export default defineAddon({
  manifest,
  stop: () => {
    stopFormatted?.()
    stopFormatted = undefined
  },
  start(context) {
    context.styles.register('handle', css)
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
          if (formatted && step && !formatted.dom.closest('[inert], [hidden]'))
            step(formatted, direction)
        },
      })
  },
})
