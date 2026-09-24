import { defineAddon, type MarkdownFlavor } from '../api'
import { flavorInfo } from './flavor-info'
import manifest from './manifest'
import { Subscript, Subtext } from './nodes'
import css from './styles.css?inline'
import { textExtrasMarkdown } from './syntax'

const flavor: MarkdownFlavor = {
  ...flavorInfo,
  serialization: 'block-local',
  richExtensions: [Subscript, Subtext],
  export: { extensions: [textExtrasMarkdown], css },
}
export default defineAddon({
  manifest,
  flavors: [flavor],
  start(context) {
    context.editor.registerFlavor(flavor)
    context.styles.register('text-extras', css)
    for (const id of ['subscript', 'subtext'] as const)
      context.editor.registerSyntax({
        id,
        label: id === 'subscript' ? 'Subscript' : 'Small text',
        group: 'Text extras',
        description: id === 'subscript' ? 'H~2~O' : '-# small text',
        level: id === 'subscript' ? 'inline' : 'block',
        extensions: [id],
        matches: (token) => token.type === id,
        slash:
          id === 'subscript'
            ? {
                markdown: '~~',
                cursor: 1,
                rich: (chain) => chain.toggleMark('subscript'),
              }
            : {
                markdown: '-# ',
                rich: (chain) => chain.setNode('subtext'),
              },
      })
  },
})
