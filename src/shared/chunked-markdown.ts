import {
  type Input,
  NodeProp,
  NodeType,
  Parser,
  type PartialParse,
  type SyntaxNode,
  Tree,
  type TreeFragment,
} from '@lezer/common'
import type { MarkdownParser } from '@lezer/markdown'

/**
 * Chunks start at top-level block starts of an exact parse. Parsing a chunk
 * alone yields the whole-document nodes for its range, so an edit reparses
 * one chunk and a viewport change parses only the chunks it reveals.
 *
 * A top-level block that spans a scan window is continued in bounded windows
 * from replay points: lines whose parse, after the opening lines of the
 * blocks around them, recreates the parser state at that line. A block
 * longer than `giantBlock` gets inner nodes only in a window around the
 * viewport. Every step of a parse therefore reads a bounded range, apart from
 * lines longer than a window, which lezer reads whole.
 */

/** Whole lines: `from` starts a line and `to` follows its newline. */
type Lines = { from: number; to: number }

/**
 * Parsing the lines in `head` and then the text from `at` recreates the
 * parser state at `at`: `head` holds the opening lines of the blocks around
 * `at` that start before it. `lists` counts the items before `at` of the
 * ordered lists around it, by list start; `retype` marks a point inside a
 * paragraph or table, whose last line decides its type.
 */
type Replay = {
  at: number
  head: readonly Lines[]
  lists: readonly { from: number; items: number }[]
  retype?: boolean
}

/** A paragraph, table, or closed fence a window may cut, and its last line's start. */
type End = { from: number; last: number }

/**
 * A block that spans scan windows: longer than the giant size, or still being
 * continued. Positions are relative to its chunk.
 */
type Giant = {
  /** Start of the block node. */
  start: number
  /**
   * Replay points in document order. A top-level leaf block has one, set by
   * its opening lines, which holds at any of its later lines.
   */
  points: readonly Replay[]
  leaf: boolean
  /** What a top-level leaf block's opening lines decide for its later lines. */
  key: string | null
  /** A paragraph or table becomes a setext heading at its end, so it is never left open. */
  retype: boolean
  /** Its renderers read its text, so only its opening and last lines get inner nodes. */
  opaque: boolean
  /** Leaf blocks inside this block that need their last line across windows, in document order. */
  ends: readonly End[]
  /** The block's end, or null when it continues past the chunk into unscanned text. */
  end: number | null
  /**
   * No replay point holds past the chunk, so the text after it shows as
   * written up to a line that must start a top-level block.
   */
  stuck?: Stuck
}

/**
 * The quote (`>`) or list a stuck block leaves open at its end: the list's
 * marker (`-`, `+`, `*`, `.` or `)`) and the content column of its last item.
 * No marker when it is unknown.
 */
type Stuck = { marker: string | null; width: number }

/** Reading the text after a stuck block for the line where parsing resumes. */
type Lost = Stuck & {
  /** Next position to read. */
  at: number
  /** Start of the line `at` is inside, read in an earlier window. */
  line: number | null
  /** The last line read was blank. */
  blank: boolean
  /** The blank lines just read hold a carriage return, which html blocks do not end at. */
  cr: boolean
  /** A line was checked against blank lines without one. */
  lf: boolean
  /** In some reading, a line since the block left it, so any line may be at the top level. */
  top: boolean
}

/**
 * Lines of a giant block with inner nodes: the opening lines it was parsed
 * with, and a window around the viewport.
 */
type Window = {
  head: readonly Lines[]
  from: number
  to: number
}

/** How far decisions made in a chunk or group read ahead, relative to its start. */
type Reach = {
  reach?: number
  /** Decisions on a chunk's first line, which also decide where the chunk before it ends. */
  edge?: number
}

type ChunkInfo =
  | ({ kind: 'root' | 'group'; parsed: number; giants: number } & Reach)
  | ({ kind: 'parsed' | 'pending' | 'tail' | 'plain' } & Reach)
  | ({ kind: 'giant'; block: Giant; window: Window | null } & Reach)
type GiantInfo = Extract<ChunkInfo, { kind: 'giant' }>

const chunkInfo = new NodeProp<ChunkInfo>({ perNode: true })

/** The parse reading each input, for decisions that read ahead. */
const readers = new WeakMap<Input, (to: number) => void>()

/**
 * For a Markdown extension whose decision on the line being parsed read the
 * input past that line: report that it read `input`, the input a `wrap`
 * receives, up to `to`. The chunk the decision was made in, and the chunk
 * before it when it was made on the chunk's first line, are parsed again
 * once an edit lands before `to`.
 */
export function readAhead(input: Input, to: number) {
  readers.get(input)?.(to)
}

/** The furthest reach of these chunks, relative to the first one's start. */
function reachOf(chunks: readonly Tree[], positions: readonly number[]) {
  let reach = -1
  for (let i = 0; i < chunks.length; i++) {
    const own = chunks[i]!.prop(chunkInfo)?.reach
    if (own !== undefined) reach = Math.max(reach, positions[i]! + own)
  }
  return reach < 0 ? {} : { reach }
}

/**
 * On the top node of a window into a giant block: for ordered lists that
 * start before the window, by list start relative to the top node, the items
 * between the list's first item, which the window parses with its opening
 * lines, and the window's first item.
 */
export const listWindow = new NodeProp<ReadonlyMap<number, number>>({
  perNode: true,
})

/** Leaf blocks whose last line decides their type. */
const retypes = new Set([
  'Paragraph',
  'Table',
  'SetextHeading1',
  'SetextHeading2',
])

/** Items of a list node in a tree starting at `base` whose lines start in `from`-`to`. */
function itemsIn(list: SyntaxNode, base: number, from: number, to: number) {
  let count = 0
  for (let item = list.firstChild; item; item = item.nextSibling)
    if (item.name === 'ListItem' && base + item.from >= from) {
      if (base + item.from >= to) break
      count++
    }
  return count
}

/** Deterministic work counters for scale tests. */
export type ChunkedMarkdownProbe = {
  /** Chunks and windows parsed with inline content. */
  parsedChunks: number
  /** UTF-16 units parsed with inline content. */
  parsedUnits: number
  /** UTF-16 units covered by block-only boundary scans. */
  scannedUnits: number
  /** Chunk and group nodes reused from a previous tree. */
  reusedNodes: number
  /** Group nodes created for the new tree. */
  builtGroups: number
  /** Worker adoption diagnostics; absent until a worker is attached. */
  adoptionDeclined?: number
  adoptedRecords?: number
  adoptionSlices?: number
}

export type ChunkedMarkdownOptions = {
  /** Preferred chunk length in UTF-16 units. */
  chunkSize?: number
  /** Chunks per group node. */
  groupSize?: number
  /** Blocks longer than this get inner nodes only near the viewport. */
  giantBlock?: number
  /** Node names whose blocks longer than two chunks need inner nodes only for their opening and last lines. */
  opaque?: ReadonlySet<string>
  probe?: ChunkedMarkdownProbe
}

/** A visible document range. */
export type Demand = { from: number; to: number }

/** A parse that can report its progress and follow the viewport while it runs. */
export interface ChunkedPartialParse extends PartialParse {
  /** The verified chunks so far, with the rest unscanned. */
  snapshot(): Tree
  /** A changed block context is still being continued beyond verified chunks. */
  readonly scanningContext: boolean
  setDemand(demand: Demand): void
}

type Old = {
  fragment: TreeFragment
  root: Tree
  /** Old nodes ending at or before this position keep their next two lines. */
  safe: number
  /** Where the next change starts: decisions that read this far no longer hold. */
  cut: number
}

/** A block being continued window by window; positions are absolute. */
type Continuation = {
  from: number
  start: number
  /** Replay points so far; the last one starts the next window. */
  points: Replay[]
  leaf: boolean
  key: string | null
  retype: boolean
  opaque: boolean
  ends: End[]
  /** A line start inside the block where the next window begins. */
  frontier: number
  span: number
}

type Found = Pick<Continuation, 'leaf' | 'key' | 'retype' | 'frontier'> & {
  point: Replay
}

type Work =
  | { kind: 'scan'; from: number; span: number; parse: PartialParse }
  | { kind: 'parse'; from: number; to: number; parse: PartialParse }
  | {
      kind: 'continue'
      block: Continuation
      base: number
      to: number
      units: number
      parse: PartialParse
    }
  | {
      kind: 'window'
      from: number
      to: number
      block: Giant
      window: Window
      point: Replay
      base: number
      units: number
      parse: PartialParse
    }

/** Inner parser steps per outer step, so the host can yield inside a long range. */
const innerSteps = 256

/** The start of the line containing `pos`. */
function lineStart(input: Input, pos: number) {
  if (pos === 0 || input.read(pos - 1, pos) === '\n') return pos
  for (let at = pos, size = 64; at > 0; size = Math.min(size * 4, 4096)) {
    const from = Math.max(0, at - size)
    const index = input.read(from, at).lastIndexOf('\n')
    if (index >= 0) return from + index + 1
    at = from
  }
  return 0
}

/** The end of the line containing `pos`: its newline, or the input end. */
function lineEnd(input: Input, pos: number) {
  for (
    let at = pos, size = 256;
    at < input.length;
    size = Math.min(size * 4, 65536)
  ) {
    const to = Math.min(input.length, at + size)
    const index = input.read(at, to).indexOf('\n')
    if (index >= 0) return at + index
    at = to
  }
  return input.length
}

/** The start of the blank lines that end at line start `pos`, not before line start `floor`. */
function blankRunStart(input: Input, pos: number, floor: number) {
  let start = pos
  // Characters before `at` are examined backwards; pos - 1 ends the previous line.
  let at = pos - 1
  if (at > floor && !/[ \t\n]/.test(input.read(at - 1, at))) return start
  while (at > floor) {
    const from = Math.max(floor, at - 64)
    const text = input.read(from, at)
    let i = text.length - 1
    while (i >= 0 && (text[i] === ' ' || text[i] === '\t')) i--
    if (i >= 0) {
      if (text[i] !== '\n') return start
      start = from + i + 1
      at = from + i
    } else at = from
  }
  // Only spaces and tabs remain back to `floor`, which starts a line.
  return at === floor ? floor : start
}

