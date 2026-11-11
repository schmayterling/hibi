import {
  type Lexer,
  type MarkedExtension,
  marked,
  type Token,
  Tokenizer,
  type Tokens,
} from 'marked'
import { blockStartLines, lazyItemEnd } from '../addons/_shared/block-start.ts'
import {
  type BlockLines,
  blockLine,
  blockOrigin,
  blockRow,
  relativeLines,
  sourceLines,
} from './marked-block-lines.ts'
import { withFenceRules } from './marked-fences.ts'
import {
  extendQuote,
  isLeafBlock,
  lazyContinuation,
  leafListEnd,
  quoteReader,
  withLeafBlocks,
} from './marked-leaf-blocks.ts'

// Keep each parser's block grammar, but scan lines without a backtracking frame
// per character or continuation line. Equivalence tests guard the rule delimiters.
const setextRules = new WeakMap<RegExp, { start: RegExp; candidate: RegExp }>()
const paragraphRules = new WeakMap<RegExp, RegExp>()
const quoteRules = new WeakMap<RegExp, RegExp | null>()
// Tabs keep their physical columns when a list removes its content indent.
const containerColumns = new WeakMap<Tokenizer, number>()
// Lazy setext candidates, measured from the end of this item's unchanged text.
const lazyUnderlines = new WeakMap<
  Tokenizer,
  { text: string; ends: Set<number> }
>()

// Candidate calls and source spans, including title interruption windows, and
// the quote lines scanned for the native quote rule's extent.
export const blockScanCounters = { calls: 0, units: 0, quoteLines: 0 }

// Lines where the lexer's block extensions start. They interrupt paragraphs
// there, so, as in lezer, they also end lazy quote lines and setext text.
function extensionLines(tokenizer: Tokenizer) {
  return (tokenizer.lexer.options.extensions?.startBlock ?? []).flatMap(
    (start) => blockStartLines.get(start) ?? [],
  )
}

// The paragraph interruptions inside the native quote rule, or null when a
// custom rule replaced it.
function quoteInterrupt(tokenizer: Tokenizer) {
  const pattern = tokenizer.rules.block.blockquote
  let interrupt = quoteRules.get(pattern)
  if (interrupt === undefined) {
    const start = '^( {0,3}> ?(?:(?![ \\t]*(?:\\n|$))(([^\\n]+(?:\\n(?!'
    const end = ')[^\\n]+)*))|[^\\n]*)(?:\\n|$))+'
    interrupt =
      pattern.source.startsWith(start) && pattern.source.endsWith(end)
        ? new RegExp(`^(?:${pattern.source.slice(start.length, -end.length)})`)
        : null
    quoteRules.set(pattern, interrupt)
  }
  return interrupt
}

type QuoteScan = {
  /** Line `index` of the quote's extent, or undefined past its end. */
  line(index: number): string | undefined
  /** The first `count` lines exactly as read, joined. */
  raw(count: number): string
  /** The source up to the end of the scanned lines, as the native rule matches. */
  extent(): string
  /** A scanned line contains a tab. */
  tabs: boolean
}
/** Lines for a nested re-read, each with its newline when one follows. */
type QuoteFeed = (index: number) => string | undefined

// The native quote regexp keeps a backtracking frame for every quoted/lazy
// line, and matches the whole extent before the reader consumes its first
// line. Apply the same interruptions one line at a time, including an empty >,
// only as far as the reader asks: a reader that stops early leaves the rest
// for the quote call that follows it instead of scanning it again.
function quoteScan(
  tokenizer: Tokenizer,
  source: string,
  feed?: QuoteFeed,
): QuoteScan | undefined {
  const { blockquoteStart } = tokenizer.rules.other
  if (!blockquoteStart.test(source)) return
  const interrupt = quoteInterrupt(tokenizer)
  // A line's newline tells that the quote's container goes on after it, but
  // not in a nested re-read, whose lines can run past the enclosing quote.
  const blocks = feed ? [] : extensionLines(tokenizer)
  // Line starts of the extent in the source, or the fed lines; text is sliced
  // on demand.
  const starts: number[] = []
  const lines: string[] = []
  let at = 0
  let lazy = false
  let done = false
  let tabs = false
  if (!interrupt) {
    // A custom quote rule: its match is the whole extent.
    if (feed) {
      let text = ''
      for (let line = feed(0), index = 1; line !== undefined; index++) {
        text += line
        line = feed(index)
      }
      source = text
      feed = undefined
    }
    const match = tokenizer.rules.block.blockquote.exec(source)
    if (!match) return
    const extent = match[0].replace(/\n+$/, '')
    for (let from = 0; from <= extent.length; ) {
      starts.push(from)
      const newline = extent.indexOf('\n', from)
      from = newline < 0 ? extent.length + 1 : newline + 1
    }
    at = extent.length + 1
    done = true
    tabs = extent.includes('\t')
  }
  // Whether the next line continues the extent.
  const continues = (raw: string, line: string) => {
    blockScanCounters.quoteLines++
    if (blockquoteStart.test(line)) {
      const marker = line.indexOf('>')
      lazy = /[^ \t]/.test(line.slice(marker + 1))
    } else if (
      !lazy ||
      !line ||
      interrupt!.test(raw) ||
      blocks.some((block) => block.test(raw))
    )
      return false
    if (!scan.tabs && line.includes('\t')) scan.tabs = true
    return true
  }
  const content = (raw: string) => (raw.endsWith('\n') ? raw.slice(0, -1) : raw)
  const scan: QuoteScan = {
    tabs,
    line(index) {
      if (feed) {
        while (lines.length <= index && !done) {
          const raw = feed(lines.length)
          if (raw === undefined || !continues(raw, content(raw))) done = true
          else lines.push(raw)
        }
        const raw = lines[index]
        return raw === undefined ? undefined : content(raw)
      }
      while (starts.length <= index && !done) {
        if (at >= source.length) {
          done = true
          break
        }
        const newline = source.indexOf('\n', at)
        const to = newline < 0 ? source.length : newline
        if (!continues(source.slice(at, to + 1), source.slice(at, to))) {
          done = true
          break
        }
        starts.push(at)
        at = to + 1
      }
      const from = starts[index]
      if (from === undefined) return
      const end = index + 1 < starts.length ? starts[index + 1]! - 1 : at - 1
      return source.slice(from, end)
    },
    raw(count) {
      if (feed) return lines.slice(0, count).map(content).join('\n')
      return source.slice(
        0,
        count < starts.length ? starts[count]! - 1 : at - 1,
      )
    },
    extent() {
      let count = feed ? lines.length : starts.length
      while (scan.line(count) !== undefined) count++
      return feed
        ? lines.join('')
        : source.slice(0, Math.min(at, source.length))
    },
  }
  return scan
}

// A nested re-read takes its lines from the enclosing reader as it asks for
// them, and reports how many it consumed and the length of the raw it read.
// A tab in a line the enclosing reader has not put under column state ends
// the feed; the retry installs it.
type QuoteHandoff = {
  lines: QuoteFeed
  taken: number
  length?: number
  tabs?: boolean
  physical?: { parent: BlockLines; row: (row: number) => number }
}
let quoteFeed: QuoteHandoff | undefined
// A quote's raw text that its extensions re-read, and the source it was read
// from: the raw is no suffix of the frame, so its row comes from the source.
let quoteSource:
  | {
      raw: string
      source: string
      quote: Tokens.Blockquote
      lexer: Lexer
      input?: string
    }
  | undefined

type SetextFrame = {
  source: string
  parent: SetextFrame | undefined
  candidates: Map<RegExp, RegExpExecArray | null>
  invalid?: number
}
// Only Marked's immediate merge sees this view; addons see actual tokens.
// Inspecting a growing raw rope's last character would flatten its prefix.
function rawMergeView(token: Token, newline: boolean) {
  const prefix = newline ? '\n' : ''
  return new Proxy(token, {
    get(target, key) {
      return key === 'raw' ? prefix : Reflect.get(target, key)
    },
    set(target, key, value) {
      if (key !== 'raw') return Reflect.set(target, key, value)
      target.raw += String(value).slice(prefix.length)
      return true
    },
  })
}

function withTextMerges<T>(
  tokenizer: Tokenizer,
  source: string,
  tokens: Token[],
  read: () => T,
): T {
  const text = tokenizer.text,
    at = tokens.at,
    descriptor = Object.getOwnPropertyDescriptor(tokens, 'at'),
    native = new WeakSet<Token>()
  let merge = false,
    newline = false
  tokenizer.text = function (input) {
    const token = text.call(this, input)
    if (setextFrames.get(this)?.source !== source) return token
    merge = !!token && token.raw === input.slice(0, token.raw.length)
    newline = source.charCodeAt(source.length - input.length - 1) === 10
    if (merge) native.add(token!)
    return token
  }
  Object.defineProperty(tokens, 'at', {
    configurable: true,
    value: (index: number) => {
      const token = at.call(tokens, index),
        pending = merge
      merge = false
      return pending &&
        index === -1 &&
        token?.type === 'text' &&
        native.has(token)
        ? rawMergeView(token, newline)
        : token
    },
  })
  try {
    return read()
  } finally {
    tokenizer.text = text
    if (descriptor) Object.defineProperty(tokens, 'at', descriptor)
    else Reflect.deleteProperty(tokens, 'at')
  }
}

