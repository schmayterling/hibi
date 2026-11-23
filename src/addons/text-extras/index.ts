import { formattedRegistry } from '../../renderer/src/formatted-registry'
import { defineAddon, type MarkdownFlavor } from '../api'
import { flavorInfo } from './flavor-info'
import manifest from './manifest'
import css from './styles.css?inline'
import { keepBold, textExtrasMarkdown, underlineToken } from './syntax'

const flavor: MarkdownFlavor = {
  ...flavorInfo,
  export: { extensions: [textExtrasMarkdown], css },
}
let stopFormatted: (() => void)[] = []

export default defineAddon({
  manifest,
  flavors: [flavor],
  start(context) {
    context.editor.registerFlavor(flavor)
    context.styles.register('text-extras', css)
    stopFormatted = (['subscript', 'subtext', 'underline'] as const).map((id) =>
      formattedRegistry.register({
        id: `text-extras.${id}`,
        load: () =>
          import('./formatted').then(({ contributions }) => contributions[id]),
      }),
    )
    for (const id of ['subscript', 'subtext'] as const)
      context.editor.registerSyntax({
        id,
        label: id === 'subscript' ? 'Subscript' : 'Small text',
        group: 'Text extras',
        description: id === 'subscript' ? 'H~2~O' : '-# small text',
        level: id === 'subscript' ? 'inline' : 'block',
        matches: (token) => token.type === id,
        slash:
          id === 'subscript'
            ? { markdown: '~~', cursor: 1 }
            : { markdown: '-# ' },
      })
    context.editor.registerSyntax({
      id: 'underline',
      label: 'Underline',
      group: 'Text extras',
      description: '__underline__',
      level: 'inline',
      // While underline is off, `__text__` is bold again instead of text as written.
      matches(token) {
        if (underlineToken(token)) keepBold(token)
        return false
      },
      slash: { markdown: '____', cursor: 2 },
    })
  },
  stop() {
    for (const stop of stopFormatted) stop()
    stopFormatted = []
  },
})
