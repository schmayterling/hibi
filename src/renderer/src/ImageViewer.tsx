import { useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type { DocumentPreviewProps } from '../../addons/api'

const MIN_ZOOM = 1
const MAX_ZOOM = 8

/** The zoom after one wheel step, where 1 fits the image to the pane. */
export function wheelZoom(zoom: number, deltaY: number) {
  return Math.min(
    MAX_ZOOM,
    Math.max(MIN_ZOOM, zoom * Math.exp(-deltaY * 0.002)),
  )
}

/** undefined is still loading, null is unavailable. */
export function ImageContent({
  url,
  name,
  zoom,
  onError,
}: {
  url: string | null | undefined
  name: string
  zoom: number
  /** The browser could not decode the bytes, which the read can't tell. */
  onError?: () => void
}) {
  if (url === undefined) return null
  if (url === null)
    return (
      <div className="format-unavailable image-unavailable" role="status">
        <strong>Unable to display image</strong>
        <p>The file may be missing, damaged, or not a supported image.</p>
      </div>
    )
  return (
    <img
      className="image-preview"
      src={url}
      alt={name}
      draggable={false}
      decoding="async"
      onError={onError}
      style={{
        objectFit: 'contain',
        width: `${zoom * 100}%`,
        height: `${zoom * 100}%`,
      }}
    />
  )
}

/** Shows an image fitted to the pane; Ctrl or ⌘ with the wheel zooms it. */
export function ImageViewer({ document }: DocumentPreviewProps) {
  const [url, setUrl] = useState<string | null | undefined>(undefined)
  const [zoom, setZoom] = useState(1)
  const frame = useRef<HTMLDivElement>(null)
  const zoomRef = useRef(1)
  useEffect(() => {
    let current = true
    let unsubscribe: (() => void) | undefined
    setUrl(undefined)
    zoomRef.current = 1
    setZoom(1)
    // Use the note editor's shared, cancellable stream instead of copying
    // the whole image through IPC as a base64 string.
    // Import inside the effect so startup stays small without a second
    // Suspense fallback delaying the first image request.
    void import('./document-media')
      .then(({ observeDocumentMedia }) => {
        if (!current) return
        unsubscribe = observeDocumentMedia(
          encodeURIComponent(document.name),
          document.revision,
          (media) => setUrl(media?.kind === 'image' ? media.url : null),
        )
      })
      .catch(() => {
        if (current) setUrl(null)
      })
    return () => {
      current = false
      unsubscribe?.()
    }
  }, [document.name, document.revision])
  useEffect(() => {
    const element = frame.current
    if (!element) return
    // React's wheel handlers are passive, so this one is added directly.
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      const image = element.querySelector('img')
      const next = wheelZoom(zoomRef.current, event.deltaY)
      if (!image || next === zoomRef.current) return
      const before = image.getBoundingClientRect()
      zoomRef.current = next
      flushSync(() => setZoom(next))
      // Keeps the point under the cursor where it was.
      const after = image.getBoundingClientRect()
      const x = (event.clientX - before.left) / before.width
      const y = (event.clientY - before.top) / before.height
      element.scrollLeft += after.left + x * after.width - event.clientX
      element.scrollTop += after.top + y * after.height - event.clientY
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  }, [])
  return (
    <div className="image-viewer" ref={frame}>
      <ImageContent
        url={url}
        name={document.name}
        zoom={zoom}
        onError={() => setUrl((current) => (current === url ? null : current))}
      />
    </div>
  )
}
