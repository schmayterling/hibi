import type { Input, PartialParse } from '@lezer/common'
import type {
  BlockContext,
  Element,
  InlineContext,
  Line,
  MarkdownConfig,
} from '@lezer/markdown'
import { readAhead } from '../../shared/chunked-markdown.ts'
import {
  type Closers,
  formulaLimit,
  inlineDisplayMathEnd,
  inlineMathEnd,
} from './inline-display.ts'
import { blockMath } from './syntax.ts'

export { inlineMathEnd }

/*
 * Math syntax for the formatted view. It decides like the math addon's Marked
 * tokenizers (./syntax.ts) and the source outline: `$…$` and `$$…$$` inside a
 * line, and `$$…$$` blocks that start a line, also inside quotes and lists. A
 * `$$` line is math only when its closing `$$` follows within the formula
 * limit; other `$$` lines stay paragraph text.
 */

/**
 * The input of the parse that is running, so the block parser can read past
 * the current line, and past the parsed range, as a whole-document parse does.
 */
let current: Input | null = null
const wrap = (inner: PartialParse, input: Input): PartialParse => ({
  get parsedPos() {
    return inner.parsedPos
  },
  get stoppedAt() {
    return inner.stoppedAt
  },
  stopAt: (pos) => inner.stopAt(pos),
  advance() {
    const outer = current
    current = input
    try {
      return inner.advance()
    } finally {
      current = outer
    }
  },
})

/** The text of the line starting at `pos`. */
function rawLine(input: Input, pos: number) {
  let text = ''
  while (pos < input.length) {
    const chunk = input.chunk(pos)
    if (input.lineChunks) return chunk === '\n' ? text : text + chunk
    const eol = chunk.indexOf('\n')
    if (eol >= 0) return text + chunk.slice(0, eol)
    text += chunk
    pos += chunk.length
  }
  return text
}

/** How later lines continue the containers of a `$$` line: quote markers, list item columns. */
type Level = { quote: true } | { quote: false; column: number }

const space = (code: number) => code === 32 || code === 9
const nextColumn = (column: number, code: number) =>
  code === 9 ? column + 4 - (column % 4) : column + 1

function containerLevels(cx: BlockContext, line: Line): Level[] {
  const names: string[] = []
  for (let depth = 1; depth < cx.depth; depth++)
    names.push(cx.parentType(depth).name)
  const levels: Level[] = []
  const { text } = line
  let pos = 0,
    column = 0
  const skip = (to: number) => {
    for (; pos < to; pos++) column = nextColumn(column, text.charCodeAt(pos))
  }
  const skipSpace = () => {
    let to = pos
    while (to < line.basePos && space(text.charCodeAt(to))) to++
    skip(to)
  }
  names.forEach((name, index) => {
    if (name === 'Blockquote') {
      skipSpace()
      if (text[pos] === '>')
        skip(pos + (space(text.charCodeAt(pos + 1)) ? 2 : 1))
      levels.push({ quote: true })
    } else if (name === 'ListItem') {
      if (
        !names
          .slice(index + 1)
          .some((other) => other === 'Blockquote' || other === 'ListItem')
      ) {
        pos = line.basePos
        column = line.baseIndent
      } else {
        // An item opened on this line has its marker before the next container's.
        const marker = /^[ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]+/.exec(
          text.slice(pos, line.basePos),
        )
        skip(pos + (marker?.[0].length ?? 0))
        skipSpace()
      }
      levels.push({ quote: false, column })
    }
  })
  return levels
}

/** Where a later line's content starts inside the containers, or -1 when they end before it. */
function contentStart(levels: readonly Level[], text: string) {
  let pos = 0,
    column = 0
  for (const level of levels) {
    if (level.quote) {
      while (space(text.charCodeAt(pos)))
        column = nextColumn(column, text.charCodeAt(pos++))
      if (text[pos] !== '>') return -1
      pos++
      column++
      if (space(text.charCodeAt(pos)))
        column = nextColumn(column, text.charCodeAt(pos++))
    } else {
      if (/^[ \t]*$/.test(text.slice(pos))) return text.length
      while (column < level.column && space(text.charCodeAt(pos)))
        column = nextColumn(column, text.charCodeAt(pos++))
      if (column < level.column) return -1
    }
  }
  return pos
}

/** A display block found from its opening line, in the text of its lines inside their containers. */
type Found = {
  /** Lines after the opening one, through the closing one: their offset in the text and content start. */
  lines: { offset: number; base: number }[]
  /** Offsets of the body and of the closing `$$`. */
  body: number
  close: number
}

