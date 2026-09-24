import { mergeAttributes, Node } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import { alertMarker, alertStart, alertToken, alertType } from './alerts.ts'

export const GithubAlert = Node.create({
  name: 'githubAlert',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes: () => ({
    alertType: { default: 'note', rendered: false },
    title: { default: '', rendered: false },
    fold: { default: '', rendered: false },
  }),
  parseHTML: () => [
    {
      tag: 'blockquote[data-alert]',
      priority: 60,
      contentElement: '.github-alert-body',
      getAttrs: (element) => {
        const type = alertType(element.getAttribute('data-alert'))
        return type
          ? {
              alertType: type,
              title:
                element.querySelector('.github-alert-title')?.textContent ?? '',
              fold: element.getAttribute('data-fold') ?? '',
            }
          : false
      },
    },
  ],
  renderHTML: ({ node, HTMLAttributes }) => {
    const type = alertType(node.attrs.alertType) ?? 'note'
    return [
      'blockquote',
      mergeAttributes(HTMLAttributes, {
        class: 'github-alert',
        'data-alert': type,
        'data-fold': node.attrs.fold,
      }),
      [
        'p',
        { class: 'github-alert-title', contenteditable: 'false' },
        node.attrs.title || type,
      ],
      ['div', { class: 'github-alert-body' }, 0],
    ]
  },
  markdownTokenName: 'githubAlert',
  markdownTokenizer: {
    name: 'githubAlert',
    level: 'block',
    start: alertStart,
    tokenize(source, _tokens, lexer) {
      const token = alertToken(source)
      if (token) return { ...token, tokens: lexer.blockTokens(token.text) }
    },
  },
  parseMarkdown: (token, helpers) => {
    const content = helpers.parseChildren(token.tokens ?? [])
    return helpers.createNode(
      'githubAlert',
      {
        alertType: alertType(token.alertType) ?? 'note',
        title: token.title ?? '',
        fold: token.fold ?? '',
      },
      content.length ? content : [helpers.createNode('paragraph')],
    )
  },
  renderMarkdown: (node, helpers) => {
    const type = alertType(node.attrs?.alertType) ?? 'note'
    const body = helpers.renderChildren(node.content ?? [], '\n\n')
    const marker = `> [!${type.toUpperCase()}]${node.attrs?.fold ?? ''}${node.attrs?.title ? ` ${node.attrs.title}` : ''}`
    return `${marker}\n${body
      .split('\n')
      .map((line) => (line ? `> ${line}` : '>'))
      .join('\n')}`
  },
  addKeyboardShortcuts() {
    return {
      Enter: () => {
        const { state, view } = this.editor
        const { $from, empty } = state.selection
        if (
          !empty ||
          $from.depth !== 2 ||
          $from.node(1).type.name !== 'blockquote' ||
          $from.index(1) !== 0 ||
          $from.parent.type.name !== 'paragraph' ||
          $from.parentOffset !== $from.parent.content.size
        )
          return false
        const marker = alertMarker($from.parent.textContent)
        if (!marker || marker[0] !== $from.parent.textContent) return false
        const transaction = state.tr
          .setNodeMarkup($from.before(1), this.type, {
            alertType: marker[1]!.toLowerCase(),
            title: marker[3]?.trim() ?? '',
            fold: marker[2] ?? '',
          })
          .delete($from.start(), $from.end())
        view.dispatch(
          transaction
            .setSelection(TextSelection.create(transaction.doc, $from.start()))
            .scrollIntoView(),
        )
        return true
      },
    }
  },
})
