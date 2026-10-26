import { lazy } from 'react'
import { formattedRegistry } from '../../renderer/src/formatted-registry'
import { defineAddon } from '../api'
import manifest from './manifest'
import { addFrontmatter, parseFrontmatter } from './markdown'
import { Properties } from './Properties'

let removeFormatted: (() => void) | undefined

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
    context.commands.register({
      id: 'add',
      label: 'Add frontmatter',
      slash: {
        label: 'Frontmatter',
        description: 'Add page properties',
        keywords: 'properties metadata yaml',
        when: (source) => !parseFrontmatter(source),
        transform: addFrontmatter,
      },
      run: () => context.editor.updateMarkdown(addFrontmatter),
    })
  },
  stop() {
    removeFormatted?.()
    removeFormatted = undefined
  },
})
