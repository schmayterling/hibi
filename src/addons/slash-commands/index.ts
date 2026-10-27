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
    context.editor.registerFormatted({
      id: 'menu',
      async create() {
        const [
          { sourceSlashCommands },
          { formattedCellExtensions, formattedSyntaxTree },
        ] = await Promise.all([
          import('./source'),
          import('../../renderer/src/formatted-contributions'),
        ])
        return [
          sourceSlashCommands(context, formattedSyntaxTree),
          formattedCellExtensions.of((main) =>
            sourceSlashCommands(context, undefined, undefined, main),
          ),
        ]
      },
    })
    context.editor.registerSource({
      id: 'menu',
      async create() {
        const [{ sourceSlashCommands }, { frontmatterBounds }] =
          await Promise.all([
            import('./source'),
            import('../../renderer/src/formatted-frontmatter'),
          ])
        return [
          frontmatterBounds,
          sourceSlashCommands(context, undefined, (state) =>
            state.field(frontmatterBounds, false),
          ),
        ]
      },
    })
  },
})
