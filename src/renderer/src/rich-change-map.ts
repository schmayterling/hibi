import { Fragment, type Node, type Slice } from '@tiptap/pm/model'
import { StepMap } from '@tiptap/pm/transform'

// `[a, b)` in the old document became `[c, d)` in the new one.
type Span = { a: number; b: number; c: number; d: number }
type Edit = { from: number; to: number; insert: string }
type Lookup = ((position: number, from: 'source' | 'rich') => number | null) & {
  nearest(offset: number, side: -1 | 1): { source: number; rich: number } | null
}

/**
 * Maps the old preview into the new one through the source edits between
 * them, given in order in old source offsets, with each side's source
 * position lookup. Each edit is bounded by the nearest unchanged offsets that
 * both previews show as the same visible text, and narrowed to where the
 * previews differ; without such an offset it merges with its neighbour.
 */
export function richEditMap(
  before: Node,
  after: Node,
  edits: readonly Edit[],
  length: number,
  lookups: readonly [Lookup, Lookup],
) {
  // Visible text maps exactly both ways; anything else is a nearest guess.
  const exact = (side: 0 | 1, offset: number) => {
    const rich = lookups[side](offset, 'source')
    return rich !== null && lookups[side](rich, 'rich') === offset ? rich : null
  }
  // The nearest source offset toward `side`, within [low, high], that both
  // previews map exactly: visible text the edits left alone. A point where two
  // runs meet can be ambiguous; the next one inside a run is not.
  const anchor = (
    offset: number,
    shift: number,
    side: -1 | 1,
    low: number,
    high: number,
  ) => {
    for (let at = offset, tries = 0; tries < 8; tries++) {
      const point = lookups[0].nearest(at, side)
      if (!point || point.source < low || point.source > high) return null
      const a = exact(0, point.source),
        c = a === null ? null : exact(1, point.source + shift)
      if (a !== null && c !== null) return [a, c] as const
      at = point.source + side
    }
    return null
  }
  const windows: Span[] = []
  let shift = 0,
    previous = 0
  for (const [index, edit] of edits.entries()) {
    const next = shift + edit.insert.length - (edit.to - edit.from),
      start = anchor(edit.from, shift, -1, previous, edit.from),
      end = anchor(edit.to, next, 1, edit.to, edits[index + 1]?.from ?? length)
    const [b, d] = end ?? [before.content.size, after.content.size],
      last = windows.at(-1)
    if (last && (!start || start[0] < last.b || start[1] < last.d)) {
      last.b = Math.max(last.b, b)
      last.d = Math.max(last.d, d)
    } else {
      const [a, c] = start ?? [0, 0]
      windows.push({ a, b, c, d })
    }
    shift = next
    previous = edit.to
  }
  return rangeMap(
    before,
    after,
    windows.flatMap((window) => narrow(before, after, window)),
  )
}

// Child start offsets of each fragment, built when first needed. Resolving or
// cutting a position walks every earlier sibling, so doing that once per edit
// in a long document or list would read it once per edit.
const childStarts = new WeakMap<Fragment, number[]>()
function startsOf(fragment: Fragment) {
  const cached = childStarts.get(fragment)
  if (cached) return cached
  const starts: number[] = []
  let at = 0
  fragment.forEach((child) => {
    starts.push(at)
    at += child.nodeSize
  })
  childStarts.set(fragment, starts)
  return starts
}
// The first child of `fragment` that ends after `position`.
function childAfter(fragment: Fragment, position: number) {
  const list = startsOf(fragment)
  let low = 0,
    high = list.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if ((list[middle + 1] ?? fragment.size) <= position) low = middle + 1
    else high = middle
  }
  return low
}

// A copy of `node` holding only the children that [from, to) reaches, at
// every depth, and how far that moves the positions it keeps.
function prune(node: Node, from: number, to: number): [Node, number] {
  const list = startsOf(node.content),
    first = childAfter(node.content, from)
  let last = first,
    high = list.length
  while (last < high) {
    const middle = (last + high) >>> 1
    if (list[middle]! < to) last = middle + 1
    else high = middle
  }
  const children = node.content.content.slice(first, last),
    head = children[0],
    start = list[first]
  let moved = start ?? node.content.size
  if (head && start !== undefined && from > start && !head.isLeaf) {
    const [inner, shift] = prune(head, from - start - 1, to - start - 1)
    children[0] = inner
    moved += shift
  }
  return [node.type.create(node.attrs, children, node.marks), moved]
}
const sliceOf = (doc: Node, from: number, to: number) => {
  const [local, moved] = prune(doc, from, to)
  return local.slice(from - moved, to - moved)
}

