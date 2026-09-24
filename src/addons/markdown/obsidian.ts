import { Mark, Node } from '@tiptap/core'
import type { MarkedExtension } from 'marked'
import { wikiHref } from '../../shared/note-links'

const wiki = /^(!?)\[\[([^\]\r\n]+)\]\]/
const image = /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i
const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        character
      ] ?? character,
  )

export function wikiParts(raw: string) {
  const match = wiki.exec(raw)
  if (!match) return null
  const [target, alias] = (match[2] ?? '').split('|', 2)
  if (!target?.trim()) return null
  return {
    raw: match[0],
    embed: !!match[1],
    target: target.trim(),
    label: alias?.trim() || target.trim(),
    aliased: alias !== undefined,
  }
}

const token = (source: string, embed: boolean) => {
  const parts = wikiParts(source)
  if (!parts || parts.embed !== embed) return undefined
  return {
    type: embed ? 'obsidianEmbed' : 'obsidianWikiLink',
    raw: parts.raw,
    text: parts.label,
    target: parts.target,
    aliased: parts.aliased,
    tokens: [{ type: 'text', raw: parts.label, text: parts.label }],
  }
}

const highlightToken = (source: string) => {
  const match = /^==(\S(?:[^\r\n]*?\S)?)==/.exec(source)
  if (!match) return undefined
  const text = match[1] ?? ''
  return {
    type: 'obsidianHighlight',
    raw: match[0],
    text,
    tokens: [{ type: 'text', raw: text, text }],
  }
}

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
  parseMarkdown: (value, helpers) =>
    helpers.applyMark(
      'obsidianWikiLink',
      helpers.parseInline(value.tokens ?? []),
      {
        target: value.target,
        label: value.text,
        aliased: value.aliased,
      },
    ),
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
      const render = async () => {
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
        const source = target.includes('/') ? `/${target}` : target
        const media = await window.hibi
          .readDocumentMedia(source, revision)
          .catch(() => null)
        if (id === request && media?.kind === 'image') img.src = media.url
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
        },
      }
    }
  },
})

export const obsidianMarkdown: MarkedExtension = {
  extensions: [
    {
      name: 'obsidianEmbed',
      level: 'inline',
      start: (source) => source.indexOf('![['),
      tokenizer(source) {
        return token(source, true)
      },
      renderer(value) {
        return `<span class="obsidian-embed">${escapeHtml(value.raw)}</span>`
      },
    },
    {
      name: 'obsidianWikiLink',
      level: 'inline',
      start: (source) => source.indexOf('[['),
      tokenizer(source) {
        return token(source, false)
      },
      renderer(value) {
        return `<span class="obsidian-wiki-link">${escapeHtml(value.text)}</span>`
      },
    },
    {
      name: 'obsidianHighlight',
      level: 'inline',
      start: (source) => source.indexOf('=='),
      tokenizer: highlightToken,
      renderer(value) {
        return `<mark>${escapeHtml(value.text)}</mark>`
      },
    },
  ],
}
