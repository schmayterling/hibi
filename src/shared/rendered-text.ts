import { decodeHTMLStrict } from 'entities'
import type { SourceSnapshot } from './source-buffer.ts'
import { normalizedSource } from './source-projection.ts'

export type RenderedRange = Readonly<{ from: number; to: number }>
export type RenderedContainer = Readonly<{
  kind: 'mark' | 'link'
  open: RenderedRange
  close: RenderedRange
  visible: RenderedRange
  autolink?: true
}>
export type RenderedCode = RenderedRange & Readonly<{ width: number }>
export type RenderedMatchContext = Readonly<{
  lineFrom: number
  linePrefix: string
  after: string
  code:
    | (RenderedCode & Readonly<{ leftTicks: number; rightTicks: number }>)
    | null
}>
export type RenderedRun = RenderedRange &
  Readonly<{ text?: string; block?: true }>
export type RenderedChunk = RenderedRange &
  Readonly<{ text: string; precise: boolean }>

/** Assemble retained syntax runs; only explicit block boundaries change separators. */
export function* renderedRange(
  runs: Iterable<RenderedRun>,
  from: number,
  to: number,
  read: (from: number, to: number) => string,
  options: Readonly<{ blockSeparator?: string }> = {},
): Generator<RenderedChunk> {
  if (from === to) return
  for (const run of runs) {
    if (run.to <= from) continue
    if (run.from >= to) break
    const start = Math.max(from, run.from),
      end = Math.min(to, run.to),
      text = run.block ? (options.blockSeparator ?? run.text) : run.text
    if (text !== undefined) {
      yield {
        from: start,
        to: end,
        text,
        precise: from <= run.from && to >= run.to,
      }
    } else {
      for (let at = start; at < end; ) {
        let stop = Math.min(at + sliceUnits, end),
          text = read(at, stop)
        if (
          stop < end &&
          /[\uD800-\uDBFF]$/.test(text) &&
          /[\uDC00-\uDFFF]/.test(read(stop, stop + 1))
        ) {
          stop--
          text = text.slice(0, -1)
        }
        yield { from: at, to: stop, text, precise: true }
        at = stop
      }
    }
  }
}
type Pair = {
  kind: 'mark' | 'link'
  open: RenderedRange
  close: RenderedRange
  autolink?: true
}
type Delimiter = {
  from: number
  to: number
  code: string
  open: boolean
  close: boolean
  previous: Delimiter | null
  index: number
}
const whitespace = (character: string) => !character || /\s/u.test(character)
const punctuation = (character: string) =>
  !!character && /[\p{P}\p{S}]/u.test(character)
