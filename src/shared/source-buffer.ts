import {
  combineMetrics,
  emptyMetrics,
  highSurrogate,
  lowSurrogate,
  SourceChunk,
  type TextMetrics,
} from './source-metrics.ts'
import {
  type DocumentKey,
  parseSourceOperation,
  type RawEdit,
  type SourceOperation,
  safePosition,
} from './source-operations.ts'
import { ownSourceText } from './source-text.ts'

export type SourceBufferOptions = Readonly<{
  fanout?: number
  leafCapacity?: number
  chunkUnits?: number
  maximumBytes?: number | undefined
}>
export type SourceBufferCounters = {
  nodeVisits: number
  metricSlotsCopied: number
  pieceDescriptorsCopied: number
  unitsScanned: number
  sourceUnitsRead: number
  materializations: number
  materializedUnits: number
  publishedRoots: number
  compactionUnits: number
  arenaAllocatedUnits: number
  arenaWrittenUnits: number
  storageNodesVisited: number
  storagePiecesVisited: number
  loadAppends: number
  maxLoadInputUnits: number
  maxLoadUnitsScanned: number
  maxLoadTreeWork: number
}
const newCounters = (): SourceBufferCounters => ({
  nodeVisits: 0,
  metricSlotsCopied: 0,
  pieceDescriptorsCopied: 0,
  unitsScanned: 0,
  sourceUnitsRead: 0,
  materializations: 0,
  materializedUnits: 0,
  publishedRoots: 0,
  compactionUnits: 0,
  arenaAllocatedUnits: 0,
  arenaWrittenUnits: 0,
  storageNodesVisited: 0,
  storagePiecesVisited: 0,
  loadAppends: 0,
  maxLoadInputUnits: 0,
  maxLoadUnitsScanned: 0,
  maxLoadTreeWork: 0,
})
type Piece = Readonly<{
  chunk: SourceChunk
  from: number
  to: number
  metrics: TextMetrics
}>
type Node = Readonly<{
  height: number
  metrics: TextMetrics
  pieces: number
  leaves: number
}> &
  (
    | Readonly<{ kind: 'leaf'; entries: readonly Piece[] }>
    | Readonly<{ kind: 'branch'; entries: readonly Node[] }>
  )
type Config = Readonly<{
  fanout: number
  leafCapacity: number
  chunkUnits: number
  maximumBytes: number | undefined
}>
type Axis = 'rawUnits' | 'normalizedUnits' | 'utf8Bytes' | 'breaks'
const roots = new WeakMap<SourceSnapshot, Node>()
const trees = new WeakMap<SourceSnapshot, PieceTree>()
const increment = (value: number) => {
  if (!Number.isSafeInteger(value + 1))
    throw new Error('Source generation exhausted.')
  return value + 1
}

