import { EditorView, WidgetType } from '@codemirror/view'
import { observeDocumentMedia } from '../../renderer/src/document-media.ts'
import {
  type FormattedContribution,
  formattedDocument,
} from '../../renderer/src/formatted-contributions.ts'
import { wikiHref } from '../../shared/note-links.ts'
import { obsidianSyntax, wikiParts } from './formatted-syntax.ts'

const image = /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i

/** Embeds the formatted view drew, for viewport tests. */
export const embedRenders = { count: 0 }

/**
 * `![[…]]`: the rich view's embed markup, an image read through the document's
 * media, or a link to the embedded note.
 */
class EmbedWidget extends WidgetType {
  constructor(
    readonly target: string,
    readonly label: string,
    readonly revision: number,
  ) {
    super()
  }
  override eq(other: EmbedWidget) {
    return (
      other.target === this.target &&
      other.label === this.label &&
      other.revision === this.revision
    )
  }
  toDOM() {
    embedRenders.count++
    const dom = document.createElement('span')
    dom.className = 'obsidian-embed'
    const file = this.target.split('#')[0] ?? ''
    if (!image.test(file)) {
      const link = document.createElement('a')
      link.href = wikiHref(this.target)
      link.textContent = this.label
      dom.append(link)
      return dom
    }
    const img = document.createElement('img')
    img.loading = 'lazy'
    img.decoding = 'async'
    // A label of `200` or `200x100` sizes the image, as in Obsidian.
    const dimensions = /^(\d{1,4})(?:x(\d{1,4}))?$/.exec(this.label)
    img.alt = dimensions ? (file.split('/').at(-1) ?? file) : this.label
    if (dimensions) {
      img.width = Number(dimensions[1])
      if (dimensions[2]) img.height = Number(dimensions[2])
    }
    dom.append(img)
    stops.set(
      dom,
      observeDocumentMedia(
        file.includes('/') ? `/${file}` : file,
        this.revision,
        (media) => {
          if (media?.kind === 'image') img.src = media.url
          else img.removeAttribute('src')
        },
      ),
    )
    return dom
  }
  override destroy(dom: HTMLElement) {
    stops.get(dom)?.()
    stops.delete(dom)
    dom.querySelector('img')?.removeAttribute('src')
  }
}

const stops = new WeakMap<HTMLElement, () => void>()

/** Wikilinks, embeds and highlights in documents that use the Obsidian flavor. */
export const contribution: FormattedContribution = {
  id: 'markdown.obsidian',
  flavor: 'markdown.obsidian',
  syntax: obsidianSyntax,
  views: [
    {
      nodes: ['WikiLink'],
      decorate(node, out, { state }) {
        const parts = wikiParts(state.sliceDoc(node.from, node.to))
        if (!parts) return false
        // The label reads as a link; brackets, and the target behind an alias, are syntax.
        out.syntax(node.from, node.from + parts.labelFrom)
        out.mark(node.from + parts.labelFrom, node.from + parts.labelTo, {
          class: 'hibi-lp-link',
          'data-wiki-link': parts.target,
        })
        out.syntax(node.from + parts.labelTo, node.to)
        return false
      },
    },
    {
      nodes: ['WikiEmbed'],
      decorate(node, out, { state, revealed }) {
        const parts = wikiParts(state.sliceDoc(node.from, node.to))
        if (!parts) return false
        if (revealed) {
          out.syntax(node.from, node.from + 3)
          out.syntax(node.to - 2, node.to)
        } else
          out.replace(
            node.from,
            node.to,
            new EmbedWidget(
              parts.target,
              parts.label,
              state.facet(formattedDocument).revision,
            ),
          )
        return false
      },
    },
    {
      nodes: ['Highlight'],
      decorate(node, out) {
        out.syntax(node.from, node.from + 2)
        out.mark(node.from + 2, node.to - 2, { class: 'hibi-lp-highlight' })
        out.syntax(node.to - 2, node.to)
        return false
      },
    },
  ],
  // The colors of the rich view's `<mark>`, which only the browser styles.
  extension: EditorView.baseTheme({
    '.hibi-lp-highlight': { backgroundColor: 'Mark', color: 'MarkText' },
  }),
}
