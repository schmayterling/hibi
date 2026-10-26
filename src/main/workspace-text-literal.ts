import { foldSearchText } from '../shared/search-fold.ts'

export type TextSearchLine = { line: number; text: string }

/** Context-free lowercase search across streamed UTF-16 chunks. */
export class WorkspaceLiteralMatcher {
  readonly needle: string
  private readonly found: TextSearchLine[] = []
  private carry = ''
  private line = 1
  private tail = ''
  private nativeTail = ''
  units = 0

  constructor(query: string) {
    this.needle = foldSearchText(query)
  }

  get lines(): readonly TextSearchLine[] {
    return this.found
  }

  private nativeSearch(text: string): TextSearchLine | null {
    const lower = foldSearchText(text)
    const prefix = this.nativeTail.length
    const source = this.nativeTail + lower
    const aligned = lower.length === text.length
    let nextLine = text.indexOf('\n')
    this.units += lower.length
    let raw = 0,
      folded = 0,
      line = this.line,
      from = 0
    while (
      from <= source.length - this.needle.length &&
      this.found.length < 3
    ) {
      const match = source.indexOf(this.needle, from)
      if (match < 0) break
      const end = match + this.needle.length - prefix
      if (aligned) {
        raw = Math.max(0, end - 1)
        while (nextLine >= 0 && nextLine < raw) {
          line++
          nextLine = text.indexOf('\n', nextLine + 1)
        }
      }
      while (!aligned && raw < text.length) {
        const character = String.fromCodePoint(text.codePointAt(raw) as number)
        const length = foldSearchText(character).length
        if (folded + length >= end) break
        folded += length
        raw += character.length
        if (character === '\n') line++
      }
      if (!this.found.some((item) => item.line === line)) {
        const lineStart = text.lastIndexOf('\n', raw - 1) + 1
        const start = Math.max(lineStart, raw - 80)
        const newline = text.indexOf('\n', raw)
        const to = Math.min(newline < 0 ? text.length : newline, start + 240)
        const carry =
          start === 0 && this.tail && raw < 80
            ? this.tail.slice(-(80 - raw))
            : ''
        this.found.push({
          line,
          text: `${start > lineStart ? '…' : ''}${carry}${text.slice(start, to)}${to < text.length && text[to] !== '\n' ? '…' : ''}`,
        })
      }
      from = match + 1
    }
    this.nativeTail =
      this.needle.length > 1 ? source.slice(1 - this.needle.length) : ''
    for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1))
      this.line++
    this.tail = text.slice(
      Math.max(text.lastIndexOf('\n') + 1, text.length - 80),
    )
    return this.found[0] ?? null
  }

  push(input: string, final = false): TextSearchLine | null {
    let text = this.carry + input
    this.carry = ''
    if (!final && /[\uD800-\uDBFF]$/.test(text)) {
      this.carry = text.slice(-1)
      text = text.slice(0, -1)
    }
    return this.nativeSearch(text)
  }

  finish(): TextSearchLine | null {
    return this.push('', true)
  }
}
/** SQLite replaces noncharacters; broaden candidates and verify against source. */
export function workspaceCandidateText(text: string): string {
  return foldSearchText(text).replace(/[\uFFFE\uFFFF]/g, '�')
}

export const workspaceShortSeparator = '\u0001'

export function workspaceIndexText(text: string): string {
  const folded = workspaceCandidateText(text)
  const buffer = Buffer.allocUnsafe(folded.length * 4)
  let written = 0
  for (let index = 0; index < folded.length; index++) {
    const code = folded.charCodeAt(index)
    buffer.writeUInt16LE(code, written)
    written += 2
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < folded.length) {
      const low = folded.charCodeAt(index + 1)
      if (low >= 0xdc00 && low <= 0xdfff) {
        buffer.writeUInt16LE(low, written)
        written += 2
        index++
      }
    }
    buffer.writeUInt16LE(1, written)
    written += 2
  }
  return (
    folded + workspaceShortSeparator + buffer.toString('utf16le', 0, written)
  )
}

/** Sample necessary grams, never requiring them to occur in the same source part. */
export function workspaceQueryGrams(query: string): string[] {
  if (query.includes('\0')) return []
  for (let index = 0; index < query.length; index++) {
    const code = query.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = query.charCodeAt(++index)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return []
    } else if (code >= 0xdc00 && code <= 0xdfff) return []
  }
  const folded = workspaceCandidateText(query)
  const small = [...folded.slice(0, 6)]
  if ([...small.join('')].length < 3 && folded.length <= 4) {
    if (small.length === 1)
      return [workspaceShortSeparator + small[0] + workspaceShortSeparator]
    if (small.length === 2)
      return [small[0] + workspaceShortSeparator + small[1]]
  }
  const grams = new Set<string>()
  const stride = Math.max(1, Math.ceil((folded.length - 2) / 8))
  let pair = '',
    position = 0,
    next = 0
  for (const character of folded) {
    const gram = pair + character
    if ([...pair].length === 2 && position >= next && grams.size < 8) {
      grams.add(gram)
      next = position + stride
    }
    pair = [...gram].slice(-2).join('')
    position += character.length
  }
  return [...grams]
}