/**
 * Whether the `$$` at `line.pos` opens display math. Reads the next lines
 * inside the same containers until the first `$$` outside a backslash pair,
 * or past the formula limit, which is as far as the tokenizer can match, and
 * lets it decide.
 */
function findBlock(
  cx: BlockContext,
  line: Line,
  input: Input,
): { found: Found | null; read: number } {
  // The parsed range can end inside this line; decisions read the document.
  const opening = rawLine(input, cx.parsedPos)
  const indent = opening.slice(line.basePos, line.pos)
  /** Where the lines read after the opening one end, if any were read. */
  let read = -1
  if (
    indent.length > 3 ||
    /[^ ]/.test(indent) ||
    !opening.startsWith('$$', line.pos)
  )
    return { found: null, read }
  const levels = cx.depth > 1 ? containerLevels(cx, line) : []
  let text = opening.slice(line.pos)
  const lines: Found['lines'] = []
  let next = cx.parsedPos + opening.length + 1
  let i = 2
  while (space(text.charCodeAt(i))) i++
  // The body starts after the opening line's spaces, or after its line break.
  let body = i < text.length ? i : -1
  scan: for (;;) {
    while (i < text.length) {
      if (body >= 0 && i - body > formulaLimit) break scan
      const code = text.charCodeAt(i)
      if (code === 36 && text.charCodeAt(i + 1) === 36) break scan
      i += code === 92 ? 2 : 1
    }
    if (next > input.length) break
    const raw = rawLine(input, next)
    read = Math.min(input.length, next + raw.length + 1)
    const base = levels.length ? contentStart(levels, raw) : 0
    if (base < 0) break
    text += '\n'
    if (body < 0) i = body = text.length
    lines.push({ offset: text.length, base })
    text += raw.slice(base)
    next += raw.length + 1
  }
  const token = blockMath(text)
  if (!token) return { found: null, read }
  const close = token.raw.trimEnd().length - 2
  return {
    found: {
      lines: lines.filter((entry) => entry.offset <= close),
      body,
      close,
    },
    read,
  }
}

/** A display block over its lines, with their quote markers, as `BlockMath`. */
function parseBlock(cx: BlockContext, line: Line, found: Found) {
  const from = cx.lineStart + line.pos
  const marks: Element[] = [cx.elt('MathMark', from, from + 2)]
  const texts: { from: number; to: number }[] = []
  const add = (start: number, end: number) => {
    const last = texts.at(-1)
    if (last?.to === start) last.to = end
    else if (end > start) texts.push({ from: start, to: end })
  }
  // Document position of offset `offset` on the current line is `base`.
  let base = from,
    offset = 0
  const at = (target: number) => base + target - offset
  for (let index = 0; ; index++) {
    const end = cx.lineStart + line.text.length
    const start = Math.max(base, at(found.body))
    if (index === found.lines.length) {
      // A parsed range that ends before the closing `$$` leaves the block open.
      const close = at(found.close)
      add(start, Math.min(close, end))
      if (close + 2 <= end) marks.push(cx.elt('MathMark', close, close + 2))
      cx.nextLine()
      break
    }
    add(start, end)
    const entry = found.lines[index]!
    if (!cx.nextLine() || line.basePos !== entry.base) break
    // Line breaks inside the body are body text.
    if (at(found.body) <= end) add(end, end + 1)
    marks.push(...line.markers)
    base = cx.lineStart + line.basePos
    offset = entry.offset
  }
  const children = [
    ...marks,
    ...texts.map((text) => cx.elt('MathText', text.from, text.to)),
  ].sort((a, b) => a.from - b.from)
  cx.addElement(cx.elt('BlockMath', from, cx.prevLineEnd(), children))
}

/** The last decision, shared by the paragraph interruption check and the block parser. */
let last: {
  input: Input
  at: number
  depth: number
  found: Found | null
  read: number
} | null = null
function decide(cx: BlockContext, line: Line) {
  const at = cx.parsedPos + line.pos
  if (!current) return null
  // A lazy line is checked inside its quote, then parsed after the quote ends.
  if (last?.input !== current || last.at !== at || last.depth !== cx.depth)
    last = {
      input: current,
      at,
      depth: cx.depth,
      ...findBlock(cx, line, current),
    }
  // The decision read later lines: an edit before their end parses this
  // line's chunk again, as a whole-document parse would decide anew.
  if (last.read >= 0) readAhead(current, last.read)
  return last.found
}