/**
 * The end of the lines that set a leaf block's state for all its later lines,
 * after their newline, or null for blocks whose later lines need more context.
 */
function openingEnd(input: Input, name: string, from: number) {
  let lines: number
  switch (name) {
    case 'FencedCode':
    case 'CodeBlock':
    case 'HTMLBlock':
    case 'CommentBlock':
    case 'ProcessingInstructionBlock':
      lines = 1
      break
    // The second line decides whether a paragraph is a table; a setext
    // heading is a paragraph until its last line.
    case 'Table':
    case 'Paragraph':
    case 'Task':
    case 'SetextHeading1':
    case 'SetextHeading2':
      lines = 2
      break
    default:
      return null
  }
  let end = lineStart(input, from)
  // A link reference definition is decided within its label's 999
  // characters and the two lines after them.
  if (
    (name === 'Paragraph' || name === 'Task' || name.startsWith('Setext')) &&
    input.read(from, from + 1) === '['
  )
    end = lineEnd(input, Math.min(input.length, from + 1000)) + 1
  for (let i = 0; i < lines; i++) end = lineEnd(input, end) + 1
  return end
}

/**
 * What the opening lines of a top-level leaf block decide for its later
 * lines: blocks with the same key continue the same way from any later line.
 */
function stateKey(input: Input, name: string, from: number) {
  const first = input.read(from, lineEnd(input, from))
  switch (name) {
    case 'Paragraph':
    case 'SetextHeading1':
    case 'SetextHeading2': {
      // A table parser, inert after the second line, keeps a later table
      // from interrupting the paragraph. Escaped pipes do not count.
      for (let i = 0; i < first.length; i++) {
        if (first[i] === '|') return 'pipe'
        if (first[i] === '\\') i++
      }
      return 'plain'
    }
    case 'Table':
    case 'CodeBlock':
      return name
    case 'FencedCode':
      return `${name} ${/^[`~]+/.exec(first)?.[0]}`
    default:
      return `${name} ${first}`
  }
}

/** Index of the child starting exactly at `pos`, or -1. */
function childAt(tree: Tree, pos: number) {
  let low = 0,
    high = tree.positions.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1,
      at = tree.positions[middle]!
    if (at === pos) return middle
    if (at < pos) low = middle + 1
    else high = middle - 1
  }
  return -1
}

/** Index of the last child starting at or before `pos`, or -1. */
function childBefore(tree: Tree, pos: number) {
  let low = 0,
    high = tree.positions.length - 1,
    found = -1
  while (low <= high) {
    const middle = (low + high) >> 1
    if (tree.positions[middle]! <= pos) {
      found = middle
      low = middle + 1
    } else high = middle - 1
  }
  return found
}

/** The chunk of a chunked root that contains `pos`. */
function chunkAround(root: Tree, pos: number) {
  const groupIndex = childBefore(root, pos)
  if (groupIndex < 0) return null
  const group = root.children[groupIndex] as Tree
  const groupFrom = root.positions[groupIndex]!
  const index = childBefore(group, pos - groupFrom)
  if (index < 0) return null
  const chunk = group.children[index] as Tree
  const start = groupFrom + group.positions[index]!
  return pos < start + chunk.length ? { start, chunk } : null
}

const counts = (tree: Tree) => {
  const info = tree.prop(chunkInfo)
  if (info && 'parsed' in info) return info
  return {
    parsed:
      info?.kind === 'parsed' || (info?.kind === 'giant' && info.window)
        ? 1
        : 0,
    giants: info?.kind === 'giant' ? 1 : 0,
  }
}

/** Unscanned text follows this chunk. */
const endsOpen = (chunk: Tree | undefined) => {
  const info = chunk?.prop(chunkInfo)
  return (
    info?.kind === 'tail' ||
    info?.kind === 'plain' ||
    (info?.kind === 'giant' && info.block.end === null)
  )
}

/** Where a giant block's covered head ends: its opening lines for a leaf block. */
const head = (block: Giant) => (block.leaf ? block.points[0]!.at : 0)

/** Whether a giant chunk at `start` has inner nodes for all of `from`-`to`. */
function giantCovers(
  info: GiantInfo,
  start: number,
  length: number,
  from: number,
  to: number,
) {
  if (!info.window) return false
  if (info.block.opaque) return true
  const a = Math.max(from, start + head(info.block)),
    b = Math.min(to, start + length)
  return (
    a >= b || (start + info.window.from <= a && b <= start + info.window.to)
  )
}

const shift = (point: Replay, by: number): Replay => ({
  ...point,
  at: point.at + by,
  head: point.head.map((range) => ({
    from: range.from + by,
    to: range.to + by,
  })),
  lists: point.lists.map((list) => ({
    from: list.from + by,
    items: list.items,
  })),
})

const shiftEnd = (end: End, by: number): End => ({
  from: end.from + by,
  last: end.last + by,
})

/** The last noted leaf block starting at or before `pos`. */
function endAround(ends: readonly End[], pos: number) {
  let low = 0,
    high = ends.length - 1,
    found: End | null = null
  while (low <= high) {
    const middle = (low + high) >> 1
    if (ends[middle]!.from <= pos) {
      found = ends[middle]!
      low = middle + 1
    } else high = middle - 1
  }
  return found
}

/** A line that is blank inside its quotes and lists. */
const blank = /^[ \t>\r]*$/

/**
 * A line's indentation column and the quote or list marker it starts with
 * within three columns, with the content column of that list item (null
 * after a tab); null for a blank line.
 */
function shapeOf(text: string) {
  let column = 0,
    index = 0
  for (; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code === 32) column++
    else if (code === 9) column += 4 - (column % 4)
    else break
  }
  const rest = text.slice(index)
  if (rest === '' || rest === '\r') return null
  const none = { column, marker: null, width: null }
  if (column > 3) return none
  if (rest[0] === '>') return { column, marker: '>', width: null }
  // A thematic break is not a list item.
  if (/^([-*_])(?:[ \t]*\1){2,}[ \t]*\r?$/.test(rest)) return none
  const match = /^(?:[-+*]|\d{1,9}[.)])(?=[ \t]|\r?$)/.exec(rest)
  if (!match) return none
  const after = rest.slice(match[0].length)
  const spaces = /^ */.exec(after)![0].length
  const start = column + match[0].length
  return {
    column,
    marker: match[0].at(-1)!,
    width:
      after[spaces] === '\t'
        ? null
        : spaces > 4 || /^ *\r?$/.test(after)
          ? start + 1
          : start + spaces,
  }
}

/** The blocks around the line at `pos` and where they start, in a tree starting at `base`. */
function blocksAround(input: Input, tree: Tree, base: number, pos: number) {
  const end = lineEnd(input, pos)
  let key = ''
  for (
    let node: SyntaxNode | null = tree.resolveInner(
      end - base,
      end > pos ? -1 : 1,
    );
    node;
    node = node.parent
  )
    if (node.type.is('Block') && !node.type.isTop)
      // A setext heading is a paragraph until its last line, which a
      // replay of two lines may not reach.
      key += `${node.name.startsWith('Setext') ? 'Paragraph' : node.name} ${base + node.from},`
  return key
}

class ChunkedParse implements ChunkedPartialParse {
  stoppedAt: number | null = null
  private pos = 0
  private groups: Tree[] = []
  private groupPositions: number[] = []
  private chunks: Tree[] = []
  private chunkPositions: number[] = []
  private groupStart = 0
  private groupParsed = 0
  private groupGiants = 0
  private olds: Old[]
  private work: Work | null = null
  private tree: Tree | null = null
  private snapshotTree: Tree | null = null
  private snapshotKey = ''
  /** Units scanned after the demand region while looking for a resync point. */
  private resynced = 0
  /** A stuck block came before this position, and parsing has not found where it ends. */
  private lost: Lost | null = null
  /** The inner parse running now, whose line a read-ahead decision is on. */
  private reading: PartialParse | null = null
  /** Read-ahead decisions not yet in a chunk: the line each was on and how far it read. */
  private reads: { at: number; to: number }[] = []

  private parser: ChunkedMarkdownParser
  private input: Input
  private view: Demand | null

  constructor(
    parser: ChunkedMarkdownParser,
    input: Input,
    fragments: readonly TreeFragment[],
    view: Demand | null,
    prefix = 0,
  ) {
    this.parser = parser
    this.input = input
    this.view = view
    const length = input.length
    // A prefix that is not Markdown, such as frontmatter, is one opaque node.
    if (prefix > 0 && parser.frontmatter) {
      this.addChunk(
        new Tree(
          NodeType.none,
          [new Tree(parser.frontmatter, [], [], prefix)],
          [0],
          prefix,
          [[chunkInfo, { kind: 'parsed' }]],
        ),
      )
      this.pos = prefix
    }
    this.olds = fragments.flatMap((fragment) => {
      if (fragment.tree.prop(chunkInfo)?.kind !== 'root') return []
      let safe = length,
        cut = Number.POSITIVE_INFINITY
      // A fragment cut by a change at the end of the text ends at its end too.
      if (fragment.to < length || fragment.openEnd) {
        cut = fragment.to
        // A node may end differently if one of its next two lines changed.
        safe = lineStart(input, fragment.to)
        for (let i = 0; i < 2 && safe > 0; i++)
          safe = lineStart(input, safe - 1)
      }
      return [{ fragment, root: fragment.tree, safe, cut }]
    })
    readers.set(input, (to) => {
      this.reads.push({ at: this.reading?.parsedPos ?? this.pos, to })
    })
  }

  get parsedPos() {
    return this.pos
  }

  get scanningContext() {
    const work = this.work
    return (
      work?.kind === 'continue' ||
      this.lost !== null ||
      (work?.kind === 'scan' &&
        !this.hints(work.from, work.from + work.span).size)
    )
  }

  stopAt(pos: number) {
    this.stoppedAt = pos
  }

  setDemand(demand: Demand) {
    if (this.view) this.view = demand
  }

  advance(): Tree | null {
    if (this.tree) return this.tree
    for (let heavy = 0; ; ) {
      if (this.work) {
        if (heavy++) return null
        if (!this.continueWork()) return null
        continue
      }
      if (this.pos >= this.input.length) return this.finish()
      if (this.lost) {
        if (heavy++) return null
        this.resync()
        continue
      }
      if (this.reuse()) continue
      if (!this.begin()) return this.finish()
    }
  }

  snapshot(): Tree {
    if (this.tree) return this.tree
    const length = this.input.length
    // A block being continued keeps its verified lines, so an edit resumes it.
    const work = this.work
    const open =
      work?.kind === 'continue' && work.block.frontier > work.block.from
        ? work.block
        : null
    const rest = open ? open.frontier : this.pos
    const key = `${this.groups.length} ${this.chunks.length} ${this.pos} ${rest}`
    // Unchanged progress keeps the same tree, so the view does no work for it.
    if (this.snapshotTree && this.snapshotKey === key) return this.snapshotTree
    const groups = [...this.groups],
      positions = [...this.groupPositions]
    const chunks = [...this.chunks],
      chunkPositions = [...this.chunkPositions]
    const groupStart = chunks.length ? this.groupStart : this.pos
    if (open) {
      // Its read-ahead decisions so far come along, for an edit meanwhile.
      let reach = -1
      for (const read of this.reads)
        if (read.at >= open.from && read.at < rest)
          reach = Math.max(reach, read.to - open.from)
      chunks.push(
        this.giantLeaf(
          this.giant(open, null),
          rest - open.from,
          reach < 0 ? {} : { reach },
        ),
      )
      chunkPositions.push(open.from - groupStart)
    }
    if (rest < length) {
      chunks.push(this.leaf('tail', length - rest))
      chunkPositions.push(rest - groupStart)
    }
    if (chunks.length) {
      groups.push(
        new Tree(NodeType.none, chunks, chunkPositions, length - groupStart, [
          [
            chunkInfo,
            {
              kind: 'group',
              parsed: this.groupParsed,
              giants: this.groupGiants,
              ...reachOf(chunks, chunkPositions),
            },
          ],
        ]),
      )
      positions.push(groupStart)
    }
    this.snapshotKey = key
    this.snapshotTree = new Tree(
      this.parser.document,
      groups,
      positions,
      length,
      [[chunkInfo, this.rootInfo(groups)]],
    )
    return this.snapshotTree
  }

  /** Region parsed with inline content, or null when everything is wanted. */
  private demand() {
    const viewport = this.view
    if (!viewport) return null
    const margin = this.parser.chunkSize
    return { from: viewport.from - margin, to: viewport.to + margin }
  }

  private wanted(from: number, to: number) {
    const demand = this.demand()
    return !demand || (from < demand.to && to > demand.from)
  }

  /** Parsed chunks outside this range become pending, so memory follows the viewport. */
  private far(from: number, to: number) {
    const demand = this.demand()
    if (!demand) return false
    const margin = this.parser.chunkSize * this.parser.groupSize
    return to < demand.from - margin || from > demand.to + margin
  }

  private stopped(pos: number) {
    return this.stoppedAt !== null && pos >= this.stoppedAt
  }

  private old(pos: number) {
    for (const old of this.olds)
      if (old.fragment.from <= pos && pos < old.fragment.to) return old
    return null
  }

  /** Reuse the largest old node starting here whose text and next lines are unchanged. */
  private reuse() {
    const old = this.old(this.pos)
    if (!old) return false
    const { root, fragment } = old,
      at = this.pos + fragment.offset
    const probe = this.parser.options.probe
    const groupIndex = childBefore(root, at)
    if (groupIndex < 0) return false
    const group = root.children[groupIndex] as Tree
    const groupFrom = root.positions[groupIndex]!
    const last = group.children.at(-1) as Tree | undefined
    if (groupFrom === at) {
      const end = this.pos + group.length
      const { parsed, giants } = counts(group)
      if (
        end <= old.safe &&
        !this.readsPast(old, this.pos, group) &&
        !this.edgeAt(old, end) &&
        last?.prop(chunkInfo)?.kind !== 'tail' &&
        !endsOpen(last) &&
        !(parsed && this.far(this.pos, end)) &&
        !(
          (parsed < group.children.length || giants) &&
          this.wanted(this.pos, end)
        )
      ) {
        this.addGroup(group)
        if (probe) probe.reusedNodes++
        return true
      }
    }
    const index = childAt(group, at - groupFrom)
    if (index < 0) return false
    const chunk = group.children[index] as Tree
    const info = chunk.prop(chunkInfo)
    const end = this.pos + chunk.length
    // Shown as written after a stuck block: the block's chunk decides again.
    if (info?.kind === 'plain') return false
    if (info?.kind === 'tail') {
      // Still unscanned: keep it until the viewport reaches it.
      if (
        this.view?.from === Number.POSITIVE_INFINITY ||
        this.wanted(this.pos, this.input.length)
      )
        return false
      this.addTail()
      return true
    }
    // A decision in the chunk, or one deciding where it ends, read past the change.
    if (this.readsPast(old, this.pos, chunk) || this.edgeAt(old, end))
      return false
    if (info?.kind === 'giant') return this.reuseGiant(old, chunk, info)
    if (end > old.safe) return false
    if (
      info?.kind === 'pending' &&
      this.wanted(this.pos, end) &&
      !this.stopped(this.pos)
    ) {
      // Its boundaries are known, so the revealed chunk parses without a scan.
      this.startParse(this.pos, end)
      return true
    }
    if (info?.kind === 'parsed' && this.far(this.pos, end)) {
      this.addChunk(this.leaf('pending', chunk.length, info))
    } else this.addChunk(chunk)
    if (probe) probe.reusedNodes++
    this.pos = end
    return true
  }

  /** Whether a decision in an old chunk or group at `pos` read past the next change. */
  private readsPast(old: Old, pos: number, tree: Tree) {
    const reach = tree.prop(chunkInfo)?.reach
    return reach !== undefined && pos + reach >= old.cut
  }

  /** Whether the old chunk at `pos` read past the next change deciding, on its first line, that a block starts there. */
  private edgeAt(old: Old, pos: number) {
    if (old.cut === Number.POSITIVE_INFINITY) return false
    const at = pos + old.fragment.offset,
      found = chunkAround(old.root, at)
    const edge = found?.start === at ? found.chunk.prop(chunkInfo)?.edge : null
    return edge != null && pos + edge >= old.cut
  }

  private reuseGiant(old: Old, chunk: Tree, info: GiantInfo) {
    const { block } = info,
      from = this.pos,
      end = from + chunk.length
    const continuation = (
      points: readonly Replay[],
      frontier: number,
      retype = block.retype,
    ): Continuation => ({
      from,
      start: from + block.start,
      points: points.map((point) => shift(point, from)),
      leaf: block.leaf,
      key: block.key,
      retype,
      opaque: block.opaque,
      // Leaf blocks after the frontier are noted again as they are scanned.
      ends: block.ends
        .filter((known) => from + known.last < frontier)
        .map((known) => shiftEnd(known, from)),
      frontier,
      span: 2 * this.parser.chunkSize,
    })
    if (end > old.safe) {
      // Edited inside: the block continues from its last replay point before
      // the edit, so only the lines after it are scanned again.
      if (block.leaf) {
        const prefix = from + block.points[0]!.at
        if (prefix > old.safe) return false
        this.stepGiant(continuation(block.points, Math.max(prefix, old.safe)))
        return true
      }
      let index = block.points.length - 1
      while (index >= 0 && from + block.points[index]!.at > old.safe) index--
      if (index < 0) return false
      const points = block.points.slice(0, index + 1)
      const point = points.at(-1)!
      this.stepGiant(
        continuation(points, from + point.at, point.retype ?? false),
      )
      return true
    }
    const demand = this.demand()
    const stopped = this.stopped(from)
    if (
      block.end === null &&
      !stopped &&
      (!demand ||
        demand.to > end ||
        block.retype ||
        chunk.length < this.parser.giantBlock)
    ) {
      // The viewport moved past the scanned part of an open block, a short
      // block is finished exactly, or a paragraph's type depends on its end.
      this.stepGiant(continuation(block.points, end))
      return true
    }
    if (
      this.wanted(from, end) &&
      !stopped &&
      !giantCovers(
        info,
        from,
        chunk.length,
        demand?.from ?? from,
        demand?.to ?? end,
      )
    ) {
      this.startWindow(from, end, block)
      return true
    }
    this.addChunk(
      info.window && this.far(from, end)
        ? // Read-ahead decisions in the window still hold the block's place.
          this.giantLeaf(block, chunk.length, {
            ...(info.reach === undefined ? {} : { reach: info.reach }),
            ...(info.edge === undefined ? {} : { edge: info.edge }),
          })
        : chunk,
    )
    const probe = this.parser.options.probe
    if (probe) probe.reusedNodes++
    this.pos = end
    if (block.end === null) this.addRest(block)
    return true
  }

  /** Start scanning for the next chunk end, or leave the rest unscanned. */
  private begin() {
    const demand = this.demand()
    const after = !!demand && this.pos >= demand.to
    if (
      this.stopped(this.pos) ||
      (after &&
        (this.resynced >= this.parser.chunkSize * 4 ||
          !this.olds.some((old) => old.fragment.to > this.pos)))
    ) {
      this.addTail()
      return false
    }
    // Far from the viewport, wider windows split into several pending chunks.
    const size = this.parser.chunkSize
    this.startScan(
      demand && demand.from - this.pos > 32 * size ? 16 * size : 2 * size,
    )
    return true
  }

  /** Scan a bounded window, so no inner step reads past it. */
  private startScan(span: number) {
    const parse = this.parser.scan.startParse(
      this.input,
      [],
      [{ from: this.pos, to: Math.min(this.input.length, this.pos + span) }],
    )
    this.work = { kind: 'scan', from: this.pos, span, parse }
  }

  private startParse(from: number, to: number) {
    this.pos = from
    // Before a block that is not after blank lines, the chunk's input ends
    // with its last line's text: that block's line closes everything open,
    // where an empty last line would continue a fence in a list item.
    const end =
      to < this.input.length &&
      !/^[ \t\r]*$/.test(this.input.read(to, lineEnd(this.input, to)))
        ? to - 1
        : to
    const parse = this.parser.full.startParse(
      this.input,
      [],
      [{ from, to: end }],
    )
    this.work = { kind: 'parse', from, to, parse }
  }

  /** Advance the active inner parse; true when it finished. */
  private continueWork() {
    const work = this.work!
    let tree: Tree | null = null
    this.reading = work.parse
    for (let i = 0; i < innerSteps && !tree; i++) tree = work.parse.advance()
    this.reading = null
    if (!tree) return false
    this.work = null
    if (work.kind === 'scan') this.scanned(work.from, work.span, tree)
    else if (work.kind === 'parse') this.parsed(work.from, work.to, tree)
    else if (work.kind === 'continue') this.continued(work, tree)
    else this.windowed(work, tree)
    return true
  }

  /** Line start two complete lines before the end of a window ending at `to`, not before `floor`. */
  private limit(to: number, floor: number) {
    if (to >= this.input.length) return this.input.length
    let limit = lineStart(this.input, to - 1)
    for (let i = 0; i < 2 && limit > floor; i++)
      limit = lineStart(this.input, limit - 1)
    return limit
  }

  /** Split a scanned window at verified block starts into chunks. */
  private scanned(from: number, span: number, tree: Tree) {
    const length = this.input.length,
      size = this.parser.chunkSize
    const probe = this.parser.options.probe
    if (probe) probe.scannedUnits += tree.length
    const end = from + tree.length
    // Lezer looks at most one line ahead; keep two complete lines after a start.
    const limit = end < length ? this.limit(end, from) : end
    // Blocks such as indented code start after their indentation, so chunks
    // start at lines. Blank lines before a block belong to its chunk: an open
    // block at the end of a chunk would otherwise absorb them, as at the end
    // of a document.
    const starts: number[] = []
    let previous: SyntaxNode | null = null
    for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
      const line = lineStart(this.input, from + node.from)
      if (line > limit) break
      let start = blankRunStart(this.input, line, from)
      // Blank lines that an open block above took in, such as a fence in a
      // list item, stay in its chunk.
      if (previous)
        start = Math.max(
          start,
          Math.min(line, lineEnd(this.input, from + previous.to) + 1),
        )
      if (start > from && start !== starts.at(-1)) starts.push(start)
      previous = node
    }
    if (end >= length && starts.at(-1) !== length) starts.push(length)
    if (!starts.length) {
      // One block spans the window: continue it from a replay point, or
      // widen the window when it has none.
      const found =
        this.view && this.replayAt(tree, from, limit, from, null, from)
      if (!found) {
        if (!this.view || this.widens(tree, from, limit, span, from, end))
          this.startScan(span * 2)
        else {
          // Quotes and lists end at the next line that does not continue
          // them; a leaf block shows as written to the end.
          this.pos = from
          const stuck = this.stuckAt(tree, from, from)
          if (stuck) this.lost = this.lostAt(from, stuck, true)
          else this.addPlain()
        }
        return
      }
      const top = tree.topNode.firstChild!
      const block: Continuation = {
        from,
        start: from + top.from,
        points: found.leaf
          ? [found.point]
          : [{ at: from, head: [], lists: [] }, found.point],
        leaf: found.leaf,
        key: found.key,
        retype: found.retype,
        opaque: this.parser.opaque.has(top.name),
        ends: [],
        frontier: from,
        span,
      }
      if (!found.leaf) this.noteEnds(block, tree, from, found.frontier)
      block.frontier = found.frontier
      this.stepGiant(block)
      return
    }
    const hints = this.hints(from, limit)
    const demand = this.demand()
    let chunkFrom = from
    for (const start of starts) {
      const hint = hints.has(start)
      if (!hint && start - chunkFrom < size && start !== starts.at(-1)) continue
      if (this.wanted(chunkFrom, start)) {
        this.startParse(chunkFrom, start)
        return
      }
      this.pos = chunkFrom
      this.addChunk(this.leaf('pending', start - chunkFrom))
      if (demand && chunkFrom >= demand.to) this.resynced += start - chunkFrom
      chunkFrom = start
      // Stop where reuse can resume or where the caller asked to stop.
      if (hint || this.stopped(chunkFrom)) break
    }
    this.pos = chunkFrom
  }

  /**
   * A replay point past `after` and at most `limit` for the top-level block of
   * a scan, when that block spans `limit`. Positions in `tree` are relative to
   * `base`; `previous` is the point the scan continued from, at `frontier`.
   */
  private replayAt(
    tree: Tree,
    base: number,
    limit: number,
    after: number,
    previous: Replay | null,
    frontier: number,
  ): Found | null {
    const input = this.input
    const top = tree.topNode.firstChild
    if (!top || base + top.to < limit) return null
    const lineOf = (node: SyntaxNode) => lineStart(input, base + node.from)
    if (top.type.is('LeafBlock')) {
      const prefix = openingEnd(input, top.name, base + top.from)
      if (prefix === null || prefix > limit) return null
      return {
        leaf: true,
        key: stateKey(input, top.name, base + top.from),
        retype: retypes.has(top.name),
        point: {
          at: prefix,
          head: [{ from: lineOf(top), to: prefix }],
          lists: [],
        },
        frontier: limit,
      }
    }
    const point = (
      at: number,
      chain: readonly SyntaxNode[],
      head: Lines[],
      retype: boolean,
    ): Found | null => {
      if (!this.verified(tree, base, head, at)) return null
      // Items before `at` of the ordered lists around it.
      const lists = chain.flatMap((node) => {
        if (node.name !== 'OrderedList') return []
        const from = base + node.from
        const known = previous?.lists.find((list) => list.from === from)
        return [
          {
            from,
            items: known
              ? known.items + itemsIn(node, base, frontier, at)
              : itemsIn(node, base, from, at),
          },
        ]
      })
      return {
        leaf: false,
        key: null,
        retype,
        point: { at, head, lists, ...(retype ? { retype } : {}) },
        frontier: at,
      }
    }
    // The latest block that starts a line inside the quotes and lists at the
    // limit continues after the opening lines of the blocks around it.
    const chain: SyntaxNode[] = []
    const starts: { at: number; chain: SyntaxNode[] }[] = []
    for (let node: SyntaxNode = top; ; ) {
      chain.push(node)
      let child = node.childBefore(limit - base + 1)
      while (child && !child.type.is('Block')) child = child.prevSibling
      if (!child) break
      const at = lineOf(child)
      if (at > after && at !== starts.at(-1)?.at)
        starts.push({ at, chain: [...chain] })
      if (!child.type.is('BlockContext')) break
      node = child
    }
    for (let i = starts.length - 1; i >= 0; i--) {
      const { at, chain } = starts[i]!
      const found = point(at, chain, this.headOf(chain, base, at, true), false)
      if (found) return found
    }
    // Inside a long leaf block, its opening lines join those of the blocks
    // around it, and it continues from any later line: the limit, or the
    // last line before blank ones there.
    let at = limit
    while (at > after && blank.test(input.read(at, lineEnd(input, at))))
      at = lineStart(input, at - 1)
    if (at <= after) return null
    const end = lineEnd(input, at)
    let leaf: SyntaxNode | null = tree.resolveInner(
      end - base,
      end > at ? -1 : 1,
    )
    while (leaf && !leaf.type.is('LeafBlock')) leaf = leaf.parent
    if (!leaf || base + leaf.to < at) return null
    const line = lineOf(leaf)
    const prefix = openingEnd(input, leaf.name, base + leaf.from)
    if (line >= at || prefix === null || prefix > at) return null
    const around: SyntaxNode[] = []
    for (
      let node = leaf.parent;
      node && node.name !== 'Document';
      node = node.parent
    ) {
      if (!node.type.is('BlockContext')) return null
      around.unshift(node)
    }
    const head = this.headOf([...around, leaf], base, at, false)
    head.at(-1)!.to = Math.max(head.at(-1)!.to, prefix)
    return point(at, around, head, retypes.has(leaf.name))
  }

  /**
   * The opening lines of the blocks in `chain`, from the top down, that start
   * before the line at `at`, with the blank line before each: a block after a
   * blank line would otherwise continue a paragraph above it. Positions in
   * the chain's tree are relative to `base`.
   */
  private headOf(
    chain: readonly SyntaxNode[],
    base: number,
    at: number,
    starts: boolean,
  ) {
    const input = this.input
    const head: Lines[] = []
    const push = (from: number) => {
      const to = lineEnd(input, from) + 1,
        previous = head.at(-1)
      if (previous && previous.to === from) previous.to = to
      else head.push({ from, to })
    }
    const blankBefore = (line: number) => {
      const last = head.at(-1)
      if (!last) return
      const before = lineStart(input, line - 1)
      if (before >= last.to && blank.test(input.read(before, line - 1)))
        push(before)
    }
    const add = (line: number) => {
      const last = head.at(-1)
      if (line >= at || (last && line < last.to)) return
      blankBefore(line)
      push(line)
    }
    for (const node of chain) {
      const line = lineStart(input, base + node.from)
      add(line)
      // A list item opened on an otherwise blank line ends at a blank line
      // while its marker is all it holds, so it replays its first two
      // blocks, opening and last lines: a paragraph first ends only where
      // the next block starts.
      if (node.name !== 'ListItem') continue
      let child = node.firstChild
      while (child && !child.type.is('Block')) child = child.nextSibling
      if (!child || lineStart(input, base + child.from) <= line) continue
      for (let count = 0; child && count < 2; count++) {
        const first = lineStart(input, base + child.from),
          last = lineStart(input, base + child.to)
        if (first >= at) break
        add(first)
        const opening = openingEnd(input, child.name, base + child.from)
        for (
          let next = lineEnd(input, first) + 1;
          opening !== null && next < Math.min(opening, last, at);
          next = lineEnd(input, next) + 1
        )
          add(next)
        if (last < at) add(last)
        child = child.nextSibling
        while (child && !child.type.is('Block')) child = child.nextSibling
      }
    }
    // A block starting at `at` after a blank line starts a new block there.
    if (starts) blankBefore(at)
    return head
  }

  /**
   * Whether parsing `head` and then the line at `at` and the next one puts
   * the same blocks around `at` as `tree`, which starts at `base`.
   */
  private verified(
    tree: Tree,
    base: number,
    head: readonly Lines[],
    at: number,
  ) {
    const input = this.input
    const to = Math.min(
      input.length,
      lineEnd(input, lineEnd(input, at) + 1) + 1,
    )
    const ranges = head.map((range) => ({ ...range }))
    const last = ranges.at(-1)
    if (last && last.to === at) last.to = to
    else ranges.push({ from: at, to })
    const parse = this.parser.scan.startParse(input, [], ranges)
    let replayed: Tree | null = null
    this.reading = parse
    while (!replayed) replayed = parse.advance()
    this.reading = null
    const probe = this.parser.options.probe
    if (probe)
      probe.scannedUnits += ranges.reduce(
        (sum, range) => sum + range.to - range.from,
        0,
      )
    return (
      blocksAround(input, replayed, ranges[0]!.from, at) ===
      blocksAround(input, tree, base, at)
    )
  }

  /**
   * Note paragraphs, tables, and closed fences ending by `until` that a
   * window may cut. Their last line decides their type or closing bound.
   */
  private noteEnds(
    block: Continuation,
    tree: Tree,
    base: number,
    until: number,
  ) {
    const long = this.parser.chunkSize / 2
    tree.iterate({
      from: Math.max(0, block.frontier - base),
      to: until - base,
      enter: (node) => {
        if (!node.type.is('Block')) return false
        const close = node.name === 'FencedCode' ? node.node.lastChild : null
        if (
          !retypes.has(node.name) &&
          !(close?.name === 'CodeMark' && close.from > node.from)
        )
          return node.type.is('BlockContext') ? undefined : false
        const from = base + node.from,
          to = base + node.to
        if (
          to <= until &&
          (from < block.frontier || to - from > long) &&
          (block.ends.at(-1)?.from ?? -1) < from
        )
          block.ends.push({ from, last: lineStart(this.input, to) })
        return false
      },
    })
  }

  /**
   * Whether a scan without a replay point may read a wider window: up to the
   * giant size, to the end of the opening lines of the leaf block at the
   * limit, or while lines are too long for the window to hold a few.
   */
  private widens(
    tree: Tree,
    base: number,
    limit: number,
    span: number,
    from: number,
    to: number,
  ) {
    if (span < this.parser.giantBlock) return true
    let leaf: SyntaxNode | null = tree.resolveInner(limit - base, 1)
    while (leaf && !leaf.type.is('LeafBlock')) leaf = leaf.parent
    const prefix = leaf && openingEnd(this.input, leaf.name, base + leaf.from)
    if (prefix != null && prefix > limit) return true
    const text = this.input.read(from, to)
    let lines = 0
    for (
      let index = text.indexOf('\n');
      index >= 0 && lines < 8;
      index = text.indexOf('\n', index + 1)
    )
      lines++
    return lines < 8
  }

  /**
   * How far the old tree knew a leaf block with the same opening state
   * continued past `pos`, when that still holds: the text from `pos` on is
   * unchanged, so the block continues as it did.
   */
  private known(key: string, pos: number) {
    const old = this.old(pos)
    if (!old) return null
    const at = pos + old.fragment.offset
    const found = chunkAround(old.root, at)
    const info = found?.chunk.prop(chunkInfo)
    if (
      !found ||
      info?.kind !== 'giant' ||
      info.block.key !== key ||
      at < found.start + info.block.points[0]!.at
    )
      return null
    const end =
      found.start + (info.block.end ?? found.chunk.length) - old.fragment.offset
    return end > pos && end <= old.safe
      ? { at: end, closed: info.block.end !== null }
      : null
  }

  private giant(block: Continuation, end: number | null): Giant {
    return {
      start: block.start - block.from,
      points: block.points.map((point) => shift(point, -block.from)),
      leaf: block.leaf,
      key: block.key,
      retype: block.retype,
      opaque: block.opaque,
      ends: block.ends.map((known) => shiftEnd(known, -block.from)),
      end: end === null ? null : end - block.from,
    }
  }

  /** Continue a block from its frontier, or stop where the viewport ends. */
  private stepGiant(block: Continuation) {
    this.pos = block.from
    if (block.key !== null) {
      const known = this.known(block.key, block.frontier)
      if (known?.closed) {
        this.endGiant(block, known.at)
        return
      }
      if (known) block.frontier = known.at
    }
    const demand = this.demand()
    // Blocks up to the giant size are scanned to their end for an exact chunk;
    // past the viewport, the rest of a giant block stays unscanned until the
    // viewport reaches it, and a block after the viewport is not scanned.
    if (
      this.stopped(block.frontier) ||
      (demand &&
        (block.from >= demand.to ||
          (block.frontier >= demand.to &&
            block.frontier - block.from >= this.parser.giantBlock &&
            !block.retype)))
    ) {
      if (this.wanted(block.from, block.frontier))
        this.startWindow(block.from, block.frontier, this.giant(block, null))
      else this.addTail()
      return
    }
    const point = block.points.at(-1)!
    const to = Math.min(this.input.length, block.frontier + block.span)
    const ranges: Lines[] = []
    for (const range of point.head)
      if (range.from < block.frontier)
        ranges.push({
          from: range.from,
          to: Math.min(range.to, block.frontier),
        })
    const last = ranges.at(-1)
    if (last && last.to === block.frontier) last.to = to
    else ranges.push({ from: block.frontier, to })
    this.work = {
      kind: 'continue',
      block,
      base: ranges[0]!.from,
      to,
      units: ranges.reduce((sum, range) => sum + range.to - range.from, 0),
      parse: this.parser.scan.startParse(this.input, [], ranges),
    }
  }

  /** Find where a continued block ends in its window, or move its frontier. */
  private continued(work: Extract<Work, { kind: 'continue' }>, tree: Tree) {
    const { block, base, to } = work
    const probe = this.parser.options.probe
    if (probe) probe.scannedUnits += work.units
    const top = tree.topNode.firstChild
    const end = base + (top?.to ?? 0)
    const limit = this.limit(to, block.frontier)
    if (to >= this.input.length || end < limit) {
      if (!block.leaf) this.noteEnds(block, tree, base, end)
      this.endGiant(block, end)
      return
    }
    let frontier = block.frontier
    if (block.leaf) frontier = limit
    else {
      const found = this.replayAt(
        tree,
        base,
        limit,
        block.frontier,
        block.points.at(-1)!,
        block.frontier,
      )
      if (found) {
        block.points.push(found.point)
        block.retype = found.retype
        frontier = found.frontier
      }
    }
    if (frontier > block.frontier) {
      if (!block.leaf) this.noteEnds(block, tree, base, frontier)
      block.frontier = frontier
      block.span = Math.min(this.parser.giantBlock, block.span * 2)
    } else if (this.widens(tree, base, limit, block.span, block.frontier, to)) {
      // ponytail: lines longer than the window are read whole, as lezer
      // parses lines; a step reads at most a few of them.
      block.span *= 2
    } else {
      this.stuck(block, tree, base)
      return
    }
    this.stepGiant(block)
  }

  /**
   * No replay point holds past the frontier, so the rest of the block could
   * be read only in one step. Its scanned part stays an open block with
   * inner nodes near the viewport, and the text after it shows as written
   * up to a line that must start a top-level block.
   */
  private stuck(block: Continuation, tree: Tree, base: number) {
    const { from, frontier } = block
    const stuck = this.stuckAt(tree, base, frontier)
    if (!stuck) {
      this.pos = from
      this.addPlain()
      return
    }
    if (frontier > from) {
      const giant: Giant = { ...this.giant(block, null), stuck }
      if (this.wanted(from, frontier) && !this.stopped(from)) {
        this.startWindow(from, frontier, giant)
        return
      }
      this.pos = from
      this.addChunk(this.giantLeaf(giant, frontier - from))
    }
    this.pos = frontier
    this.lost = this.lostAt(frontier, stuck, frontier === from)
  }

  /**
   * The quote or list that a stuck top-level block in `tree`, which starts
   * at `base`, leaves open before line start `pos`; null for other blocks,
   * whose lines the search after it cannot follow.
   */
  private stuckAt(tree: Tree, base: number, pos: number): Stuck | null {
    const top = tree.topNode.firstChild
    if (top?.name === 'Blockquote') return { marker: '>', width: 0 }
    if (top?.name !== 'BulletList' && top?.name !== 'OrderedList') return null
    const item = top.childBefore(Math.max(top.from + 1, pos - base))
    const line = item && lineStart(this.input, base + item.from)
    const shape =
      line !== null &&
      shapeOf(this.input.read(line, Math.min(this.input.length, line + 64)))
    return shape && shape.marker !== null && shape.width !== null
      ? { marker: shape.marker, width: shape.width }
      : { marker: null, width: 0 }
  }

  /** Search on from line start `at` after a stuck block, from the line's end when `inside`. */
  private lostAt(at: number, stuck: Stuck, inside: boolean): Lost {
    const before = this.input.read(Math.max(0, at - 64), at)
    const start = before.lastIndexOf('\n', before.length - 2) + 1
    return {
      ...stuck,
      at,
      line: inside ? at : null,
      // The line before, when it is short enough to tell.
      blank:
        !inside &&
        at > 0 &&
        (start > 0 || at <= 64) &&
        /^[ \t\r]*$/.test(before.slice(start, -1)),
      cr: false,
      lf: false,
      top: stuck.marker === null,
    }
  }

  /**
   * After a stuck block, read on a window at a time, carrying line state
   * between windows, for the first line that starts a top-level block
   * however the lines before it continue the block's quote or list, and
   * parse on from there; the text before it shows as written. A line that
   * might be outside the container and opens a block that blank lines do
   * not end, such as a fence, leaves the rest of the document as written.
   */
  private resync() {
    const lost = this.lost!,
      length = this.input.length,
      size = this.parser.giantBlock
    const to = Math.min(length, lost.at + size)
    const text = this.input.read(lost.at, to)
    const probe = this.parser.options.probe
    if (probe) probe.scannedUnits += text.length
    // Lines that may open a block at the top level, checked together.
    const checks: string[] = []
    let index = 0,
      checked = 0,
      resume = -1,
      literal = false
    if (lost.line !== null) {
      const newline = text.indexOf('\n')
      index = newline < 0 ? text.length : newline + 1
      if (newline >= 0) lost.line = null
    }
    while (lost.line === null && index < text.length && checked < size) {
      const start = lost.at + index
      const newline = text.indexOf('\n', index)
      // The next window reads a line it cuts from its start, unless the
      // line fills it; then only the line's start is known.
      if (newline < 0 && to < length && index > 0) break
      const whole = newline >= 0 || to >= length
      const line = text.slice(index, newline < 0 ? text.length : newline)
      index = newline < 0 ? text.length : newline + 1
      if (!whole) lost.line = start
      const shape = shapeOf(line)
      if (!shape) {
        if (!whole) {
          literal = true
          break
        }
        lost.blank = true
        if (line.includes('\r')) lost.cr = true
        continue
      }
      const after = lost.blank
      lost.blank = false
      // A check against other blank lines does not hold after these.
      if (after && lost.cr && lost.lf) {
        literal = true
        break
      }
      lost.cr = false
      let check = false
      if (lost.top) {
        // Every reading leaves its quotes and lists, and blank lines end
        // the other blocks that do not survive the check.
        if (after && shape.column <= 1) {
          if (shape.marker === null || shape.marker === '>') resume = start
          else if (shape.width !== null) {
            // Every reading starts a top-level list item.
            lost.top = false
            lost.marker = shape.marker
            lost.width = shape.width
          }
        } else check = shape.marker === null
      } else if (lost.marker === '>' && shape.marker === '>' && !after) {
        // The quote goes on.
      } else if (lost.marker !== '>' && shape.column >= lost.width) {
        // The list item goes on.
      } else if (lost.marker !== '>' && shape.marker === lost.marker) {
        if (shape.width === null) lost.top = true
        else lost.width = shape.width
      } else if (after || (whole && this.interrupts(line))) {
        // Blank lines before it may belong to a fence in the block.
        resume = start
      } else {
        // Lazy text in the block, or the first line after it.
        check = shape.marker === null
        lost.top = true
      }
      if (check) {
        if (!whole) literal = true
        if (!line.endsWith('\r')) lost.lf = true
        checks.push(line)
        checked += line.length + 7
      }
      if (resume >= 0 || literal) break
    }
    if (checks.length && this.survives(checks)) literal = true
    lost.at += index
    if (literal) {
      this.addPlain()
      this.lost = null
      return
    }
    const end =
      resume >= 0 ? resume : lost.at >= length ? length : (lost.line ?? lost.at)
    if (end > this.pos) {
      this.addChunk(this.leaf('plain', end - this.pos))
      this.pos = end
    }
    if (resume >= 0 || lost.at >= length) this.lost = null
  }

  /** Whether a line ends a paragraph above it, which a lazy line does not. */
  private interrupts(line: string) {
    const parsed = this.standIn(`a\n${line}\n`)
    const first = parsed?.topNode.firstChild
    return first?.name === 'Paragraph' && first.to === 1
  }

  /**
   * Whether any of these lines, at the top level after a blank line, opens a
   * block that a blank line and an unindented paragraph do not end.
   */
  private survives(lines: readonly string[]) {
    let text = 'x\n\n'
    const after: number[] = []
    for (const line of lines) {
      // Blank lines in crlf text hold a carriage return.
      text += `${line}\n${line.endsWith('\r') ? '\r' : ''}\nx\n\n`
      after.push(text.length - 3)
    }
    const tree = this.standIn(text)
    return (
      !tree ||
      after.some((at) => {
        const node = tree.resolve(at, 1)
        return !(
          node.name === 'Paragraph' &&
          node.from === at &&
          node.parent?.type.isTop
        )
      })
    )
  }

  /**
   * Parse text standing in for lines of the note, or null when a decision
   * read ahead in it, which in the note would read different text.
   */
  private standIn(text: string) {
    const probe = this.parser.options.probe
    if (probe) probe.scannedUnits += text.length
    const input: Input = {
      length: text.length,
      chunk: (from) => text.slice(from),
      lineChunks: false,
      read: (from, to) => text.slice(from, to),
    }
    let ahead = false
    readers.set(input, () => {
      ahead = true
    })
    const tree = this.parser.scan.parse(input)
    return ahead ? null : tree
  }

  /** A continued block ends at `end`: one chunk, windowed when it is giant. */
  private endGiant(block: Continuation, end: number) {
    const { from } = block
    const to = end < this.input.length ? end + 1 : end
    const demand = this.demand()
    if (demand && from >= demand.to) this.resynced += to - from
    // Opaque blocks get windows sooner: their renderers never read inner
    // nodes, so a medium table need not be parsed again on every edit.
    if (
      to - from <=
      (block.opaque ? 2 * this.parser.chunkSize : this.parser.giantBlock)
    ) {
      if (this.wanted(from, to) && !this.stopped(from)) {
        this.startParse(from, to)
        return
      }
      this.pos = from
      this.addChunk(this.leaf('pending', to - from))
      this.pos = to
      return
    }
    const giant = this.giant(block, end)
    if (this.wanted(from, to) && !this.stopped(from)) {
      this.startWindow(from, to, giant)
      return
    }
    this.pos = from
    this.addChunk(this.giantLeaf(giant, to - from))
    this.pos = to
  }

  /**
   * Parse the lines of a giant block around the viewport after the replay
   * point before them, with a leaf block's last line, as one input, so lezer
   * builds exact nodes for those lines.
   */
  private startWindow(from: number, to: number, block: Giant) {
    const input = this.input,
      demand = this.demand()
    // The last line end inside the chunk that belongs to the block.
    const last = block.end === null ? to - 1 : from + block.end
    // Room to scroll before the window is rebuilt.
    const pad = 2 * this.parser.chunkSize
    const want = demand ? Math.max(from, demand.from - pad) : from
    let point = block.points[0]!
    let start: number
    if (block.leaf)
      start = lineStart(input, Math.min(last, Math.max(from + point.at, want)))
    else {
      // Quotes and lists change state between replay points, so the window
      // parses on from the last one before it.
      for (const candidate of block.points)
        if (from + candidate.at <= want) point = candidate
      start = from + point.at
    }
    const stop = Math.min(
      last,
      lineEnd(
        input,
        Math.min(last, Math.max(start, demand ? demand.to + pad : last)),
      ),
    )
    const segments: [number, number][] = point.head.map((range) => [
      from + range.from,
      from + range.to - 1,
    ])
    // An opaque block's renderers read its text: no lines between its ends.
    if (!block.opaque) segments.push([start, stop])
    // The last line decides a heading or closes a fence, including a leaf
    // inside a container that the window cuts.
    if (block.leaf && block.end !== null)
      segments.push([lineStart(input, last), last])
    else if (!block.leaf) {
      const cut = endAround(block.ends, stop - from)
      if (cut && from + cut.last > stop)
        segments.push([from + cut.last, lineEnd(input, from + cut.last)])
    }
    const ranges: { from: number; to: number }[] = []
    for (const [a, b] of segments) {
      const previous = ranges.at(-1)
      if (previous && a <= previous.to)
        previous.to = Math.max(previous.to, b + 1)
      else ranges.push({ from: a, to: b + 1 })
    }
    // The input ends with the last line's text, not an empty line after it.
    ranges.at(-1)!.to -= 1
    this.pos = from
    this.work = {
      kind: 'window',
      from,
      to,
      block,
      window: {
        head: point.head,
        from: block.opaque ? point.at : start - from,
        to: block.opaque ? point.at : Math.min(to, stop + 1) - from,
      },
      point,
      base: ranges[0]!.from,
      units: ranges.reduce((sum, range) => sum + range.to - range.from, 0),
      parse: this.parser.full.startParse(input, [], ranges),
    }
  }

  private windowed(work: Extract<Work, { kind: 'window' }>, tree: Tree) {
    const { from, to, block, window, point } = work
    const probe = this.parser.options.probe
    if (probe) {
      probe.parsedChunks++
      probe.parsedUnits += work.units
    }
    const node = tree.children[0] as Tree
    const start = from + block.start,
      offset = work.base + tree.positions[0]! - start
    const last = block.end === null ? to - 1 : from + block.end
    // The block keeps its real extent; lines outside the window have no inner nodes.
    const props = [...node.propValues]
    // Ordered lists around the window's start have their first item, from
    // the opening lines, but not the items between it and the window.
    const lists = new Map<number, number>()
    for (const list of point.lists) {
      const listFrom = from + list.from
      let found: SyntaxNode | null = tree.resolveInner(listFrom - work.base, 1)
      while (
        found &&
        !(found.name === 'OrderedList' && work.base + found.from === listFrom)
      )
        found = found.parent
      if (found)
        lists.set(
          listFrom - start,
          list.items - itemsIn(found, work.base, listFrom, from + point.at),
        )
    }
    if (lists.size) props.push([listWindow, lists])
    const extended = new Tree(
      node.type,
      node.children,
      offset
        ? node.positions.map((position) => position + offset)
        : node.positions,
      last - start,
      props,
    )
    this.addChunk(
      new Tree(NodeType.none, [extended], [block.start], to - from, [
        [chunkInfo, { kind: 'giant', block, window }],
      ]),
    )
    this.pos = to
    if (block.end === null) this.addRest(block)
  }

  private parsed(from: number, to: number, tree: Tree) {
    const probe = this.parser.options.probe
    if (probe) {
      probe.parsedChunks++
      probe.parsedUnits += to - from
    }
    this.addChunk(
      new Tree(NodeType.none, tree.children, tree.positions, to - from, [
        [chunkInfo, { kind: 'parsed' }],
      ]),
    )
    this.pos = to
  }

  /** Old chunk starts in (from, to] where ending a new chunk lets reuse resume. */
  private hints(from: number, to: number) {
    const hints = new Set<number>()
    for (const { fragment, root } of this.olds) {
      const lo = Math.max(from, fragment.from),
        hi = Math.min(to, fragment.to)
      if (lo > hi) continue
      const offset = fragment.offset
      for (
        let groupIndex = Math.max(0, childBefore(root, lo + offset));
        groupIndex < root.children.length;
        groupIndex++
      ) {
        const groupFrom = root.positions[groupIndex]! - offset
        if (groupFrom > hi) break
        const group = root.children[groupIndex] as Tree
        for (const position of group.positions) {
          const start = groupFrom + position
          if (start > hi) break
          if (start > lo) hints.add(start)
        }
      }
    }
    return hints
  }

  private leaf(
    kind: 'pending' | 'tail' | 'plain',
    length: number,
    reach: Reach = {},
  ) {
    const { reach: own, edge } = reach
    return new Tree(NodeType.none, [], [], length, [
      [
        chunkInfo,
        {
          kind,
          ...(own === undefined ? {} : { reach: own }),
          ...(edge === undefined ? {} : { edge }),
        },
      ],
    ])
  }

  private giantLeaf(block: Giant, length: number, reach: Reach = {}) {
    return new Tree(NodeType.none, [], [], length, [
      [chunkInfo, { kind: 'giant', block, window: null, ...reach }],
    ])
  }

  private addTail() {
    const length = this.input.length
    if (this.pos >= length) return
    this.addChunk(this.leaf('tail', length - this.pos))
    this.pos = length
  }

  /** The rest of the document, shown as written after a stuck block. */
  private addPlain() {
    const length = this.input.length
    if (this.pos >= length) return
    this.addChunk(this.leaf('plain', length - this.pos))
    this.pos = length
  }

  /** What follows an open block: unscanned text, or plain text after a stuck one. */
  private addRest(block: Giant) {
    if (block.stuck) this.lost = this.lostAt(this.pos, block.stuck, false)
    else this.addTail()
  }

  /** Append a chunk starting at the current position. */
  private addChunk(chunk: Tree) {
    // Read-ahead decisions made inside the chunk travel with it.
    if (this.reads.length) {
      const from = this.pos,
        end = from + chunk.length
      let reach = -1,
        edge = -1
      this.reads = this.reads.filter((read) => {
        if (read.at >= end) return true
        if (read.at >= from) {
          reach = Math.max(reach, read.to - from)
          if (read.at === from) edge = Math.max(edge, read.to - from)
        }
        return false
      })
      const info = chunk.prop(chunkInfo)
      if (info && reach >= 0)
        chunk = new Tree(
          chunk.type,
          chunk.children,
          chunk.positions,
          chunk.length,
          [
            [
              chunkInfo,
              {
                ...info,
                reach: Math.max(reach, info.reach ?? -1),
                ...(edge >= 0 ? { edge: Math.max(edge, info.edge ?? -1) } : {}),
              },
            ],
          ],
        )
    }
    if (!this.chunks.length) this.groupStart = this.pos
    this.chunks.push(chunk)
    this.chunkPositions.push(this.pos - this.groupStart)
    const { parsed, giants } = counts(chunk)
    this.groupParsed += parsed
    this.groupGiants += giants
    if (this.chunks.length >= this.parser.groupSize)
      this.flush(this.pos + chunk.length)
  }

  private addGroup(group: Tree) {
    if (
      this.chunks.length &&
      this.chunks.length + group.children.length <= this.parser.groupSize
    ) {
      // Merge into the open group so repeated edits do not fragment the tree.
      const start = this.pos
      for (let i = 0; i < group.children.length; i++) {
        this.pos = start + group.positions[i]!
        this.addChunk(group.children[i] as Tree)
      }
      this.pos = start + group.length
      return
    }
    this.flush(this.pos)
    this.groups.push(group)
    this.groupPositions.push(this.pos)
    this.pos += group.length
  }

  private flush(end: number) {
    if (!this.chunks.length) return
    this.groups.push(
      new Tree(
        NodeType.none,
        this.chunks,
        this.chunkPositions,
        end - this.groupStart,
        [
          [
            chunkInfo,
            {
              kind: 'group',
              parsed: this.groupParsed,
              giants: this.groupGiants,
              ...reachOf(this.chunks, this.chunkPositions),
            },
          ],
        ],
      ),
    )
    this.groupPositions.push(this.groupStart)
    const probe = this.parser.options.probe
    if (probe) probe.builtGroups++
    this.chunks = []
    this.chunkPositions = []
    this.groupParsed = 0
    this.groupGiants = 0
  }

  private rootInfo(groups: readonly Tree[]): ChunkInfo {
    let parsed = 0,
      giants = 0
    for (const group of groups) {
      const info = counts(group)
      parsed += info.parsed
      giants += info.giants
    }
    return { kind: 'root', parsed, giants }
  }

  private finish() {
    this.flush(this.pos)
    this.tree = new Tree(
      this.parser.document,
      this.groups,
      this.groupPositions,
      this.input.length,
      [[chunkInfo, this.rootInfo(this.groups)]],
    )
    this.pos = this.input.length
    return this.tree
  }
}

/** Composes independent lezer Markdown parses of verified chunks. */
export class ChunkedMarkdownParser extends Parser {
  /** Configured parser, including inline syntax and code-language nesting. */
  readonly full: MarkdownParser
  readonly options: ChunkedMarkdownOptions
  readonly document: NodeType
  readonly scan: MarkdownParser
  readonly chunkSize: number
  readonly groupSize: number
  readonly giantBlock: number
  readonly opaque: ReadonlySet<string>
  /** The node a document prefix that is not Markdown becomes, when the syntax defines it. */
  readonly frontmatter: NodeType | undefined

  /** `base` has the same block syntax as `full`, without code-language nesting. */
  constructor(
    full: MarkdownParser,
    base: MarkdownParser,
    options: ChunkedMarkdownOptions = {},
  ) {
    super()
    this.full = full
    this.options = options
    this.document = full.nodeSet.types.find((type) => type.name === 'Document')!
    // Inline parsers never change block structure, so boundary scans skip them.
    const inline = (base as unknown as { inlineNames?: unknown }).inlineNames
    this.scan = Array.isArray(inline)
      ? base.configure({
          remove: inline.filter(
            (name): name is string => typeof name === 'string',
          ),
        })
      : base
    this.chunkSize = options.chunkSize ?? 4096
    this.groupSize = options.groupSize ?? 64
    this.giantBlock = options.giantBlock ?? 16 * this.chunkSize
    this.opaque = options.opaque ?? new Set()
    this.frontmatter = full.nodeSet.types.find(
      (type) => type.name === 'Frontmatter',
    )
  }

  createParse(
    input: Input,
    fragments: readonly TreeFragment[],
    ranges: readonly { from: number; to: number }[],
  ): PartialParse {
    // Nested use over partial ranges keeps the plain parser's behavior.
    if (
      ranges.length !== 1 ||
      ranges[0]?.from !== 0 ||
      ranges[0]?.to !== input.length
    )
      return this.full.createParse(input, fragments, ranges)
    return new ChunkedParse(this, input, fragments, null)
  }

  /** Scan every boundary with no inline trees, using the view's bounded scanner. */
  startBoundaryParse(
    input: Input,
    fragments: readonly TreeFragment[] = [],
    prefix = 0,
  ): ChunkedPartialParse {
    return new ChunkedParse(
      this,
      input,
      fragments,
      { from: Number.POSITIVE_INFINITY, to: Number.POSITIVE_INFINITY },
      prefix,
    )
  }

  /**
   * Parse with inline content near `demand`; null parses the whole document.
   * The first `prefix` units become one `Frontmatter` node.
   */
  startChunkedParse(
    input: Input,
    fragments: readonly TreeFragment[],
    demand: Demand | null,
    prefix = 0,
  ): ChunkedPartialParse {
    return new ChunkedParse(this, input, fragments, demand, prefix)
  }
}

/** Chunks with inner nodes, their positions, and the ranges those nodes cover. */
export function parsedChunks(
  tree: Tree,
  /** Only chunks touching this range, found by position. */
  range: { from: number; to: number } = { from: 0, to: tree.length },
): { from: number; chunk: Tree; covered: { from: number; to: number }[] }[] {
  if (tree.prop(chunkInfo)?.kind !== 'root')
    return [{ from: 0, chunk: tree, covered: [{ from: 0, to: tree.length }] }]
  const chunks: {
    from: number
    chunk: Tree
    covered: { from: number; to: number }[]
  }[] = []
  for (
    // A chunk ending where the range starts touches it too.
    let groupIndex = Math.max(0, childBefore(tree, range.from - 1));
    groupIndex < tree.children.length;
    groupIndex++
  ) {
    const group = tree.children[groupIndex] as Tree
    const groupFrom = tree.positions[groupIndex]!
    if (groupFrom > range.to) break
    if (!counts(group).parsed || groupFrom + group.length < range.from) continue
    for (
      let index = Math.max(0, childBefore(group, range.from - groupFrom - 1));
      index < group.children.length;
      index++
    ) {
      const chunk = group.children[index] as Tree
      const from = groupFrom + group.positions[index]!
      if (from > range.to) break
      if (from + chunk.length < range.from) continue
      const info = chunk.prop(chunkInfo)
      if (info?.kind === 'parsed')
        chunks.push({
          from,
          chunk,
          covered: [{ from, to: from + chunk.length }],
        })
      else if (info?.kind === 'giant' && info.window) {
        const { window } = info
        const covered: { from: number; to: number }[] = []
        const headTo = head(info.block)
        if (headTo) covered.push({ from, to: from + headTo })
        else
          for (const range of window.head)
            covered.push({ from: from + range.from, to: from + range.to })
        if (window.to > window.from)
          covered.push({ from: from + window.from, to: from + window.to })
        chunks.push({ from, chunk, covered })
      }
    }
  }
  return chunks
}

/** Whether any pending, unscanned or unwindowed text intersects `from`-`to`. */
export function uncovered(tree: Tree, from: number, to: number) {
  if (tree.prop(chunkInfo)?.kind !== 'root') return false
  for (
    let groupIndex = Math.max(0, childBefore(tree, from));
    groupIndex < tree.children.length;
    groupIndex++
  ) {
    const groupFrom = tree.positions[groupIndex]!
    if (groupFrom >= to) break
    const group = tree.children[groupIndex] as Tree
    if (groupFrom + group.length <= from) continue
    for (
      let index = Math.max(0, childBefore(group, from - groupFrom));
      index < group.children.length;
      index++
    ) {
      const start = groupFrom + group.positions[index]!
      if (start >= to) break
      const chunk = group.children[index] as Tree
      if (start + chunk.length <= from) continue
      const info = chunk.prop(chunkInfo)
      // Text after a stuck block shows as written; parsing will not change that.
      if (info?.kind === 'parsed' || info?.kind === 'plain') continue
      if (
        info?.kind === 'giant' &&
        giantCovers(info, start, chunk.length, from, to)
      )
        continue
      return true
    }
  }
  return false
}

/** Bounded wire records. A giant's arrays and long key are split, never cloned as one payload. */
export type BoundaryRecord =
  | {
      kind: 'chunk'
      length: number
      type: 'pending' | 'tail' | 'plain' | 'giant'
      reach?: number
      edge?: number
    }
  | {
      kind: 'giant'
      start: number
      leaf: boolean
      retype: boolean
      opaque: boolean
      end: number | null
      stuck?: Stuck
    }
  | { kind: 'key'; text: string }
  | { kind: 'point'; at: number; retype?: boolean }
  | { kind: 'head'; from: number; to: number }
  | { kind: 'list'; from: number; items: number }
  | { kind: 'end'; from: number; last: number }

export const boundaryPageSize = 128

/** The chunk boundary at or before a requested suffix. */
export function boundaryStart(tree: Tree, from: number) {
  const groupIndex = Math.max(0, childBefore(tree, from))
  const group = tree.children[groupIndex] as Tree | undefined
  if (!group) return 0
  const groupFrom = tree.positions[groupIndex]!
  const index = Math.max(0, childBefore(group, from - groupFrom))
  return groupFrom + group.positions[index]!
}

/** Only the final tail lacks verified boundaries; find it without walking the index. */
export function unindexedFrom(tree: Tree): number | null {
  const group = tree.children.at(-1) as Tree | undefined
  const chunk = group?.children.at(-1) as Tree | undefined
  return chunk?.prop(chunkInfo)?.kind === 'tail'
    ? tree.positions.at(-1)! + group!.positions.at(-1)!
    : null
}

/** Only metadata crosses realms. The receiving view creates its own viewport windows. */
export function* boundaryRecords(
  tree: Tree,
  from = 0,
): Generator<BoundaryRecord> {
  const firstGroup = Math.max(0, childBefore(tree, from))
  for (let g = firstGroup; g < tree.children.length; g++) {
    const group = tree.children[g] as Tree
    const firstChunk =
      g === firstGroup
        ? Math.max(0, childBefore(group, from - tree.positions[g]!))
        : 0
    for (let c = firstChunk; c < group.children.length; c++) {
      const chunk = group.children[c] as Tree
      const info = chunk.prop(chunkInfo)!
      const type = info.kind === 'parsed' ? 'pending' : info.kind
      if (type === 'root' || type === 'group') continue
      yield {
        kind: 'chunk',
        length: chunk.length,
        type,
        ...(info.reach === undefined ? {} : { reach: info.reach }),
        ...(info.edge === undefined ? {} : { edge: info.edge }),
      }
      if (info.kind !== 'giant') continue
      const { points, key, ends, ...block } = info.block
      yield { kind: 'giant', ...block }
      if (key !== null) {
        if (!key.length) yield { kind: 'key', text: '' }
        for (let from = 0; from < key.length; from += 4096)
          yield { kind: 'key', text: key.slice(from, from + 4096) }
      }
      for (const point of points) {
        yield {
          kind: 'point',
          at: point.at,
          ...(point.retype === undefined ? {} : { retype: point.retype }),
        }
        for (const range of point.head) yield { kind: 'head', ...range }
        for (const list of point.lists) yield { kind: 'list', ...list }
      }
      for (const end of ends) yield { kind: 'end', ...end }
    }
  }
}

/** Appending a page visits only that page; finishing never walks the accumulated index. */
export class BoundaryTree {
  private groups: Tree[] = []
  private positions: number[] = []
  private chunks: Tree[] = []
  private chunkPositions: number[] = []
  private pos = 0
  private groupFrom = 0
  private giants = 0
  private groupGiants = 0
  private current: Extract<BoundaryRecord, { kind: 'chunk' }> | null = null
  private block: Giant | null = null
  private point: {
    at: number
    retype?: boolean
    head: Lines[]
    lists: { from: number; items: number }[]
  } | null = null
  private parser: ChunkedMarkdownParser
  readonly length: number
  constructor(parser: ChunkedMarkdownParser, length: number) {
    this.parser = parser
    this.length = length
  }

  append(records: readonly BoundaryRecord[]) {
    if (records.length > boundaryPageSize)
      throw new Error('Could not read a document worker reply.')
    for (const record of records) {
      if (!record || typeof record !== 'object')
        throw new Error('Could not read a document worker reply.')
      if (record.kind === 'chunk') {
        this.flushChunk()
        if (
          !Number.isSafeInteger(record.length) ||
          record.length <= 0 ||
          !['pending', 'plain', 'giant'].includes(record.type) ||
          this.pos + record.length > this.length
        )
          throw new Error('Could not read a document worker reply.')
        this.current = record
      } else if (record.kind === 'giant') {
        if (this.current?.type !== 'giant' || this.block)
          throw new Error('Could not read a document worker reply.')
        const { kind: _kind, ...block } = record
        this.block = { ...block, key: null, points: [], ends: [] }
      } else if (record.kind === 'key') {
        if (
          !this.block ||
          typeof record.text !== 'string' ||
          record.text.length > 4096
        )
          throw new Error('Could not read a document worker reply.')
        this.block!.key = (this.block!.key ?? '') + record.text
      } else if (record.kind === 'point') {
        if (!this.block)
          throw new Error('Could not read a document worker reply.')
        this.point = {
          at: record.at,
          head: [],
          lists: [],
          ...(record.retype === undefined ? {} : { retype: record.retype }),
        }
        ;(this.block!.points as Replay[]).push(this.point)
      } else if (record.kind === 'head') {
        if (!this.point)
          throw new Error('Could not read a document worker reply.')
        this.point.head.push({ from: record.from, to: record.to })
      } else if (record.kind === 'list') {
        if (!this.point)
          throw new Error('Could not read a document worker reply.')
        this.point.lists.push({ from: record.from, items: record.items })
      } else if (record.kind === 'end') {
        if (!this.block)
          throw new Error('Could not read a document worker reply.')
        ;(this.block.ends as End[]).push({
          from: record.from,
          last: record.last,
        })
      } else throw new Error('Could not read a document worker reply.')
    }
  }

  private flushChunk() {
    const current = this.current
    if (!current) return
    const { type, length, reach, edge } = current
    const shared = {
      ...(reach === undefined ? {} : { reach }),
      ...(edge === undefined ? {} : { edge }),
    }
    if (type === 'giant') {
      if (!this.block)
        throw new Error('Could not read a document worker reply.')
    }
    const info: ChunkInfo =
      type === 'giant'
        ? { kind: type, block: this.block!, window: null, ...shared }
        : { kind: type, ...shared }
    if (!this.chunks.length) this.groupFrom = this.pos
    this.chunks.push(
      new Tree(NodeType.none, [], [], length, [[chunkInfo, info]]),
    )
    this.chunkPositions.push(this.pos - this.groupFrom)
    if (type === 'giant') {
      this.giants++
      this.groupGiants++
    }
    this.pos += length
    this.current = null
    this.block = null
    this.point = null
    if (this.chunks.length === this.parser.groupSize) this.flushGroup()
  }

  private flushGroup() {
    if (!this.chunks.length) return
    this.groups.push(
      new Tree(
        NodeType.none,
        this.chunks,
        this.chunkPositions,
        this.pos - this.groupFrom,
        [
          [
            chunkInfo,
            {
              kind: 'group',
              parsed: 0,
              giants: this.groupGiants,
              ...reachOf(this.chunks, this.chunkPositions),
            },
          ],
        ],
      ),
    )
    this.positions.push(this.groupFrom)
    this.chunks = []
    this.chunkPositions = []
    this.groupGiants = 0
  }

  finish() {
    this.flushChunk()
    if (this.pos !== this.length)
      throw new Error('Could not read a document worker reply.')
    this.flushGroup()
    return new Tree(
      this.parser.document,
      this.groups,
      this.positions,
      this.length,
      [[chunkInfo, { kind: 'root', parsed: 0, giants: this.giants }]],
    )
  }
}
