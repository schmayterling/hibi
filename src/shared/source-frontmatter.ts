import {
  frontmatterProbe,
  isFrontmatterMapping,
  maximumFrontmatterUnits,
} from './frontmatter.ts'
import type { SourceSnapshot } from './source-buffer.ts'
import type { RawEdit } from './source-operations.ts'

export type FrontmatterBounds = Readonly<{
  yamlFrom: number
  yamlTo: number
  headerTo: number
  contentFrom: number
  eol: '\n' | '\r\n' | '\r'
}>
export type FrontmatterRead = Readonly<{
  bounds: FrontmatterBounds | null
  inspectedTo: number
  dependsOnEnd: boolean
  /** The opening line was followed by a complete scan with no closing marker. */
  unclosed: boolean
  open: boolean
  closedTo: number
  oversized: boolean
}>

/** A completed read owns only scalars. Its unfinished generator owns the input. */
export function* readSourceFrontmatter(
  source: Pick<SourceSnapshot, 'utf16Length' | 'sliceRaw'> &
    Partial<Pick<SourceSnapshot, 'chunks'>>,
  known?: FrontmatterBounds,
): Generator<void, FrontmatterRead> {
  const chunks = (function* () {
    for (let from = 0; from < source.utf16Length; ) {
      const to = Math.min(source.utf16Length, from + (from === 0 ? 4 : 4096))
      yield source.chunks
        ? [...source.chunks(from, to)].join('')
        : source.sliceRaw(from, to)
      from = to
    }
  })()
  const lineEnds = /[\r\n\u2028\u2029]/g
  let chunk = '',
    chunkFrom = 0,
    position = 0,
    inspectedTo = 0,
    dependsOnEnd = false,
    normalized = 0,
    previousCr = false,
    open = false,
    closedTo = 0,
    oversized = false
  const move = (to: number) => {
    const text = chunk.slice(position - chunkFrom, to - chunkFrom)
    normalized +=
      text.length -
      (text.match(/\r\n/g)?.length ?? 0) -
      Number(previousCr && text.startsWith('\n'))
    previousCr = text.endsWith('\r')
    position = to
  }
  const peek = () => {
    if (normalized > maximumFrontmatterUnits + 4096) {
      if (!closedTo) oversized = true
      return ''
    }
    if (position === source.utf16Length) {
      dependsOnEnd = true
      return ''
    }
    while (position >= chunkFrom + chunk.length) {
      chunkFrom += chunk.length
      chunk = chunks.next().value!
    }
    inspectedTo = Math.max(inspectedTo, position + 1)
    return chunk[position - chunkFrom]!
  }
  const take = () => {
    const character = peek()
    if (character) move(position + 1)
    return character
  }
  const finish = (
    bounds: FrontmatterBounds | null,
    unclosed = false,
  ): FrontmatterRead =>
    Object.freeze({
      bounds: bounds && Object.freeze(bounds),
      inspectedTo,
      dependsOnEnd,
      unclosed,
      open,
      closedTo,
      oversized,
    })
  function* spaces() {
    while (peek() === ' ' || peek() === '\t') {
      take()
      if (position % 4096 === 0) yield
    }
  }
  try {
    if (peek() === '\uFEFF') take()
    for (let count = 0; count < 3; count++)
      if (take() !== '-') return finish(null)
    yield* spaces()
    const cr = peek() === '\r'
    if (cr) take()
    const lf = peek() === '\n'
    if (lf) take()
    else if (!cr) return finish(null)
    open = true
    const yamlFrom = position,
      eol = cr ? (lf ? '\r\n' : '\r') : '\n'
    let lineStart = true
    while (position < source.utf16Length) {
      if (normalized > maximumFrontmatterUnits) {
        oversized = true
        return finish(null)
      }
      if (lineStart) frontmatterProbe.lines++
      if (lineStart && (peek() === '-' || peek() === '.')) {
        const yamlTo = position,
          marker = take()
        lineStart = false
        if (peek() === marker) {
          take()
          if (peek() === marker) {
            take()
            yield* spaces()
            const ending = peek()
            if (!ending || /[\r\n\u2028\u2029]/.test(ending)) {
              if (ending === '\r') take()
              if (peek() === '\n') take()
              const headerTo = position
              if (oversized) return finish(null)
              closedTo = headerTo
              if (
                !(known?.yamlFrom === yamlFrom && known.yamlTo === yamlTo) &&
                !isFrontmatterMapping(source.sliceRaw(yamlFrom, yamlTo))
              )
                return finish(null)
              let contentFrom = headerTo
              // Blank lines end in LF, CRLF or CR, exactly like the oracle.
              for (;;) {
                yield* spaces()
                const cr = peek() === '\r'
                if (cr) take()
                if (peek() === '\n') take()
                else if (!cr) break
                contentFrom = position
              }
              return finish({ yamlFrom, yamlTo, headerTo, contentFrom, eol })
            }
          }
        }
      }
      // On to the next line's start in this piece, or the piece's end.
      peek()
      lineEnds.lastIndex = position - chunkFrom
      const end = lineEnds.exec(chunk)
      const next = chunkFrom + (end ? end.index + 1 : chunk.length)
      inspectedTo = Math.max(inspectedTo, next)
      const pause = Math.floor(next / 4096) > Math.floor(position / 4096)
      move(next)
      lineStart = !!end
      if (pause) yield
    }
    if (normalized > maximumFrontmatterUnits) {
      oversized = true
      return finish(null)
    }
    // No closing marker: a future append can complete one.
    dependsOnEnd = true
    return finish(null, true)
  } finally {
    chunks.return?.()
  }
}

