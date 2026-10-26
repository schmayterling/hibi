import { defineAddon } from '../api'
import manifest from './manifest'
import { attachRich } from './rich'
import css from './slash.css?inline'

export default defineAddon({
  manifest,
  start(context) {
    context.styles.register('menu', css)
    context.editor.registerRich({
      id: 'menu',
      preview: 'deferred',
      attach: (editor) => attachRich(editor, context),
    })
    context.editor.registerSource({
      id: 'menu',
      create: async () =>
        (await import('./source')).sourceSlashCommands(context),
    })
  },
})