const setextFrames = new WeakMap<Tokenizer, SetextFrame>()
const scanningQuotes = new WeakSet<Tokenizer>()
const blockLinesOf = new WeakMap<Tokenizer, BlockLines>()
/** Underlines kept verbatim by dedenting are lazy, so cannot form headings. */
function lazySetextEnds(source: string, text: string, physical = 0) {
  const ends = new Set<number>()
  if (/\n {0,3}(?:=+|-+)[ \t]*(?:\n|$)/.test(text))
    for (let at = 0, row = 0; at <= text.length; row++) {
      const lf = text.indexOf('\n', at),
        end = lf < 0 ? text.length : lf
      const next = source.indexOf('\n', physical)
      const line = text.slice(at, end)
      const written = source.slice(physical, next < 0 ? undefined : next)
      if (
        row &&
        /^ {0,3}(?:=+|-+)[ \t]*$/.test(line) &&
        (line === written || (lf < 0 && line === written.trimEnd()))
      )
        ends.add(text.length - at)
      if (lf < 0) break
      at = lf + 1
      physical = next < 0 ? source.length : next + 1
    }
  return ends
}

/** Parse a footnote with the physical columns of its actual container. */
export function continuationTokens<T>(
  lexer: Lexer,
  physical: string,
  text: string,
  read: () => T,
) {
  const tokenizer = lexer.options.tokenizer!,
    previous = lazyUnderlines.get(tokenizer),
    previousLines = blockLinesOf.get(tokenizer)
  let owner = { lines: sourceLines(physical), row: 0 }
  if (
    previousLines &&
    previousLines.source === setextFrames.get(tokenizer)?.source
  ) {
    const quote = quoteFrames.get(tokenizer)
    const at =
      quote?.extension &&
      quote.frame?.source === previousLines.source &&
      quote.frame.scope === quote.scope
        ? quote.frame.scanned
        : previousLines.source.length - physical.length
    if (at >= 0) {
      const row = blockRow(previousLines, at)
      const end = physical.indexOf('\n')
      if (
        blockLine(previousLines, row) ===
        physical.slice(0, end < 0 ? undefined : end)
      ) {
        const original = blockOrigin(previousLines, row)
        if (original.lines !== previousLines) owner = original
      }
    }
  }
  const ends = new Set<number>()
  for (let at = 0, row = 0; at <= text.length; row++) {
    const lf = text.indexOf('\n', at),
      end = lf < 0 ? text.length : lf
    if (
      row &&
      /^ {0,3}(?:=+|-+)[ \t]*$/.test(text.slice(at, end)) &&
      /^ {0,3}(?:=+|-+)[ \t]*$/.test(
        blockLine(owner.lines, owner.row + row) ?? '',
      )
    )
      ends.add(text.length - at)
    if (lf < 0) break
    at = lf + 1
  }
  if (ends.size) lazyUnderlines.set(tokenizer, { text, ends })
  else lazyUnderlines.delete(tokenizer)
  // No parent: a nested definition's first line always loses this marker or
  // its indent, and unindented definition lines end the body, so no origin
  // lookup walks past these lines.
  blockLinesOf.set(tokenizer, sourceLines(text))
  const top = lexer.state.top
  lexer.state.top = true
  try {
    return withQuoteScan(tokenizer, read)
  } finally {
    lexer.state.top = top
    if (previousLines) blockLinesOf.set(tokenizer, previousLines)
    else blockLinesOf.delete(tokenizer)
    if (previous) lazyUnderlines.set(tokenizer, previous)
    else lazyUnderlines.delete(tokenizer)
  }
}

// Tokenizers whose quotes keep Marked's own tab handling.
const untabbedQuotes = new WeakSet<Tokenizer>()
// Each lexer makes a rules object: the long native quotes share one, so the
// fence and definition rules derived from it are built once.
let nativeQuoteRules: Tokenizer['rules'] | undefined
type QuoteRead = { source: string; quote: Tokens.Blockquote }
const nativeQuoteReads = new WeakMap<Lexer, Map<number, QuoteRead>>()
const quoteReadCaches = new WeakMap<Tokenizer, Map<number, QuoteRead>>()

function rememberQuote(
  tokenizer: Tokenizer,
  quote: Tokens.Blockquote,
  source?: string,
) {
  const cache = quoteReadCaches.get(tokenizer)
  // A known definition can change a nested re-read's boundary. Cache only
  // independent reads, and key by length before comparing the source bytes.
  if (!cache || Object.keys(tokenizer.lexer.tokens.links).length) return
  cache.set(quote.raw.length, { source: quote.raw, quote: { ...quote } })
  if (source && source !== quote.raw)
    cache.set(source.length, { source, quote: { ...quote } })
}
function quoteText(source: string, rules: Tokenizer['rules']) {
  return source
    .replace(rules.other.blockquoteSetextReplace, '\n    $1')
    .replace(rules.other.blockquoteSetextReplace2, (prefix: string) =>
      prefix.endsWith('\t') ? ' '.repeat(3 - ((prefix.length - 1) % 4)) : '',
    )
}

/**
 * A quote read with Marked's decisions and tab handling, only as far as it
 * goes: Marked's quote rule first scans the rest of a lazy extent, which is
 * quadratic for a reader called at every quote.
 */
export function readNativeQuote(source: string, lexer?: Lexer) {
  // An extension of this quote must keep the boundary already consumed.
  if (quoteSource?.raw === source && quoteSource.lexer === lexer)
    return quoteSource.quote
  if (quoteSource?.input === source && quoteSource.lexer === lexer)
    return { ...quoteSource.quote, raw: source }
  let cache = lexer && nativeQuoteReads.get(lexer)
  const cached = cache?.get(source.length)
  if (cached?.source === source) return cached.quote
  const input = source
  // The rule's extent stops at a blank line: bound the fast native read.
  const end = quoteWindow(source)
  if (end !== undefined) {
    source = source.slice(0, end)
    const tokenizer = new Tokenizer()
    new marked.Lexer({ gfm: true, tokenizer })
    let valid = true
    const nested: QuoteRead[] = []
    tokenizer.blockquote = (input) => {
      const quote = Tokenizer.prototype.blockquote.call(tokenizer, input)
      // Check nested re-reads too: their corrupt raw can lose body lines even
      // when the outer raw still matches. Retry with the shared reader.
      if (quote && !input.startsWith(quote.raw) && quote.raw !== `${input}\n`)
        valid = false
      if (lexer && quote && input !== source)
        nested.push({ source: input, quote: { ...quote } })
      return quote
    }
    const quote = tokenizer.blockquote(source)
    if (valid) {
      // A lone invented newline at EOF needs no body re-read. Bound the
      // physical source and remove one quote level without child text splices.
      if (quote) {
        if (quote.raw.length > source.length) quote.raw = source
        // Native marker expansion also consumes literal tabs in fenced code.
        quote.text = quoteText(quote.raw, tokenizer.rules)
        if (lexer && nested.length) {
          if (!cache) {
            cache = new Map()
            nativeQuoteReads.set(lexer, cache)
          }
          quoteReadCaches.set(tokenizer, cache)
          for (const read of nested) {
            if (read.quote.raw.length > read.source.length)
              read.quote.raw = read.source
            read.quote.text = quoteText(read.quote.raw, tokenizer.rules)
            rememberQuote(tokenizer, read.quote, read.source)
          }
          rememberQuote(tokenizer, quote, input)
        }
      }
      return quote
    }
  }
  if (lexer && !cache) {
    cache = new Map()
    nativeQuoteReads.set(lexer, cache)
  }
  const tokenizer = new BlockTokenizer()
  new marked.Lexer({ gfm: true, tokenizer })
  tokenizer.rules = nativeQuoteRules ??= tokenizer.rules
  untabbedQuotes.add(tokenizer)
  if (cache) quoteReadCaches.set(tokenizer, cache)
  const quote = tokenizer.blockquote(source)
  if (quote && input !== source) rememberQuote(tokenizer, quote, input)
  return quote
}
// Where the first empty line within 32 lines starts, or the end of a source
// that ends sooner.
function quoteWindow(source: string) {
  for (let at = 0, line = 0; line < 32; line++) {
    if (source.charCodeAt(at) === 10) return at
    const next = source.indexOf('\n', at)
    if (next < 0) return source.length
    at = next + 1
  }
}
const invalidSetext = /[\r\u2028\u2029]/g