// The containers around `position`, outermost first, each with the position
// just before it.
function containers(doc: Node, position: number) {
  const found: { node: Node; before: number }[] = []
  for (let node = doc, offset = 0; ; ) {
    const index = childAfter(node.content, position - offset),
      start = startsOf(node.content)[index]
    if (start === undefined || start >= position - offset) return found
    const child = node.child(index)
    if (child.isText || child.isLeaf) return found
    found.push({ node: child, before: offset + start })
    node = child
    offset += start + 1
  }
}

// The part of matching windows where the documents differ, if any.
function narrow(before: Node, after: Node, window: Span): Span[] {
  const left = sliceOf(before, window.a, window.b),
    right = sliceOf(after, window.c, window.d)
  if (left.openStart !== right.openStart || left.openEnd !== right.openEnd)
    return [window]
  const start = left.content.findDiffStart(right.content)
  const end = start === null ? null : left.content.findDiffEnd(right.content)
  if (start === null || !end) return []
  // Positions past either cut stand for the window's own edges.
  const overlap = Math.max(0, start - Math.min(end.a, end.b)),
    a = window.a - left.openStart,
    c = window.c - right.openStart,
    clamp = (value: number, low: number, high: number) =>
      Math.min(high, Math.max(low, value))
  return [
    {
      a: clamp(a + start, window.a, window.b),
      b: clamp(a + end.a + overlap, window.a, window.b),
      c: clamp(c + start, window.c, window.d),
      d: clamp(c + end.b + overlap, window.c, window.d),
    },
  ]
}

// Equal content between changes. The blocks cut at either end may change type,
// as when a heading marker is typed, without moving the positions inside.
function same(left: Slice, right: Slice) {
  const fragments = (
    a: Fragment,
    b: Fragment,
    open: number,
    close: number,
  ): boolean =>
    a.childCount === b.childCount &&
    a.content.every((child, index) => {
      const other = b.child(index),
        first = index === 0 && open > 0,
        last = index === a.childCount - 1 && close > 0
      return first || last
        ? fragments(
            child.content,
            other.content,
            first ? open - 1 : 0,
            last ? close - 1 : 0,
          )
        : child.eq(other)
    })
  return (
    left.openStart === right.openStart &&
    left.openEnd === right.openEnd &&
    fragments(left.content, right.content, left.openStart, left.openEnd)
  )
}

/**
 * Maps through ranges that cover every change, in order. Content between
 * ranges must match exactly; where a change had wider effects, the ranges
 * around the differing content merge.
 */
function rangeMap(before: Node, after: Node, ranges: readonly Span[]) {
  const fits = (b: number, d: number, a: number, c: number) =>
    a >= b &&
    c >= d &&
    a - b === c - d &&
    same(sliceOf(before, b, a), sliceOf(after, d, c))
  // Where the containers at a gap's edge differ, as when `> ` wraps a paragraph
  // in a quote, the gap starts after the outermost differing one and ends
  // before it, so unchanged siblings still anchor the ranges beside it.
  const edge = (position: number, next: number, end: boolean) => {
    const left = containers(before, position),
      right = containers(after, next)
    for (let depth = 0; depth < Math.max(left.length, right.length); depth++) {
      const a = left[depth],
        b = right[depth]
      if (a && b && a.node.hasMarkup(b.node.type, b.node.attrs, b.node.marks))
        continue
      const side = (found: typeof a, at: number) =>
        found ? found.before + (end ? 0 : found.node.nodeSize) : at
      return [side(a, position), side(b, next)] as const
    }
    return [position, next] as const
  }
  const kept: Span[] = [{ a: 0, b: 0, c: 0, d: 0 }]
  for (const range of [
    ...ranges,
    {
      a: before.content.size,
      b: before.content.size,
      c: after.content.size,
      d: after.content.size,
    },
  ]) {
    const last = kept.at(-1)!
    if (fits(last.b, last.d, range.a, range.c)) {
      kept.push({ ...range })
      continue
    }
    const [b, d] = edge(last.b, last.d, false),
      [a, c] = edge(range.a, range.c, true)
    if (fits(b, d, a, c)) {
      last.b = b
      last.d = d
      kept.push({ ...range, a, c })
    } else {
      last.b = Math.max(last.b, range.b)
      last.d = Math.max(last.d, range.d)
    }
  }
  const steps = kept.flatMap(({ a, b, c, d }) =>
    b > a || d > c ? [a, b - a, d - c] : [],
  )
  return steps.length ? new StepMap(steps) : StepMap.empty
}