/** Changes use pre-state coordinates; insertions at an inspected EOF invalidate. */
export function reuseFrontmatterRead(
  read: FrontmatterRead,
  changes: readonly RawEdit[],
) {
  return changes.every(
    (change) =>
      change.from >= read.inspectedTo &&
      (!read.dependsOnEnd || change.from !== read.inspectedTo),
  )
}

/**
 * Whether edits keep a read that found an opening line and no closing one:
 * they leave the opening line alone and make no line that could close it.
 * `source` is the source after them. Lines are its LF lines, as in the
 * formatted view, and edits that insert other line ends do not keep it. The
 * kept read is up to `source`'s end.
 */
export function keepUnclosedFrontmatterRead(
  read: FrontmatterRead,
  changes: readonly RawEdit[],
  source: Pick<
    SourceSnapshot,
    'lineAt' | 'lineCount' | 'sliceRaw' | 'utf16Length'
  >,
): FrontmatterRead | null {
  if (!read.open || (!read.unclosed && !read.oversized)) return null
  if (read.oversized && changes.some(({ from, to }) => to > from)) return null
  const opening = source.lineAt(0)
  if (
    !opening ||
    opening.to > maximumFrontmatterUnits ||
    opening.number === source.lineCount ||
    !/^\uFEFF?---[ \t]*$/.test(source.sliceRaw(0, opening.to))
  )
    return null
  /** Whether the line starting at `start` is a closing line, read only up to its marker's end. */
  const closes = (start: number) => {
    const line = source.lineAt(start)
    if (!line || line.to - start < 3) return false
    const marker = source.sliceRaw(start, start + 3)
    if (marker !== '---' && marker !== '...') return false
    const limit = Math.min(line.to, maximumFrontmatterUnits * 2 + 8)
    for (let at = start + 3; at < limit; at += 64) {
      const after = /[^ \t]/.exec(
        source.sliceRaw(at, Math.min(limit, at + 64)),
      )?.[0]
      if (after) return /[\r\u2028\u2029]/.test(after)
    }
    return true
  }
  let shift = 0,
    inspectedTo = read.inspectedTo
  for (const { from, to, insert } of changes) {
    const at = from + shift,
      delta = insert.length - (to - from)
    shift += delta
    if (from < read.inspectedTo) inspectedTo += delta
    if (/[\r\u2028\u2029]/.test(insert)) return null
    const line = source.lineAt(at)
    if (!line || line.number === 1 || closes(line.from)) return null
    for (let i = insert.indexOf('\n'); i >= 0; i = insert.indexOf('\n', i + 1))
      if (closes(at + i + 1)) return null
  }
  return Object.freeze({
    ...read,
    inspectedTo: read.oversized ? inspectedTo : source.utf16Length,
  })
}
