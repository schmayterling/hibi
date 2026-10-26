import { isMap, parseDocument } from 'yaml'

const openingLine = /^(?:\uFEFF)?---[ \t]*(\r?\n)/
const closingLine = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m

/** A divider alone is Markdown. Frontmatter needs a closed metadata mapping. */
export function readFrontmatter(source: string) {
  const opening = openingLine.exec(source)
  if (!opening) return null
  const closing = closingLine.exec(source.slice(opening[0].length))
  if (!closing) return null
  const yaml = source.slice(
    opening[0].length,
    opening[0].length + closing.index,
  )
  try {
    // Keep malformed mappings recognizable so the addon can offer YAML repair.
    if (!isMap(parseDocument(yaml).contents)) return null
  } catch {
    return null
  }
  const end = opening[0].length + closing.index + closing[0].length
  const spacing = /^(?:[ \t]*\r?\n)*/.exec(source.slice(end))?.[0] ?? ''
  const prefix = source.slice(0, end + spacing.length)
  return {
    opening: opening[0],
    yaml,
    closing: closing[0] + spacing,
    eol: opening[1] as string,
    prefix,
    content: source.slice(prefix.length),
  }
}

/** Where the last whole line of `text` ends; a final CR may start a CRLF. */
const wholeLines = (text: string) =>
  Math.max(
    text.lastIndexOf('\n'),
    text.lastIndexOf('\r', text.length - 2),
    text.lastIndexOf('\u2028'),
    text.lastIndexOf('\u2029'),
  ) + 1

/**
 * Where frontmatter opening a note would end, after its first closing line,
 * or -1, reading the note in pieces only up to there. `readFrontmatter` of
 * the note up to that end decides whether it is frontmatter.
 */
export function frontmatterEnd(note: {
  readonly length: number
  slice(from: number, to: number): string
}) {
  let size = 4096,
    text = note.slice(0, size)
  while (text.length < note.length && !wholeLines(text)) {
    size *= 2
    text = note.slice(0, size)
  }
  const opening = openingLine.exec(text)
  if (!opening) return -1
  let from = opening[0].length
  for (size = 4096; ; ) {
    text = note.slice(from, from + size)
    const whole = from + text.length >= note.length
    // A line that may go on past this piece is read again with the next one.
    const end = whole ? text.length : wholeLines(text)
    const closing = closingLine.exec(text.slice(0, end))
    if (closing) return from + closing.index + closing[0].length
    if (whole) return -1
    from += end
    // Pieces grow with what has been read, each at most 1 MiB, or until
    // a long line fits.
    size = end ? Math.min(size * 2, 1 << 20) : size * 2
  }
}
