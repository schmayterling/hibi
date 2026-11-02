import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentProxy,
} from 'pdfjs-dist'
import worker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { useEffect, useRef, useState } from 'react'
import { DocumentNotice } from '../../ui/DocumentNotice'

GlobalWorkerOptions.workerSrc = worker

const load = (data: Uint8Array) =>
  getDocument({
    data: new Uint8Array(data),
    disableFontFace: true,
    useSystemFonts: false,
  })

export { load as loadPdf }

function Page({
  document,
  number,
}: {
  document: PDFDocumentProxy
  number: number
}) {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = host.current
    if (!element) return
    let active = true
    let cancel = () => {}
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        observer.disconnect()
        void document
          .getPage(number)
          .then(async (page) => {
            if (!active) return
            const base = page.getViewport({ scale: 1 })
            const scale = Math.min(
              2,
              Math.max(0.5, element.clientWidth / base.width) *
                devicePixelRatio,
            )
            const viewport = page.getViewport({ scale })
            if (viewport.width * viewport.height > 16_000_000)
              throw new Error('This PDF page is too large to preview.')
            const canvas = window.document.createElement('canvas')
            canvas.width = Math.ceil(viewport.width)
            canvas.height = Math.ceil(viewport.height)
            canvas.setAttribute('aria-label', `Page ${number}`)
            element.replaceChildren(canvas)
            const render = page.render({ canvas, viewport })
            cancel = () => render.cancel()
            try {
              await render.promise
            } catch {
              /* A changed document cancels the old page. */
            }
          })
          .catch(() => {
            if (active) element.textContent = `Could not render page ${number}.`
          })
      },
      { rootMargin: '300px' },
    )
    observer.observe(element)
    return () => {
      active = false
      observer.disconnect()
      cancel()
      element.replaceChildren()
    }
  }, [document, number])
  return <div ref={host} className="format-pdf-page" />
}

export function FormatPdf({ data }: { data: Uint8Array }) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    setDocument(null)
    setError('')
    const task = load(data)
    void task.promise
      .then((document) => {
        if (document.numPages > 200)
          throw new Error('PDF previews support up to 200 pages.')
        if (active) setDocument(document)
      })
      .catch((error) => {
        if (active) setError(String(error))
      })
    return () => {
      active = false
      void task.destroy()
    }
  }, [data])
  if (error)
    return <DocumentNotice title="PDF preview unavailable" message={error} />
  if (!document) return <DocumentNotice title="Loading PDF…" busy />
  return (
    <div className="format-pdf">
      {Array.from({ length: document.numPages }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: page numbers are stable identities within this PDF.
        <Page key={index + 1} document={document} number={index + 1} />
      ))}
    </div>
  )
}

export async function pdfHtml(data: Uint8Array) {
  const task = load(data)
  try {
    const document = await task.promise
    if (document.numPages > 200)
      throw new Error('PDF exports support up to 200 pages.')
    const images: string[] = []
    let bytes = 0
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number)
      const viewport = page.getViewport({ scale: 1.25 })
      if (viewport.width * viewport.height > 16_000_000)
        throw new Error('This PDF page is too large to export.')
      const canvas = window.document.createElement('canvas')
      canvas.width = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)
      await page.render({ canvas, viewport }).promise
      const image = canvas.toDataURL('image/png')
      bytes += image.length
      if (bytes > 20 * 1024 * 1024)
        throw new Error(
          'The PDF preview exceeds 20 MiB. Export the PDF file instead.',
        )
      images.push(`<img src="${image}" alt="Page ${number}">`)
      canvas.width = canvas.height = 0
    }
    return images.join('\n')
  } finally {
    await task.destroy()
  }
}
