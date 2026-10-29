import { Mark, markInputRule, Node, textblockTypeInputRule } from '@tiptap/core'
import { leafBlock } from '../../shared/marked-leaf-blocks.ts'
import { subscriptToken, subtextStart, subtextToken } from './syntax.ts'

export const Subscript = Mark.create({
  name: 'subscript',
  inclusive: false,
  parseHTML: () => [{ tag: 'sub' }],
  renderHTML: () => ['sub', {}, 0],
  markdownTokenName: 'subscript',
  markdownTokenizer: {
    name: 'subscript',
    level: 'inline',
    start: (source) => source.indexOf('~'),
    tokenize(source, _tokens, lexer) {
      const token = subscriptToken(source)
      if (token) return { ...token, tokens: lexer.inlineTokens(token.text) }
    },
  },
  parseMarkdown: (token, helpers) =>
    helpers.applyMark('subscript', helpers.parseInline(token.tokens ?? [])),
  renderMarkdown: (node, helpers) => `~${helpers.renderChildren(node)}~`,
  addInputRules() {
    return [
      markInputRule({
        find: /(?<![~\\])(~([^\s~](?:[^~\n]*?[^\s~])?)~)$/,
        type: this.type,
      }),
    ]
  },
})

export const Subtext = Node.create({
  name: 'subtext',
  group: 'block',
  content: 'inline*',
  defining: true,
  parseHTML: () => [{ tag: 'p.markdown-subtext', priority: 60 }],
  renderHTML: () => ['p', { class: 'markdown-subtext' }, 0],
  markdownTokenName: 'subtext',
  markdownTokenizer: {
    name: 'subtext',
    level: 'block',
    start: subtextStart,
    tokenize(source, _tokens, lexer) {
      const token = subtextToken(source)
      if (token)
        return leafBlock({ ...token, tokens: lexer.inlineTokens(token.text) })
    },
  },
  parseMarkdown: (token, helpers) =>
    helpers.createNode(
      'subtext',
      undefined,
      helpers.parseInline(token.tokens ?? []),
    ),
  renderMarkdown: (node, helpers) =>
    helpers
      .renderChildren(node.content ?? [])
      .split('\n')
      .map((line) => `-# ${line}`)
      .join('\n'),
  addInputRules() {
    return [textblockTypeInputRule({ find: /^-#\s$/, type: this.type })]
  },
  addKeyboardShortcuts() {
    return {
      Enter: () =>
        this.editor.isActive(this.name) &&
        this.editor
          .chain()
          .splitBlock()
          .command(({ tr, dispatch }) => {
            if (dispatch)
              tr.setNodeMarkup(
                tr.selection.$from.before(),
                this.editor.schema.nodes.paragraph,
              )
            return true
          })
          .run(),
    }
  },
})
