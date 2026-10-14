import { Image } from '@tiptap/extension-image'
import { attachmentMarkdown } from '../../shared/media.ts'
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
        let request = 0
        const render = async () => {
          const id = ++request
          const { src, alt, title } = current.attrs
          const result =
            /^data:image\/(png|jpeg|gif|webp|avif|svg\+xml);base64,/i.test(src)
              ? { url: src, kind: 'image' }
              : await window.hibi
                  .readDocumentMedia(src, revision)
                  .catch(() => null)
          if (id !== request) return
          if (
            (result?.kind === 'video') !==
            media instanceof HTMLVideoElement
          ) {
            if (media instanceof HTMLVideoElement) media.pause()
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
          } else media.alt = alt ?? ''
          if (result) {
            if (media.getAttribute('src') !== result.url) media.src = result.url
          } else {
            media.removeAttribute('src')
            media.removeAttribute('title')
            media.dataset.tooltip =
              'Could not load this media. Check the file path. Save the note first if the path is relative to it.'
          }
        }
        void render()
        const unsubscribe = window.hibi.onWorkspaceChanged(() => void render())
        return {
          dom: container,
          stopEvent: (event) =>
            event.target instanceof Element && !!event.target.closest('video'),
          update(next) {
            if (next.type !== current.type) return false
            const changed =
              JSON.stringify(next.attrs) !== JSON.stringify(current.attrs)
            current = next
            if (changed) void render()
            return true
          },
          ignoreMutation: () => true,
          destroy() {
            request += 1
            unsubscribe()
            if (media instanceof HTMLVideoElement) media.pause()
          },
        }
      }
    },
  }).configure({ allowBase64: true })
}
