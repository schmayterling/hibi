import type { Input, PartialParse } from '@lezer/common'
import type {
  BlockContext,
  Element,
  InlineContext,
  Line,
  MarkdownConfig,
} from '@lezer/markdown'
import { blockInput, readAhead } from '../../shared/chunked-markdown.ts'
import { blockMathClose, blockMathRun } from './grammar.ts'
import {
  type Closers,
  formulaLimit,
  inlineDisplayMathEnd,
  inlineMathEnd,
} from './inline-display.ts'
import { contentStart, type Level } from './seams.ts'

export { inlineMathEnd }

/*
 * Math syntax for the formatted view. It decides like the math addon's Marked
 * tokenizers (./syntax.ts) and the source outline: `$…$` and `$$…$$` inside a
 * line, and `$$…$$` blocks that start a line, also inside quotes and lists. A
 * `$$` line opens a block as in Obsidian, which runs to its closing line or
 * to the end of its quote, list item or note; over the formula limit, the
 * block keeps its lines and shows as text.
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

/** How many contexts, the document included, the line read last continues. */
const lineDepth = (line: Line) =>
  (line as typeof line & { depth: number }).depth

/** Lezer's open contexts; a list item's value is its content column past its base. */
const contexts = (cx: BlockContext) =>
  (cx as unknown as { stack: readonly { from: number; value: number }[] }).stack

/** The containers of a line inside the first `depth` contexts. */
function containerLevels(cx: BlockContext, depth: number): Level[] {
  const levels: Level[] = []
  for (let index = 1; index < depth; index++) {
    const name = cx.parentType(index).name
    if (name === 'Blockquote') levels.push({ quote: true })
    else if (name === 'ListItem')
      levels.push({ quote: false, value: contexts(cx)[index]!.value })
  }
  return levels
}

/**
 * A display block decided on its opening line: the length of its opening `$`
 * run, and whether its formula is over the limit, which shows it as text.
 */
type Found = { size: number; over: boolean }

const blankText = (text: string, from: number) =>
  /^[ \t\r]*$/.test(text.slice(from))
/** Where a list item's lazy text ends: at a blank line or the next item. */
const lazyEnd = (text: string) =>
  blankText(text, 0) || /^[ \t]*(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/.test(text)

const listMarker = /^(?:[-+*]|\d{1,9}([.)]))(?=[ \t]|$)/

/**
 * Whether `text` starts the next item of the list around the innermost item
 * of the first `depth` contexts: its marker of the same kind, as far into its
 * line, after the containers around the list.
 */
function nextItem(
  cx: BlockContext,
  depth: number,
  levels: readonly Level[],
  input: Input,
  text: string,
) {
  // ponytail: lezer keeps where a context starts internal; read the item's
  // marker there, within 256 units of its line start.
  const item = contexts(cx)[depth - 1]
  if (!item || contentStart(levels.slice(0, -1), text) < 0) return false
  const before = input.read(Math.max(0, item.from - 256), item.from)
  const at = before.length - 1 - before.lastIndexOf('\n')
  if (at > 255) return false
  const mine = listMarker.exec(input.read(item.from, item.from + 11))
  const theirs = /^[ \t>]*$/.test(text.slice(0, at))
    ? listMarker.exec(text.slice(at))
    : null
  return !!mine && !!theirs && (mine[1] ?? mine[0]) === (theirs[1] ?? theirs[0])
}

/**
 * Whether the `$` run at `line.pos` opens display math, as Obsidian 1.13.7
 * reads block math (./grammar.ts blockMath): a line must follow inside the
 * same containers, where an item's trailing blank lines do not count. Reads
 * the next lines up to the closing one or past the formula limit.
 */