/**
 * Per parse input, where the later lines of paragraphs in quotes and list
 * items start their content: their markers read as spaces inline, but
 * Obsidian strips them, so a `$` there can close math.
 */
const contentStarts = new WeakMap<Input, Set<number>>()

/** A paragraph's closer searches, so each closer is read about once. */
type Scans = {
  closers: Closers
  /** Per delimiter character: the first run at or after `from` that can close, or -1. */
  runs: Map<number, { from: number; at: number }>
  /** Per section position, the first `]` at or after it that no `[` after it matches, or -1; read once, when first needed. */
  brackets: Int32Array | null
  /** The section's other delimiters so far, by index in its parts, each with the runs open after it. */
  delimiters: {
    at: number
    part: Delimiter
    open: ReadonlyMap<number, number>
  }[]
  /** Link and image starts so far, by index in its parts. */
  starts: { at: number; part: Delimiter }[]
  /** How many parts were read. */
  seen: number
}
type Delimiter = { from: number; side: number }
const scansOf = new WeakMap<InlineContext, Scans>()
function scans(cx: InlineContext) {
  let found = scansOf.get(cx)
  if (!found) {
    found = {
      closers: { from: -1, at: -1 },
      runs: new Map(),
      brackets: null,
      delimiters: [],
      starts: [],
      seen: 0,
    }
    scansOf.set(cx, found)
  }
  return found
}

/** Parts and units the precedence check read, for complexity tests. */
export const precedenceWork = { reads: 0 }

// As @lezer/markdown decides which delimiter runs can close.
const punctuation = /[\p{S}\p{P}]/u
const blank = /\s|^$/
function canClose(cx: InlineContext, char: number, from: number, to: number) {
  const before = cx.slice(from - 1, from),
    after = cx.slice(to, to + 1)
  const sBefore = blank.test(before),
    sAfter = blank.test(after)
  const pBefore = punctuation.test(before),
    pAfter = punctuation.test(after)
  const left = !sAfter && (!pAfter || sBefore || pBefore)
  const right = !sBefore && (!pBefore || sAfter || pAfter)
  return right && (char !== 95 || !left || pAfter)
}

/** The first run of `char` at or after `from` that can close emphasis or strikethrough, or -1. */
function runClose(cx: InlineContext, char: number, from: number) {
  const runs = scans(cx).runs
  const known = runs.get(char)
  if (known && known.from <= from && (known.at < 0 || known.at >= from))
    return known.at
  let found = -1
  for (let at = from; at < cx.end; at++) {
    precedenceWork.reads++
    const code = cx.char(at)
    if (code === 92) at++
    else if (code === char) {
      let end = at + 1
      while (cx.char(end) === char) end++
      if ((char !== 126 || end - at === 2) && canClose(cx, char, at, end)) {
        found = at
        break
      }
      at = end - 1
    }
  }
  runs.set(char, { from, at: found })
  return found
}

/** The first `]` at or after `from` that no `[` after `from` matches, or -1. */
function bracketClose(cx: InlineContext, from: number) {
  const state = scans(cx)
  if (!state.brackets) {
    // That `]` is the next one at the depth `from` has, so one pass back
    // from the end answers every position.
    const length = cx.end - cx.offset
    precedenceWork.reads += length
    const depth = new Int32Array(length),
      closes = new Uint8Array(length)
    for (let at = 0, level = 0; at < length; at++) {
      depth[at] = level
      const code = cx.text.charCodeAt(at)
      if (code === 92 && at + 1 < length) depth[++at] = level
      else if (code === 91) level++
      else if (code === 93) {
        closes[at] = 1
        level--
      }
    }
    const next = new Map<number, number>()
    state.brackets = new Int32Array(length)
    for (let at = length - 1; at >= 0; at--) {
      if (closes[at]) next.set(depth[at]!, cx.offset + at)
      state.brackets[at] = next.get(depth[at]!) ?? -1
    }
  }
  return state.brackets[from - cx.offset] ?? -1
}

/**
 * Where emphasis, strikethrough or a link still open before `pos` closes
 * first after it, or the section's end. As in Obsidian and exports, the
 * syntax that opened first wins, so math cannot run past that closer.
 */
