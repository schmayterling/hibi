import { mergeAttributes, Node } from '@tiptap/core'
import { Plugin, TextSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { quoteBlock } from '../../shared/marked-leaf-blocks.ts'
import { alertMarker, alertStart, alertToken, alertType } from './alerts.ts'
import { calloutToggle, updateCalloutToggle } from './callout-toggle.ts'

/** Unfolds a callout, by its node view's element. */
const unfolds = new WeakMap<globalThis.Node, () => void>()

/**
 * A selection end inside a folded callout shows it, as find, the outline
 * and undo place one there. Plugin views update before the view scrolls to
 * the selection.
 */
const revealFolds = new Plugin({
  view: () => ({
    update(view: EditorView, previous) {
      const { doc, selection } = view.state
      if (doc === previous.doc && selection.eq(previous.selection)) return
      for (const $pos of [selection.$anchor, selection.$head])
        for (let depth = $pos.depth; depth > 0; depth--)
          if ($pos.node(depth).type.name === 'githubAlert') {
            const dom = view.nodeDOM($pos.before(depth))
            if (dom) unfolds.get(dom)?.()
          }
    },
  }),
})

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
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('blockquote')
      dom.className = 'github-alert'
      const title = document.createElement('p')
      title.className = 'github-alert-title'
      title.contentEditable = 'false'
      const label = document.createElement('span')
      const contentDOM = document.createElement('div')
      contentDOM.className = 'github-alert-body'
      title.append(label)
      dom.append(title, contentDOM)
      let current = node
      let expanded = node.attrs.fold !== '-'
      let button: HTMLButtonElement | undefined
      const toggle = () => {
        expanded = !expanded
        render()
      }
      const render = () => {
        const type = alertType(current.attrs.alertType) ?? 'note'
        const text = current.attrs.title || type
        dom.dataset.alert = type
        dom.dataset.fold = current.attrs.fold
        label.textContent = text
        const foldable = /^[+-]$/.test(current.attrs.fold)
        contentDOM.hidden = foldable && !expanded
        if (foldable) {
          if (!button) {
            button = calloutToggle(text, expanded, toggle)
            title.prepend(button)
          } else updateCalloutToggle(button, text, expanded, toggle)
        } else {
          button?.remove()
          button = undefined
        }
      }
      render()
      unfolds.set(dom, () => {
        if (expanded) return
        expanded = true
        render()
      })
      return {
        dom,
        contentDOM,
        update(next) {
          if (next.type !== current.type) return false
          if (next.attrs.fold !== current.attrs.fold)
            expanded = next.attrs.fold !== '-'
          current = next
          render()
          return true
        },
        stopEvent: (event) =>
          button?.contains(event.target as globalThis.Node) ?? false,
        ignoreMutation: (mutation) =>
          mutation.type !== 'selection' &&
          ((mutation.type === 'attributes' && mutation.target === contentDOM) ||
            !contentDOM.contains(mutation.target)),
      }
    }
  },
  addProseMirrorPlugins: () => [revealFolds],
  markdownTokenName: 'githubAlert',
  markdownTokenizer: {
    name: 'githubAlert',
    level: 'block',
    start: alertStart,
    tokenize(source, _tokens, lexer) {
      const token = alertToken(source)
      if (token)
        return quoteBlock(
          { ...token, tokens: lexer.blockTokens(token.text) },
          token,
        )
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