// A candidate beyond custom blocks also belongs to later paragraphs in this
// same blockTokens call. Cache it there, never across documents or containers.
function withQuoteScan<T>(tokenizer: Tokenizer, read: () => T): T {
  if (scanningQuotes.has(tokenizer)) return read()
  scanningQuotes.add(tokenizer)
  const lexer = tokenizer.lexer
  const blockTokens = lexer.blockTokens
  lexer.blockTokens = (...args) => {
    const previous = setextFrames.get(tokenizer)
    setextFrames.set(tokenizer, {
      source: args[0],
      parent: previous,
      candidates: new Map(),
    })
    try {
      return Reflect.apply(blockTokens, lexer, args)
    } finally {
      if (previous) setextFrames.set(tokenizer, previous)
      else setextFrames.delete(tokenizer)
    }
  }
  try {
    return read()
  } finally {
    lexer.blockTokens = blockTokens
    scanningQuotes.delete(tokenizer)
  }
}

// The lines of a nested re-read's input that Marked counts as read: it keeps
// the input after the new quote's raw, less one newline, by length, so a raw
// that a list re-read changed takes other lines than the quote itself read.
function readLines(lines: QuoteFeed, length: number) {
  let index = 0,
    at = 0,
    line = lines(0)
  while (line !== undefined && at + line.length <= length) {
    at += line.length
    line = lines(++index)
  }
  if (line?.[length - at] === '\n') index += lines(index + 1) === '' ? 2 : 1
  return index
}

// Find the native list boundary without running child tokenizers or inline
// callbacks. Grow only while the prefix ends before a real stopping line.
function quoteListInput(
  tokenizer: Tokenizer,
  prefix: string,
  line: (index: number) => string | undefined,
) {
  const lexer = tokenizer.lexer
  const lines: string[] = []
  for (let size = 8; ; size *= 2) {
    // Read lines before stubbing the lexer: a line can install quote state.
    while (lines.length < size) {
      const next = line(lines.length)
      if (next === undefined) break
      lines.push(next)
    }
    const input = `${prefix}\n${lines.join('\n')}`
    const read = lexer.blockTokens
    const top = lexer.state.top
    lexer.blockTokens = () => Object.assign([], { links: lexer.tokens.links })
    let list: Tokens.List | undefined
    try {
      list = Tokenizer.prototype.list.call(tokenizer, input)
    } finally {
      lexer.blockTokens = read
      lexer.state.top = top
    }
    if (!list || lines.length < size || /\S/.test(input.slice(list.raw.length)))
      return input
  }
}