class PieceTree {
  readonly config: Config
  readonly counters = newCounters()
  readonly #scanned = (units: number) => {
    this.counters.unitsScanned += units
  }
  #arena: ReturnType<typeof SourceChunk.appendable> | null = null

  constructor(options: SourceBufferOptions) {
    this.config = Object.freeze({
      fanout: options.fanout ?? 32,
      leafCapacity: options.leafCapacity ?? 64,
      chunkUnits: options.chunkUnits ?? 4096,
      maximumBytes: options.maximumBytes,
    })
    for (const [key, value] of Object.entries(this.config))
      if (
        value !== undefined &&
        (!Number.isSafeInteger(value) ||
          value < (key === 'maximumBytes' ? 0 : 4))
      )
        throw new Error('Invalid source buffer configuration.')
    if (
      this.config.fanout > 128 ||
      this.config.leafCapacity > 256 ||
      this.config.chunkUnits > 65536
    )
      throw new Error('Source buffer node or chunk capacity exceeds its bound.')
  }

  piece(chunk: SourceChunk, from: number, to: number): Piece {
    return Object.freeze({
      chunk,
      from,
      to,
      metrics: Object.freeze(chunk.metrics(from, to)),
    })
  }

  leaf(entries: readonly Piece[]): Node {
    const pieces: Piece[] = []
    for (const entry of entries) {
      if (entry.from === entry.to) continue
      const previous = pieces.at(-1)
      if (previous?.chunk === entry.chunk && previous.to === entry.from)
        pieces[pieces.length - 1] = this.piece(
          entry.chunk,
          previous.from,
          entry.to,
        )
      else pieces.push(entry)
    }
    this.counters.pieceDescriptorsCopied += pieces.length
    return Object.freeze({
      kind: 'leaf',
      height: 0,
      entries: Object.freeze(pieces),
      metrics: Object.freeze(
        pieces.reduce(
          (sum, entry) => combineMetrics(sum, entry.metrics),
          emptyMetrics,
        ),
      ),
      pieces: pieces.length,
      leaves: 1,
    })
  }

  branch(entries: readonly Node[]): Node {
    this.counters.metricSlotsCopied += entries.length
    return Object.freeze({
      kind: 'branch',
      height: entries[0]!.height + 1,
      entries: Object.freeze([...entries]),
      metrics: Object.freeze(
        entries.reduce(
          (sum, node) => combineMetrics(sum, node.metrics),
          emptyMetrics,
        ),
      ),
      pieces: entries.reduce((n, node) => n + node.pieces, 0),
      leaves: entries.reduce((n, node) => n + node.leaves, 0),
    })
  }

  groups<T>(entries: readonly T[], maximum: number): T[][] {
    const count = Math.ceil(entries.length / maximum),
      groups: T[][] = []
    let from = 0
    for (let index = 0; index < count; index++) {
      const length = Math.ceil((entries.length - from) / (count - index))
      groups.push(entries.slice(from, from + length))
      from += length
    }
    return groups
  }

  build(chunks: Iterable<string>): Node {
    const pieces: Piece[] = []
    let pending = ''
    const add = (text: string) => {
      const chunk = new SourceChunk(text, this.#scanned)
      pieces.push(this.piece(chunk, 0, text.length))
    }
    for (const text of chunks) {
      if (typeof text !== 'string')
        throw new Error('Source chunks must be strings.')
      let from = 0
      while (from < text.length) {
        const length = Math.min(
          this.config.chunkUnits - pending.length,
          text.length - from,
        )
        pending += text.slice(from, from + length)
        from += length
        if (pending.length === this.config.chunkUnits) {
          add(pending)
          pending = ''
        }
      }
    }
    if (pending) add(pending)
    return this.fromPieces(pieces)
  }
  /** Maintenance builds chunks and bounded right-spine paths between yields. */
  *rebuild(chunks: Iterable<string>): Generator<void, Node | undefined> {
    let root = this.leaf([]),
      pending = '',
      reads = 0
    let pieces: Piece[] = []
    const flush = () => {
      if (!pieces.length) return
      const joined = this.joinNodes(root, this.leaf(pieces))
      root = joined.length === 1 ? joined[0]! : this.branch(joined)
      pieces = []
    }
    const add = (text: string) => {
      const chunk = new SourceChunk(text, this.#scanned)
      pieces.push(this.piece(chunk, 0, text.length))
      this.counters.compactionUnits += text.length
      if (pieces.length === this.config.leafCapacity) flush()
    }
    for (const text of chunks) {
      let from = 0
      while (from < text.length) {
        const length = Math.min(
          this.config.chunkUnits - pending.length,
          text.length - from,
        )
        pending += text.slice(from, from + length)
        from += length
        if (pending.length === this.config.chunkUnits) {
          add(pending)
          pending = ''
          reads = 0
          yield
        }
      }
      // Fragmented input must yield even before it fills an output chunk.
      if (++reads >= 64) {
        reads = 0
        yield
      }
    }
    if (pending) {
      add(pending)
      yield
    }
    flush()
    return this.normalize(root)
  }
  *storage(
    root: Node,
  ): Generator<void, Omit<SourceStorageUsage, 'source'> | undefined> {
    const chunks = new Set<SourceChunk>(),
      pending = [root]
    let allocatedUnits = 0,
      indexBytes = 0
    const add = (chunk: SourceChunk) => {
      if (chunks.has(chunk)) return
      chunks.add(chunk)
      allocatedUnits += chunk.allocatedUnits
      indexBytes += chunk.indexBytes
    }
    while (pending.length) {
      const node = pending.pop()!
      this.counters.storageNodesVisited++
      if (node.kind === 'branch') pending.push(...node.entries)
      else
        for (const piece of node.entries) {
          this.counters.storagePiecesVisited++
          add(piece.chunk)
        }
      yield
    }
    // Rejected preparations can leave a writer that the visible root does not reference.
    if (this.#arena) add(this.#arena.chunk)
    return Object.freeze({
      allocatedUnits,
      indexBytes,
      chunks: chunks.size,
      pieces: root.pieces,
    })
  }
  fromPieces(pieces: readonly Piece[]): Node {
    if (!pieces.length) return this.leaf([])
    let nodes = this.groups(pieces, this.config.leafCapacity).map((group) =>
      this.leaf(group),
    )
    while (nodes.length > 1)
      nodes = this.groups(nodes, this.config.fanout).map((group) =>
        this.branch(group),
      )
    return nodes[0]!
  }

  insert(text: string): Node {
    const pieces: Piece[] = []
    let from = 0
    while (from < text.length) {
      if (!this.#arena?.remaining()) {
        this.#arena = SourceChunk.appendable(
          this.config.chunkUnits,
          this.#scanned,
        )
        this.counters.arenaAllocatedUnits += this.config.chunkUnits
      }
      const length = Math.min(this.#arena.remaining(), text.length - from)
      const range = this.#arena.append(text.slice(from, from + length))
      this.counters.arenaWrittenUnits += length
      pieces.push(this.piece(this.#arena.chunk, range.from, range.to))
      from += length
    }
    return this.fromPieces(pieces)
  }
  sealArena() {
    this.#arena = null
  }

  normalize(root: Node): Node {
    while (root.kind === 'branch' && root.entries.length === 1)
      root = root.entries[0]!
    return root
  }

  joinNodes(left: Node, right: Node): Node[] {
    this.counters.nodeVisits += 2
    if (left.height === right.height) {
      if (left.kind === 'leaf' && right.kind === 'leaf') {
        const merged = this.leaf([...left.entries, ...right.entries])
        if (merged.kind !== 'leaf') throw new Error('Invalid leaf.')
        return merged.entries.length <= this.config.leafCapacity
          ? [merged]
          : this.groups(merged.entries, this.config.leafCapacity).map((group) =>
              this.leaf(group),
            )
      }
      if (left.kind !== 'branch' || right.kind !== 'branch')
        throw new Error('Inconsistent source tree heights.')
      const middle = this.joinNodes(left.entries.at(-1)!, right.entries[0]!)
      return this.groups(
        [...left.entries.slice(0, -1), ...middle, ...right.entries.slice(1)],
        this.config.fanout,
      ).map((group) => this.branch(group))
    }
    if (left.height > right.height && left.kind === 'branch') {
      const tail = this.joinNodes(left.entries.at(-1)!, right)
      return this.groups(
        [...left.entries.slice(0, -1), ...tail],
        this.config.fanout,
      ).map((group) => this.branch(group))
    }
    if (right.kind !== 'branch')
      throw new Error('Inconsistent source tree heights.')
    const head = this.joinNodes(left, right.entries[0]!)
    return this.groups(
      [...head, ...right.entries.slice(1)],
      this.config.fanout,
    ).map((group) => this.branch(group))
  }

  join(left: Node | null, right: Node | null): Node {
    if (!left?.metrics.rawUnits)
      return right ? this.normalize(right) : this.leaf([])
    if (!right?.metrics.rawUnits) return this.normalize(left)
    const nodes = this.joinNodes(this.normalize(left), this.normalize(right))
    return this.normalize(nodes.length === 1 ? nodes[0]! : this.branch(nodes))
  }

  half(entries: Node[], edge: 'first' | 'last'): Node | null {
    if (!entries.length) return null
    if (entries.length > 1) {
      const index = edge === 'first' ? 0 : entries.length - 1
      const child = entries[index]!
      const minimum = Math.ceil(
        (child.kind === 'leaf'
          ? this.config.leafCapacity
          : this.config.fanout) / 2,
      )
      if (child.entries.length < minimum) {
        const start = edge === 'first' ? 0 : index - 1
        entries.splice(
          start,
          2,
          ...this.joinNodes(entries[start]!, entries[start + 1]!),
        )
      }
    }
    return this.branch(entries)
  }

  split(node: Node, at: number): [Node | null, Node | null] {
    this.counters.nodeVisits++
    if (at === 0) return [null, node]
    if (at === node.metrics.rawUnits) return [node, null]
    let offset = 0
    if (node.kind === 'leaf') {
      const left: Piece[] = [],
        right: Piece[] = []
      for (const entry of node.entries) {
        const end = offset + entry.metrics.rawUnits
        if (end <= at) left.push(entry)
        else if (offset >= at) right.push(entry)
        else {
          left.push(
            this.piece(entry.chunk, entry.from, entry.from + at - offset),
          )
          right.push(
            this.piece(entry.chunk, entry.from + at - offset, entry.to),
          )
        }
        offset = end
      }
      return [this.leaf(left), this.leaf(right)]
    }
    for (let index = 0; index < node.entries.length; index++) {
      const child = node.entries[index]!,
        end = offset + child.metrics.rawUnits
      if (at <= end) {
        const [a, b] = this.split(child, at - offset)
        return [
          this.half(
            [...node.entries.slice(0, index), ...(a ? [a] : [])],
            'last',
          ),
          this.half(
            [...(b ? [b] : []), ...node.entries.slice(index + 1)],
            'first',
          ),
        ]
      }
      offset = end
    }
    throw new Error('Source split is outside the tree.')
  }

  replace(root: Node, edit: RawEdit): Node {
    const [before, tail] = this.split(root, edit.from)
    const after = tail ? this.split(tail, edit.to - edit.from)[1] : null
    return this.join(
      this.join(before, edit.insert ? this.insert(edit.insert) : null),
      after,
    )
  }

  prefix(node: Node, to: number): TextMetrics {
    this.counters.nodeVisits++
    if (to === node.metrics.rawUnits) return node.metrics
    if (!to) return emptyMetrics
    let sum = emptyMetrics,
      remaining = to
    for (const entry of node.entries) {
      if (remaining >= entry.metrics.rawUnits) {
        sum = combineMetrics(sum, entry.metrics)
        remaining -= entry.metrics.rawUnits
      } else {
        const metrics =
          node.kind === 'leaf'
            ? (entry as Piece).chunk.metrics(
                (entry as Piece).from,
                (entry as Piece).from + remaining,
              )
            : this.prefix(entry as Node, remaining)
        return combineMetrics(sum, metrics)
      }
      if (!remaining) break
    }
    return sum
  }

  seek(
    node: Node,
    axis: Axis,
    target: number,
    before = emptyMetrics,
    rawBefore = 0,
  ): number | null {
    this.counters.nodeVisits++
    if (before[axis] === target) return rawBefore
    for (const entry of node.entries) {
      const through = combineMetrics(before, entry.metrics)
      if (through[axis] >= target) {
        if (node.kind === 'branch')
          return this.seek(entry as Node, axis, target, before, rawBefore)
        const piece = entry as Piece
        let low = 0,
          high = piece.metrics.rawUnits
        while (low < high) {
          const middle = Math.floor((low + high) / 2)
          const value = combineMetrics(
            before,
            piece.chunk.metrics(piece.from, piece.from + middle),
          )[axis]
          if (value < target) low = middle + 1
          else high = middle
        }
        return combineMetrics(
          before,
          piece.chunk.metrics(piece.from, piece.from + low),
        )[axis] === target
          ? rawBefore + low
          : null
      }
      before = through
      rawBefore += entry.metrics.rawUnits
    }
    return null
  }

  *chunks(node: Node, from: number, to: number): Iterable<string> {
    this.counters.nodeVisits++
    let offset = 0
    for (const entry of node.entries) {
      const end = offset + entry.metrics.rawUnits
      if (end > from && offset < to) {
        const a = Math.max(0, from - offset),
          b = Math.min(entry.metrics.rawUnits, to - offset)
        if (node.kind === 'leaf') {
          const piece = entry as Piece
          this.counters.sourceUnitsRead += b - a
          yield piece.chunk.slice(piece.from + a, piece.from + b)
        } else yield* this.chunks(entry as Node, a, b)
      }
      if (end >= to) break
      offset = end
    }
  }
}

/** Immutable source handle. Materialization is explicit; coordinates do not flatten. */
export class SourceSnapshot {
  readonly document: DocumentKey
  readonly version: number
  readonly storageEpoch: number
  readonly rootId: number
  readonly #tree: PieceTree

  constructor(
    tree: PieceTree,
    root: Node,
    document: DocumentKey,
    version: number,
    storageEpoch: number,
    rootId: number,
  ) {
    this.#tree = tree
    this.document = document
    this.version = version
    this.storageEpoch = storageEpoch
    this.rootId = rootId
    roots.set(this, root)
    trees.set(this, tree)
    Object.freeze(this)
  }

  get utf16Length() {
    return roots.get(this)!.metrics.rawUnits
  }
  get normalizedLength() {
    return roots.get(this)!.metrics.normalizedUnits
  }
  get utf8Bytes() {
    return roots.get(this)!.metrics.utf8Bytes
  }
  get lineCount() {
    return roots.get(this)!.metrics.breaks + 1
  }
  get metrics(): TextMetrics {
    return roots.get(this)!.metrics
  }
  sharesRoot(other: SourceSnapshot) {
    return roots.get(this) === roots.get(other)
  }
  /** Cooperative exact equality skips shared subtrees and chunk ranges. */
  *compare(other: SourceSnapshot): Generator<void, boolean> {
    if (!roots.has(other)) throw new Error('Invalid source snapshot.')
    if (
      this.utf16Length !== other.utf16Length ||
      this.utf8Bytes !== other.utf8Bytes
    )
      return false
    if (this.utf16Length === 0) return true
    type Part = { item: Node | Piece; from: number; to: number }
    const left: Part[] = [
      { item: roots.get(this)!, from: 0, to: this.utf16Length },
    ]
    const right: Part[] = [
      { item: roots.get(other)!, from: 0, to: other.utf16Length },
    ]
    const expand = (stack: Part[]) => {
      const part = stack.pop()!
      const node = part.item as Node
      let offset = 0
      const children: Part[] = []
      for (const entry of node.entries) {
        const end = offset + entry.metrics.rawUnits
        if (end > part.from && offset < part.to)
          children.push({
            item: entry,
            from: Math.max(0, part.from - offset),
            to: Math.min(entry.metrics.rawUnits, part.to - offset),
          })
        offset = end
      }
      stack.push(...children.reverse())
    }
    while (left.length && right.length) {
      this.#tree.counters.nodeVisits++
      const a = left.at(-1)!,
        b = right.at(-1)!
      if (a.item === b.item && a.from === b.from && a.to === b.to) {
        left.pop()
        right.pop()
      } else if (
        'kind' in a.item &&
        (!('kind' in b.item) || a.item.height >= b.item.height)
      )
        expand(left)
      else if ('kind' in b.item) expand(right)
      else {
        const x = a.item as Piece,
          y = b.item as Piece
        const length = Math.min(a.to - a.from, b.to - b.from)
        const fromA = x.from + a.from,
          fromB = y.from + b.from
        if (x.chunk !== y.chunk || fromA !== fromB) {
          this.#tree.counters.sourceUnitsRead += length * 2
          if (
            x.chunk.slice(fromA, fromA + length) !==
            y.chunk.slice(fromB, fromB + length)
          )
            return false
        }
        a.from += length
        b.from += length
        if (a.from === a.to) left.pop()
        if (b.from === b.to) right.pop()
      }
      yield
    }
    return left.length === 0 && right.length === 0
  }

  #range(from: number, to: number) {
    if (
      !safePosition(from) ||
      !safePosition(to) ||
      to < from ||
      to > this.utf16Length
    )
      throw new Error('Source range is outside the snapshot.')
  }
  chunks(from = 0, to = this.utf16Length): Iterable<string> {
    this.#range(from, to)
    return this.#tree.chunks(roots.get(this)!, from, to)
  }
  sliceRaw(from: number, to: number): string {
    this.#range(from, to)
    if (from === 0 && to === this.utf16Length) {
      this.#tree.counters.materializations++
      this.#tree.counters.materializedUnits += to
    }
    return [...this.chunks(from, to)].join('')
  }
  materialize() {
    return this.sliceRaw(0, this.utf16Length)
  }
  #seam(position: number) {
    if (position <= 0 || position >= this.utf16Length) return ''
    return this.sliceRaw(
      Math.max(0, position - 1),
      Math.min(this.utf16Length, position + 1),
    )
  }
  isEditBoundary(position: number) {
    if (!safePosition(position) || position > this.utf16Length) return false
    const seam = this.#seam(position)
    return (
      seam !== '\r\n' &&
      !(highSurrogate(seam.charCodeAt(0)) && lowSurrogate(seam.charCodeAt(1)))
    )
  }
  rawToEditor(position: number): number | null {
    if (
      !safePosition(position) ||
      position > this.utf16Length ||
      this.#seam(position) === '\r\n'
    )
      return null
    return this.#tree.prefix(roots.get(this)!, position).normalizedUnits
  }
  editorToRaw(position: number): number | null {
    if (!safePosition(position) || position > this.normalizedLength) return null
    const raw = this.#tree.seek(roots.get(this)!, 'normalizedUnits', position)
    return raw === null ? null : this.#seam(raw) === '\r\n' ? raw + 1 : raw
  }
  rawToByte(position: number): number | null {
    if (!safePosition(position) || position > this.utf16Length) return null
    const seam = this.#seam(position)
    if (highSurrogate(seam.charCodeAt(0)) && lowSurrogate(seam.charCodeAt(1)))
      return null
    return this.#tree.prefix(roots.get(this)!, position).utf8Bytes
  }
  byteToRaw(position: number): number | null {
    if (!safePosition(position) || position > this.utf8Bytes) return null
    const raw = this.#tree.seek(roots.get(this)!, 'utf8Bytes', position)
    return raw === null || this.rawToByte(raw) !== position ? null : raw
  }
  lineStart(line: number): number | null {
    if (!Number.isSafeInteger(line) || line < 1 || line > this.lineCount)
      return null
    const raw = this.#tree.seek(roots.get(this)!, 'breaks', line - 1)
    return raw === null ? null : this.#seam(raw) === '\r\n' ? raw + 1 : raw
  }
  lineAt(position: number) {
    if (this.rawToEditor(position) === null) return null
    const number = this.#tree.prefix(roots.get(this)!, position).breaks + 1
    const from = this.lineStart(number)!
    let to =
      number === this.lineCount ? this.utf16Length : this.lineStart(number + 1)!
    if (number < this.lineCount) {
      const ending = this.sliceRaw(Math.max(from, to - 2), to)
      to -= ending.endsWith('\r\n') ? 2 : 1
    }
    return { number, from, to }
  }
  *encodedChunks(): Iterable<Uint8Array> {
    const encoder = new TextEncoder()
    let carry = ''
    for (const part of this.chunks()) {
      let text = carry + part
      carry = ''
      if (highSurrogate(text.charCodeAt(text.length - 1))) {
        carry = text.slice(-1)
        text = text.slice(0, -1)
      }
      if (text) yield encoder.encode(text)
    }
    if (carry) yield encoder.encode(carry)
  }
}

export type PreparedSourceOperation = Readonly<{
  operation: SourceOperation
  before: SourceSnapshot
  after: SourceSnapshot
  inverse: readonly RawEdit[]
}>
export type SourceStorageChange = Readonly<{
  before: SourceSnapshot
  after: SourceSnapshot
}>
export type SourceStorageUsage = Readonly<{
  source: SourceSnapshot
  /** Unique owned UTF-16 capacity, including the current writer; string storage is an upper estimate. */
  allocatedUnits: number
  indexBytes: number
  chunks: number
  pieces: number
}>
const acceptedStorageChanges = new WeakSet<SourceStorageChange>()
/** Only committed, kernel-created storage changes can authorize reader rebasing. */
export const acceptedStorageChange = (
  value: unknown,
): value is SourceStorageChange =>
  !!value &&
  typeof value === 'object' &&
  acceptedStorageChanges.has(value as SourceStorageChange)

// An edit can create a new CRLF/surrogate seam. Its inverse must own that whole
// boundary, restoring the unchanged neighbor as well as the removed content.
function safeInverse(
  snapshot: SourceSnapshot,
  edits: readonly RawEdit[],
): readonly RawEdit[] {
  const result: RawEdit[] = []
  let group: RawEdit[] = [],
    from = 0,
    to = 0
  const flush = () => {
    if (!group.length) return
    const parts: string[] = []
    let end = from
    for (const edit of group) {
      parts.push(snapshot.sliceRaw(end, edit.from), edit.insert)
      end = edit.to
    }
    parts.push(snapshot.sliceRaw(end, to))
    result.push(Object.freeze({ from, to, insert: parts.join('') }))
  }
  for (const edit of edits) {
    const start = snapshot.isEditBoundary(edit.from) ? edit.from : edit.from - 1
    const end = snapshot.isEditBoundary(edit.to) ? edit.to : edit.to + 1
    if (group.length && start > to) {
      flush()
      group = []
    }
    if (!group.length) {
      from = start
      to = end
    } else to = Math.max(to, end)
    group.push(edit)
  }
  flush()
  return Object.freeze(result)
}

/** Private preparation capability: a forged, stale or consumed object cannot commit. */
export class SourceStore {
  readonly #tree: PieceTree
  #current: SourceSnapshot
  #rootId = 0
  readonly #prepared = new WeakSet<PreparedSourceOperation>()
  readonly #compactions = new WeakSet<SourceStorageChange>()
  readonly #accepted = new WeakSet<SourceSnapshot>()

  constructor(
    source: string | Iterable<string>,
    document: DocumentKey,
    version = 0,
    options: SourceBufferOptions = {},
  ) {
    if (
      !document ||
      typeof document.tabId !== 'string' ||
      !safePosition(version) ||
      !safePosition(document.revision) ||
      !/^[\w.:-]{1,128}$/.test(document.tabId)
    )
      throw new Error('Invalid source session identity.')
    this.#tree = new PieceTree(options)
    const root = this.#tree.build(
      typeof source === 'string' ? [source] : source,
    )
    if (
      this.#tree.config.maximumBytes !== undefined &&
      root.metrics.utf8Bytes > this.#tree.config.maximumBytes
    )
      throw new Error('Source exceeds the document size limit.')
    this.#current = new SourceSnapshot(
      this.#tree,
      root,
      Object.freeze({
        tabId: ownSourceText(document.tabId),
        revision: document.revision,
      }),
      version,
      0,
      this.#rootId,
    )
    this.#accepted.add(this.#current)
  }
  /** Fork an immutable generation without reading its source or rebuilding its indexes. */
  static fromSnapshot(
    snapshot: SourceSnapshot,
    document = snapshot.document,
    version = snapshot.version,
    limits: Pick<SourceBufferOptions, 'maximumBytes'> = {},
  ) {
    const store = new SourceStore('', document, version, {
      ...trees.get(snapshot)!.config,
      ...limits,
    })
    if (
      store.#tree.config.maximumBytes !== undefined &&
      snapshot.utf8Bytes > store.#tree.config.maximumBytes
    )
      throw new Error('Source exceeds the document size limit.')
    store.#current = new SourceSnapshot(
      store.#tree,
      roots.get(snapshot)!,
      store.#current.document,
      version,
      0,
      0,
    )
    store.#accepted.add(store.#current)
    return store
  }
  /** Unpublished construction; callers yield or acknowledge between bounded appends. */
  static loader(
    document: DocumentKey,
    version = 0,
    options: SourceBufferOptions = {},
  ): Readonly<{ append(chunk: string): void; finish(): SourceStore }> {
    const store = new SourceStore('', document, version, options),
      tree = store.#tree,
      counters = tree.counters
    let root = roots.get(store.#current)!,
      closed = false
    return Object.freeze({
      append(chunk: string) {
        if (closed) throw new Error('Source loader is closed.')
        try {
          if (typeof chunk !== 'string')
            throw new Error('Source chunks must be strings.')
          if (chunk.length > 65536)
            throw new Error('Source chunk exceeds the transfer limit.')
          if (
            tree.config.maximumBytes !== undefined &&
            root.metrics.rawUnits + chunk.length > tree.config.maximumBytes
          )
            throw new Error('Source exceeds the document size limit.')
          const scanned = counters.unitsScanned,
            work =
              counters.nodeVisits +
              counters.metricSlotsCopied +
              counters.pieceDescriptorsCopied
          const next = chunk ? tree.join(root, tree.insert(chunk)) : root
          if (
            tree.config.maximumBytes !== undefined &&
            next.metrics.utf8Bytes > tree.config.maximumBytes
          )
            throw new Error('Source exceeds the document size limit.')
          root = next
          counters.loadAppends++
          counters.maxLoadInputUnits = Math.max(
            counters.maxLoadInputUnits,
            chunk.length,
          )
          counters.maxLoadUnitsScanned = Math.max(
            counters.maxLoadUnitsScanned,
            counters.unitsScanned - scanned,
          )
          counters.maxLoadTreeWork = Math.max(
            counters.maxLoadTreeWork,
            counters.nodeVisits +
              counters.metricSlotsCopied +
              counters.pieceDescriptorsCopied -
              work,
          )
        } catch (error) {
          closed = true
          throw error
        }
      },
      finish() {
        if (closed) throw new Error('Source loader is closed.')
        closed = true
        store.#current = new SourceSnapshot(
          tree,
          root,
          store.#current.document,
          version,
          0,
          store.#rootId,
        )
        store.#accepted.add(store.#current)
        return store
      },
    })
  }
  /** Pack fragmented input into bounded slices, yielding even for empty chunks. */
  static async load(
    chunks: AsyncIterable<string> | Iterable<string>,
    document: DocumentKey,
    version = 0,
    options: SourceBufferOptions = {},
  ): Promise<SourceStore> {
    const loader = SourceStore.loader(document, version, options)
    const { loadSource } = await import('./source-load.ts')
    return loadSource(loader, chunks)
  }
  snapshot() {
    return this.#current
  }
  /** Owned published snapshots of this exact text generation survive storage swaps. */
  ownsCurrentSnapshot(snapshot: SourceSnapshot) {
    const current = this.#current
    return (
      this.#accepted.has(snapshot) &&
      snapshot.version === current.version &&
      snapshot.document.tabId === current.document.tabId &&
      snapshot.document.revision === current.document.revision
    )
  }
  /** A tab/replacement identity change does not copy text or rewind its content version. */
  reidentify(document: DocumentKey) {
    if (
      !document ||
      typeof document.tabId !== 'string' ||
      !safePosition(document.revision) ||
      !/^[\w.:-]{1,128}$/.test(document.tabId)
    )
      throw new Error('Invalid source session identity.')
    const before = this.#current
    if (
      before.document.tabId === document.tabId &&
      before.document.revision === document.revision
    )
      return before
    this.#rootId = increment(this.#rootId)
    this.#current = new SourceSnapshot(
      this.#tree,
      roots.get(before)!,
      Object.freeze({
        tabId: ownSourceText(document.tabId),
        revision: document.revision,
      }),
      before.version,
      before.storageEpoch,
      this.#rootId,
    )
    this.#accepted.add(this.#current)
    return this.#current
  }
  counters(reset = false): SourceBufferCounters {
    const result = { ...this.#tree.counters }
    if (reset) Object.assign(this.#tree.counters, newCounters())
    return result
  }
  prepare(value: SourceOperation): PreparedSourceOperation {
    const operation = parseSourceOperation(value),
      before = this.#current
    if (
      operation.document.tabId !== before.document.tabId ||
      operation.document.revision !== before.document.revision ||
      operation.baseVersion !== before.version
    )
      throw new Error('Source operation is stale.')
    let changed = false,
      shift = 0
    const inverse: RawEdit[] = []
    for (const edit of operation.changes) {
      if (!before.isEditBoundary(edit.from) || !before.isEditBoundary(edit.to))
        throw new Error(
          'Source operation splits a Unicode character or line ending, or is outside the source.',
        )
      const removed = before.sliceRaw(edit.from, edit.to)
      if (removed !== edit.insert) changed = true
      inverse.push(
        Object.freeze({
          from: edit.from + shift,
          to: edit.from + shift + edit.insert.length,
          insert: ownSourceText(removed),
        }),
      )
      shift += edit.insert.length - (edit.to - edit.from)
    }
    if (!changed) throw new Error('Source operation is empty.')
    // Every encoded UTF-16 unit needs at least one byte. Reject definitely
    // oversized bulk input before allocating its chunk indexes and tree paths.
    if (
      this.#tree.config.maximumBytes !== undefined &&
      before.utf16Length + shift > this.#tree.config.maximumBytes
    )
      throw new Error('Edited source exceeds the document size limit.')
    let root = roots.get(before)!
    for (let index = operation.changes.length - 1; index >= 0; index--)
      root = this.#tree.replace(root, operation.changes[index]!)
    if (
      this.#tree.config.maximumBytes !== undefined &&
      root.metrics.utf8Bytes > this.#tree.config.maximumBytes
    )
      throw new Error('Edited source exceeds the document size limit.')
    this.#rootId = increment(this.#rootId)
    const after = new SourceSnapshot(
      this.#tree,
      root,
      before.document,
      operation.contentVersion,
      before.storageEpoch,
      this.#rootId,
    )
    const prepared = Object.freeze({
      operation,
      before,
      after,
      inverse: safeInverse(after, inverse),
    })
    this.#prepared.add(prepared)
    return prepared
  }
  commit(prepared: PreparedSourceOperation): SourceSnapshot {
    if (!this.#prepared.delete(prepared) || prepared.before !== this.#current)
      throw new Error(
        'Source preparation is forged, stale, or already consumed.',
      )
    this.#current = prepared.after
    this.#accepted.add(this.#current)
    this.#tree.counters.publishedRoots++
    return this.#current
  }
  abort(prepared: PreparedSourceOperation) {
    this.#prepared.delete(prepared)
  }
  inspectStorage(): Generator<void, SourceStorageUsage | undefined> {
    const source = this.#current,
      work = this.#tree.storage(roots.get(source)!),
      store = this
    return (function* () {
      try {
        for (;;) {
          if (store.#current !== source)
            throw new Error('Source storage inspection is stale.')
          const next = work.next()
          if (next.done)
            return next.value
              ? Object.freeze({ source, ...next.value })
              : undefined
          yield
        }
      } finally {
        work.return(undefined)
      }
    })()
  }
  prepareCompaction(): Generator<void, SourceStorageChange | undefined> {
    const before = this.#current,
      work = this.#tree.rebuild(before.chunks()),
      store = this
    return (function* () {
      try {
        for (;;) {
          if (store.#current !== before)
            throw new Error('Source compaction is stale.')
          const next = work.next()
          if (next.done) {
            if (!next.value) return
            store.#rootId = increment(store.#rootId)
            const after = new SourceSnapshot(
              store.#tree,
              next.value,
              before.document,
              before.version,
              increment(before.storageEpoch),
              store.#rootId,
            )
            const change = Object.freeze({ before, after })
            store.#compactions.add(change)
            return change
          }
          yield
        }
      } finally {
        work.return(undefined)
      }
    })()
  }
  commitCompaction(change: SourceStorageChange): SourceSnapshot {
    if (!this.#compactions.delete(change) || change.before !== this.#current)
      throw new Error(
        'Source compaction is forged, stale, or already consumed.',
      )
    this.#tree.sealArena()
    this.#current = change.after
    this.#accepted.add(this.#current)
    acceptedStorageChanges.add(change)
    return this.#current
  }
  abortCompaction(change: SourceStorageChange) {
    this.#compactions.delete(change)
  }
  /** Explicit synchronous compatibility helper; production drives prepareCompaction in slices. */
  compact() {
    const work = this.prepareCompaction()
    for (;;) {
      const next = work.next()
      if (next.done) {
        if (!next.value) throw new Error('Source compaction was canceled.')
        return this.commitCompaction(next.value)
      }
    }
  }

  /** Explicit test/diagnostic traversal, never part of an accepted input commit. */
  inspect() {
    const root = roots.get(this.#current)!,
      occupancy: number[][] = [],
      problems: string[] = []
    const visit = (node: Node, isRoot: boolean) => {
      const maximum =
        node.kind === 'leaf'
          ? this.#tree.config.leafCapacity
          : this.#tree.config.fanout
      occupancy[node.height] ??= []
      occupancy[node.height]!.push(node.entries.length)
      if (
        node.entries.length > maximum ||
        (!isRoot && node.entries.length < Math.ceil(maximum / 2))
      )
        problems.push('occupancy')
      const sum = node.entries.reduce(
        (sum, entry) => combineMetrics(sum, entry.metrics),
        emptyMetrics,
      )
      if (JSON.stringify(sum) !== JSON.stringify(node.metrics))
        problems.push('metrics')
      if (node.kind === 'branch')
        for (const child of node.entries) {
          if (child.height !== node.height - 1) problems.push('height')
          visit(child, false)
        }
    }
    visit(root, true)
    return {
      pieceCount: root.pieces,
      leafCount: root.leaves,
      height: root.height + 1,
      occupancy,
      problems,
    }
  }
}
