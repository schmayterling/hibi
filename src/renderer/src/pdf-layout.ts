/** The largest canvas drawn for one page, matching the PDF preview's limit. */
export const MAX_CANVAS_PIXELS = 16_000_000

/** Reads the active tab's PDF bytes; null when they can't be read. */
export async function readPdf(
  revision: number,
  read?: (revision: number) => Promise<Uint8Array | null>,
): Promise<Uint8Array | null> {
  if (!read) return null
  try {
    const bytes = await read(revision)
    return bytes?.length ? bytes : null
  } catch {
    return null
  }
}

export function passwordError(reason: number) {
  return reason === 2 ? 'Incorrect password. Try again.' : null
}

/** The scale that fits a page of `page` points across `pane` pixels. */
export function fitScale(pane: number, page: number) {
  const scale = pane / page
  return Number.isFinite(scale) && scale > 0 ? scale : 1
}

/** The canvas scale for a page, reduced when the canvas would pass the pixel limit. */
export function renderScale(
  fit: number,
  zoom: number,
  ratio: number,
  width: number,
  height: number,
) {
  const wanted = fit * zoom * ratio
  const pixels = width * height * wanted * wanted
  // The small margin keeps rounding from landing just over the limit.
  return pixels > MAX_CANVAS_PIXELS
    ? wanted * Math.sqrt(MAX_CANVAS_PIXELS / pixels) * 0.999
    : wanted
}

/** The 1-based page that contains `position`, given each page's top. */
export function pageAt(tops: readonly number[], position: number) {
  let low = 0
  let high = tops.length - 1
  let found = 0
  while (low <= high) {
    const middle = (low + high) >> 1
    if ((tops[middle] ?? 0) <= position) {
      found = middle
      low = middle + 1
    } else high = middle - 1
  }
  return found + 1
}

/** Zoom is relative to fit-width, which is 1. */
export const MIN_ZOOM = 0.25
export const MAX_ZOOM = 4
const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const

/** A requested page number kept to the pages that exist. */
export function clampPage(page: number, count: number) {
  if (!Number.isFinite(page) || count < 1) return 1
  return Math.min(count, Math.max(1, Math.round(page)))
}

/** The zoom one button step away, stopping at the bounds. */
export function zoomStep(zoom: number, direction: 1 | -1) {
  const next =
    direction > 0
      ? ZOOM_STEPS.find((step) => step > zoom + 1e-6)
      : [...ZOOM_STEPS].reverse().find((step) => step < zoom - 1e-6)
  return next ?? (direction > 0 ? MAX_ZOOM : MIN_ZOOM)
}

/** The zoom after one wheel step. */
export function wheelZoom(zoom: number, deltaY: number) {
  return Math.min(
    MAX_ZOOM,
    Math.max(MIN_ZOOM, zoom * Math.exp(-deltaY * 0.002)),
  )
}