// Marked's quote algorithm, with a cursor instead of copying the unconsumed
// line array at every lazy continuation. Keep its block and re-read decisions.
function readQuote(
  this: Tokenizer,
  source: string,
): Tokens.Blockquote | undefined {
  const handoff = quoteFeed
  quoteFeed = undefined
  const scan = quoteScan(this, source, handoff?.lines)
  if (!scan) return
  const parentLines = blockLinesOf.get(this)
  const input =
    quoteSource?.raw === source && quoteSource.lexer === this.lexer
      ? quoteSource.source
      : source
  const physical = handoff?.physical
    ? sourceLines(source, handoff.physical.parent, handoff.physical.row)
    : parentLines
      ? relativeLines(
          source,
          parentLines,
          parentLines.source.length - input.length,
        )
      : sourceLines(source)
  physical.read = scan.line
  let from = 0
  let front: string[] = []
  let frontAt = 0
  // Physical rows consumed; a pending front line still belongs to a taken row.
  const rows = () => from - (front.length - frontAt)
  let text = ''
  let textRows = -1
  const tokens: Token[] = []
  let chunkLines: string[] = []
  // The chunk that produced the last token, for its row if tab state arrives later.
  let produced: { row: number; body: string; offset: number } | undefined
  // Tabs and custom leaf blocks need physical quote rows: a lazy line can
  // continue paragraph text, but cannot open a new block. An enclosing quote's
  // state is adopted at entry, or when its reader installs it while feeding
  // this one; a top-level quote installs its own.
  const lastToken = () => {
    const token = tokens.at(-1)
    return {
      tokens,
      token,
      row:
        token && produced
          ? produced.row + quoteLines(produced.body, 0, produced.offset)
          : undefined,
    }
  }
  let state = quoteFrames.get(this)
  let scope: QuoteScope | undefined
  let strip = this.rules.other.blockquoteSetextReplace2
  let release: (() => void) | undefined
  let origin: number | undefined
  let adopted: { rules: Tokenizer['rules']; scope: QuoteScope } | undefined
  const adopt = (found: QuoteState) => {
    state = found
    origin = quoteOrigin(found, source)
    adopted = { rules: this.rules, scope: found.scope }
    scope = {
      kind: 'quote',
      depth: found.scope.depth + 1,
      indent: 0,
      next: origin + rows() - chunkLines.length,
      native: found.scope.native,
      columns: found.scope.columns,
    }
    const last = lastToken()
    if (tokens.length) scope.last = tokens
    if (last.token && last.row !== undefined)
      found.origins.set(last.token, origin + last.row)
    found.scope = scope
    strip = quoteStrip(found, scope, adopted.rules)
    this.rules = {
      ...adopted.rules,
      other: { ...adopted.rules.other, blockquoteSetextReplace2: strip },
    }
  }
  if (state) adopt(state)
  const tabs = (leaves = false) => {
    if (state) {
      if (!adopted && !release) adopt(state)
      if (scan.tabs) {
        scope!.columns = true
        if (state.scope.native) state.scope.columns = true
      }
      return
    }
    const found = quoteFrames.get(this)
    if (found) adopt(found)
    else if ((scan.tabs || leaves) && !untabbedQuotes.has(this)) {
      release = installQuoteState(
        this,
        rows() - chunkLines.length,
        lastToken(),
        scan.tabs,
      )
      state = quoteFrames.get(this)!
      scope = state.scope
      strip = this.rules.other.blockquoteSetextReplace2
    }
  }
  const peek = (index: number) =>
    frontAt + index < front.length
      ? front[frontAt + index]!
      : scan.line(from + frontAt + index - front.length)
  const lineAt = (index = 0) => {
    const line = peek(index)
    if (!adopted && !release) tabs()
    const physical = scan.line(rows() + index)
    if (
      state &&
      scope &&
      physical !== undefined &&
      !this.rules.other.blockquoteStart.test(physical)
    ) {
      const row = (origin ?? 0) + rows() + index
      state.lazy.set(
        row,
        Math.min(state.lazy.get(row) ?? scope.depth, scope.depth),
      )
    }
    return line
  }
  // Line `index` as the native re-read input spells it: with a newline unless
  // it is the last line of the extent.
  const rawLineAt = (index: number) => {
    const line = peek(index)
    return line === undefined || peek(index + 1) === undefined
      ? line
      : `${line}\n`
  }
  const takeLine = () =>
    frontAt < front.length ? front[frontAt++]! : scan.line(from++)!
  const firstLine = (value: string) => {
    if (frontAt < front.length) front[frontAt] = value
    else {
      front = [value]
      frontAt = 0
      from++
    }
  }
  const nativeParagraphs = new WeakSet<Token>()
  let paragraphTail:
    | { token: Token; length: number; newline: boolean }
    | undefined
  try {
    while (lineAt() !== undefined) {
      const chunkRow = rows()
      chunkLines = []
      let quoted = false
      for (let line = lineAt(); line !== undefined; line = lineAt()) {
        if (this.rules.other.blockquoteStart.test(line)) quoted = true
        else if (quoted) break
        chunkLines.push(takeLine())
      }
      const chunk = chunkLines.join('\n')
      const body = quoteText(chunk, this.rules)
      chunkLines = []
      if (chunkRow === 0) {
        text = body
        textRows = rows()
      } else textRows = -1
      const readers = {
        code: this.code,
        def: this.def,
        paragraph: this.paragraph,
      }
      const parent = setextFrames.get(this)
      let remaining = body.length
      let definitionEnd = -1
      let merge = false
      const arm = <T>(token: T) => {
        if (setextFrames.get(this)?.parent === parent && !this.options.pedantic)
          merge = !!token
        return token
      }
      this.code = function (input) {
        if (setextFrames.get(this)?.parent === parent) remaining = input.length
        return arm(readers.code.call(this, input))
      }
      this.def = function (input) {
        const token = readers.def.call(this, input)
        if (token && setextFrames.get(this)?.parent === parent)
          definitionEnd = body.length - input.length + token.raw.length
        return arm(token)
      }
      this.paragraph = function (input) {
        const token = readers.paragraph.call(this, input)
        if (token) nativeParagraphs.add(token)
        return arm(token)
      }
      const at = tokens.at
      const descriptor = Object.getOwnPropertyDescriptor(tokens, 'at')
      Object.defineProperty(tokens, 'at', {
        configurable: true,
        value: (index: number) => {
          const token = at.call(tokens, index)
          const pending = merge
          merge = false
          if (
            !pending ||
            index !== -1 ||
            !token ||
            !nativeParagraphs.has(token) ||
            (token.type !== 'paragraph' && token.type !== 'text')
          )
            return token
          const offset = body.length - remaining
          const newline =
            offset > 0
              ? body.charCodeAt(offset - 1) === 10
              : offset === 0 &&
                  paragraphTail?.token === token &&
                  paragraphTail.length === token.raw.length
                ? paragraphTail.newline
                : undefined
          if (newline === undefined) return token
          return rawMergeView(token, newline)
        },
      })
      const before = { length: tokens.length, last: tokens.at(-1) }
      const top = this.lexer.state.top
      const previousLines = blockLinesOf.get(this)
      blockLinesOf.set(this, sourceLines(body, physical, chunkRow))
      this.lexer.state.top = true
      try {
        this.lexer.blockTokens(body, tokens, true)
      } finally {
        if (previousLines) blockLinesOf.set(this, previousLines)
        else blockLinesOf.delete(this)
        Object.assign(this, readers)
        if (descriptor) Object.defineProperty(tokens, 'at', descriptor)
        else Reflect.deleteProperty(tokens, 'at')
        this.lexer.state.top = top
      }
      const last = tokens.at(-1)
      if (last && (tokens.length !== before.length || last !== before.last))
        produced = {
          row: chunkRow,
          body,
          offset: Math.max(0, body.length - last.raw.length),
        }
      if (body.length)
        paragraphTail =
          last && (last.type === 'paragraph' || last.type === 'text')
            ? {
                token: last,
                length: last.raw.length,
                newline: body.endsWith('\n'),
              }
            : undefined
      if (lineAt() === undefined) break
      // A re-read can omit an already known definition from the token list.
      // Its preceding leaf is no longer the block at the continuation boundary.
      if (definitionEnd === body.length) continue
      if (
        last &&
        ['code', 'heading', 'hr', 'html', 'table'].includes(last.type)
      )
        break
      if (last?.type === 'blockquote') {
        // Marked re-reads the nested quote with every remaining line, one
        // quote level removed. Feed it those lines as it asks for them.
        const prefix = last.raw.split('\n')
        const prefixRow = lastToken().row!,
          followingRow = rows()
        const inner: QuoteHandoff = {
          taken: 0,
          physical: {
            parent: physical,
            row: (index) =>
              index < prefix.length
                ? prefixRow + index
                : followingRow + index - prefix.length,
          },
          lines: (index) => {
            if (index < prefix.length) return `${prefix[index]}\n`
            const line = rawLineAt(index - prefix.length)
            if (line === undefined) return
            // A tab installs this quote's state before the line is stripped.
            if (!adopted && !release) tabs()
            if (!scope) return line.replace(strip, '')
            // The strip reads rows from this scope's next row.
            const base = scope.next
            scope.next = base + index - prefix.length
            try {
              return line.replace(strip, '')
            } finally {
              scope.next = base
            }
          },
        }
        // The re-read's lines count by length, as Marked counts them, unless
        // tab columns widened its input from the start.
        const native = !scope?.columns
        quoteFeed = inner
        let quote: Tokens.Blockquote
        try {
          quote = this.blockquote(last.raw)!
        } finally {
          quoteFeed = undefined
        }
        tokens[tokens.length - 1] = quote
        let used = inner.taken - prefix.length
        if (native) {
          used =
            readLines(inner.lines, inner.length ?? quote.raw.length) -
            prefix.length
          // A tab that came in during the re-read widened the lines after it,
          // so their lengths can undercount the lines the re-read took.
          if (scope?.columns) used = Math.max(used, inner.taken - prefix.length)
        }
        // Under tab columns the raw and the widened input need not share
        // lengths: count the lines the re-read took. A last quote line that
        // strips to nothing still counts, as Marked leaves no text after it.
        const rest = !native && used >= 0 ? lineAt(used) : undefined
        if (
          rest !== undefined &&
          lineAt(used + 1) === undefined &&
          !RegExp.prototype[Symbol.replace].call(strip, rest, () => '')
        )
          used++
        for (; used > 0; used--) takeLine()
        const next = lineAt()
        if (next !== undefined && this.rules.other.blockquoteStart.test(next))
          continue
        break
      }
      if (last?.type === 'list') {
        const starts = extensionLines(this).filter((start) => start.lazyItem)
        const input = quoteListInput(this, last.raw, (index) => {
          const line = lineAt(index)
          if (
            !state &&
            line !== undefined &&
            starts.some((start) => start.test(line.trimStart() + '\n'))
          ) {
            tabs(true)
            return lineAt(index)
          }
          return line
        })
        const prefixRow = lastToken().row!,
          followingRow = rows()
        const prefixRows = followingRow - prefixRow
        const previousLines = blockLinesOf.get(this)
        blockLinesOf.set(
          this,
          sourceLines(input, physical, (row) =>
            row < prefixRows
              ? prefixRow + row
              : followingRow + row - prefixRows,
          ),
        )
        let list: Tokens.List
        try {
          list = this.list(input)!
        } finally {
          if (previousLines) blockLinesOf.set(this, previousLines)
          else blockLinesOf.delete(this)
        }
        tokens[tokens.length - 1] = list
        let consumed = list.raw.length - last.raw.length - 1
        if (consumed < 0) {
          front = last.raw
            .slice(list.raw.length)
            .split('\n')
            .concat(front.slice(frontAt))
          frontAt = 0
        } else {
          let line = lineAt()
          while (line !== undefined && consumed > line.length) {
            consumed -= takeLine().length + 1
            line = lineAt()
          }
          if (line !== undefined) firstLine(line.slice(consumed))
        }
      }
    }
    // Body text removes exactly one source quote level. Child re-reads have
    // different prefixes and lengths, so their text cannot replace a suffix.
    if (textRows !== rows()) {
      if (scope) scope.next = origin ?? 0
      text = quoteText(scan.raw(rows()), this.rules)
    }
  } finally {
    if (handoff) handoff.taken = from
    if (adopted) {
      this.rules = adopted.rules
      state!.scope = adopted.scope
    }
    release?.()
  }
  const token: Tokens.Blockquote = {
    type: 'blockquote',
    // The rows as read. Marked's own raw pastes each re-read list over them,
    // and gains a newline there that makes the lexer skip following text.
    raw: scan.raw(rows()),
    text,
    tokens,
  }
  if (adopted) state!.origins.set(token, origin!)
  if (handoff) handoff.length = token.raw.length
  rememberQuote(this, token, handoff ? undefined : source)
  return token
}

const tableTokenizer = new Tokenizer()
const tableLexer = new marked.Lexer({ gfm: true, tokenizer: tableTokenizer })
// Boundary validation only needs cell counts, so retain no pending inline work.
tableLexer.inline = () => []

function paragraphRule(pattern: RegExp) {
  let interrupt = paragraphRules.get(pattern)
  if (!interrupt) {
    const start = '^([^\\n]+(?:\\n(?!'
    const tail = ')[^\\n]+)*)'
    if (!pattern.source.startsWith(start) || !pattern.source.endsWith(tail))
      return
    interrupt = new RegExp(
      `^(?:${pattern.source.slice(start.length, -tail.length)})`,
    )
    paragraphRules.set(pattern, interrupt)
  }
  return interrupt
}

