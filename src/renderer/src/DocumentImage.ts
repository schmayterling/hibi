import { Image } from '@tiptap/extension-image'
import { attachmentMarkdown, type DocumentMedia } from '../../shared/media.ts'
import { observeDocumentMedia } from './document-media.ts'
import { decodeMarkdownEntities } from './markdown-entities.ts'

/** Resolve display URLs without changing the Markdown stored in image attrs. */
export function documentImage(revision: number) {
  return Image.extend({
    parseMarkdown: (token, helpers) => {
      const inline = token.tokens ? helpers.parseInline(token.tokens) : []
      return helpers.createNode('image', {
        src: token.href,
        // Keep the original label when inline nodes cannot become plain text.
        alt:
          inline.length && inline.every((node) => node.type === 'text')
            ? inline.map((node) => node.text ?? '').join('')
            : decodeMarkdownEntities(token.text ?? ''),
        title: token.title ? decodeMarkdownEntities(token.title) : null,
      })
    },
    renderMarkdown: (node) =>
      attachmentMarkdown([
        {
          url: node.attrs?.src ?? '',
          alt: node.attrs?.alt ?? '',
          title: node.attrs?.title ?? '',
        },
      ]),
    addNodeView() {
      return ({ node }) => {
        const container = document.createElement('span')
        container.className = 'document-media'
        container.contentEditable = 'false'
        let media: HTMLImageElement | HTMLVideoElement =
          document.createElement('img')
        container.append(media)
        let current = node
        let result: DocumentMedia | null = null
        const render = (next: DocumentMedia | null) => {
          result = next
          const { alt, title } = current.attrs
          if (
            (result?.kind === 'video') !==
            media instanceof HTMLVideoElement
          ) {
            if (media instanceof HTMLVideoElement) {
              media.pause()
              media.removeAttribute('src')
              media.load()
            }
            media = document.createElement(
              result?.kind === 'video' ? 'video' : 'img',
            )
            container.replaceChildren(media)
          }
          media.title = title ?? ''
          delete media.dataset.tooltip
          if (media instanceof HTMLVideoElement) {
            media.controls = true
            media.preload = 'metadata'
            media.setAttribute('aria-label', alt || 'Video attachment')
          } else {
            media.alt = alt ?? ''
            media.loading = 'lazy'
            media.decoding = 'async'
          }
          if (result) {
            if (media.getAttribute('src') !== result.url) media.src = result.url
          } else {
            media.removeAttribute('src')
            media.removeAttribute('title')
            media.dataset.tooltip =
              'Could not load this media. Check the file path. Save the note first if the path is relative to it.'
          }
        }
        let unsubscribe = observeDocumentMedia(
          current.attrs.src,
          revision,
          render,
        )
        return {
          dom: container,
          stopEvent: (event) =>
            event.target instanceof Element && !!event.target.closest('video'),
          update(next) {
            if (next.type !== current.type) return false
            const changed = next.attrs.src !== current.attrs.src
            current = next
            if (changed) {
              unsubscribe()
              unsubscribe = observeDocumentMedia(
                current.attrs.src,
                revision,
                render,
              )
            } else render(result)
            return true
          },
          ignoreMutation: () => true,
          destroy() {
            unsubscribe()
            media.removeAttribute('src')
            if (media instanceof HTMLVideoElement) {
              media.pause()
              media.load()
            }
          },
        }
      }
    },
  }).configure({ allowBase64: true })
}