function openSyntaxEnd(cx: InlineContext, pos: number) {
  // ponytail: @lezer/markdown keeps its pending delimiters internal and
  // resolves them only at the section's end; this pairs them in order,
  // without the rule of three, so a run that rule leaves unpaired still
  // ends math.
  const parts = (cx as unknown as { parts: readonly unknown[] }).parts
  const state = scans(cx)
  // A finished link replaces the parts from its start on: forget what was
  // read there and read on from it. Each part is read about once.
  let from = state.seen
  for (const list of [state.delimiters, state.starts])
    for (
      let last = list.at(-1);
      last && parts[last.at] !== last.part;
      last = list.at(-1)
    ) {
      precedenceWork.reads++
      list.pop()
      // A link start that could not open is cleared in place.
      if (parts[last.at] !== null) from = Math.min(from, last.at)
    }
  let open = state.delimiters.at(-1)?.open ?? new Map<number, number>()
  for (let at = from; at < parts.length; at++) {
    precedenceWork.reads++
    const part = parts[at] as Delimiter | null
    if (typeof part?.side !== 'number') continue
    const char = cx.char(part.from)
    if (char === 91 || char === 33) {
      state.starts.push({ at, part })
      continue
    }
    const count = open.get(char) ?? 0
    const next =
      part.side & 2 && count ? count - 1 : part.side & 1 ? count + 1 : count
    if (next === count) continue
    open = new Map(open).set(char, next)
    state.delimiters.push({ at, part, open })
  }
  state.seen = parts.length
  let end = cx.end
  for (const [char, count] of open)
    if (count) {
      const close = runClose(cx, char, pos)
      if (close >= 0) end = Math.min(end, close)
    }
  // Starts before a finished link lose their side; they and cleared ones
  // never open again.
  let start = state.starts.at(-1)
  while (start && (parts[start.at] !== start.part || !start.part.side)) {
    precedenceWork.reads++
    state.starts.pop()
    start = state.starts.at(-1)
  }
  if (start) {
    const close = bracketClose(cx, pos)
    if (close >= 0) end = Math.min(end, close)
  }
  return end
}

/**
 * `$…$` and `$$…$$` inside a paragraph, the second as display math, as
 * `InlineMath` with `MathMark` delimiters. Math that continues on a later
 * line of its paragraph is `InlineMathLines`, which the formatted view lays
 * out whole.
 */
export const inlineMathSyntax: MarkdownConfig = {
  defineNodes: ['InlineMath', 'InlineMathLines', 'MathMark'],
  parseInline: [
    {
      name: 'InlineMath',
      parse(cx: InlineContext, next: number, pos: number) {
        if (next !== 36) return -1
        const display = cx.char(pos + 1) === 36
        const starts = current && contentStarts.get(current)
        const end = display
          ? inlineDisplayMathEnd(cx.text, pos - cx.offset)
          : inlineMathEnd(
              cx.text,
              pos - cx.offset,
              scans(cx).closers,
              starts ? (at) => starts.has(cx.offset + at) : undefined,
            )
        if (end < 0 || cx.offset + end > openSyntaxEnd(cx, pos)) return -1
        const to = cx.offset + end,
          mark = display ? 2 : 1
        // A pair over the formula limit stays text, delimiters included, so
        // its closer opens nothing.
        if (to - pos - 2 * mark > formulaLimit) return to
        const lines = cx.slice(pos + mark, to - mark).includes('\n')
        return cx.addElement(
          cx.elt(lines ? 'InlineMathLines' : 'InlineMath', pos, to, [
            cx.elt('MathMark', pos, pos + mark),
            cx.elt('MathMark', to - mark, to),
          ]),
        )
      },
    },
  ],
}

/**
 * `$$…$$` blocks, as `BlockMath` with `MathMark` delimiters and the formula
 * as `MathText` inside the lines' containers.
 */
export const blockMathSyntax: MarkdownConfig = {
  defineNodes: [{ name: 'BlockMath', block: true }, 'MathMark', 'MathText'],
  parseBlock: [
    {
      name: 'BlockMath',
      before: 'FencedCode',
      parse(cx, line) {
        if (line.next !== 36) return false
        const found = decide(cx, line)
        if (!found) return false
        parseBlock(cx, line, found)
        return true
      },
      endLeaf(cx, line) {
        if (line.baseIndent && current) {
          let starts = contentStarts.get(current)
          if (!starts) {
            starts = new Set()
            contentStarts.set(current, starts)
          }
          starts.add(cx.lineStart + line.basePos)
        }
        return line.next === 36 && decide(cx, line) !== null
      },
    },
  ],
  wrap,
}
