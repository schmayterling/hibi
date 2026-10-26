import type { SourceSnapshot } from '../../shared/source-buffer.ts'

export const PREVIEW_PAGE_UNITS = 4096
export type PreviewCursor = Readonly<{
  from: number
  continuation: boolean
  contextual?: boolean
}>
export type MarkdownPreviewPage = Readonly<{
  from: number
  to: number
  text: string
  formatted: boolean
  next: PreviewCursor | null
}>

/** Own one bounded excerpt. Never split a Unicode character or a CRLF pair. */
export function markdownPreviewPage(
  source: SourceSnapshot,
  cursor: PreviewCursor = { from: 0, continuation: false },
): MarkdownPreviewPage {
  const from = Math.min(cursor.from, source.utf16Length)
  let to = Math.min(from + PREVIEW_PAGE_UNITS, source.utf16Length)
  if (to < source.utf16Length) {
    const seam = source.sliceRaw(to - 1, to + 1)
    if (seam === '\r\n' || /[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(seam)) to--
  }
  let text = source.sliceRaw(from, to)
  // Blank lines close independent paragraphs. Keep an unfinished block as source.
  const boundaries = /(?:\r\n|\r(?!\n)|\n)[\t ]*(?:\r\n|\r(?!\n)|\n)/g
  let boundary = 0
  for (const match of text.matchAll(boundaries))
    boundary = match.index + match[0].length
  const complete = to === source.utf16Length || boundary > 0
  if (to < source.utf16Length && boundary) {
    to = from + boundary
    text = text.slice(0, boundary)
  }
  // Only self-contained built-in prose is formatted without global syntax proof.
  // Other syntax and continued blocks remain exact, bounded source excerpts.
  const contextual =
    cursor.contextual ||
    !/^[\p{L}\p{N}\p{M}\p{Zs}\t\r\n#*_.!?,:;()'"…—–-]*$/u.test(text) ||
    /^\uFEFF?---(?:\r\n|\r|\n)/.test(text) ||
    /(?:^|[\r\n]) {0,3}(?:[-*] |\d+[.)][\t ])/.test(text)
  const formatted = !cursor.continuation && complete && !contextual
  return {
    from,
    to,
    text,
    formatted,
    next:
      to < source.utf16Length
        ? { from: to, continuation: !complete, contextual }
        : null,
  }
}