function findBlock(
  cx: BlockContext,
  line: Line,
  input: Input,
  depth: number,
  item: boolean,
): { found: Found | null; read: number } {
  // The parsed range can end inside this line; decisions read the document.
  const opening = rawLine(input, cx.parsedPos)
  const indent = opening.slice(line.basePos, line.pos)
  /** Where the lines read after the opening one end, if any were read. */
  let read = -1
  const size =
    indent.length > 3 || /[^ ]/.test(indent)
      ? 0
      : blockMathRun(opening, line.pos)
  if (!size) return { found: null, read }
  const levels = depth > 1 ? containerLevels(cx, depth) : []
  const inItem = levels.at(-1)?.quote === false
  let at = line.pos + size
  while (opening.charCodeAt(at) === 32) at++
  let body = opening.length - at,
    follows = false,
    blanks = false
  for (let next = cx.parsedPos + opening.length + 1; next <= input.length; ) {
    const raw = rawLine(input, next)
    read = Math.min(input.length, next + raw.length + 1)
    // After a list item, Obsidian reads a lazy line as the item's text, which
    // a blank line or the next item ends.
    if (item && !follows && lazyEnd(raw)) break
    const base = levels.length ? contentStart(levels, raw) : 0
    if (base < 0) {
      // Obsidian keeps an item's blank lines when the list's next item follows.
      follows ||= blanks && inItem && nextItem(cx, depth, levels, input, raw)
      break
    }
    blanks ||= blankText(raw, base)
    follows ||= !inItem || !blankText(raw, base)
    const close = blockMathClose(raw, base, raw.length, size)
    body += 1 + (close < 0 ? raw.length : close) - base
    if (close >= 0 || (follows && body > formulaLimit)) break
    next += raw.length + 1
  }
  return {
    found: follows ? { size, over: body > formulaLimit } : null,
    read,
  }
}

/**
 * A display block over its lines, with their quote markers, as `BlockMath`;
 * the formula is `MathText` unless it is over the limit.
 */
function parseBlock(cx: BlockContext, line: Line, found: Found) {
  const from = cx.lineStart + line.pos
  const marks: Element[] = [cx.elt('MathMark', from, from + found.size)]
  const texts: { from: number; to: number }[] = []
  const add = (start: number, end: number) => {
    if (found.over) return
    const last = texts.at(-1)
    if (last?.to === start) last.to = end
    else if (end > start) texts.push({ from: start, to: end })
  }
  add(
    cx.lineStart + line.skipSpace(line.pos + found.size),
    cx.lineStart + line.text.length,
  )
  // As fenced code, the block ends with its quote or list item.
  while (cx.nextLine() && lineDepth(line) >= cx.depth) {
    // Line breaks inside the body are body text.
    if (texts.length) add(cx.lineStart - 1, cx.lineStart)
    marks.push(...line.markers)
    const close = blockMathClose(
      line.text,
      line.basePos,
      line.text.length,
      found.size,
    )
    const start = cx.lineStart + line.basePos
    if (close < 0) {
      add(start, cx.lineStart + line.text.length)
      continue
    }
    add(start, cx.lineStart + close)
    let end = close
    while (line.text.charCodeAt(end) === 36) end++
    marks.push(cx.elt('MathMark', cx.lineStart + close, cx.lineStart + end))
    cx.nextLine()
    break
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
  item: boolean
  found: Found | null
  read: number
} | null = null
function decide(cx: BlockContext, line: Line, depth = cx.depth, item = false) {
  const at = cx.parsedPos + line.pos
  if (!current) return null
  if (
    last?.input !== current ||
    last.at !== at ||
    last.depth !== depth ||
    last.item !== item
  )
    last = {
      input: current,
      at,
      depth,
      item,
      ...findBlock(cx, line, blockInput(current), depth, item),
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
        if (line.next !== 36) return false
        // A lazy line is decided where it opens a block, after the
        // containers it leaves end; one leaving a list item also as its text.
        const depth = lineDepth(line)
        if (depth >= cx.depth) return decide(cx, line) !== null
        const item = cx.parentType(depth).name !== 'Blockquote'
        return decide(cx, line, depth, item) !== null
      },
    },
  ],
  wrap,
}
