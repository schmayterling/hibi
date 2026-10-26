import {
  type Input,
  NodeProp,
  NodeType,
  Parser,
  type PartialParse,
  Tree,
  type TreeFragment,
} from '@lezer/common'
import type { MarkdownParser } from '@lezer/markdown'

/**
 * Chunks start at top-level block starts of an exact parse. Parsing a chunk
 * alone yields the whole-document nodes for its range, so an edit reparses
 * one chunk and a viewport change parses only the chunks it reveals.
 */
type ChunkInfo =
  | { kind: 'root' | 'group'; parsed: number }
  | { kind: 'parsed' | 'pending' | 'tail' }

const chunkInfo = new NodeProp<ChunkInfo>({ perNode: true })

/** Deterministic work counters for scale tests. */
export type ChunkedMarkdownProbe = {
  /** Chunks parsed with inline content. */
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
  probe?: ChunkedMarkdownProbe
}

/** A visible document range. */
export type Demand = { from: number; to: number }

type Old = {
  fragment: TreeFragment
  root: Tree
  /** Old nodes ending at or before this position keep their next two lines. */
  safe: number
}

type Work =
  | { kind: 'scan'; from: number; span: number; parse: PartialParse }
  | { kind: 'parse'; from: number; to: number; parse: PartialParse }

/** Inner parser steps per outer step, so the host can yield inside a giant block. */
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

const parsedCount = (tree: Tree) => {
  const info = tree.prop(chunkInfo)
  return info && 'parsed' in info ? info.parsed : 0
}

