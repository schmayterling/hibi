import { Tags } from 'lucide-react'
import { isMarkdownDocument } from '../../shared/document-types'
import { defineAddon } from '../api'
import manifest from './manifest'
import { TagsPanel } from './Panel'
import { richTags } from './rich-decorations'
import css from './style.css?inline'
import { noteTags } from './syntax'

export default defineAddon({
  manifest,
  start(context) {
    context.styles.register('tags', css)
    const view = context.sidebar.register({
      id: 'browser',
      label: 'Tags',
      icon: Tags,
      Content: ({ input }) => <TagsPanel context={context} selection={input} />,
    })
    const browse = (tag?: string) => view.open({ tag })
    context.commands.register({
      id: 'browse',
      label: 'Browse tags',
      keywords: 'hashtags notes',
      run: () => browse(),
    })
    context.toolbar.register({
      id: 'browse',
      label: 'Browse tags',
      icon: Tags,
      onClick: () => browse(),
    })
    const status = context.statusBar.register({
      id: 'tags',
      label: '',
      tooltip: 'Browse workspace tags',
      onClick: () => browse(),
    })
    context.editor.onDocumentChange((document) => {
      const tags = isMarkdownDocument(document.name)
        ? noteTags(document.markdown)
        : []
      status.update({
        label: tags.length ? `Tags · ${tags.length}` : '',
        tooltip: tags.map((tag) => `#${tag}`).join(' · '),
      })
    })
    context.editor.registerRich(richTags(browse))
    context.editor.registerSource({
      id: 'highlights',
      async create() {
        const { sourceTags } = await import('./decorations')
        return sourceTags(browse, () =>
          isMarkdownDocument(context.editor.getDocument()?.name ?? ''),
        ).create()
      },
    })
  },
})
