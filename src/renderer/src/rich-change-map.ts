import { Fragment, type Node } from '@tiptap/pm/model'
import { StepMap } from '@tiptap/pm/transform'

type Span = { a: number; b: number; c: number; d: number }

/**
 * Maps the old preview into the new one from ranges that cover every edit,
 * in order: `[a, b)` in `before` became `[c, d)` in `after`. Content
 * between ranges must match exactly; where an edit had wider effects, the
 * ranges around the differing content merge.
 */
export function richRangeMap(
  before: Node,
  after: Node,
  ranges: readonly Span[],
) {
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
    if (
      range.a >= last.b &&
      range.c >= last.d &&
      range.a - last.b === range.c - last.d &&
      before.slice(last.b, range.a).eq(after.slice(last.d, range.c))
    )
      kept.push({ ...range })
    else {
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
