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
 * from replay points: lines whose parse, followed by the text from a later
 * line, recreates the parser state at that line. A block longer than
 * `giantBlock` gets inner nodes only in a window around the viewport. Every
 * step of a parse therefore reads a bounded range.
 */

/**
 * Parsing lines `line`-`prefix` and then the text from `at` recreates the
 * parser state at `at`. In a top-level list, `items` counts its items before
 * `line`.
 */
type Replay = { at: number; line: number; prefix: number; items?: number }

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
  /** The block's end, or null when it continues past the chunk into unscanned text. */
  end: number | null
}

/**
 * Lines of a giant block with inner nodes: the replayed lines it was parsed
 * with, and a window around the viewport. `items` counts a top-level list's
 * items before the window.
 */
type Window = {
  head: { from: number; to: number } | null
  from: number
  to: number
  items: number
}

type ChunkInfo =
  | { kind: 'root' | 'group'; parsed: number; giants: number }
  | { kind: 'parsed' | 'pending' | 'tail' }
  | { kind: 'giant'; block: Giant; window: Window | null }
type GiantInfo = Extract<ChunkInfo, { kind: 'giant' }>

const chunkInfo = new NodeProp<ChunkInfo>({ perNode: true })

/**
 * On the list node of a window into a giant top-level list: the items before
 * the window's first item and the list's first number.
 */
export const listWindow = new NodeProp<{ items: number; start: number }>({
  perNode: true,
})

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
}

export type ChunkedMarkdownOptions = {
  /** Preferred chunk length in UTF-16 units. */
  chunkSize?: number
  /** Chunks per group node. */
  groupSize?: number
  /** Blocks longer than this get inner nodes only near the viewport. */
  giantBlock?: number
  probe?: ChunkedMarkdownProbe
}

/** A visible document range. */
export type Demand = { from: number; to: number }

/** A parse that can report its progress and follow the viewport while it runs. */
export interface ChunkedPartialParse extends PartialParse {
  /** The verified chunks so far, with the rest unscanned. */
  snapshot(): Tree
  setDemand(demand: Demand): void
}

type Old = {
  fragment: TreeFragment
  root: Tree
  /** Old nodes ending at or before this position keep their next two lines. */
  safe: number
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
    // The second line decides whether a paragraph is a table.
    case 'Table':
    case 'Paragraph':
    case 'Task':
      lines = 2
      break
    default:
      return null
  }
  let end = lineStart(input, from)
  // A link reference definition is decided within its label's 999
  // characters and the two lines after them.
  if (
    (name === 'Paragraph' || name === 'Task') &&
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
    case 'Paragraph': {
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
    info?.kind === 'tail' || (info?.kind === 'giant' && info.block.end === null)
  )
}

/** Where a giant block's covered head ends: its opening lines for a leaf block. */
const head = (block: Giant) => (block.leaf ? block.points[0]!.prefix : 0)

/** Whether a giant chunk at `start` has inner nodes for all of `from`-`to`. */
function giantCovers(
  info: GiantInfo,
  start: number,
  length: number,
  from: number,
  to: number,
) {
  if (!info.window) return false
  const a = Math.max(from, start + head(info.block)),
    b = Math.min(to, start + length)
  return (
    a >= b || (start + info.window.from <= a && b <= start + info.window.to)
  )
}

