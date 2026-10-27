import { lazy } from 'react'
import { editorDocument } from '../../renderer/src/document-formats'
import { formattedRegistry } from '../../renderer/src/formatted-registry'
import { defineAddon } from '../api'
import manifest from './manifest'
import { addFrontmatter, parseFrontmatter } from './markdown'
import { Properties } from './Properties'
import { carryFrontmatterRead, hasFrontmatter } from './slash'

let removeFormatted: (() => void) | undefined
let stopFollowing: (() => void) | undefined

export default defineAddon({
  manifest,
  Settings: lazy(() =>
    import('./Settings').then(({ Settings }) => ({ default: Settings })),
  ),
  start(context) {
    context.editor.registerMarkdown({
      id: 'metadata',
      priority: 1000,
      preservation: { level: 'verbatim', version: '1' },
      parse: parseFrontmatter,
      Editor: Properties,
    })
    // The formatted view hides and protects frontmatter when a formatted view needs it.
    removeFormatted = formattedRegistry.register({
      id: 'frontmatter.metadata',
      load: () => import('./formatted').then((module) => module.contribution),
    })
    // Finished reads for the slash action last through edits that keep them.
    stopFollowing = editorDocument.subscribeChanges(carryFrontmatterRead)
    context.commands.register({
      id: 'add',
      label: 'Add frontmatter',
      slash: {
        label: 'Frontmatter',
        description: 'Add page properties',
        keywords: 'properties metadata yaml',
        available: (note) => !hasFrontmatter(note),
        transform: addFrontmatter,
      },
      run: () => context.editor.updateMarkdown(addFrontmatter),
    })
  },
  stop() {
    removeFormatted?.()
    removeFormatted = undefined
    stopFollowing?.()
    stopFollowing = undefined
  },
})