const escaped = /[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/
// CommonMark destinations exclude ASCII controls and space, including NUL.
// biome-ignore lint/suspicious/noControlCharactersInRegex: required markdown destination grammar
const linkControl = /[\x00-\x20\x7f]/
const sliceUnits = 4096
const stepUnits = 1024

/** Position-preserving reads never flatten a note or an oversized physical line. */
class Reader {
  from = -1
  text = ''
  previousFrom = -1
  previousText = ''
  reads = 0
  units = 0
  maximum = 0
  source: SourceSnapshot
  constructor(source: SourceSnapshot) {
    this.source = source
  }
  at(position: number): string {
    if (position < 0 || position >= this.source.normalizedLength) return ''
    if (position < this.from || position >= this.from + this.text.length) {
      const from = this.from,
        text = this.text
      if (
        position >= this.previousFrom &&
        position < this.previousFrom + this.previousText.length
      ) {
        this.from = this.previousFrom
        this.text = this.previousText
        this.previousFrom = from
        this.previousText = text
        return this.text[position - this.from] ?? ''
      }
      // Lookahead near a chunk seam must not reread both chunks per match.
      this.previousFrom = from
      this.previousText = text
      this.from = Math.floor(position / sliceUnits) * sliceUnits
      const end = Math.min(this.from + sliceUnits, this.source.normalizedLength)
      const rawFrom = this.source.editorToRaw(this.from)!
      const rawTo = this.source.editorToRaw(end)!
      this.text = normalizedSource(this.source.sliceRaw(rawFrom, rawTo))
      this.reads++
      this.units += rawTo - rawFrom
      this.maximum = Math.max(this.maximum, rawTo - rawFrom)
    }
    return this.text[position - this.from] ?? ''
  }
  chunk(position: number, end = this.source.normalizedLength): string {
    this.at(position)
    return this.text.slice(
      position - this.from,
      Math.min(position - this.from + 512, end - this.from),
    )
  }
  scalar(position: number): string {
    const first = this.at(position)
    return /[\uD800-\uDBFF]/.test(first) &&
      /[\uDC00-\uDFFF]/.test(this.at(position + 1))
      ? first + this.at(position + 1)
      : first
  }
  before(position: number): string {
    const last = this.at(position - 1)
    return /[\uDC00-\uDFFF]/.test(last) &&
      /[\uD800-\uDBFF]/.test(this.at(position - 2))
      ? this.at(position - 2) + last
      : last
  }
}

/**
 * Shared rendered source runs. Literal runs retain only positions; decoded
 * atoms retain their small replacement text. Parsing and normalization yield
 * before another bounded batch, including for a single physical line.
 */
export class RenderedTextIndex {
  #source: SourceSnapshot
  readonly #reader: Reader
  readonly #contextReader: Reader
  readonly #nearReader: Reader
  #code: RenderedCode[] = []
  #linePrefixes: RenderedRange[] = []
  #breaks: number[] = []
  #hidden: RenderedRange[] = []
  #literal: RenderedRange[] = []
  #pairs: Pair[] = []
  #runs: RenderedRun[] = []
  #containers: RenderedContainer[] = []
  #parents: number[] = []
  #complete = false
  #building: Generator<void, void> | null = null
  #steps = 0
  #operations = 0
  #pending = 0
  #maximum = 0
  readonly prefix: number
  constructor(source: SourceSnapshot, prefix = 0) {
    this.#source = source
    this.#reader = new Reader(source)
    this.#contextReader = new Reader(source)
    this.#nearReader = new Reader(source)
    this.prefix = prefix
  }
  adoptSource(source: SourceSnapshot) {
    this.#source = source
    this.#reader.source = source
    this.#contextReader.source = source
    this.#nearReader.source = source
  }
  counters() {
    return {
      steps: this.#steps,
      operations: this.#operations,
      maximumStep: this.#maximum,
      sourceReads: this.#reader.reads,
      sourceUnits: this.#reader.units,
      maximumRead: this.#reader.maximum,
      runs: this.#runs.length,
      containers: this.#containers.length,
      complete: this.#complete,
    }
  }
  #tick(units = 1) {
    this.#operations += units
    this.#pending += units
    if (this.#pending < stepUnits) return false
    this.#maximum = Math.max(this.#maximum, this.#pending)
    this.#pending = 0
    this.#steps++
    return true
  }
  /** Stable merge passes yield independently of the number of syntax ranges. */
  *#ordered<T>(
    values: T[],
    compare: (a: T, b: T) => number,
  ): Generator<void, T[]> {
    let input = values,
      output: T[] = []
    for (let width = 1; width < input.length; width *= 2) {
      output = []
      for (let start = 0; start < input.length; start += width * 2) {
        const end = Math.min(input.length, start + width * 2)
        const middle = Math.min(end, start + width)
        let left = start,
          right = middle
        while (left < middle || right < end) {
          output.push(
            right >= end ||
              (left < middle && compare(input[left]!, input[right]!) <= 0)
              ? input[left++]!
              : input[right++]!,
          )
          if (this.#tick()) yield
        }
      }
      input = output
    }
    return input
  }

  #pair(
    kind: Pair['kind'],
    openFrom: number,
    openTo: number,
    closeFrom: number,
    closeTo: number,
    autolink = false,
  ) {
    const open = { from: openFrom, to: openTo },
      close = { from: closeFrom, to: closeTo }
    this.#pairs.push({
      kind,
      open,
      close,
      ...(autolink ? { autolink: true as const } : {}),
    })
    this.#hidden.push(open, close)
  }
  *#blocks() {
    const read = this.#reader,
      length = this.#source.normalizedLength
    let from = this.prefix,
      fence = '',
      fenceWidth = 0,
      paragraph = false
    if (from) this.#hidden.push({ from: 0, to: from })
    while (from < length) {
      const raw = this.#source.editorToRaw(from)!
      const line = this.#source.lineAt(raw)!
      const to = this.#source.rawToEditor(line.to)!
      if (!paragraph) this.#breaks.push(from)
      let at = from,
        indent = 0
      while (
        (read.at(at) === ' ' || read.at(at) === '\t') &&
        at < to &&
        indent < 4
      ) {
        indent += read.at(at) === '\t' ? 4 - (indent % 4) : 1
        at++
      }
      if (fence) {
        let end = at
        while (read.at(end) === fence && end < to) {
          end++
          if (this.#tick()) yield
        }
        let tail = end
        while (tail < to && /[ \t]/.test(read.at(tail))) {
          tail++
          if (this.#tick()) yield
        }
        if (indent < 4 && end - at >= fenceWidth && tail === to) {
          this.#hidden.push({ from, to })
          fence = ''
        } else {
          this.#literal.push({ from, to })
          this.#code.push({ from, to: Math.min(to + 1, length), width: 0 })
        }
        paragraph = false
      } else {
        while (indent < 4 && at < to && read.at(at) === '>') {
          at++
          if (read.at(at) === ' ') at++
          while (at < to && read.at(at) === ' ' && read.at(at + 1) === '>') at++
          if (this.#tick()) yield
        }
        let marker = at,
          itemCode = false
        if (
          indent < 4 &&
          /[-+*]/.test(read.at(at)) &&
          at < to &&
          (at + 1 === to || /[ \t]/.test(read.at(at + 1)))
        ) {
          marker = at + 1
        } else if (indent < 4) {
          let end = at
          while (end < to && /[0-9]/.test(read.at(end)) && end - at < 10) end++
          if (
            end > at &&
            end - at < 10 &&
            /[.)]/.test(read.at(end)) &&
            (end + 1 === to || /[ \t]/.test(read.at(end + 1)))
          )
            marker = end + 1
        }
        if (marker !== at) {
          this.#breaks.push(from)
          at = marker
          let firstPadding = 1
          if (at < to) {
            firstPadding = read.at(at) === '\t' ? 4 - ((at - from) % 4) : 1
            at++
          }
          let padding = firstPadding - 1,
            end = at
          while (end < to && /[ \t]/.test(read.at(end)) && padding < 4) {
            padding += read.at(end) === '\t' ? 4 - ((end - from) % 4) : 1
            end++
          }
          at = end
          itemCode = padding >= 4
          paragraph = false
        }
        if (at > from && (indent < 4 || marker !== from)) {
          const prefix = { from, to: at }
          this.#hidden.push(prefix)
          this.#linePrefixes.push(prefix)
        }
        let end = at
        const code = read.at(at)
        if (indent < 4 && (code === '`' || code === '~')) {
          while (end < to && read.at(end) === code) {
            end++
            if (this.#tick()) yield
          }
          if (end - at >= 3) {
            let valid = true
            for (let pos = end; pos < to; pos++) {
              if (code === '`' && read.at(pos) === '`') valid = false
              if (this.#tick()) yield
            }
            if (valid) {
              this.#hidden.push({ from, to })
              fence = code
              fenceWidth = end - at
              paragraph = false
            }
          }
        }
        if (!fence) {
          if ((indent >= 4 && !paragraph) || itemCode) {
            const content = { from: at, to }
            this.#literal.push(content)
            this.#code.push({
              ...content,
              to: Math.min(to + 1, length),
              width: 0,
            })
          } else {
            end = at
            while (end < to && read.at(end) === '#' && end - at < 7) end++
            if (
              end > at &&
              end - at <= 6 &&
              (end === to || /[ \t]/.test(read.at(end)))
            ) {
              while (end < to && /[ \t]/.test(read.at(end))) {
                end++
                if (this.#tick()) yield
              }
              this.#breaks.push(from)
              this.#hidden.push({ from: at, to: end })
              let close = to
              while (close > end && /[ \t]/.test(read.at(close - 1))) {
                close--
                if (this.#tick()) yield
              }
              let hashes = close
              while (hashes > end && read.at(hashes - 1) === '#') {
                hashes--
                if (this.#tick()) yield
              }
              if (hashes < close && /[ \t]/.test(read.at(hashes - 1))) {
                while (hashes > end && /[ \t]/.test(read.at(hashes - 1))) {
                  hashes--
                  if (this.#tick()) yield
                }
                this.#hidden.push({ from: hashes, to })
              }
              paragraph = false
            } else paragraph = to > at
          }
        }
      }
      from = to < length ? to + 1 : length
      if (this.#tick()) yield
    }
  }
  #groupAt(position: number) {
    let lo = 0,
      hi = this.#breaks.length
    while (lo < hi) {
      const middle = (lo + hi) >>> 1
      if (this.#breaks[middle]! <= position) lo = middle + 1
      else hi = middle
    }
    return lo
  }
  #next(positions: readonly number[], position: number) {
    let lo = 0,
      hi = positions.length
    while (lo < hi) {
      const middle = (lo + hi) >>> 1
      if (positions[middle]! <= position) lo = middle + 1
      else hi = middle
    }
    return positions[lo]
  }
  *#destination(
    from: number,
    group: number,
    parentheses: ReadonlyMap<number, { to: number; bare: boolean }>,
    quotes: ReadonlyMap<string, readonly number[]>,
  ): Generator<void, number | null> {
    const read = this.#reader,
      end = this.#breaks[group] ?? this.#source.normalizedLength
    let at = from
    while (at < end && /[ \t\n]/.test(read.at(at))) {
      at++
      if (this.#tick()) yield
    }
    if (at > from) {
      const title = yield* this.#title(at, end, quotes)
      if (title !== null) return title
    }
    if (read.at(at) === '<') {
      at++
      while (at < end && read.at(at) !== '>') {
        const char = read.at(at)
        if (char === '<' || char === '\n') return null
        if (char === '\\' && escaped.test(read.at(at + 1))) at++
        at++
        if (this.#tick()) yield
      }
      if (read.at(at++) !== '>') return null
    } else {
      while (at < end && !/[ \t\n)]/.test(read.at(at))) {
        const char = read.at(at)
        if (char === '\\' && escaped.test(read.at(at + 1))) at += 2
        else if (char === '(') {
          const pair = parentheses.get(at)
          if (!pair?.bare) return null
          at = pair.to + 1
        } else {
          if (char === '<' || char === '>' || linkControl.test(char))
            return null
          const chunk = read.chunk(at, end),
            stop = chunk.search(/[\\()<>]/),
            control = chunk.search(linkControl)
          const count = Math.min(
            stop < 0 ? chunk.length : stop,
            control < 0 ? chunk.length : control,
          )
          if (!count) return null
          at += count
          if (this.#tick(count)) yield
        }
        if (this.#tick()) yield
      }
    }
    const beforeSpace = at
    while (at < end && /[ \t\n]/.test(read.at(at))) {
      at++
      if (this.#tick()) yield
    }
    if (read.at(at) === ')' && at < end) return at + 1
    if (at === beforeSpace || at >= end) return null
    return yield* this.#title(at, end, quotes)
  }
  *#title(
    at: number,
    end: number,
    quotes: ReadonlyMap<string, readonly number[]>,
  ): Generator<void, number | null> {
    const read = this.#reader
    const quote = read.at(at),
      closing = quote === '(' ? ')' : quote
    if (quote !== '"' && quote !== "'" && quote !== '(') return null
    const to = this.#next(quotes.get(closing) ?? [], at)
    if (to === undefined || to >= end) return null
    if (quote === '(') {
      const nested = this.#next(quotes.get('(') ?? [], at)
      if (nested !== undefined && nested < to) return null
    }
    at = to + 1
    while (at < end && /[ \t\n]/.test(read.at(at))) {
      at++
      if (this.#tick()) yield
    }
    return at < end && read.at(at) === ')' ? at + 1 : null
  }
  *#autolink(from: number, group: number): Generator<void, number | null> {
    const read = this.#reader,
      end = this.#breaks[group] ?? this.#source.normalizedLength
    let scheme = '',
      uri = false,
      email = true,
      domain = false,
      label = 0,
      last = ''
    for (let at = from + 1; at < end; at++) {
      const char = read.at(at)
      if (char === '>')
        return uri || (email && domain && label > 0 && last !== '-')
          ? at + 1
          : null
      if (char === '<' || char === '>' || linkControl.test(char)) return null
      if (char === ':' && /^[a-zA-Z][a-zA-Z0-9+.-]{1,31}$/.test(scheme))
        uri = true
      if (scheme.length < 33) scheme += char
      if (email) {
        if (char === '@') {
          if (domain || at === from + 1) email = false
          domain = true
        } else if (!domain) {
          if (!/[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]/.test(char)) email = false
        } else if (char === '.') {
          if (!label || last === '-') email = false
          label = 0
        } else if (
          !/[a-zA-Z0-9-]/.test(char) ||
          (++label === 1 && char === '-') ||
          label > 63
        )
          email = false
      }
      last = char
      if (this.#tick()) yield
    }
    return null
  }
  *#inline() {
    const read = this.#reader,
      length = this.#source.normalizedLength
    type Run = RenderedRange & { group: number }
    const widths = new Map<number, Run[]>(),
      openAt = new Map<number, Run>()
    const parentheses = new Map<number, { to: number; bare: boolean }>()
    let opens: { from: number; bad: number; group: number }[] = []
    const quotes = new Map<string, number[]>()
    this.#hidden = yield* this.#ordered(
      this.#hidden,
      (a, b) => a.from - b.from || b.to - a.to,
    )
    const hiddenCount = this.#hidden.length,
      literalCount = this.#literal.length
    let hidden = 0,
      literal = 0,
      slashes = 0,
      bad = 0,
      group = -1
    for (let at = this.prefix; at < length; ) {
      if (this.#tick()) yield
      while (hidden < hiddenCount && this.#hidden[hidden]!.to <= at) {
        hidden++
        if (this.#tick()) yield
      }
      while (literal < literalCount && this.#literal[literal]!.to <= at) {
        literal++
        if (this.#tick()) yield
      }
      const skip = hidden < hiddenCount ? this.#hidden[hidden] : undefined,
        raw = literal < literalCount ? this.#literal[literal] : undefined
      if (skip && skip.from <= at) {
        at = skip.to
        slashes = 0
        continue
      }
      if (raw && raw.from <= at) {
        at = raw.to
        slashes = 0
        continue
      }
      const current = this.#groupAt(at)
      if (current !== group) {
        group = current
        opens = []
      }
      const chunk = read.chunk(at)
      const stop = chunk.search(opens.length ? /[\\`()"'<>]/ : /[\\`()"']/)
      const control = opens.length ? chunk.search(linkControl) : -1
      const plain = Math.min(
        stop < 0 ? chunk.length : stop,
        control < 0 ? chunk.length : control,
      )
      if (plain) {
        at += plain
        slashes = 0
        if (this.#tick(plain)) yield
        continue
      }
      const char = read.at(at),
        isEscaped = slashes % 2 === 1
      if (char === '\\') {
        slashes++
        at++
        continue
      }
      if (char === '`') {
        const from = at
        while (at < length && read.at(at) === '`') {
          at++
          if (this.#tick()) yield
        }
        const run = { from, to: at, group }
        openAt.set(from, run)
        if (isEscaped && at - from > 1) openAt.set(from + 1, run)
        const entries = widths.get(at - from) ?? []
        entries.push(run)
        widths.set(at - from, entries)
      } else {
        if (
          opens.length &&
          (linkControl.test(char) || (!isEscaped && /[<>]/.test(char)))
        )
          bad++
        if (!isEscaped) {
          if (char === '(') opens.push({ from: at, bad, group })
          if (char === ')') {
            const open = opens.pop()
            if (open && open.group === group)
              parentheses.set(open.from, { to: at, bare: open.bad === bad })
          }
          if (char === '"' || char === "'" || char === '(' || char === ')') {
            const entries = quotes.get(char) ?? []
            entries.push(at)
            quotes.set(char, entries)
          }
        }
        at++
      }
      slashes = 0
    }
    type Bracket = {
      from: number
      image: boolean
      active: boolean
      previous: Bracket | null
      hidden: number
      literal: number
      pairs: number
      code: number
    }
    let brackets: Bracket[] = [],
      active: Bracket | null = null
    hidden = literal = 0
    group = -1
    for (let at = this.prefix; at < length; ) {
      if (this.#tick()) yield
      while (hidden < hiddenCount && this.#hidden[hidden]!.to <= at) {
        hidden++
        if (this.#tick()) yield
      }
      while (literal < literalCount && this.#literal[literal]!.to <= at) {
        literal++
        if (this.#tick()) yield
      }
      const skip = hidden < hiddenCount ? this.#hidden[hidden] : undefined,
        raw = literal < literalCount ? this.#literal[literal] : undefined
      if (skip && skip.from <= at) {
        at = skip.to
        continue
      }
      if (raw && raw.from <= at) {
        at = raw.to
        continue
      }
      const current = this.#groupAt(at)
      if (current !== group) {
        group = current
        brackets = []
        active = null
      }
      const chunk = read.chunk(at),
        stop = chunk.search(/[\\`[\]<]/)
      const plain = stop < 0 ? chunk.length : stop
      if (plain) {
        at += plain
        if (this.#tick(plain)) yield
        continue
      }
      const char = read.at(at)
      if (char === '\\' && escaped.test(read.at(at + 1))) {
        at += 2
        continue
      }
      if (char === '`') {
        const run = openAt.get(at)!
        const entries = widths.get(run.to - at) ?? []
        let lo = 0,
          hi = entries.length
        while (lo < hi) {
          const middle = (lo + hi) >>> 1
          if (entries[middle]!.from <= run.from) lo = middle + 1
          else hi = middle
        }
        const close = entries[lo]
        if (close && close.group === group) {
          this.#pair('mark', at, run.to, close.from, close.to)
          this.#literal.push({ from: run.to, to: close.from })
          this.#code.push({ from: run.to, to: close.from, width: run.to - at })
          at = close.to
        } else at = run.to
        continue
      }
      if (char === '<') {
        const to = yield* this.#autolink(at, group)
        if (to !== null) {
          this.#pair('link', at, at + 1, to - 1, to, true)
          while (active) {
            active.active = false
            active = active.previous
            if (this.#tick()) yield
          }
          this.#literal.push({ from: at + 1, to: to - 1 })
          at = to
          continue
        }
      }
      if (char === '[') {
        const bracket: Bracket = {
          from: at,
          image: read.at(at - 1) === '!',
          active: true,
          previous: active,
          hidden: this.#hidden.length,
          literal: this.#literal.length,
          pairs: this.#pairs.length,
          code: this.#code.length,
        }
        brackets.push(bracket)
        if (!bracket.image) active = bracket
      } else if (char === ']') {
        const open = brackets.pop()
        if (open?.active && !open.image) active = open.previous
        if (open?.active && read.at(at + 1) === '(') {
          const to = yield* this.#destination(
            at + 2,
            group,
            parentheses,
            quotes,
          )
          if (to !== null) {
            if (open.image) {
              this.#hidden.length = open.hidden
              this.#literal.length = open.literal
              this.#pairs.length = open.pairs
              this.#code.length = open.code
              this.#literal.push({ from: open.from - 1, to })
            } else {
              this.#pair('link', open.from, open.from + 1, at, to)
              while (active) {
                active.active = false
                active = active.previous
                if (this.#tick()) yield
              }
            }
            at = to
            continue
          }
        }
      }
      at++
    }
    this.#literal = yield* this.#ordered(
      this.#literal,
      (a, b) => a.from - b.from || b.to - a.to,
    )
  }
  *#marks() {
    const read = this.#reader,
      length = this.#source.normalizedLength
    this.#hidden = yield* this.#ordered(
      this.#hidden,
      (a, b) => a.from - b.from || b.to - a.to,
    )
    const linkPairs: Pair[] = []
    for (const pair of this.#pairs) {
      if (pair.kind === 'link') linkPairs.push(pair)
      if (this.#tick()) yield
    }
    const links = yield* this.#ordered(
      linkPairs,
      (a, b) => a.open.from - b.open.from,
    )
    const groups = new Map<
      number,
      { last: Delimiter | null; bottom: Map<string, number> }
    >()
    let hidden = 0,
      literal = 0,
      link = 0,
      index = 0
    for (let at = this.prefix; at < length; ) {
      if (this.#tick()) yield
      while (hidden < this.#hidden.length && this.#hidden[hidden]!.to <= at) {
        hidden++
        if (this.#tick()) yield
      }
      while (
        literal < this.#literal.length &&
        this.#literal[literal]!.to <= at
      ) {
        literal++
        if (this.#tick()) yield
      }
      const skip = this.#hidden[hidden],
        raw = this.#literal[literal]
      if (skip && skip.from <= at) {
        at = skip.to
        continue
      }
      if (raw && raw.from <= at) {
        at = raw.to
        continue
      }
      const chunk = read.chunk(at)
      const special = chunk.search(/[\\*_~\n]/)
      const plain = special < 0 ? chunk.length : special
      if (plain) {
        at += plain
        if (this.#tick(plain)) yield
        continue
      }
      const char = read.at(at)
      if (char === '\\') {
        at += 2
        continue
      }
      if (char !== '*' && char !== '_' && char !== '~') {
        at++
        if (this.#tick()) yield
        continue
      }
      const from = at
      while (at < length && read.at(at) === char) {
        at++
        if (this.#tick()) yield
      }
      if (char === '~' && at - from !== 2) continue
      while (link < links.length && links[link]!.close.to <= from) {
        link++
        if (this.#tick()) yield
      }
      const currentLink = links[link]
      const group =
        currentLink &&
        currentLink.open.to <= from &&
        from < currentLink.close.from
          ? link
          : -this.#groupAt(from) - 1
      let state = groups.get(group)
      if (!state) {
        state = { last: null, bottom: new Map() }
        groups.set(group, state)
      }
      const before = read.before(from),
        after = read.scalar(at)
      const left =
        !whitespace(after) &&
        (!punctuation(after) || whitespace(before) || punctuation(before))
      const right =
        !whitespace(before) &&
        (!punctuation(before) || whitespace(after) || punctuation(after))
      const delimiter: Delimiter = {
        from,
        to: at,
        code: char,
        open: char === '_' ? left && (!right || punctuation(before)) : left,
        close: char === '_' ? right && (!left || punctuation(after)) : right,
        previous: state.last,
        index: ++index,
      }
      while (delimiter.close && delimiter.to > delimiter.from) {
        const key =
          char + Number(delimiter.open) + ((delimiter.to - delimiter.from) % 3)
        const bottom = state.bottom.get(key) ?? -1
        let open = state.last
        while (open && open.index > bottom) {
          const size = delimiter.to - delimiter.from,
            width = open.to - open.from
          if (
            open.code === char &&
            open.open &&
            !(
              char !== '~' &&
              (open.close || delimiter.open) &&
              (size + width) % 3 === 0 &&
              (size % 3 !== 0 || width % 3 !== 0)
            )
          )
            break
          open = open.previous
          if (this.#tick()) yield
        }
        if (!open || open.index <= bottom) {
          state.bottom.set(key, state.last?.index ?? -1)
          break
        }
        const count =
          char === '~' ||
          Math.min(open.to - open.from, delimiter.to - delimiter.from) >= 2
            ? 2
            : 1
        this.#pair(
          'mark',
          open.to - count,
          open.to,
          delimiter.from,
          delimiter.from + count,
        )
        open.to -= count
        delimiter.from += count
        state.last = open.to > open.from ? open : open.previous
        if (this.#tick()) yield
      }
      if (delimiter.open && delimiter.from < delimiter.to) {
        delimiter.previous = state.last
        state.last = delimiter
      }
      if (this.#tick()) yield
    }
  }
  *build(): Generator<void, void> {
    if (this.#complete) return
    this.#building ??= this.#build()
    for (;;) {
      const step = this.#building.next()
      if (step.done) {
        this.#building = null
        return
      }
      yield
    }
  }
  *#build(): Generator<void, void> {
    this.#breaks = []
    this.#hidden = []
    this.#literal = []
    this.#pairs = []
    this.#runs = []
    this.#containers = []
    this.#parents = []
    this.#code = []
    this.#linePrefixes = []
    yield* this.#blocks()
    yield* this.#inline()
    this.#code = yield* this.#ordered(this.#code, (a, b) => a.from - b.from)
    yield* this.#marks()
    this.#hidden = yield* this.#ordered(
      this.#hidden,
      (a, b) => a.from - b.from || b.to - a.to,
    )
    const read = this.#reader,
      length = this.#source.normalizedLength
    let hidden = 0,
      literal = 0,
      at = 0
    let plainFrom = -1,
      plainTo = -1
    const flush = () => {
      if (plainFrom >= 0) this.#runs.push({ from: plainFrom, to: plainTo })
      plainFrom = plainTo = -1
    }
    const plain = (from: number, to: number) => {
      if (plainTo !== from) {
        flush()
        plainFrom = from
      }
      plainTo = to
    }
    const append = (run: RenderedRun) => {
      flush()
      this.#runs.push(run)
    }
    while (at < length) {
      if (this.#tick()) yield
      while (hidden < this.#hidden.length && this.#hidden[hidden]!.to <= at) {
        hidden++
        if (this.#tick()) yield
      }
      while (
        literal < this.#literal.length &&
        this.#literal[literal]!.to <= at
      ) {
        literal++
        if (this.#tick()) yield
      }
      const skip = this.#hidden[hidden],
        raw = this.#literal[literal]
      if (skip && skip.from <= at) {
        at = skip.to
        continue
      }
      if (raw && raw.from <= at) {
        const end = Math.min(raw.to, skip?.from ?? length)
        plain(at, end)
        at = end
        continue
      }
      const stop = Math.min(skip?.from ?? length, raw?.from ?? length, length)
      const chunk = read.chunk(at, stop)
      const special = chunk.search(/[\\&]/)
      const count = special < 0 ? chunk.length : special
      if (count) {
        plain(at, at + count)
        at += count
        if (this.#tick(count)) yield
        continue
      }
      const char = read.at(at)
      if (
        char === '\\' &&
        (escaped.test(read.at(at + 1)) || read.at(at + 1) === '\n')
      ) {
        append({ from: at, to: at + 2, text: read.at(at + 1) })
        at += 2
      } else if (char === '&') {
        let text = '&',
          end = at + 1
        while (
          end < length &&
          end - at < 34 &&
          /[a-zA-Z0-9#;]/.test(read.at(end))
        ) {
          text += read.at(end++)
          if (text.endsWith(';')) break
        }
        const decoded =
          /^&(?:#[0-9]{1,7}|#x[0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});$/.test(
            text,
          )
            ? decodeHTMLStrict(text)
            : text
        if (decoded !== text) {
          append({ from: at, to: end, text: decoded })
          at = end
        } else {
          plain(at, at + 1)
          at++
        }
      } else {
        plain(at, at + 1)
        at++
      }
      if (this.#tick()) yield
    }
    flush()
    const pairs = yield* this.#ordered(
      this.#pairs,
      (a, b) => a.open.from - b.open.from || b.close.to - a.close.to,
    )
    const stack: number[] = []
    for (const pair of pairs) {
      while (
        stack.length &&
        this.#containers[stack.at(-1)!]!.close.to <= pair.open.from
      ) {
        stack.pop()
        if (this.#tick()) yield
      }
      const from = this.#runAt(pair.open.to),
        to = this.#runAt(pair.close.from)
      const first = this.#runs[from],
        last =
          this.#runs[to] && this.#runs[to]!.from < pair.close.from
            ? this.#runs[to]
            : this.#runs[to - 1]
      if (first && last && first.from < pair.close.from) {
        const visible = {
          from: Math.max(first.from, pair.open.to),
          to: Math.min(last.to, pair.close.from),
        }
        const parent = stack.at(-1),
          outer = parent === undefined ? undefined : this.#containers[parent]
        if (
          pair.kind === 'mark' &&
          outer?.kind === 'mark' &&
          outer.visible.from === visible.from &&
          outer.visible.to === visible.to &&
          outer.open.to === pair.open.from &&
          pair.close.to === outer.close.from
        ) {
          this.#containers[parent!] = {
            kind: 'mark',
            open: { from: outer.open.from, to: pair.open.to },
            close: { from: pair.close.from, to: outer.close.to },
            visible,
          }
          if (this.#tick()) yield
          continue
        }
        this.#parents.push(stack.at(-1) ?? -1)
        this.#containers.push({
          ...pair,
          visible,
        })
        stack.push(this.#containers.length - 1)
      }
      if (this.#tick()) yield
    }
    this.#maximum = Math.max(this.#maximum, this.#pending)
    this.#hidden = []
    this.#literal = []
    this.#pairs = []
    this.#breaks = []
    this.#complete = true
  }
  get length() {
    return this.#source.normalizedLength
  }
  validStart(position: number) {
    const raw = this.#source.editorToRaw(position)
    return raw !== null && this.#source.isEditBoundary(raw)
  }
  #runAt(position: number) {
    let lo = 0,
      hi = this.#runs.length
    while (lo < hi) {
      const middle = (lo + hi) >>> 1
      if (this.#runs[middle]!.to <= position) lo = middle + 1
      else hi = middle
    }
    return lo
  }
  *runs(from = 0): Generator<RenderedRun> {
    for (let index = this.#runAt(from); index < this.#runs.length; index++) {
      const run = this.#runs[index]!
      if (run.to <= from) continue
      yield run.text === undefined
        ? { from: Math.max(from, run.from), to: run.to }
        : run
    }
  }
  /** Stream one selection without flattening it; partial decoded atoms are imprecise. */
  *range(from: number, to: number): Generator<RenderedChunk> {
    if (!this.#complete) throw new Error('Find coverage is incomplete.')
    if (
      !Number.isSafeInteger(from) ||
      !Number.isSafeInteger(to) ||
      from < 0 ||
      to < from ||
      to > this.length ||
      !this.validStart(from) ||
      !this.validStart(to)
    )
      throw new Error('Find selection is outside its source snapshot.')
    yield* renderedRange(this.runs(from), from, to, (start, end) =>
      this.text(start, end),
    )
  }
  text(from: number, to: number) {
    const rawFrom = this.#source.editorToRaw(from)!,
      rawTo = this.#source.editorToRaw(to)!
    return normalizedSource(this.#source.sliceRaw(rawFrom, rawTo))
  }
  *context(
    from: number,
    to: number,
    firstTo: number,
  ): Generator<void, RenderedMatchContext> {
    const read = this.#contextReader
    const line = this.#source.lineAt(this.#source.editorToRaw(from)!)!
    const physicalFrom = this.#source.rawToEditor(line.from)!
    let lo = 0,
      hi = this.#linePrefixes.length
    while (lo < hi) {
      const middle = (lo + hi) >>> 1
      if (this.#linePrefixes[middle]!.from <= physicalFrom) lo = middle + 1
      else hi = middle
    }
    const prefix = this.#linePrefixes[lo - 1]
    const lineFrom = prefix?.from === physicalFrom ? prefix.to : physicalFrom
    let linePrefix = ''
    // Three spaces and nine ordered-list digits may precede a new delimiter.
    for (let at = lineFrom; at < Math.min(lineFrom + 12, from); at++)
      linePrefix += read.at(at)
    lo = 0
    hi = this.#code.length
    while (lo < hi) {
      const middle = (lo + hi) >>> 1
      if (this.#code[middle]!.from <= from) lo = middle + 1
      else hi = middle
    }
    const code = this.#code[lo - 1]
    const near = this.#nearReader
    let after = ''
    for (let at = firstTo; at < Math.min(this.length, firstTo + 34); at++)
      after += near.at(at)
    let leftTicks = 0,
      rightTicks = 0,
      work = 0
    if (code && from < code.to && code.width) {
      for (let at = from - 1; at >= code.from && near.at(at) === '`'; at--) {
        leftTicks++
        if (++work === stepUnits) {
          work = 0
          yield
        }
      }
      for (
        let at = Math.min(to, code.to);
        at < code.to && near.at(at) === '`';
        at++
      ) {
        rightTicks++
        if (++work === stepUnits) {
          work = 0
          yield
        }
      }
    }
    return {
      lineFrom,
      linePrefix,
      after,
      code: code && from < code.to ? { ...code, leftTicks, rightTicks } : null,
    }
  }
  *containers(from: number, to: number): Generator<RenderedContainer | null> {
    let lo = 0,
      hi = this.#containers.length
    while (lo < hi) {
      const middle = (lo + hi) >>> 1
      if (this.#containers[middle]!.open.from < from) lo = middle + 1
      else hi = middle
    }
    let parent = lo - 1,
      work = 0
    while (parent >= 0) {
      const item = this.#containers[parent]!
      if (item.visible.from < from || item.visible.to > to) {
        if (item.autolink && item.close.to > from) yield item
        break
      }
      if (item.close.to > from) yield item
      parent = this.#parents[parent]!
      if (++work === stepUnits) {
        work = 0
        yield null
      }
    }
    for (let index = lo; index < this.#containers.length; index++) {
      const item = this.#containers[index]!
      if (item.open.from >= to) break
      if (item.autolink || (item.visible.from >= from && item.visible.to <= to))
        yield item
      if (++work === stepUnits) {
        work = 0
        yield null
      }
    }
  }
}
