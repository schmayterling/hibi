import type { Input, PartialParse } from '@lezer/common'
import type {
  BlockContext,
  Element,
  InlineContext,
  Line,
  MarkdownConfig,
} from '@lezer/markdown'
import { readAhead } from '../../shared/chunked-markdown.ts'
import { blockMath } from './syntax.ts'

/*
 * Math syntax for the formatted view. It decides like the math addon's Marked
 * tokenizers (./syntax.ts) and the source outline: `$…$` inside a line, and
 * `$$…$$` blocks that start a line, also inside quotes and lists. A `$$` line
 * is math only when its closing `$$` follows within the formula limit; other
 * `$$` lines stay paragraph text.
 */

/** UTF-16 units a formula may have, as in ./syntax.ts. */
const formulaLimit = 10_000

const isTerminator = (code: number) =>
  code === 10 || code === 13 || code === 0x2028 || code === 0x2029

/** Positions the inline math scan examined, for complexity tests. */
export const inlineMathWork = { positions: 0 }

/**
 * The end of inline math opened by the `$` at `open`, or -1, as the inline
 * tokenizer's regular expression matches. It searches depth first in the
 * expression's order: after each body unit the lazy body tries to close, and
 * a `\x` pair comes before a plain backslash. A position that cannot reach a
 * closing is remembered, so each is explored once, the search stops at the
 * first closing, and runs of backslashes cost linear time instead of the
 * expression's backtracking.
 */
export function inlineMathEnd(text: string, open: number, end = text.length) {
  const start = open + 1
  const first = text.charCodeAt(start)
  if (start >= end || first === 36 || first === 10) return -1
  const dead = new Set<number>()
  // Frames: where a body unit starts, and which alternative comes next.
  const units = [start],
    tried = [0]
  while (units.length) {
    const top = units.length - 1
    const at = units[top]!
    const code = text.charCodeAt(at)
    let next = -1
    if (tried[top] === 0) {
      tried[top] = 1
      if (code === 92 && at + 1 < end && !isTerminator(text.charCodeAt(at + 1)))
        next = at + 2
    }
    if (next < 0 && tried[top] === 1) {
      tried[top] = 2
      if (at < end && code !== 36 && code !== 10) next = at + 1
    }
    if (next < 0) {
      units.pop()
      tried.pop()
      dead.add(at)
      continue
    }
    if (dead.has(next)) continue
    inlineMathWork.positions++
    if (
      next < end &&
      text.charCodeAt(next) === 36 &&
      (next + 1 >= end || text.charCodeAt(next + 1) !== 36)
    ) {
      const latex = text.slice(start, next)
      return latex.length > formulaLimit || latex.trim() !== latex
        ? -1
        : next + 1
    }
    units.push(next)
    tried.push(0)
  }
  return -1
}

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

/** `$…$` inside a line, as `InlineMath` with `MathMark` delimiters. */
export const inlineMathSyntax: MarkdownConfig = {
  defineNodes: ['InlineMath', 'MathMark'],
  parseInline: [
    {
      name: 'InlineMath',
      parse(cx: InlineContext, next: number, pos: number) {
        if (next !== 36) return -1
        const end = inlineMathEnd(cx.text, pos - cx.offset)
        if (end < 0) return -1
        const to = cx.offset + end
        return cx.addElement(
          cx.elt('InlineMath', pos, to, [
            cx.elt('MathMark', pos, pos + 1),
            cx.elt('MathMark', to - 1, to),
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
      endLeaf: (cx, line) => line.next === 36 && decide(cx, line) !== null,
    },
  ],
  wrap,
}