const definitionPatterns = new WeakMap<RegExp, RegExp>()
// CommonMark separates a definition's label, destination and title, and ends
// it, with spaces or tabs; Marked's rule accepts spaces only.
const definitionGaps = [
  [String.raw`\]: *(?:\n[ \t]*)?`, String.raw`\]:[ \t]*(?:\n[ \t]*)?`],
  [
    String.raw`(?: +(?:\n[ \t]*)?| *\n[ \t]*)`,
    String.raw`(?:[ \t]+(?:\n[ \t]*)?|[ \t]*\n[ \t]*)`,
  ],
  [String.raw`)? *(?:\n+|$)`, String.raw`)?[ \t]*(?:\n+|$)`],
] as const
const definitionStart = /^ *\[/
function withDefinitionRules<T>(
  tokenizer: Tokenizer,
  source: string,
  read: () => T,
): T {
  // Every paragraph comes here first, and each lexer has its own rules object.
  if (!definitionStart.test(source)) return read()
  const rules = tokenizer.rules
  const { def } = rules.block
  let fixed = definitionPatterns.get(def)
  if (!fixed) {
    // Only Marked's CommonMark rule; pedantic mode keeps its own.
    fixed = definitionGaps.every(([gap]) => def.source.includes(gap))
      ? new RegExp(
          definitionGaps.reduce(
            (text, [gap, wide]) => text.replace(gap, () => wide),
            def.source,
          ),
          def.flags,
        )
      : def
    definitionPatterns.set(def, fixed)
  }
  tokenizer.rules = { ...rules, block: { ...rules.block, def: fixed } }
  try {
    return read()
  } finally {
    tokenizer.rules = rules
  }
}

/** Reference titles cannot cross CommonMark paragraph boundaries. */
export function endsReferenceTitle(
  source: string,
  paragraph = marked.Lexer.rules.block.normal.paragraph,
) {
  blockScanCounters.calls++
  blockScanCounters.units += source.length
  if (
    /^[ \t]*(?:\r?\n|$)/.test(source) ||
    /^ {0,3}(?:=+|-+)[ \t]*(?:\r?\n|$)/.test(source)
  )
    return true
  if (!paragraphRule(paragraph)?.test(source)) return false
  if (
    paragraph !== marked.Lexer.rules.block.gfm.paragraph ||
    paragraphRule(marked.Lexer.rules.block.normal.paragraph)?.test(source)
  )
    return true
  // Match block precedence on container-relative text before checking cell counts.
  const end = source.indexOf('\n', source.indexOf('\n') + 1)
  const lines = end < 0 ? source : source.slice(0, end)
  return !tableTokenizer.code(lines) && !!tableTokenizer.table(lines)
}

export function lexMarkdown(source: string) {
  return marked.lexer(source, {
    ...marked.defaults,
    tokenizer: new BlockTokenizer(),
  })
}

export function parseMarkdown(source: string) {
  return marked.parse(source, {
    async: false,
    tokenizer: new BlockTokenizer(),
  })
}

export const blockMarkdown: MarkedExtension = {
  tokenizer: {
    fences(source) {
      return BlockTokenizer.prototype.fences.call(
        this,
        source,
        Object.getPrototypeOf(this).fences,
      )
    },
    code(source) {
      return BlockTokenizer.prototype.code.call(
        this,
        source,
        Object.getPrototypeOf(this).code,
      )
    },
    list(source) {
      return BlockTokenizer.prototype.list.call(
        this,
        source,
        Object.getPrototypeOf(this).list,
      )
    },
    blockquote(source) {
      return BlockTokenizer.prototype.blockquote.call(this, source, readQuote)
    },
    def(source) {
      return BlockTokenizer.prototype.def.call(
        this,
        source,
        Object.getPrototypeOf(this).def,
      )
    },
    lheading(source) {
      return BlockTokenizer.prototype.lheading.call(
        this,
        source,
        Object.getPrototypeOf(this).lheading,
      )
    },
    paragraph(source) {
      return BlockTokenizer.prototype.paragraph.call(
        this,
        source,
        Object.getPrototypeOf(this).paragraph,
      )
    },
  },
}

/** Container parsing and setext boundaries for plain Marked addons. */
export const blockContainers = {
  list: blockMarkdown.tokenizer!.list!,
  blockquote: blockMarkdown.tokenizer!.blockquote!,
  lheading(this: Tokenizer, source: string) {
    if (!lazyUnderlines.has(this)) return false as const
    return BlockTokenizer.prototype.lheading.call(this, source)
  },
}

// Let upstream construct tokens, including its version-specific newline behavior.
function blockToken<Result>(
  tokenizer: Tokenizer,
  name: 'lheading' | 'paragraph' | 'fences',
  source: string,
  parts: [string, ...string[]],
  read: (source: string) => Result,
): Result {
  const match = Object.assign(parts, { index: 0, input: source })
  const rule = /(?:)/
  rule.exec = () => match
  const rules = tokenizer.rules
  tokenizer.rules = {
    ...rules,
    block: { ...rules.block, [name]: rule },
  }
  try {
    return read.call(tokenizer, source)
  } finally {
    tokenizer.rules = rules
  }
}

type QuoteScope = {
  kind: 'quote' | 'list' | 'extension'
  depth: number
  indent: number
  next: number
  native: boolean
  columns: boolean
  last?: Token[]
}
// A nested quote's extent from its first scanned line, with each tab after its
// marker widened: `text` is the widened extent and the rest of the source, and
// `tabs` holds each widened line's start, its prefix end in `text` and the
// total width added through it.
type QuoteExtent = {
  from: number
  to: number
  text: string
  tabs: { at: number; end: number; added: number }[]
  next: number
}
type QuoteState = {
  base: number
  scope: QuoteScope
  frame?:
    | {
        source: string
        scope: QuoteScope
        scanned: number
        row: number
        tokens: Token[]
        extent?: QuoteExtent
      }
    | undefined
  origins: WeakMap<object, number>
  prefixes: Map<number, string>
  /** First quote level absent on a physical row: only paragraph text can continue there. */
  lazy: Map<number, number>
  extension?: { source: string; line: number } | undefined
}
const quoteFrames = new WeakMap<Tokenizer, QuoteState>()
function quoteLines(text: string, from = 0, to = text.length) {
  if (from >= to) return 0
  let count = 0
  for (
    let at = text.indexOf('\n', from);
    at >= 0 && at < to;
    at = text.indexOf('\n', at + 1)
  )
    count++
  return count
}
function quoteOrigin(state: QuoteState, source: string) {
  const frame = state.frame
  if (frame && frame.scope === state.scope) {
    const at = frame.source.length - source.length
    frame.row += quoteLines(frame.source, frame.scanned, at)
    frame.scanned = at
    return frame.row
  }
  return state.origins.get(state.scope.last!.at(-1)!)!
}
function quoteIndent(state: QuoteState, row: number, limit: number) {
  const raw = state.prefixes.get(row)
  if (!raw) return
  let column = state.base,
    depth = 0
  for (let at = 0; at < raw.length; at++) {
    const char = raw[at]!
    column += char === '\t' ? 4 - (column % 4) : 1
    if (char !== '>' || ++depth !== state.scope.depth) continue
    const cut =
      column +
      (raw[at + 1] === ' ' || raw[at + 1] === '\t' ? 1 : 0) +
      state.scope.indent
    let prefix = '',
      used = 0
    for (at++; at < raw.length && (raw[at] === ' ' || raw[at] === '\t'); at++) {
      const width = raw[at] === '\t' ? 4 - (column % 4) : 1
      const kept = column + width - Math.max(column, cut)
      if (kept > 0) {
        prefix +=
          raw[at] === '\t' && column >= cut && used >= limit
            ? '\t'
            : ' '.repeat(kept)
        used += kept
      }
      column += width
      if (used >= limit && column >= cut) {
        const end = raw.indexOf('>', at + 1)
        return prefix + raw.slice(at + 1, end < 0 ? undefined : end)
      }
    }
    return prefix
  }
}
// Interpret structural columns at block validation, preserving source body tabs.
function quoteInput(
  tokenizer: Tokenizer,
  source: string,
  line: number,
  limit = 4,
  columns = false,
) {
  const state = quoteFrames.get(tokenizer)
  if (!state || (!state.scope.native && !(columns && state.scope.columns)))
    return { text: source, offsets: [] as [number, number][] }
  let row = line,
    scanned = 0,
    added = 0
  const offsets: [number, number][] = []
  const text = source.replace(/^[ \t]+/gm, (prefix, at: number) => {
    row += quoteLines(source, scanned, at)
    scanned = at
    const normalized = quoteIndent(state, row, limit)
    if (normalized === undefined || normalized === prefix) return prefix
    added += normalized.length - prefix.length
    offsets.push([at + prefix.length + added, added])
    return normalized
  })
  return { text, offsets }
}

function quoteTab(
  state: QuoteState,
  row: number,
  depth: number,
  prefix: string,
) {
  let column = state.base,
    seen = 0
  for (const char of state.prefixes.get(row) ?? prefix) {
    column += char === '\t' ? 4 - (column % 4) : 1
    if (char === '>' && ++seen === depth) break
  }
  return 4 - (column % 4)
}
function quoteRaw(
  source: string,
  length: number,
  offsets: readonly [number, number][],
) {
  let extra = 0
  for (const [end, added] of offsets) {
    if (end > length) break
    extra = added
  }
  return source.slice(0, length - extra)
}
function quoteExtent(
  tokenizer: Tokenizer,
  state: QuoteState,
  source: string,
  line: number,
  from: number,
): QuoteExtent {
  const extent = quoteScan(tokenizer, source)?.extent() ?? ''
  const tabs: QuoteExtent['tabs'] = []
  const result = { from, to: from + extent.length, text: '', tabs, next: 0 }
  if (!extent.includes('\t')) return result
  const rule = tokenizer.rules.other.blockquoteSetextReplace2
  let row = line,
    scanned = 0,
    added = 0
  const text = RegExp.prototype[Symbol.replace].call(
    new RegExp(rule.source, rule.flags),
    extent,
    (prefix: string, at: number) => {
      if (!prefix.endsWith('\t')) return prefix
      row += quoteLines(extent, scanned, at)
      scanned = at
      const normalized =
        prefix.slice(0, -1) +
        ' '.repeat(quoteTab(state, row, state.scope.depth + 1, prefix))
      added += normalized.length - prefix.length
      tabs.push({ at, end: at + prefix.length + added, added })
      return normalized
    },
  )
  if (tabs.length) result.text = text + source.slice(extent.length)
  return result
}
function quoteExtensionInput(
  tokenizer: Tokenizer,
  state: QuoteState,
  source: string,
  line: number,
  tokens: Token[],
): { text: string; raw?: (length: number) => string } {
  if (
    !state.scope.columns ||
    !tokenizer.rules.other.blockquoteStart.test(source)
  )
    return { text: source }
  // A later quote line of the same extent ends at the same line, and widens
  // the same rows. Within one frame's own loop, reuse the extent instead of
  // scanning its rest again at every block and extension.
  const frame = state.frame
  const own =
    frame?.scope === state.scope &&
    frame.tokens === tokens &&
    !tokenizer.lexer.options.pedantic
      ? frame
      : undefined
  const at = own ? own.source.length - source.length : 0
  let extent = own?.extent
  if (
    !extent ||
    at < extent.from ||
    at >= extent.to ||
    (at !== extent.from && own!.source.charCodeAt(at - 1) !== 10)
  ) {
    extent = quoteExtent(tokenizer, state, source, line, at)
    if (own) own.extent = extent
  }
  const offset = at - extent.from
  const { tabs } = extent
  while (extent.next < tabs.length && tabs[extent.next]!.at < offset)
    extent.next++
  const first = extent.next
  if (first === tabs.length) return { text: source }
  const added = first ? tabs[first - 1]!.added : 0
  const start = offset + added
  return {
    text: extent.text.slice(start),
    raw: (length) => {
      let extra = 0
      for (
        let index = first;
        index < tabs.length && tabs[index]!.end - start <= length;
        index++
      )
        extra = tabs[index]!.added - added
      return source.slice(0, length - extra)
    },
  }
}

// Strip a quote level like Marked, widening a tab after the marker to its
// column and remembering depth-one prefixes with tabs for later column reads.
function quoteStrip(
  state: QuoteState,
  scope: QuoteScope,
  rules: Tokenizer['rules'],
) {
  const strip = new RegExp(
    rules.other.blockquoteSetextReplace2.source,
    rules.other.blockquoteSetextReplace2.flags,
  )
  Object.defineProperty(strip, Symbol.replace, {
    value: (text: string) => {
      let row = scope.next,
        scanned = 0
      const leading = /[ \t>]*/y
      return RegExp.prototype[Symbol.replace].call(
        strip,
        text,
        (prefix: string, at: number) => {
          row += quoteLines(text, scanned, at)
          scanned = at
          if (scope.depth === 1) {
            leading.lastIndex = at
            const head = leading.exec(text)![0]
            if (head.includes('\t')) state.prefixes.set(row, head)
          }
          if (!prefix.endsWith('\t') || !scope.columns) return ''
          return ' '.repeat(quoteTab(state, row, scope.depth, prefix) - 1)
        },
      )
    },
  })
  return strip
}

// Column state for a top-level quote, from physical row `next` of its source.
// `last` describes the tokens the reader already produced natively, so a
// nested re-read can still find the row of the token it replaces.
function installQuoteState(
  tokenizer: Tokenizer,
  next: number,
  last: { tokens: Token[]; token: Token | undefined; row: number | undefined },
  columns: boolean,
) {
  const scope: QuoteScope = {
    kind: 'quote',
    depth: 1,
    indent: 0,
    next,
    native: true,
    columns,
  }
  if (last.tokens.length) scope.last = last.tokens
  const state: QuoteState = {
    base: containerColumns.get(tokenizer) ?? 0,
    scope,
    origins: new WeakMap(),
    prefixes: new Map(),
    lazy: new Map(),
  }
  if (last.token && last.row !== undefined)
    state.origins.set(last.token, last.row)
  quoteFrames.set(tokenizer, state)
  const rules = tokenizer.rules,
    lexer = tokenizer.lexer,
    blockTokens = lexer.blockTokens,
    options = lexer.options
  tokenizer.rules = {
    ...rules,
    other: {
      ...rules.other,
      blockquoteSetextReplace2: quoteStrip(state, scope, rules),
    },
  }
  if (options.extensions?.block)
    lexer.options = {
      ...options,
      extensions: {
        ...options.extensions,
        block: options.extensions.block.map((read) =>
          quoteReader(function (
            this: ThisParameterType<typeof read>,
            source: string,
            tokens: Token[],
          ) {
            // Another lexer given these options, such as a definition's
            // bounding probe, reads text outside this quote's rows.
            if (this.lexer !== lexer) return read.call(this, source, tokens)
            const previous = state.extension
            const line = quoteOrigin(
              state,
              quoteSource?.raw === source ? quoteSource.source : source,
            )
            state.extension = { source, line }
            const input = quoteExtensionInput(
              tokenizer,
              state,
              source,
              line,
              tokens,
            )
            const previousQuote = quoteSource
            if (quoteSource?.raw === source && quoteSource.lexer === lexer)
              quoteSource = { ...quoteSource, input: input.text }
            try {
              const token = read.call(this, input.text, tokens)
              if (
                token &&
                isLeafBlock(token) &&
                (state.lazy.get(line) ?? Infinity) <= state.scope.depth
              )
                return
              if (token && input.raw) token.raw = input.raw(token.raw.length)
              return token
            } finally {
              quoteSource = previousQuote
              state.extension = previous
            }
          }, read),
        ),
      },
    }
  lexer.blockTokens = (...args) => {
    const previous = state.frame,
      parent = state.scope
    const recursive = previous?.scope === parent
    const extension = state.extension
    const quote =
      recursive &&
      extension &&
      rules.other.blockquoteStart.test(extension.source)
    const frameScope: QuoteScope = recursive
      ? {
          ...parent,
          kind: 'extension',
          native: false,
          columns: !!quote && parent.columns,
          depth: parent.depth + (quote ? 1 : 0),
          indent: quote ? 0 : parent.indent,
          next: extension ? extension.line + (quote ? 1 : 0) : 0,
        }
      : parent
    state.scope = frameScope
    const row = frameScope.next
    if (frameScope.kind === 'quote') frameScope.next += quoteLines(args[0]) + 1
    // Name the token list Marked passes to this frame's own block calls.
    args[1] ??= []
    state.frame = {
      source: args[0],
      scope: frameScope,
      scanned: 0,
      row,
      tokens: args[1],
    }
    try {
      const tokens = Reflect.apply(blockTokens, lexer, args)
      frameScope.last = tokens
      return tokens
    } finally {
      state.frame = previous
      state.scope = parent
    }
  }
  return () => {
    tokenizer.rules = rules
    lexer.blockTokens = blockTokens
    lexer.options = options
    quoteFrames.delete(tokenizer)
  }
}

/** Queue entries passed over to find task text, a deterministic complexity check. */
export const taskQueueCounters = { steps: 0 }

// Marked's task pass, except that each item strips the marker from its own
// queued text: Marked strips the last queued text that starts with a marker,
// which can belong to a later item's quote. Items queue their text in order,
// so one forward cursor from the list's first entry finds each one.
function readTasks(
  lexer: Lexer,
  list: Tokens.List,
  tasks: boolean[],
  rules: Tokenizer['rules']['other'],
  start: number,
) {
  const queue = lexer.inlineQueue
  let cursor = start
  list.items.forEach((item, index) => {
    const first = item.tokens[0]
    if (
      !tasks[index] ||
      (first?.type !== 'text' && first?.type !== 'paragraph')
    )
      return
    item.task = true
    item.text = item.text.replace(rules.listReplaceTask, '')
    first.raw = first.raw.replace(rules.listReplaceTask, '')
    first.text = first.text.replace(rules.listReplaceTask, '')
    while (cursor < queue.length && queue[cursor]!.tokens !== first.tokens) {
      taskQueueCounters.steps++
      cursor++
    }
    const own = queue[cursor]
    if (own) own.src = own.src.replace(rules.listReplaceTask, '')
    const marker = rules.listTaskCheckbox.exec(item.raw)
    if (!marker) return
    const box: Tokens.Checkbox = {
      type: 'checkbox',
      raw: marker[0] + ' ',
      checked: marker[0] !== '[ ]',
    }
    item.checked = box.checked
    if (!list.loose) item.tokens.unshift(box)
    else if ('tokens' in first && first.tokens) {
      first.raw = box.raw + first.raw
      first.text = box.raw + first.text
      first.tokens.unshift(box)
    } else
      item.tokens.unshift({
        type: 'paragraph',
        raw: box.raw,
        text: box.raw,
        tokens: [box],
      })
  })
}

export class BlockTokenizer extends Tokenizer {
  override list(source: string, read = Tokenizer.prototype.list) {
    const lazy = lazyContinuation(this.lexer, source)
    if (lazy) return lazy as unknown as Tokens.List
    return withQuoteScan(this, () =>
      withLeafBlocks(this, () =>
        BlockTokenizer.prototype.readList.call(this, source, read),
      ),
    )
  }

  private readList(
    source: string,
    read: typeof Tokenizer.prototype.list,
    physical?: BlockLines,
  ): ReturnType<Tokenizer['list']> {
    if (!this.rules.block.list.test(source)) return read.call(this, source)
    const enclosing = blockLinesOf.get(this)
    const sourceView =
      physical ??
      (enclosing
        ? relativeLines(
            source,
            enclosing,
            enclosing.source.length - source.length,
          )
        : sourceLines(source))
    const state = quoteFrames.get(this)
    const parent = state?.scope
    const origin = state && quoteOrigin(state, source)
    const scope = parent && { ...parent, kind: 'list' as const, next: origin! }
    const restart =
      state && parent?.kind === 'quote' && state.frame?.scope !== parent
    if (state && scope) state.scope = scope
    const rows: number[] = [],
      itemsAt: number[] = []
    let row = origin ?? 0,
      scanned = 0
    const rules = this.rules,
      columns: number[] = [],
      base = containerColumns.get(this) ?? 0
    const pattern = rules.block.lheading
    const nativeSetext =
      !this.options.pedantic &&
      (pattern === marked.Lexer.rules.block.normal.lheading ||
        pattern === marked.Lexer.rules.block.gfm.lheading)
    const lheading = nativeSetext
      ? new RegExp(pattern.source, pattern.flags)
      : pattern
    // Marked adds four source spaces to lazy underlines. Keep the bytes and
    // reject those heading candidates during item lexing instead.
    if (nativeSetext) lheading.test = () => false
    // Marked restarts its task marker search at the end of the inline queue
    // for every task item. Record the answers and strip with one cursor below.
    const isTask = rules.other.listIsTask,
      tasks: boolean[] = []
    const listIsTask = new RegExp(isTask.source, isTask.flags)
    listIsTask.test = (text) => {
      tasks.push(isTask.test(text))
      return false
    }
    this.rules = {
      ...rules,
      block: { ...rules.block, lheading },
      other: {
        ...rules.other,
        listIsTask,
        listItemRegex: (bullet) => {
          const rule = rules.other.listItemRegex(bullet),
            exec = rule.exec
          rule.exec = (text) => {
            const match = exec.call(rule, text)
            if (match) {
              itemsAt.push(source.length - text.length)
              if (scope) {
                const at = source.length - text.length
                row += quoteLines(source, scanned, at)
                scanned = at
                rows.push(row)
              }
              let column = base + match[1]!.length
              for (const char of /^[ \t]*/.exec(match[2]!)![0])
                column += char === '\t' ? 4 - (column % 4) : 1
              const padding = column - base - match[1]!.length
              const indent = padding > 4 ? 1 : padding || 1
              columns.push(base + match[1]!.length + indent)
            }
            return match
          }
          return rule
        },
      },
    }
    const listRules = this.rules
    const lexer = this.lexer,
      blockTokens = lexer.blockTokens
    let item = 0
    const nested: typeof blockTokens = (...args) => {
      this.rules = rules
      lexer.blockTokens = blockTokens
      const current = item++
      containerColumns.set(this, columns[current]!)
      if (scope) {
        scope.next = rows[current]!
        scope.indent = parent!.indent + columns[current]! - base
      }
      const previous = lazyUnderlines.get(this),
        previousLines = blockLinesOf.get(this),
        text = args[0],
        ends = nativeSetext
          ? lazySetextEnds(source, text, itemsAt[current]!)
          : new Set<number>()
      blockLinesOf.set(this, relativeLines(text, sourceView, itemsAt[current]!))
      if (ends.size) lazyUnderlines.set(this, { text, ends })
      else lazyUnderlines.delete(this)
      try {
        const read = () => Reflect.apply(blockTokens, lexer, args)
        args[1] ??= []
        return withTextMerges(this, text, args[1], read)
      } finally {
        if (previous) lazyUnderlines.set(this, previous)
        else lazyUnderlines.delete(this)
        if (previousLines) blockLinesOf.set(this, previousLines)
        else blockLinesOf.delete(this)
        containerColumns.set(this, base)
        lexer.blockTokens = nested
      }
    }
    lexer.blockTokens = nested
    const inlineLength = lexer.inlineQueue.length
    let cutoff = source.length
    let token: ReturnType<Tokenizer['list']>
    try {
      // Native lists end before a lazy custom opener after an empty item,
      // heading or fence. Retain opted opening lines in that item's forward
      // extent, even when their body later decides they are literal text.
      const starts = extensionLines(this).filter((start) => start.lazyItem)
      const firstMarker = rules.block.list.exec(source)![1]!.trim()
      const markerKind = (marker: string) =>
        /[.)]$/.test(marker) ? marker.at(-1) : marker
      const sameItem = (at: number) => {
        const text = source.slice(at)
        const marker = rules.block.list.exec(text)?.[1]?.trim()
        return (
          marker &&
          !rules.block.hr.test(text) &&
          markerKind(marker) === markerKind(firstMarker)
        )
      }
      let from = 0
      for (;;) {
        this.rules = listRules
        lexer.blockTokens = nested
        const firstColumn = columns.length
        const queued = lexer.inlineQueue.length
        const group = read.call(this, source.slice(from))
        if (group) readTasks(lexer, group, tasks, rules.other, queued)
        tasks.length = 0
        if (!group) break
        const bound = leafListEnd(
          group,
          source.slice(from),
          columns.slice(firstColumn),
          base,
        )
        if (bound < source.length - from) {
          cutoff = from + bound
          break
        }
        let end = from + group.raw.length
        let recovered = false
        const newline = /^[ \t]*\n/.exec(source.slice(end))
        let at = newline ? end + newline[0].length : -1
        const lineEnd = at < 0 ? -1 : source.indexOf('\n', at)
        const line =
          at < 0 ? '' : source.slice(at, lineEnd < 0 ? undefined : lineEnd)
        if (at >= 0 && starts.some((start) => start.test(line + '\n'))) {
          const tailAt = at
          const last = group.items.at(-1)!
          const column = columns.at(-1)!
          const width = column - base
          const added: string[] = []
          let blank = false
          for (; at < source.length; ) {
            const lf = source.indexOf('\n', at)
            const stop = lf < 0 ? source.length : lf
            const raw = source.slice(at, stop)
            let skip = 0,
              col = base
            while (col < column && (raw[skip] === ' ' || raw[skip] === '\t'))
              col += raw[skip++] === '\t' ? 4 - (col % 4) : 1
            const indented = col >= column
            if (!indented && raw.trim() && (blank || lazyItemEnd.test(raw)))
              break
            added.push(indented ? raw.slice(skip) : raw)
            blank = !raw.trim()
            end = stop
            at = lf < 0 ? source.length : lf + 1
          }
          const follows = at < source.length && sameItem(at)
          const addition =
            added.join('\n').trimEnd() + (blank && follows ? '\n' : '')
          let itemFrom = from
          for (const entry of group.items) {
            itemFrom = source.indexOf(entry.raw, itemFrom)
            if (entry !== last) itemFrom += entry.raw.length
          }
          last.raw = source.slice(itemFrom, follows ? at : end)
          if (!follows) last.raw = last.raw.trimEnd()
          last.text += '\n' + addition
          const next = scope?.next,
            indent = scope?.indent,
            top = lexer.state.top,
            previousLines = blockLinesOf.get(this)
          this.rules = rules
          lexer.blockTokens = blockTokens
          containerColumns.set(this, column)
          if (scope) {
            scope.next = rows.at(-1)! + quoteLines(source, itemFrom, tailAt)
            scope.indent = parent!.indent + width
          }
          blockLinesOf.set(this, relativeLines(addition, sourceView, tailAt))
          lexer.state.top = false
          try {
            last.tokens.push(
              ...Reflect.apply(blockTokens, lexer, [addition, []]),
            )
          } finally {
            lexer.state.top = top
            if (previousLines) blockLinesOf.set(this, previousLines)
            else blockLinesOf.delete(this)
            containerColumns.set(this, base)
            lexer.blockTokens = nested
            if (scope) {
              scope.next = next!
              scope.indent = indent!
            }
          }
          group.raw = source.slice(from, follows ? at : end)
          if (!follows) group.raw = group.raw.trimEnd()
          if (follows && blank) group.loose = true
          recovered = true
          end = follows ? at : from + group.raw.length
        }
        if (!token) token = group
        else {
          token.items.push(...group.items)
          token.loose ||= group.loose
        }
        token.raw = source.slice(0, end).trimEnd()
        if (!recovered || end >= source.length || !sameItem(end)) break
        from = end
      }
      if (token?.loose)
        for (const entry of token.items) {
          entry.loose = true
          for (const child of entry.tokens)
            if (child.type === 'text') child.type = 'paragraph'
        }
      if (token && state) {
        state.origins.set(token, origin!)
        if (restart) parent!.next = origin! + quoteLines(token.raw)
      }
    } finally {
      this.rules = rules
      lexer.blockTokens = blockTokens
      containerColumns.set(this, base)
      if (state && parent) state.scope = parent
    }
    if (cutoff < source.length) {
      lexer.inlineQueue.length = inlineLength
      return BlockTokenizer.prototype.readList.call(
        this,
        source.slice(0, cutoff),
        read,
        sourceView,
      )
    }
    return token
  }

  override blockquote(source: string, read = readQuote) {
    return withQuoteScan(this, () =>
      withLeafBlocks(this, () => {
        const quote = read.call(this, source)
        if (!quote) return quote
        const previous = quoteSource
        quoteSource = { raw: quote.raw, source, quote, lexer: this.lexer }
        try {
          return extendQuote(quote, this.lexer)
        } finally {
          quoteSource = previous
        }
      }),
    )
  }

  override fences(source: string, read = Tokenizer.prototype.fences) {
    return withFenceRules(this, () => {
      const state = quoteFrames.get(this)
      if (!state?.scope.columns) return read.call(this, source)
      const match = this.rules.block.fences.exec(source)
      const indent =
        match &&
        this.rules.other.indentCodeCompensation.exec(match[0])?.[1]?.length
      if (!match) return read.call(this, source)
      // Expand only the columns consumed by the opening fence's indentation.
      const body = quoteInput(
        this,
        match[3] ?? '',
        quoteOrigin(state, source) + 1,
        indent ?? 0,
        true,
      )
      const parts = Array.from(match) as [string, ...string[]]
      parts[3] = body.text
      return blockToken(this, 'fences', source, parts, read)
    })
  }

  override code(source: string, read = Tokenizer.prototype.code) {
    const state = quoteFrames.get(this)
    if (!state?.scope.native) return read.call(this, source)
    const match = this.rules.block.code.exec(source)
    if (!match) return read.call(this, source)
    const normalized = quoteInput(this, match[0], quoteOrigin(state, source))
    const token = read.call(this, normalized.text)
    if (token)
      token.raw = quoteRaw(source, token.raw.length, normalized.offsets)
    return token
  }

  override def(source: string, read = Tokenizer.prototype.def) {
    return withDefinitionRules(this, source, () =>
      BlockTokenizer.prototype.readDefinition.call(this, source, read),
    )
  }

  private readDefinition(
    source: string,
    read: typeof Tokenizer.prototype.def,
  ): ReturnType<Tokenizer['def']> {
    let token = read.call(this, source)
    const title = token?.title && this.rules.block.def.exec(token.raw)?.[3]
    if (title && token) {
      const from = token.raw.lastIndexOf(title)
      let boundary = from + title.length
      // A definition can hold block syntax even inside a list's text context.
      const top = this.lexer.state.top
      this.lexer.state.top = true
      try {
        // Extension starts are candidates; only a real block ends the title.
        for (const start of this.options.extensions?.startBlock ?? []) {
          for (let offset = 0; offset < title.length; ) {
            const at = start.call({ lexer: this.lexer }, title.slice(offset))
            if (typeof at !== 'number' || at < 0) break
            offset += at
            if (
              this.options.extensions?.block?.some((read) =>
                read.call(
                  { lexer: this.lexer },
                  source.slice(from + offset),
                  [],
                ),
              )
            ) {
              boundary = Math.min(boundary, from + offset)
              break
            }
            offset++
          }
        }
      } finally {
        this.lexer.state.top = top
      }
      const line = source.lastIndexOf('\n', from - 1) + 1
      const state = quoteFrames.get(this)
      let physicalLine = state
        ? quoteOrigin(state, source) + quoteLines(source, 0, line)
        : 0
      for (let at = line; at < boundary; ) {
        // Include the first title line and the delimiter after its closing line.
        // Only this line and the next can establish a table interruption.
        const end = source.indexOf('\n', at)
        const next = end < 0 ? -1 : source.indexOf('\n', end + 1)
        if (
          endsReferenceTitle(
            quoteInput(
              this,
              source.slice(at, next < 0 ? undefined : next),
              physicalLine,
              4,
              true,
            ).text,
            this.rules.block.paragraph,
          )
        ) {
          boundary = at
          break
        }
        if (end < 0) break
        at = end + 1
        physicalLine++
      }
      if (boundary < from + title.length)
        token = read.call(this, source.slice(0, boundary))
    }
    if (token && !token.title) {
      // The failed optional title still belongs to the definition's paragraph.
      const indent = /^\n[ \t]+(?=["'(])/.exec(source.slice(token.raw.length))
      if (indent) token.raw += indent[0]
    }
    return token
  }

  override lheading(source: string, read = Tokenizer.prototype.lheading) {
    const pattern = this.rules.block.lheading
    let rule = setextRules.get(pattern)
    if (!rule) {
      const [start, body] = pattern.source.split('((?:.|\\n(?!')
      if (!start || !body) return read.call(this, source)
      const [interrupt, underline] = body.split('))+?)\\n')
      if (!interrupt || !underline) return read.call(this, source)
      rule = {
        start: new RegExp(start),
        candidate: new RegExp(`\\n(?:(${underline})|${interrupt})`, 'g'),
      }
      setextRules.set(pattern, rule)
    }
    if (!rule.start.test(source)) return
    // Stop at the first underline or interruption without a frame per character.
    blockScanCounters.calls++
    const frame = this.options.pedantic ? undefined : setextFrames.get(this)
    const from = frame ? frame.source.length - source.length : 0
    let candidate = frame?.candidates.get(pattern)
    if (candidate === undefined || (candidate && candidate.index < from)) {
      rule.candidate.lastIndex = from
      const scanned = frame?.source ?? source,
        lazy = lazyUnderlines.get(this)
      candidate = rule.candidate.exec(scanned)
      if (lazy?.text === scanned)
        while (
          candidate?.[1] &&
          lazy.ends.has(scanned.length - candidate.index - 1)
        ) {
          rule.candidate.lastIndex = candidate.index + 1
          candidate = rule.candidate.exec(scanned)
        }
      blockScanCounters.units += candidate
        ? candidate.index + candidate[0].length - from
        : source.length
      frame?.candidates.set(pattern, candidate)
    }
    const index = candidate ? candidate.index - from : 0
    if (!candidate?.[1] || !index) return
    const text = source.slice(source.indexOf('\n'), index + 1)
    if (extensionLines(this).some((line) => line.test(text))) return
    if (frame) {
      if (frame.invalid === undefined || frame.invalid < from) {
        invalidSetext.lastIndex = from
        const invalid = invalidSetext.exec(frame.source)
        frame.invalid = invalid?.index ?? frame.source.length
        blockScanCounters.units += frame.invalid - from
      }
      if (frame.invalid < candidate.index) return
    } else {
      blockScanCounters.units += index
      if (/[\r\u2028\u2029]/.test(source.slice(0, index))) return
    }
    return blockToken(
      this,
      'lheading',
      source,
      [
        source.slice(0, index + candidate[0].length),
        source.slice(0, index),
        candidate[2] as string,
      ],
      read,
    )
  }

  override paragraph(source: string, read = Tokenizer.prototype.paragraph) {
    let end = source.indexOf('\n')
    // One physical line needs no repeated continuation match.
    if (end < 0) return read.call(this, source)
    if (!end) return
    const firstLine = end
    const interrupt = paragraphRule(this.rules.block.paragraph)
    if (!interrupt) return read.call(this, source)
    while (end < source.length) {
      const from = end + 1
      if (
        from === source.length ||
        source.charCodeAt(from) === 10 ||
        interrupt.test(source.slice(from))
      )
        break
      const newline = source.indexOf('\n', from)
      end = newline < 0 ? source.length : newline
    }
    if (end === firstLine) return read.call(this, source)
    const text = source.slice(0, end)
    return blockToken(this, 'paragraph', source, [text, text], read)
  }
}
