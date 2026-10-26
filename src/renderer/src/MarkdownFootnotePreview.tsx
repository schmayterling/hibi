import DOMPurify from 'dompurify'
import { useEffect, useRef } from 'react'
import { observeDocumentMedia } from './document-media'
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
    const disposers: (() => void)[] = []
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
            image.loading = 'lazy'
            image.decoding = 'async'
            return { image, path }
          })
          host.current.replaceChildren(fragment)
          for (const { image, path } of images) {
            if (!path) continue
            let video: HTMLVideoElement | null = null
            const clear = () => {
              image.removeAttribute('src')
              if (video) {
                video.removeAttribute('src')
                video.load()
              }
            }
            disposers.push(
              observeDocumentMedia(path, revision, (media) => {
                if (!active) return
                if (media?.kind === 'image') {
                  if (video) {
                    clear()
                    video.replaceWith(image)
                    video = null
                  }
                  image.src = media.url
                } else if (media?.kind === 'video') {
                  if (!video) {
                    video = document.createElement('video')
                    video.controls = true
                    video.preload = 'metadata'
                    video.setAttribute(
                      'aria-label',
                      image.getAttribute('alt') || 'Video attachment',
                    )
                    image.replaceWith(video)
                  }
                  video.src = media.url
                } else clear()
              }),
              clear,
            )
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
      for (const dispose of disposers) dispose()
    }
  }, [source, documentId, revision, version])
  return <div className="format-content markdown-footnote-preview" ref={host} />
}
