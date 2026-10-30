import { Mark, Node } from '@tiptap/core'
import { observeDocumentMedia } from '../../renderer/src/document-media.ts'
import { wikiHref } from '../../shared/note-links.ts'
import { highlightToken, token } from './obsidian-markdown.ts'

export { obsidianMarkdown } from './obsidian-markdown.ts'

const image = /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i

export const WikiLink = Mark.create({
  name: 'obsidianWikiLink',
  inclusive: false,
  addAttributes: () => ({
    target: { default: '' },
    label: { default: '' },
    aliased: { default: false },
  }),
  parseHTML: () => [{ tag: 'a[data-wiki-link]' }],
  renderHTML: ({ HTMLAttributes }) => [
    'a',
    {
      href: wikiHref(HTMLAttributes.target),
      'data-wiki-link': HTMLAttributes.target,
    },
    0,
  ],
  markdownTokenName: 'obsidianWikiLink',
  markdownTokenizer: {
    name: 'obsidianWikiLink',
    level: 'inline',
    start: (source) => source.indexOf('[['),
    tokenize(source) {
      return token(source, false)
    },
  },
  parseMarkdown: (value, helpers) => {
    const content = helpers.parseInline(value.tokens ?? [])
    return helpers.applyMark('obsidianWikiLink', content, {
      target: value.target,
      label: content.map((node) => node.text ?? '').join(''),
      aliased: value.aliased,
    })
  },
  renderMarkdown: (node, helpers) => {
    const target = node.attrs?.target ?? ''
    const text = helpers.renderChildren(node)
    const alias = node.attrs?.aliased || text !== node.attrs?.label
    return `[[${target}${alias ? `|${text}` : ''}]]`
  },
})

export const ObsidianHighlight = Mark.create({
  name: 'obsidianHighlight',
  parseHTML: () => [{ tag: 'mark' }],
  renderHTML: () => ['mark', {}, 0],
  markdownTokenName: 'obsidianHighlight',
  markdownTokenizer: {
    name: 'obsidianHighlight',
    level: 'inline',
    start: (source) => source.indexOf('=='),
    tokenize: highlightToken,
  },
  parseMarkdown: (value, helpers) =>
    helpers.applyMark(
      'obsidianHighlight',
      helpers.parseInline(value.tokens ?? []),
    ),
  renderMarkdown: (node, helpers) => `==${helpers.renderChildren(node)}==`,
})

export const WikiEmbed = Node.create({
  name: 'obsidianEmbed',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => ({ target: { default: '' }, label: { default: '' } }),
  parseHTML: () => [{ tag: 'span[data-wiki-embed]' }],
  renderHTML: ({ node }) => [
    'span',
    { 'data-wiki-embed': node.attrs.target, class: 'obsidian-embed' },
    node.attrs.label,
  ],
  markdownTokenName: 'obsidianEmbed',
  markdownTokenizer: {
    name: 'obsidianEmbed',
    level: 'inline',
    start: (source) => source.indexOf('![['),
    tokenize(source) {
      return token(source, true)
    },
  },
  parseMarkdown: (value, helpers) =>
    helpers.createNode('obsidianEmbed', {
      target: value.target,
      label: value.text,
    }),
  renderMarkdown: (node) =>
    `![[${node.attrs?.target ?? ''}${node.attrs?.label !== node.attrs?.target ? `|${node.attrs?.label}` : ''}]]`,
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('span')
      dom.className = 'obsidian-embed'
      dom.contentEditable = 'false'
      let current = node
      let request = 0
      let unsubscribe = () => {}
      const render = async () => {
        unsubscribe()
        dom.querySelector('img')?.removeAttribute('src')
        const id = ++request
        const fullTarget = String(current.attrs.target ?? '')
        const target = fullTarget.split('#')[0] ?? ''
        if (!image.test(target)) {
          const link = document.createElement('a')
          link.href = wikiHref(fullTarget)
          link.textContent = String(current.attrs.label ?? target)
          dom.replaceChildren(link)
          return
        }
        const img = document.createElement('img')
        img.loading = 'lazy'
        img.decoding = 'async'
        const label = String(current.attrs.label ?? '')
        const dimensions = /^(\d{1,4})(?:x(\d{1,4}))?$/.exec(label)
        img.alt = dimensions
          ? (target.split('/').at(-1) ?? target)
          : label || target
        if (dimensions) {
          img.width = Number(dimensions[1])
          if (dimensions[2]) img.height = Number(dimensions[2])
        }
        dom.replaceChildren(img)
        const revision = (await window.hibi.getDocument()).revision
        if (id !== request) return
        const source = target.includes('/') ? `/${target}` : target
        unsubscribe = observeDocumentMedia(source, revision, (media) => {
          if (media?.kind === 'image') img.src = media.url
          else img.removeAttribute('src')
        })
      }
      void render()
      return {
        dom,
        update(next) {
          if (next.type !== current.type) return false
          if (
            next.attrs.target !== current.attrs.target ||
            next.attrs.label !== current.attrs.label
          ) {
            current = next
            void render()
          }
          return true
        },
        ignoreMutation: () => true,
        destroy() {
          request++
          unsubscribe()
          dom.querySelector('img')?.removeAttribute('src')
          dom.replaceChildren()
        },
      }
    }
  },
})
