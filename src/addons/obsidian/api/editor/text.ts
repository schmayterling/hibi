/**
 * The note's canonical source as Obsidian's editor sees it: every line break
 * counts as one character, like CodeMirror's document, while edits write raw
 * UTF-16 ranges and the note's own line endings.
 */
export type EditorPosition = { line: number; ch: number }

export class SourceText {
  readonly text: string
  /** Offsets of each line start in `text`. */
  readonly lineStarts: number[]
  /** Offsets in `text` of breaks that are two characters (`\r\n`) in the raw source. */
  private readonly wide: number[]
  readonly lineEnding: '\n' | '\r\n'
  readonly raw: string

  constructor(raw: string) {
    this.raw = raw
    const parts: string[] = []
    this.lineStarts = [0]
    this.wide = []
    let crlf = 0
    let breaks = 0
    let start = 0
    let length = 0
    for (const match of raw.matchAll(/\r\n|\r|\n/g)) {
      parts.push(raw.slice(start, match.index), '\n')
      length += match.index - start
      if (match[0].length === 2) {
        this.wide.push(length)
        crlf++
      }
      breaks++
      length++
      this.lineStarts.push(length)
      start = match.index + match[0].length
    }
    parts.push(raw.slice(start))
    this.text = parts.join('')
    this.lineEnding = breaks && crlf * 2 >= breaks ? '\r\n' : '\n'
  }

  get length() {
    return this.text.length
  }
  lineCount() {
    return this.lineStarts.length
  }
  lineEnd(line: number) {
    return line + 1 < this.lineStarts.length
      ? this.lineStarts[line + 1]! - 1
      : this.text.length
  }
  getLine(line: number) {
    if (line < 0 || line >= this.lineStarts.length) return ''
    return this.text.slice(this.lineStarts[line], this.lineEnd(line))
  }
  /** Out-of-range positions clamp, as in Obsidian. */
  posToOffset({ line, ch }: EditorPosition) {
    if (line < 0) return 0
    if (line >= this.lineStarts.length) return this.text.length
    const start = this.lineStarts[line]!
    return start + Math.max(0, Math.min(ch, this.lineEnd(line) - start))
  }
  offsetToPos(offset: number): EditorPosition {
    const at = Math.max(0, Math.min(offset, this.text.length))
    let low = 0
    let high = this.lineStarts.length - 1
    while (low < high) {
      const middle = (low + high + 1) >> 1
      if (this.lineStarts[middle]! <= at) low = middle
      else high = middle - 1
    }
    return { line: low, ch: at - this.lineStarts[low]! }
  }
  /** Raw offset of an editor offset; never inside a `\r\n`. */
  toRaw(offset: number) {
    let low = 0
    let high = this.wide.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (this.wide[middle]! < offset) low = middle + 1
      else high = middle
    }
    return offset + low
  }
  /** Inserted line breaks follow the note's line endings. */
  toRawInsert(text: string) {
    return text.replace(/\r\n|\r|\n/g, this.lineEnding)
  }
}
