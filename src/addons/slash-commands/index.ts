import { codemirrorFormattedView } from '../../renderer/src/formatted-engine'
import { defineAddon } from '../api'
import manifest from './manifest'
import css from './slash.css?inline'

// The Tiptap editor loads only when it is the selected engine.
const rich = codemirrorFormattedView ? undefined : await import('./rich')

export default defineAddon({
  manifest,
  start(context) {
    context.styles.register('menu', css)
    if (rich)
      context.editor.registerRich({
        id: 'menu',
        preview: 'deferred',
        attach: (editor) => rich.attachRich(editor, context),
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
