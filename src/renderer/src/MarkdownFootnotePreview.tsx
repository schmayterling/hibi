import DOMPurify from 'dompurify'
import { useEffect, useRef } from 'react'
import { renderMarkdownAsync } from './flavors'

export function MarkdownFootnotePreview({
  source,
  documentId,
  revision,
  version,
}: {
  source: string
  documentId: string
  revision: number
  version: string
}) {
  const host = useRef<HTMLDivElement>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: syntax and flavor changes invalidate rendered Markdown.
  useEffect(() => {
    let active = true
    const timer = setTimeout(() => {
      void renderMarkdownAsync(source, documentId)
        .then(({ html }) => {
          if (!active || !host.current) return
          const fragment = DOMPurify.sanitize(html, {
            RETURN_DOM_FRAGMENT: true,
            USE_PROFILES: { html: true, mathMl: true, svg: true },
            FORBID_TAGS: [
              'style',
              'form',
              'input',
              'button',
              'textarea',
              'select',
              'iframe',
              'audio',
              'video',
              'source',
              'picture',
            ],
            FORBID_ATTR: ['style', 'srcset'],
          })
          const images = [
            ...fragment.querySelectorAll<HTMLImageElement>('img[src]'),
          ].map((image) => {
            const path = image.getAttribute('src') ?? ''
            image.removeAttribute('src')
            return { image, path }
          })
          host.current.replaceChildren(fragment)
          for (const { image, path } of images) {
            if (
              /^data:image\/(?:png|jpeg|gif|webp|avif|svg\+xml);base64,/i.test(
                path,
              )
            ) {
              image.src = path
              continue
            }
            if (!path) continue
            void window.hibi
              .readDocumentMedia(path, revision)
              .catch(() => null)
              .then((media) => {
                if (!active || !image.isConnected) return
                if (media?.kind === 'image') image.src = media.url
                else if (media?.kind === 'video') {
                  const video = document.createElement('video')
                  video.controls = true
                  video.preload = 'metadata'
                  video.setAttribute(
                    'aria-label',
                    image.getAttribute('alt') || 'Video attachment',
                  )
                  video.src = media.url
                  image.replaceWith(video)
                }
              })
          }
        })
        .catch(() => {
          if (active && host.current)
            host.current.textContent =
              'Preview unavailable. Source is unchanged.'
        })
    }, 120)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [source, documentId, revision, version])
  return <div className="format-content markdown-footnote-preview" ref={host} />
}
