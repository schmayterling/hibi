import { type MarkedExtension, marked, type Token, Tokenizer } from 'marked'
import {
  extendQuote,
  leafListEnd,
  quoteReader,
  withLeafBlocks,
} from './marked-leaf-blocks.ts'

// Keep each parser's block grammar, but scan lines without a backtracking frame
// per character or continuation line. Equivalence tests guard the rule delimiters.
const setextRules = new WeakMap<RegExp, { start: RegExp; candidate: RegExp }>()
const paragraphRules = new WeakMap<RegExp, RegExp>()
// Tabs keep their physical columns when a list removes its content indent.
const containerColumns = new WeakMap<Tokenizer, number>()

// Candidate calls and source spans, including title interruption windows.
export const blockScanCounters = { calls: 0, units: 0 }

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
      return BlockTokenizer.prototype.blockquote.call(
        this,
        source,
        Object.getPrototypeOf(this).blockquote,
      )
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

/** Only container overrides, for addons used with a plain Marked instance. */
export const blockContainers = {
  list: blockMarkdown.tokenizer!.list!,
  blockquote: blockMarkdown.tokenizer!.blockquote!,
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
type QuoteState = {
  base: number
  scope: QuoteScope
  frame?:
    | { source: string; scope: QuoteScope; scanned: number; row: number }
    | undefined
  origins: WeakMap<object, number>
  prefixes: Map<number, string>
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
      if (used >= limit) {
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
function quoteExtensionInput(
  tokenizer: Tokenizer,
  state: QuoteState,
  source: string,
  line: number,
) {
  const offsets: [number, number][] = []
  if (
    !state.scope.columns ||
    !tokenizer.rules.other.blockquoteStart.test(source)
  )
    return { text: source, offsets }
  const match = tokenizer.rules.block.blockquote.exec(source)
  if (!match?.[0].includes('\t')) return { text: source, offsets }
  const rule = tokenizer.rules.other.blockquoteSetextReplace2
  let row = line,
    scanned = 0,
    added = 0
  const text = RegExp.prototype[Symbol.replace].call(
    new RegExp(rule.source, rule.flags),
    match[0],
    (prefix: string, at: number) => {
      if (!prefix.endsWith('\t')) return prefix
      row += quoteLines(match[0], scanned, at)
      scanned = at
      const normalized =
        prefix.slice(0, -1) +
        ' '.repeat(quoteTab(state, row, state.scope.depth + 1, prefix))
      added += normalized.length - prefix.length
      offsets.push([at + prefix.length + added, added])
      return normalized
    },
  )
  return {
    text: offsets.length ? text + source.slice(match[0].length) : source,
    offsets,
  }
}

export class BlockTokenizer extends Tokenizer {
  override list(source: string, read = Tokenizer.prototype.list) {
    return withLeafBlocks(this, () =>
      BlockTokenizer.prototype.readList.call(this, source, read),
    )
  }

  private readList(
    source: string,
    read: typeof Tokenizer.prototype.list,
  ): ReturnType<Tokenizer['list']> {
    if (!this.rules.block.list.test(source)) return read.call(this, source)
    const state = quoteFrames.get(this)
    const parent = state?.scope
    const origin = state && quoteOrigin(state, source)
    const scope = parent && { ...parent, kind: 'list' as const, next: origin! }
    const restart =
      state && parent?.kind === 'quote' && state.frame?.scope !== parent
    if (state && scope) state.scope = scope
    const rows: number[] = []
    let row = origin ?? 0,
      scanned = 0
    const rules = this.rules,
      columns: number[] = [],
      base = containerColumns.get(this) ?? 0
    this.rules = {
      ...rules,
      other: {
        ...rules.other,
        listItemRegex: (bullet) => {
          const rule = rules.other.listItemRegex(bullet),
            exec = rule.exec
          rule.exec = (text) => {
            const match = exec.call(rule, text)
            if (match) {
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
      try {
        return Reflect.apply(blockTokens, lexer, args)
      } finally {
        containerColumns.set(this, base)
        lexer.blockTokens = nested
      }
    }
    lexer.blockTokens = nested
    const inlineLength = lexer.inlineQueue.length
    let cutoff = source.length
    let token: ReturnType<Tokenizer['list']>
    try {
      token = read.call(this, source)
      if (token) cutoff = leafListEnd(token, source, columns, base)
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
      )
    }
    return token
  }

  override blockquote(source: string, read = Tokenizer.prototype.blockquote) {
    return withLeafBlocks(this, () => {
      const quote = BlockTokenizer.prototype.readBlockquote.call(
        this,
        source,
        read,
      )
      return quote && extendQuote(quote, this.lexer)
    })
  }

  private readBlockquote(
    source: string,
    read: typeof Tokenizer.prototype.blockquote,
  ) {
    const match = this.rules.block.blockquote.exec(source)
    if (!match) return read.call(this, source)
    const previousState = quoteFrames.get(this)
    if (!previousState && !match[0].includes('\t'))
      return read.call(this, source)
    const line = previousState ? quoteOrigin(previousState, source) : 0
    const previousScope = previousState?.scope
    const scope: QuoteScope = {
      kind: 'quote',
      depth: (previousScope?.depth ?? 0) + 1,
      indent: 0,
      next: line,
      native: previousScope?.native ?? true,
      columns: previousScope?.columns ?? true,
    }
    const state: QuoteState = previousState ?? {
      base: containerColumns.get(this) ?? 0,
      scope,
      origins: new WeakMap(),
      prefixes: new Map(),
    }
    state.scope = scope
    const rules = this.rules,
      lexer = this.lexer,
      blockTokens = lexer.blockTokens,
      options = lexer.options
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
    this.rules = {
      ...rules,
      other: { ...rules.other, blockquoteSetextReplace2: strip },
    }
    if (!previousState) {
      quoteFrames.set(this, state)
      const tokenizer = this
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
                const previous = state.extension
                const line = quoteOrigin(state, source)
                state.extension = { source, line }
                const input = quoteExtensionInput(
                  tokenizer,
                  state,
                  source,
                  line,
                )
                try {
                  const token = read.call(this, input.text, tokens)
                  if (token && input.offsets.length)
                    token.raw = quoteRaw(
                      source,
                      token.raw.length,
                      input.offsets,
                    )
                  return token
                } finally {
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
        if (frameScope.kind === 'quote')
          frameScope.next += quoteLines(args[0]) + 1
        state.frame = { source: args[0], scope: frameScope, scanned: 0, row }
        try {
          const tokens = Reflect.apply(blockTokens, lexer, args)
          frameScope.last = tokens
          return tokens
        } finally {
          state.frame = previous
          state.scope = parent
        }
      }
    }
    try {
      const token = read.call(this, source)
      if (token) {
        state.origins.set(token, line)
        if (!previousState) token.raw = source.slice(0, token.raw.length)
      }
      return token
    } finally {
      this.rules = rules
      if (previousScope) state.scope = previousScope
      if (!previousState) {
        lexer.blockTokens = blockTokens
        lexer.options = options
        quoteFrames.delete(this)
      }
    }
  }

  override fences(source: string, read = Tokenizer.prototype.fences) {
    const state = quoteFrames.get(this)
    if (!state?.scope.columns) return read.call(this, source)
    const match = this.rules.block.fences.exec(source)
    const indent =
      match &&
      this.rules.other.indentCodeCompensation.exec(match[0])?.[1]?.length
    if (!match || !indent) return read.call(this, source)
    // Only the indent consumed by a backtick opening needs expansion.
    const body = quoteInput(
      this,
      match[3] ?? '',
      quoteOrigin(state, source) + 1,
      indent,
      true,
    )
    const parts = Array.from(match) as [string, ...string[]]
    parts[3] = body.text
    return blockToken(this, 'fences', source, parts, read)
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
        candidate: new RegExp(`\\n(?:(${underline})|${interrupt})`),
      }
      setextRules.set(pattern, rule)
    }
    if (!rule.start.test(source)) return
    // Stop at the first underline or interruption without a frame per character.
    blockScanCounters.calls++
    const candidate = rule.candidate.exec(source)
    blockScanCounters.units += candidate
      ? candidate.index + candidate[0].length
      : source.length
    if (!candidate?.[1] || !candidate.index) return
    blockScanCounters.units += candidate.index
    if (/[\r\u2028\u2029]/.test(source.slice(0, candidate.index))) return
    return blockToken(
      this,
      'lheading',
      source,
      [
        source.slice(0, candidate.index + candidate[0].length),
        source.slice(0, candidate.index),
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
