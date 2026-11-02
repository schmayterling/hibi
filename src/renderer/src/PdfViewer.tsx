import {
  ChevronDown,
  ChevronUp,
  MoveHorizontal,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { loadPdf } from '../../addons/_shared/FormatPdf'
import type { DocumentPreviewProps } from '../../addons/api'
import { Button, IconButton, TextInput } from '../../ui/Controls'
import { useDialogs } from '../../ui/DialogProvider'
import { PreviewActions } from '../../ui/PreviewActions'
import {
  clampPage,
  fitScale,
  MAX_ZOOM,
  MIN_ZOOM,
  pageAt,
  passwordError,
  readPdf,
  renderScale,
  wheelZoom,
  zoomStep,
} from './pdf-layout'

/** The space between pages in CSS pixels. */
const PAGE_GAP = 16

type Size = { width: number; height: number }
type Layout = { tops: number[]; heights: number[] }
type Job = { number: number; cancelled: boolean; cancel: () => void }
/** The point in a page to keep under the same spot of the view across a zoom. */
type Anchor = { page: number; fx: number; fy: number; x: number; y: number }

function PdfPages({
  pdf,
  toolbar,
}: {
  pdf: PDFDocumentProxy
  toolbar?: HTMLElement | null | undefined
}) {
  const frame = useRef<HTMLDivElement>(null)
  const container = useRef<HTMLDivElement>(null)
  const [paneWidth, setPaneWidth] = useState(0)
  const [zoom, setZoom] = useState(1)
  const [page, setPage] = useState(1)
  const [draft, setDraft] = useState<string | null>(null)
  const zoomRef = useRef(1)
  const anchor = useRef<Anchor | null>(null)
  // Pages are laid out and drawn at the zoomed width.
  const width = Math.round(paneWidth * zoom)
  const [first, setFirst] = useState<Size | null>(null)
  const [sizes, setSizes] = useState<ReadonlyMap<number, Size>>(new Map())
  const latest = useRef({ width, first })
  const layoutRef = useRef<Layout>({ tops: [], heights: [] })
  const refresh = useRef<() => void>(() => {})

  useEffect(() => {
    const element = container.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setPaneWidth(Math.floor(entry.contentRect.width))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // Pages take the first page's size until their own is known.
  useEffect(() => {
    let current = true
    void pdf
      .getPage(1)
      .then((page) => {
        const view = page.getViewport({ scale: 1 })
        if (current) setFirst({ width: view.width, height: view.height })
      })
      .catch(() => {})
    return () => {
      current = false
    }
  }, [pdf])

  const layout = useMemo<Layout>(() => {
    const tops: number[] = []
    const heights: number[] = []
    let top = 0
    for (let number = 1; number <= pdf.numPages; number++) {
      const size = sizes.get(number) ?? first
      const height = size && width ? (width * size.height) / size.width : 0
      tops.push(top)
      heights.push(height)
      top += height + PAGE_GAP
    }
    return { tops, heights }
  }, [pdf, sizes, first, width])
  useLayoutEffect(() => {
    latest.current = { width, first }
    layoutRef.current = layout
    // A zoom puts the anchored point of its page back under the same spot.
    const point = anchor.current
    const root = frame.current
    const pages = container.current
    if (!point || !root || !pages) return
    anchor.current = null
    const slot = pages.children[point.page - 1] as HTMLElement | undefined
    if (!slot) return
    root.scrollTop =
      pages.offsetTop +
      (layout.tops[point.page - 1] ?? 0) +
      point.fy * (layout.heights[point.page - 1] ?? 0) -
      point.y
    root.scrollLeft = slot.offsetLeft + point.fx * slot.offsetWidth - point.x
  }, [width, first, layout])

  // Zooms around a point of the view, the middle unless one is given.
  const applyZoom = useCallback(
    (next: number, at?: { x: number; y: number }) => {
      const root = frame.current
      const pages = container.current
      if (!root || !pages || next === zoomRef.current) return
      const x = at?.x ?? root.clientWidth / 2
      const y = at?.y ?? root.clientHeight / 2
      const { tops, heights } = layoutRef.current
      const number = pageAt(tops, root.scrollTop + y - pages.offsetTop)
      const slot = pages.children[number - 1] as HTMLElement | undefined
      if (slot && heights[number - 1])
        anchor.current = {
          page: number,
          x,
          y,
          fy:
            (root.scrollTop + y - pages.offsetTop - (tops[number - 1] ?? 0)) /
            (heights[number - 1] ?? 1),
          fx: (root.scrollLeft + x - slot.offsetLeft) / (slot.offsetWidth || 1),
        }
      zoomRef.current = next
      setZoom(next)
    },
    [],
  )

  useEffect(() => {
    const root = frame.current
    if (!root) return
    // React's wheel handlers are passive, so this one is added directly.
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      const box = root.getBoundingClientRect()
      applyZoom(wheelZoom(zoomRef.current, event.deltaY), {
        x: event.clientX - box.left,
        y: event.clientY - box.top,
      })
    }
    root.addEventListener('wheel', wheel, { passive: false })
    return () => root.removeEventListener('wheel', wheel)
  }, [applyZoom])

  // The current page follows the scroll.
  const ready = width > 0 && first !== null
  useEffect(() => {
    const root = frame.current
    const pages = container.current
    if (!ready || !root || !pages) return
    let request = 0
    const update = () => {
      request = 0
      const atEnd =
        root.scrollTop > 0 &&
        root.scrollTop + root.clientHeight >= root.scrollHeight - 1
      setPage(
        atEnd
          ? pdf.numPages
          : pageAt(
              layoutRef.current.tops,
              root.scrollTop - pages.offsetTop + 1,
            ),
      )
    }
    const onScroll = () => {
      if (!request) request = requestAnimationFrame(update)
    }
    root.addEventListener('scroll', onScroll, { passive: true })
    update()
    return () => {
      root.removeEventListener('scroll', onScroll)
      if (request) cancelAnimationFrame(request)
    }
  }, [pdf, ready])

  const jump = (number: number) => {
    const root = frame.current
    const pages = container.current
    if (!root || !pages) return
    const target = clampPage(number, pdf.numPages)
    root.scrollTo({
      top: pages.offsetTop + (layoutRef.current.tops[target - 1] ?? 0),
    })
    setPage(target)
  }

  useEffect(() => {
    const root = frame.current
    const pages = container.current
    if (!ready || !root || !pages) return
    const slots = Array.from(pages.children) as HTMLElement[]
    const wanted = new Set<number>()
    const failed = new Set<number>()
    // The width each drawn page was last rendered for.
    const drawn = new Map<number, number>()
    let active: Job | null = null
    let stopped = false

    const release = (number: number) => {
      const slot = slots[number - 1]
      if (!slot) return
      // A page's error message stays, so scrolling back doesn't retry it.
      for (const canvas of slot.querySelectorAll('canvas')) {
        canvas.width = canvas.height = 0
        canvas.remove()
      }
      drawn.delete(number)
    }

    const draw = (number: number) => {
      const job: Job = {
        number,
        cancelled: false,
        cancel: () => {
          job.cancelled = true
        },
      }
      active = job
      const target = latest.current.width
      void pdf
        .getPage(number)
        .then(async (page) => {
          if (stopped || job.cancelled) return
          const base = page.getViewport({ scale: 1 })
          setSizes((previous) => {
            const known = previous.get(number) ?? latest.current.first
            return known?.width === base.width && known.height === base.height
              ? previous
              : new Map(previous).set(number, {
                  width: base.width,
                  height: base.height,
                })
          })
          const scale = renderScale(
            fitScale(target, base.width),
            1,
            window.devicePixelRatio,
            base.width,
            base.height,
          )
          const viewport = page.getViewport({ scale })
          const canvas = window.document.createElement('canvas')
          canvas.width = Math.ceil(viewport.width)
          canvas.height = Math.ceil(viewport.height)
          canvas.setAttribute('aria-label', `Page ${number}`)
          const task = page.render({ canvas, viewport })
          job.cancel = () => {
            job.cancelled = true
            task.cancel()
          }
          try {
            await task.promise
          } catch (error) {
            canvas.width = canvas.height = 0
            throw error
          }
          const slot = slots[number - 1]
          if (stopped || job.cancelled || !slot) {
            canvas.width = canvas.height = 0
            return
          }
          for (const old of slot.querySelectorAll('canvas'))
            old.width = old.height = 0
          slot.replaceChildren(canvas)
          drawn.set(number, target)
        })
        .catch(() => {
          // A cancelled render is expected; any other failure skips the page.
          if (job.cancelled) return
          failed.add(number)
          const message = window.document.createElement('p')
          message.className = 'pdf-page-error'
          message.textContent = `Could not render page ${number}.`
          slots[number - 1]?.replaceChildren(message)
        })
        .finally(() => {
          if (active === job) active = null
          pump()
        })
    }

    // Draws the wanted page nearest the middle of the view, one at a time.
    const pump = () => {
      if (stopped || active || !latest.current.width) return
      const { tops, heights } = layoutRef.current
      const middle = root.scrollTop + root.clientHeight / 2 - pages.offsetTop
      let best = 0
      let distance = Number.POSITIVE_INFINITY
      for (const number of wanted) {
        if (failed.has(number) || drawn.get(number) === latest.current.width)
          continue
        const center = (tops[number - 1] ?? 0) + (heights[number - 1] ?? 0) / 2
        if (Math.abs(center - middle) < distance) {
          best = number
          distance = Math.abs(center - middle)
        }
      }
      if (best) draw(best)
    }

    const pageOf = (target: Element) =>
      Number((target as HTMLElement).dataset.page)
    const near = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) wanted.add(pageOf(entry.target))
          else wanted.delete(pageOf(entry.target))
        }
        pump()
      },
      { root, rootMargin: '100% 0px' },
    )
    // Pages that leave this wider margin give their canvas back.
    const far = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) continue
          const number = pageOf(entry.target)
          wanted.delete(number)
          if (active?.number === number) active.cancel()
          release(number)
        }
      },
      { root, rootMargin: '200% 0px' },
    )
    for (const slot of slots) {
      near.observe(slot)
      far.observe(slot)
    }

    // A new width redraws the pages in view; old canvases stay until replaced.
    refresh.current = () => {
      drawn.clear()
      if (active) active.cancel()
      else pump()
    }
    return () => {
      stopped = true
      refresh.current = () => {}
      near.disconnect()
      far.disconnect()
      active?.cancel()
      for (const canvas of pages.querySelectorAll('canvas'))
        canvas.width = canvas.height = 0
    }
  }, [pdf, ready])

  useEffect(() => {
    if (!width) return
    const timer = setTimeout(() => refresh.current(), 100)
    return () => clearTimeout(timer)
  }, [width])

  const pageCount = pdf.numPages
  return (
    <div className="pdf-viewer" ref={frame}>
      <PreviewActions target={toolbar}>
        <IconButton
          aria-label="Previous page"
          title="Previous page"
          disabled={page <= 1}
          onClick={() => jump(page - 1)}
        >
          <ChevronUp size={16} aria-hidden />
        </IconButton>
        <TextInput
          className="pdf-page-input"
          aria-label="Page number"
          inputMode="numeric"
          value={draft ?? String(page)}
          onChange={(event) => setDraft(event.target.value.replace(/\D/g, ''))}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setDraft(null)
            if (event.key !== 'Enter') return
            if (draft) jump(Number(draft))
            setDraft(null)
          }}
          onBlur={() => setDraft(null)}
        />
        <span className="pdf-toolbar-label">of {pageCount}</span>
        <IconButton
          aria-label="Next page"
          title="Next page"
          disabled={page >= pageCount}
          onClick={() => jump(page + 1)}
        >
          <ChevronDown size={16} aria-hidden />
        </IconButton>
        <IconButton
          aria-label="Zoom out"
          title="Zoom out"
          disabled={zoom <= MIN_ZOOM}
          onClick={() => applyZoom(zoomStep(zoomRef.current, -1))}
        >
          <ZoomOut size={16} aria-hidden />
        </IconButton>
        <span className="pdf-toolbar-label">{Math.round(zoom * 100)}%</span>
        <IconButton
          aria-label="Zoom in"
          title="Zoom in"
          disabled={zoom >= MAX_ZOOM}
          onClick={() => applyZoom(zoomStep(zoomRef.current, 1))}
        >
          <ZoomIn size={16} aria-hidden />
        </IconButton>
        <IconButton
          aria-label="Fit width"
          title="Fit width"
          disabled={zoom === 1}
          onClick={() => applyZoom(1)}
        >
          <MoveHorizontal size={16} aria-hidden />
        </IconButton>
      </PreviewActions>
      <div className="pdf-pages" ref={container} style={{ gap: PAGE_GAP }}>
        {ready &&
          layout.heights.map((height, index) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: page numbers are stable identities within this PDF.
              key={index + 1}
              className="pdf-page"
              data-page={index + 1}
              style={{ width, height }}
            />
          ))}
      </div>
    </div>
  )
}