const shift = (point: Replay, by: number): Replay => ({
  ...point,
  at: point.at + by,
  line: point.line + by,
  prefix: point.prefix + by,
})

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
  private resync = 0

  private parser: ChunkedMarkdownParser
  private input: Input
  private view: Demand | null

  constructor(
    parser: ChunkedMarkdownParser,
    input: Input,
    fragments: readonly TreeFragment[],
    view: Demand | null,
  ) {
    this.parser = parser
    this.input = input
    this.view = view
    const length = input.length
    this.olds = fragments.flatMap((fragment) => {
      if (fragment.tree.prop(chunkInfo)?.kind !== 'root') return []
      let safe = length
      if (fragment.to < length) {
        // A node may end differently if one of its next two lines changed.
        safe = lineStart(input, fragment.to)
        for (let i = 0; i < 2 && safe > 0; i++)
          safe = lineStart(input, safe - 1)
      }
      return [{ fragment, root: fragment.tree, safe }]
    })
  }

  get parsedPos() {
    return this.pos
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
      chunks.push(this.giantLeaf(this.giant(open, null), rest - open.from))
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
    if (groupFrom === at) {
      const end = this.pos + group.length
      const { parsed, giants } = counts(group)
      if (
        end <= old.safe &&
        !endsOpen(group.children.at(-1) as Tree | undefined) &&
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
    if (info?.kind === 'tail') {
      // Still unscanned: keep it until the viewport reaches it.
      if (this.wanted(this.pos, this.input.length)) return false
      this.addTail()
      return true
    }
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
      this.addChunk(this.leaf('pending', chunk.length))
    } else this.addChunk(chunk)
    if (probe) probe.reusedNodes++
    this.pos = end
    return true
  }

  private reuseGiant(old: Old, chunk: Tree, info: GiantInfo) {
    const { block } = info,
      from = this.pos,
      end = from + chunk.length
    const continuation = (
      points: readonly Replay[],
      frontier: number,
    ): Continuation => ({
      from,
      start: from + block.start,
      points: points.map((point) => shift(point, from)),
      leaf: block.leaf,
      key: block.key,
      retype: block.retype,
      frontier,
      span: 2 * this.parser.chunkSize,
    })
    if (end > old.safe) {
      // Edited inside: the block continues from its last replay point before
      // the edit, so only the lines after it are scanned again.
      if (block.leaf) {
        const prefix = from + block.points[0]!.prefix
        if (prefix > old.safe) return false
        this.stepGiant(continuation(block.points, Math.max(prefix, old.safe)))
        return true
      }
      let index = block.points.length - 1
      while (index >= 0 && from + block.points[index]!.at > old.safe) index--
      if (index < 0) return false
      const points = block.points.slice(0, index + 1)
      this.stepGiant(continuation(points, from + points.at(-1)!.at))
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
        ? this.giantLeaf(block, chunk.length)
        : chunk,
    )
    const probe = this.parser.options.probe
    if (probe) probe.reusedNodes++
    this.pos = end
    if (block.end === null) this.addTail()
    return true
  }

  /** Start scanning for the next chunk end, or leave the rest unscanned. */
  private begin() {
    const demand = this.demand()
    const after = !!demand && this.pos >= demand.to
    if (
      this.stopped(this.pos) ||
      (after &&
        (this.resync >= this.parser.chunkSize * 4 ||
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
    const parse = this.parser.full.startParse(this.input, [], [{ from, to }])
    this.work = { kind: 'parse', from, to, parse }
  }

  /** Advance the active inner parse; true when it finished. */
  private continueWork() {
    const work = this.work!
    let tree: Tree | null = null
    for (let i = 0; i < innerSteps && !tree; i++) tree = work.parse.advance()
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
    for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
      const line = lineStart(this.input, from + node.from)
      if (line > limit) break
      const start = blankRunStart(this.input, line, from)
      if (start > from && start !== starts.at(-1)) starts.push(start)
    }
    if (end >= length && starts.at(-1) !== length) starts.push(length)
    if (!starts.length) {
      // One block spans the window: continue it from a replay point, or
      // widen the window when it has none.
      const found = this.view && this.replayAt(tree, from, limit, from)
      if (!found) {
        this.startScan(span * 2)
        return
      }
      const top = tree.topNode.firstChild!
      if (/^(Bullet|Ordered)List$/.test(top.name))
        found.point.items = itemsIn(top, from, from, found.point.line)
      this.stepGiant({
        from,
        start: from + top.from,
        points: found.leaf
          ? [found.point]
          : [{ at: from, line: from, prefix: from, items: 0 }, found.point],
        leaf: found.leaf,
        key: found.key,
        retype: found.retype,
        frontier: found.frontier,
        span,
      })
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
      if (demand && chunkFrom >= demand.to) this.resync += start - chunkFrom
      chunkFrom = start
      // Stop where reuse can resume or where the caller asked to stop.
      if (hint || this.stopped(chunkFrom)) break
    }
    this.pos = chunkFrom
  }

  /**
   * A replay point past `after` and at most `limit` for the top-level block of
   * a scan, when that block spans `limit`. Positions in `tree` are relative to
   * `base`.
   */
  private replayAt(
    tree: Tree,
    base: number,
    limit: number,
    after: number,
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
        retype: top.name === 'Paragraph' || top.name === 'Table',
        point: { at: prefix, line: lineOf(top), prefix },
        frontier: limit,
      }
    }
    // A block that starts a line inside quotes and lists, where every list
    // item around it starts on that line too, parses alone as in place.
    let best = -1
    for (
      let node: SyntaxNode = top;
      node.name === 'Blockquote' ||
      node.name === 'BulletList' ||
      node.name === 'OrderedList';
    ) {
      let child = node.childBefore(limit - base + 1)
      while (child && !child.type.is('Block')) child = child.prevSibling
      if (!child) break
      const at = lineOf(child)
      if (at > after) best = at
      node = child
    }
    if (best > after)
      return {
        leaf: false,
        key: null,
        retype: false,
        point: { at: best, line: best, prefix: best },
        frontier: best,
      }
    // A long leaf block opened on its list item's line continues with its
    // opening lines, like a top-level one.
    let leaf: SyntaxNode | null = tree.resolveInner(limit - base, 1)
    while (leaf && !leaf.type.is('LeafBlock')) leaf = leaf.parent
    if (!leaf || base + leaf.to < limit || limit <= after) return null
    const line = lineOf(leaf)
    for (
      let node = leaf.parent;
      node && node.name !== 'Document';
      node = node.parent
    )
      if (
        node.name !== 'Blockquote' &&
        node.name !== 'BulletList' &&
        node.name !== 'OrderedList' &&
        (node.name !== 'ListItem' || lineOf(node) !== line)
      )
        return null
    const prefix = openingEnd(input, leaf.name, base + leaf.from)
    if (prefix === null || prefix > limit) return null
    return {
      leaf: false,
      key: null,
      retype: false,
      point: { at: limit, line, prefix },
      frontier: limit,
    }
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
      at < found.start + info.block.points[0]!.prefix
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
    const ranges =
      point.prefix > point.line && block.frontier > point.prefix
        ? [
            { from: point.line, to: point.prefix },
            { from: block.frontier, to },
          ]
        : [{ from: Math.min(point.line, block.frontier), to }]
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
      this.endGiant(block, end)
      return
    }
    let frontier = block.frontier
    if (block.leaf) frontier = limit
    else {
      const found = this.replayAt(tree, base, limit, block.frontier)
      if (found) {
        const top = tree.topNode.firstChild!,
          point = block.points.at(-1)!
        if (
          point.items !== undefined &&
          /^(Bullet|Ordered)List$/.test(top.name)
        )
          found.point.items =
            point.items + itemsIn(top, base, point.line, found.point.line)
        block.points.push(found.point)
        frontier = found.frontier
      }
    }
    if (frontier > block.frontier) {
      block.frontier = frontier
      block.span = Math.min(this.parser.giantBlock, block.span * 2)
    } else {
      // ponytail: a line longer than the window, or a block nested in a list
      // item opened on an earlier line, is read in growing windows; lines that
      // long need a line-splitting scan, nested blocks deeper replay points.
      block.span *= 2
    }
    this.stepGiant(block)
  }

  /** A continued block ends at `end`: one chunk, windowed when it is giant. */
  private endGiant(block: Continuation, end: number) {
    const { from } = block
    const to = end < this.input.length ? end + 1 : end
    const demand = this.demand()
    if (demand && from >= demand.to) this.resync += to - from
    if (to - from <= this.parser.giantBlock) {
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
      start = lineStart(
        input,
        Math.min(last, Math.max(from + point.prefix, want)),
      )
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
    const line = from + point.line,
      prefix = from + point.prefix
    const segments: [number, number][] = []
    if (prefix > line) segments.push([line, prefix - 1])
    segments.push([start, stop])
    // A leaf block's last line decides a setext heading and closes a fence.
    if (block.leaf && block.end !== null)
      segments.push([lineStart(input, last), last])
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
        head: prefix > line ? { from: line - from, to: prefix - from } : null,
        from: start - from,
        to: Math.min(to, stop + 1) - from,
        items: point.items ?? 0,
      },
      base: ranges[0]!.from,
      units: ranges.reduce((sum, range) => sum + range.to - range.from, 0),
      parse: this.parser.full.startParse(input, [], ranges),
    }
  }

  private windowed(work: Extract<Work, { kind: 'window' }>, tree: Tree) {
    const { from, to, block, window } = work
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
    if (node.type.name === 'OrderedList' && offset)
      props.push([
        listWindow,
        {
          items: window.items,
          start: Number.parseInt(this.input.read(start, start + 12), 10),
        },
      ])
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
    if (block.end === null) this.addTail()
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

  private leaf(kind: 'pending' | 'tail', length: number) {
    return new Tree(NodeType.none, [], [], length, [[chunkInfo, { kind }]])
  }

  private giantLeaf(block: Giant, length: number) {
    return new Tree(NodeType.none, [], [], length, [
      [chunkInfo, { kind: 'giant', block, window: null }],
    ])
  }

  private addTail() {
    const length = this.input.length
    if (this.pos >= length) return
    this.addChunk(this.leaf('tail', length - this.pos))
    this.pos = length
  }

  /** Append a chunk starting at the current position. */
  private addChunk(chunk: Tree) {
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

  /** Parse with inline content near `demand`; null parses the whole document. */
  startChunkedParse(
    input: Input,
    fragments: readonly TreeFragment[],
    demand: Demand | null,
  ): ChunkedPartialParse {
    return new ChunkedParse(this, input, fragments, demand)
  }
}

/** Chunks with inner nodes, their positions, and the ranges those nodes cover. */
export function parsedChunks(
  tree: Tree,
): { from: number; chunk: Tree; covered: { from: number; to: number }[] }[] {
  if (tree.prop(chunkInfo)?.kind !== 'root')
    return [{ from: 0, chunk: tree, covered: [{ from: 0, to: tree.length }] }]
  const chunks: {
    from: number
    chunk: Tree
    covered: { from: number; to: number }[]
  }[] = []
  for (let groupIndex = 0; groupIndex < tree.children.length; groupIndex++) {
    const group = tree.children[groupIndex] as Tree
    if (!counts(group).parsed) continue
    const groupFrom = tree.positions[groupIndex]!
    for (let index = 0; index < group.children.length; index++) {
      const chunk = group.children[index] as Tree
      const from = groupFrom + group.positions[index]!
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
        else if (window.head)
          covered.push({
            from: from + window.head.from,
            to: from + window.head.to,
          })
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
      if (info?.kind === 'parsed') continue
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
