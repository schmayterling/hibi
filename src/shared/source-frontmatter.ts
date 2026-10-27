import { isMap, parseDocument } from 'yaml'
import type { SourceSnapshot } from './source-buffer.ts'
import type { RawEdit } from './source-operations.ts'

export type FrontmatterBounds = Readonly<{
  yamlFrom: number
  yamlTo: number
  headerTo: number
  contentFrom: number
  eol: '\n' | '\r\n'
}>
export type FrontmatterRead = Readonly<{
  bounds: FrontmatterBounds | null
  inspectedTo: number
  dependsOnEnd: boolean
  /** The opening line was followed by a complete scan with no closing marker. */
  unclosed: boolean
}>

/** A completed read owns only scalars. Its unfinished generator owns the input. */
export function* readSourceFrontmatter(
  source: Pick<SourceSnapshot, 'utf16Length' | 'chunks' | 'sliceRaw'>,
): Generator<void, FrontmatterRead> {
  const chunks = source.chunks()[Symbol.iterator]()
  const lineEnds = /[\r\n\u2028\u2029]/g
  let chunk = '',
    chunkFrom = 0,
    position = 0,
    inspectedTo = 0,
    dependsOnEnd = false
  const peek = () => {
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
    if (character) position++
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
    if (take() !== '\n') return finish(null)
    const yamlFrom = position,
      eol = cr ? '\r\n' : '\n'
    let lineStart = true
    while (position < source.utf16Length) {
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
              let headerTo = position,
                bareCr = false
              if (ending === '\r') {
                take()
                bareCr = peek() !== '\n'
              }
              if (peek() === '\n') {
                take()
                headerTo = position
              }
              try {
                if (
                  !isMap(
                    parseDocument(source.sliceRaw(yamlFrom, yamlTo)).contents,
                  )
                )
                  return finish(null)
              } catch {
                return finish(null)
              }
              let contentFrom = headerTo
              // JS multiline $ accepts bare CR and Unicode separators; the
              // spacing expression accepts only LF/CRLF, exactly like the oracle.
              if (!bareCr) {
                for (;;) {
                  yield* spaces()
                  if (peek() === '\r') take()
                  if (peek() !== '\n') break
                  take()
                  contentFrom = position
                }
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
      position = next
      lineStart = !!end
      if (pause) yield
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
  source: SourceSnapshot,
): FrontmatterRead | null {
  if (!read.unclosed) return null
  const opening = source.lineAt(0)
  if (
    !opening ||
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
    for (let at = start + 3; at < line.to; at += 64) {
      const after = /[^ \t]/.exec(
        source.sliceRaw(at, Math.min(line.to, at + 64)),
      )?.[0]
      if (after) return /[\r\u2028\u2029]/.test(after)
    }
    return true
  }
  let shift = 0
  for (const { from, to, insert } of changes) {
    const at = from + shift
    shift += insert.length - (to - from)
    if (/[\r\u2028\u2029]/.test(insert)) return null
    const line = source.lineAt(at)
    if (!line || line.number === 1 || closes(line.from)) return null
    for (let i = insert.indexOf('\n'); i >= 0; i = insert.indexOf('\n', i + 1))
      if (closes(at + i + 1)) return null
  }
  return Object.freeze({ ...read, inspectedTo: source.utf16Length })
}