function PdfPasswordForm({
  error,
  close,
}: {
  error: string | null
  close: (value: string | null) => void
}) {
  const [value, setValue] = useState('')
  const id = useId()
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    input.current?.focus()
  }, [])
  return (
    <form
      className="dialog-form"
      onSubmit={(event) => {
        event.preventDefault()
        close(value)
      }}
    >
      <label htmlFor={id}>Password</label>
      <TextInput
        ref={input}
        id={id}
        type="password"
        autoComplete="off"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : undefined}
      />
      {error && (
        <p id={`${id}-error`} role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <Button onClick={() => close(null)}>Cancel</Button>
        <Button type="submit" className="dialog-primary">
          Unlock
        </Button>
      </div>
    </form>
  )
}

/** Shows every page of a PDF in one scroll, drawing only the pages near the view. */
export function PdfViewer({ document, toolbar }: DocumentPreviewProps) {
  const dialogs = useDialogs()
  // undefined is still loading, null is unavailable, locked is a cancelled password.
  const [pdf, setPdf] = useState<
    PDFDocumentProxy | null | 'locked' | undefined
  >(undefined)
  const [attempt, setAttempt] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt reruns the load after a cancelled password.
  useEffect(() => {
    let current = true
    let task: ReturnType<typeof loadPdf> | null = null
    let prompt: ReturnType<typeof dialogs.open<string>> | null = null
    let cancelled = false
    setPdf(undefined)
    void readPdf(document.revision, window.hibi?.readDocumentPdf).then(
      async (bytes) => {
        if (!current) return
        if (!bytes) return setPdf(null)
        // The script decoders, font data and CMaps ship in the app; WebAssembly
        // is off because the app's policy doesn't allow it.
        task = loadPdf(bytes, {
          useWasm: false,
          wasmUrl: new URL('pdfjs/wasm/', window.document.baseURI).href,
          standardFontDataUrl: new URL(
            'pdfjs/standard_fonts/',
            window.document.baseURI,
          ).href,
          cMapUrl: new URL('pdfjs/cmaps/', window.document.baseURI).href,
          cMapPacked: true,
        })
        // The password stays in this dialog and the pdf.js call.
        task.onPassword = (
          update: (password: string | Error) => void,
          reason: number,
        ) => {
          prompt = dialogs.open<string>({
            title: 'Password required',
            description: `Enter the password to open ${document.name}.`,
            closeOnOutsideClick: false,
            content: ({ close }) => (
              <PdfPasswordForm error={passwordError(reason)} close={close} />
            ),
          })
          void prompt.result.then((value) => {
            if (!current) return
            if (value === null) {
              cancelled = true
              update(new Error('The password prompt was cancelled.'))
            } else update(value)
          })
        }
        try {
          const loaded = await task.promise
          if (current) setPdf(loaded)
        } catch {
          if (current) setPdf(cancelled ? 'locked' : null)
        }
      },
    )
    return () => {
      current = false
      prompt?.close()
      void task?.destroy()
    }
  }, [document.name, document.revision, attempt, dialogs])
  if (pdf && pdf !== 'locked')
    return <PdfPages key={document.revision} pdf={pdf} toolbar={toolbar} />
  return (
    <div className="pdf-viewer">
      {pdf === null && (
        <div className="format-unavailable pdf-unavailable" role="status">
          <strong>Unable to display PDF</strong>
          <p>
            The file may be missing, damaged, password-protected, or not a PDF.
          </p>
        </div>
      )}
      {pdf === 'locked' && (
        <div className="format-unavailable pdf-unavailable" role="status">
          <strong>This PDF is password-protected.</strong>
          <p>Enter its password to view it.</p>
          <Button onClick={() => setAttempt((count) => count + 1)}>
            Enter password
          </Button>
        </div>
      )}
    </div>
  )
}
