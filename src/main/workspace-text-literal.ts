export type TextSearchLine = { line: number; text: string }
type State = { matched: number; lines: TextSearchLine[] }

/** Exact default JavaScript lowercase semantics, including deferred final sigma. */
export class WorkspaceLiteralMatcher {
  readonly needle: string
  readonly failure: Uint32Array
  private state: State = { matched: 0, lines: [] }
  private pending: { normal: State; final: State } | null = null
  private beforeCased = false
  private carry = ''
  private line = 1
  private tail = ''
  private nativeTail = ''
  private readonly native: boolean
  units = 0

  constructor(query: string) {
    this.needle = query.toLowerCase()
    this.native = !/[σς]/.test(this.needle)
    this.failure = new Uint32Array(this.needle.length)
    for (let index = 1, prefix = 0; index < this.needle.length; index++) {
      while (prefix && this.needle[index] !== this.needle[prefix])
        prefix = this.failure[prefix - 1] as number
      if (this.needle[index] === this.needle[prefix]) prefix++
      this.failure[index] = prefix
    }
  }

  get lines(): readonly TextSearchLine[] {
    return this.state.lines
  }

  private feed(state: State, folded: string, text: string, offset: number) {
    if (state.lines.length === 3) return
    for (let index = 0; index < folded.length; index++) {
      this.units++
      while (state.matched && folded[index] !== this.needle[state.matched])
        state.matched = this.failure[state.matched - 1] as number
      if (folded[index] === this.needle[state.matched]) state.matched++
      if (state.matched !== this.needle.length) continue
      state.matched = this.failure[this.needle.length - 1] as number
      if (state.lines.some((line) => line.line === this.line)) continue
      const lineStart = text.lastIndexOf('\n', offset - 1) + 1
      const start = Math.max(lineStart, offset - 80)
      const newline = text.indexOf('\n', offset)
      const end = Math.min(newline < 0 ? text.length : newline, start + 240)
      const prefix =
        start === 0 && this.tail && offset < 80
          ? this.tail.slice(-(80 - offset))
          : ''
      state.lines.push({
        line: this.line,
        text: `${start > lineStart ? '…' : ''}${prefix}${text.slice(start, end)}${end < text.length && text[end] !== '\n' ? '…' : ''}`,
      })
      if (state.lines.length === 3) return
    }
  }

  private nativeSearch(text: string): TextSearchLine | null {
    const lower = text.toLowerCase()
    const prefix = this.nativeTail.length
    const source = this.nativeTail + lower
    const aligned = lower.length === text.length
    let lineCursor = 0
    this.units += lower.length
    let raw = 0,
      folded = 0,
      line = this.line,
      from = 0
    while (
      from <= source.length - this.needle.length &&
      this.state.lines.length < 3
    ) {
      const match = source.indexOf(this.needle, from)
      if (match < 0) break
      const end = match + this.needle.length - prefix
      if (aligned) {
        raw = Math.max(0, end - 1)
        for (
          let next = text.indexOf('\n', lineCursor);
          next >= 0 && next < raw;
          next = text.indexOf('\n', lineCursor)
        ) {
          line++
          lineCursor = next + 1
        }
      }
      while (!aligned && raw < text.length) {
        const character = String.fromCodePoint(text.codePointAt(raw) as number)
        const length = character.toLowerCase().length
        if (folded + length >= end) break
        folded += length
        raw += character.length
        if (character === '\n') line++
      }
      if (!this.state.lines.some((item) => item.line === line)) {
        const lineStart = text.lastIndexOf('\n', raw - 1) + 1
        const start = Math.max(lineStart, raw - 80)
        const newline = text.indexOf('\n', raw)
        const to = Math.min(newline < 0 ? text.length : newline, start + 240)
        const carry =
          start === 0 && this.tail && raw < 80
            ? this.tail.slice(-(80 - raw))
            : ''
        this.state.lines.push({
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
    return this.state.lines[0] ?? null
  }

  push(input: string, final = false): TextSearchLine | null {
    let text = this.carry + input
    this.carry = ''
    if (!final && /[\uD800-\uDBFF]$/.test(text)) {
      this.carry = text.slice(-1)
      text = text.slice(0, -1)
    }
    if (this.native) return this.nativeSearch(text)
    let offset = 0
    for (const character of text) {
      const ignored = /\p{Case_Ignorable}/u.test(character)
      const cased = /\p{Cased}/u.test(character)
      if (this.pending && !ignored) {
        this.state = cased ? this.pending.normal : this.pending.final
        this.pending = null
      }
      if (this.state.lines.length === 3)
        return this.state.lines[0] as TextSearchLine
      if (character === 'Σ' && this.beforeCased) {
        this.pending = {
          normal: { matched: this.state.matched, lines: [...this.state.lines] },
          final: { matched: this.state.matched, lines: [...this.state.lines] },
        }
        this.feed(this.pending.normal, 'σ', text, offset)
        this.feed(this.pending.final, 'ς', text, offset)
      } else if (this.pending) {
        const folded = character.toLowerCase()
        this.feed(this.pending.normal, folded, text, offset)
        this.feed(this.pending.final, folded, text, offset)
      } else this.feed(this.state, character.toLowerCase(), text, offset)
      if (!ignored) this.beforeCased = cased
      if (character === '\n') this.line++
      offset += character.length
    }
    this.tail = text.slice(
      Math.max(text.lastIndexOf('\n') + 1, text.length - 80),
    )
    return this.state.lines[0] ?? null
  }

  finish(): TextSearchLine | null {
    this.push('', true)
    if (this.pending) this.state = this.pending.final
    this.pending = null
    return this.state.lines[0] ?? null
  }
}

/** Extra folding only broadens candidates; verification keeps original semantics. */
export function workspaceCandidateText(text: string): string {
  return text
    .toLowerCase()
    .replaceAll('ς', 'σ')
    .replace(/[\uFFFE\uFFFF]/g, '�')
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