/**
 * Maps positions from one parse of a document to the next when the edits
 * between them are unknown, through only the ranges that differ. Top-level
 * blocks unique on both sides anchor the match (as in patience diff), equal
 * neighbours extend it, and each remaining gap is narrowed to its first and
 * last differing positions.
 */
export function richChangeMap(before: Node, after: Node) {
  const blocks = (doc: Node) => {
    const nodes: Node[] = [],
      starts: number[] = []
    doc.forEach((node, offset) => {
      nodes.push(node)
      starts.push(offset)
    })
    starts.push(doc.content.size)
    return { nodes, starts }
  }
  const a = blocks(before),
    b = blocks(after)
  const key = (node: Node) =>
    `${node.type.name}\u0000${JSON.stringify(node.attrs)}\u0000${node.textContent}`
  const seen = new Map<string, { a: number; b: number }>()
  for (const [side, list] of [
    ['a', a.nodes],
    ['b', b.nodes],
  ] as const)
    list.forEach((node, index) => {
      const text = key(node)
      const entry = seen.get(text) ?? { a: -1, b: -1 }
      entry[side] = entry[side] === -1 ? index : -2
      seen.set(text, entry)
    })
  // The longest run of unique pairs that stays in order on both sides.
  const pairs = [...seen.values()]
    .filter(
      (pair) =>
        pair.a >= 0 && pair.b >= 0 && a.nodes[pair.a]!.eq(b.nodes[pair.b]!),
    )
    .sort((x, y) => x.a - y.a)
  const tails: number[] = [],
    previous: number[] = []
  pairs.forEach((pair, index) => {
    let low = 0,
      high = tails.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (pairs[tails[middle]!]!.b < pair.b) low = middle + 1
      else high = middle
    }
    previous[index] = low ? tails[low - 1]! : -1
    tails[low] = index
  })
  const anchors: { a: number; b: number }[] = []
  for (let at = tails.at(-1) ?? -1; at >= 0; at = previous[at]!)
    anchors.push(pairs[at]!)
  anchors.reverse().push({ a: a.nodes.length, b: b.nodes.length })
  const ranges: number[] = []
  let fromA = 0,
    fromB = 0
  for (const anchor of anchors) {
    let toA = anchor.a,
      toB = anchor.b
    while (fromA < toA && fromB < toB && a.nodes[fromA]!.eq(b.nodes[fromB]!)) {
      fromA++
      fromB++
    }
    while (
      toA > fromA &&
      toB > fromB &&
      a.nodes[toA - 1]!.eq(b.nodes[toB - 1]!)
    ) {
      toA--
      toB--
    }
    if (fromA < toA || fromB < toB) {
      const gapA = Fragment.fromArray(a.nodes.slice(fromA, toA)),
        gapB = Fragment.fromArray(b.nodes.slice(fromB, toB))
      const start = gapA.findDiffStart(gapB)
      const end = start === null ? null : gapA.findDiffEnd(gapB)
      if (start !== null && end) {
        const overlap = Math.max(0, start - Math.min(end.a, end.b))
        ranges.push(
          a.starts[fromA]! + start,
          end.a + overlap - start,
          end.b + overlap - start,
        )
      }
    }
    fromA = anchor.a + 1
    fromB = anchor.b + 1
  }
  return ranges.length ? new StepMap(ranges) : StepMap.empty
}