class ChunkedParse implements PartialParse {
  stoppedAt: number | null = null
  private pos = 0
  private groups: Tree[] = []
  private groupPositions: number[] = []
  private chunks: Tree[] = []
  private chunkPositions: number[] = []
  private groupStart = 0
  private groupParsed = 0
  private olds: Old[]
  private work: Work | null = null
  private tree: Tree | null = null
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
      const last = group.children.at(-1) as Tree | undefined
      const parsed = parsedCount(group)
      if (
        end <= old.safe &&
        last?.prop(chunkInfo)?.kind !== 'tail' &&
        !(parsed && this.far(this.pos, end)) &&
        !(parsed < group.children.length && this.wanted(this.pos, end))
      ) {
        this.addGroup(group)
        if (probe) probe.reusedNodes++
        return true
      }
    }
    const index = childAt(group, at - groupFrom)
    if (index < 0) return false
    const chunk = group.children[index] as Tree
    const kind = chunk.prop(chunkInfo)?.kind
    const end = this.pos + chunk.length
    if (kind === 'tail') {
      // Still unscanned: keep it until the viewport reaches it.
      if (this.wanted(this.pos, this.input.length)) return false
      this.addChunk(this.leaf('tail', this.input.length - this.pos))
      this.pos = this.input.length
      return true
    }
    if (end > old.safe) return false
    if (
      kind === 'pending' &&
      this.wanted(this.pos, end) &&
      (this.stoppedAt === null || this.pos < this.stoppedAt)
    ) {
      // Its boundaries are known, so the revealed chunk parses without a scan.
      const parse = this.parser.full.startParse(
        this.input,
        [],
        [{ from: this.pos, to: end }],
      )
      this.work = { kind: 'parse', from: this.pos, to: end, parse }
      return true
    }
    if (kind === 'parsed' && this.far(this.pos, end)) {
      this.addChunk(this.leaf('pending', chunk.length))
    } else this.addChunk(chunk)
    if (probe) probe.reusedNodes++
    this.pos = end
    return true
  }

  /** Start scanning for the next chunk end, or leave the rest unscanned. */
  private begin() {
    const demand = this.demand()
    const after = !!demand && this.pos >= demand.to
    if (
      (this.stoppedAt !== null && this.pos >= this.stoppedAt) ||
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

  private startScan(span: number) {
    const parse = this.parser.scan.startParse(
      this.input,
      [],
      [{ from: this.pos, to: this.input.length }],
    )
    parse.stopAt(Math.min(this.input.length, this.pos + span))
    this.work = { kind: 'scan', from: this.pos, span, parse }
  }

  /** Advance the active inner parse; true when it finished. */
  private continueWork() {
    const work = this.work!
    let tree: Tree | null = null
    for (let i = 0; i < innerSteps && !tree; i++) tree = work.parse.advance()
    if (!tree) return false
    this.work = null
    if (work.kind === 'scan') this.scanned(work.from, work.span, tree)
    else this.parsed(work.from, work.to, tree)
    return true
  }

  /** Split a scanned window at verified block starts into chunks. */
  private scanned(from: number, span: number, tree: Tree) {
    const length = this.input.length,
      size = this.parser.chunkSize
    const probe = this.parser.options.probe
    if (probe) probe.scannedUnits += tree.length
    const end = from + tree.length
    // Lezer looks at most one line ahead; keep two complete lines after a start.
    let limit = end
    if (end < length) {
      limit = lineStart(this.input, end - 1)
      for (let i = 0; i < 2 && limit > from; i++)
        limit = lineStart(this.input, limit - 1)
    }
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
      // One block is longer than the window; widen it.
      this.startScan(span * 2)
      return
    }
    const hints = this.hints(from, limit)
    const demand = this.demand()
    let chunkFrom = from
    for (const start of starts) {
      const hint = hints.has(start)
      if (!hint && start - chunkFrom < size && start !== starts.at(-1)) continue
      if (this.wanted(chunkFrom, start)) {
        this.pos = chunkFrom
        const parse = this.parser.full.startParse(
          this.input,
          [],
          [{ from: chunkFrom, to: start }],
        )
        this.work = { kind: 'parse', from: chunkFrom, to: start, parse }
        return
      }
      this.pos = chunkFrom
      this.addChunk(this.leaf('pending', start - chunkFrom))
      if (demand && chunkFrom >= demand.to) this.resync += start - chunkFrom
      chunkFrom = start
      // Stop where reuse can resume or where the caller asked to stop.
      if (hint || (this.stoppedAt !== null && chunkFrom >= this.stoppedAt))
        break
    }
    this.pos = chunkFrom
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
    if (chunk.prop(chunkInfo)?.kind === 'parsed') this.groupParsed++
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
        [[chunkInfo, { kind: 'group', parsed: this.groupParsed }]],
      ),
    )
    this.groupPositions.push(this.groupStart)
    const probe = this.parser.options.probe
    if (probe) probe.builtGroups++
    this.chunks = []
    this.chunkPositions = []
    this.groupParsed = 0
  }

  private finish() {
    this.flush(this.pos)
    let parsed = 0
    for (const group of this.groups) parsed += parsedCount(group)
    this.tree = new Tree(
      this.parser.document,
      this.groups,
      this.groupPositions,
      this.input.length,
      [[chunkInfo, { kind: 'root', parsed }]],
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
  ): PartialParse {
    return new ChunkedParse(this, input, fragments, demand)
  }
}

/** Parsed chunks with their positions, found without visiting pending groups. */
export function parsedChunks(tree: Tree): { from: number; chunk: Tree }[] {
  if (tree.prop(chunkInfo)?.kind !== 'root') return [{ from: 0, chunk: tree }]
  const chunks: { from: number; chunk: Tree }[] = []
  for (let groupIndex = 0; groupIndex < tree.children.length; groupIndex++) {
    const group = tree.children[groupIndex] as Tree
    if (!parsedCount(group)) continue
    const groupFrom = tree.positions[groupIndex]!
    for (let index = 0; index < group.children.length; index++) {
      const chunk = group.children[index] as Tree
      if (chunk.prop(chunkInfo)?.kind === 'parsed')
        chunks.push({ from: groupFrom + group.positions[index]!, chunk })
    }
  }
  return chunks
}

/** Whether any pending or unscanned chunk intersects `from`-`to`. */
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
      if (
        start + chunk.length > from &&
        chunk.prop(chunkInfo)?.kind !== 'parsed'
      )
        return true
    }
  }
  return false
}
