import { DocInput } from '@codemirror/language'
import {
  type EditorState,
  StateEffect,
  StateField,
  type Text,
} from '@codemirror/state'
import { type EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import type { SyntaxNode, Tree } from '@lezer/common'
import {
  type MarkdownConfig,
  type MarkdownParser,
  parser,
} from '@lezer/markdown'
import { mappedPrefix } from '../../../shared/source-projection.ts'
import { ChunkedMarkdownParser } from '../chunked-markdown.ts'
import {
  formattedMarkdown,
  formattedOwner,
  formattedPrefix,
  formattedRefresh,
  formattedSyntaxTree,
} from '../formatted-contributions.ts'

/*
 * The labels a note defines, so a footnote reference knows whether it
 * resolves. The note is read as Markdown blocks, without inline syntax, in
 * stretches that start at top-level blocks, so a definition counts where the
 * formatted view parses one: code, HTML and paragraph text define nothing,
 * list items and quotes can. Opening a note reads none of it: once a
 * reference is in view, the start of the note is read before that frame
 * paints and idle time reads the rest, in slices sized to the time left. An edit reads again from the stretch before it until blocks start
 * where they did after it, usually within the next block, or further when,
 * say, a code fence opens above; stretches keep their labels until then.
 */

/** Work counters, slice and window sizes, for scale tests. */
export const footnoteScan = {
  /** Most characters an idle slice parses; an edit parses up to a sixteenth of it at once. */
  slice: 1 << 20,
  /** Characters per millisecond a first idle slice assumes; later slices use the rate they measured. */
  rate: 4096,
  /** Characters a reading window covers, past three more lines. */
  window: 4096,
  /** Characters parsed. */
  parsed: 0,
  /** Characters inspected while finding a window's following lines. */
  scanned: 0,
  /** Label counts copied into leaves that changed. */
  copied: 0,
}

/** Stretches per group: changing one copies its group and the list of groups. */
const groupSize = 64

type Stretch = { readonly length: number; readonly labels: readonly string[] }
type Group = { readonly length: number; readonly stretches: readonly Stretch[] }
/** Label counts in a hash trie: a change copies the nodes and leaves on its labels' paths. */
type Leaf = Map<string, number>
/** Labels whose hashes are equal, sorted, in chunks of up to 16: a change copies one chunk and the list of chunks. */
type Collisions = { chunks: (readonly [label: string, count: number])[][] }
type Labels = (Labels | Leaf | Collisions | undefined)[]
/** Children per node, picked by this many bits of a label's hash. */
const fanOut = 32
const bits = 5
/** Labels a leaf holds before it splits into a node. */
const leafSize = 16

const groupOf = (stretches: readonly Stretch[]): Group => ({
  length: stretches.reduce((sum, stretch) => sum + stretch.length, 0),
  stretches,
})

/** The stretch holding `pos`, or the last one at the end. */
function locate(groups: readonly Group[], start: number, pos: number) {
  let at = start
  for (let group = 0; group < groups.length; group++) {
    const { length, stretches } = groups[group]!
    if (pos >= at + length && group < groups.length - 1) {
      at += length
      continue
    }
    for (let index = 0; index < stretches.length; index++) {
      const stretch = stretches[index]!
      if (pos < at + stretch.length || index === stretches.length - 1)
        return { group, index, from: at, to: at + stretch.length, stretch }
      at += stretch.length
    }
  }
  return null
}

/**
 * Replace the stretches overlapping `from`-`to`, where `from` starts a
 * stretch, with those `build` makes from the removed ones and where the last
 * of them ended.
 */
function replace(
  groups: readonly Group[],
  start: number,
  from: number,
  to: number,
  build: (removed: readonly Stretch[], end: number) => readonly Stretch[],
) {
  const first = locate(groups, start, from)
  const last = locate(groups, start, Math.max(from, to - 1))
  if (!first || !last) return { groups, removed: [], end: from }
  const removed: Stretch[] = []
  for (let group = first.group; group <= last.group; group++) {
    const { stretches } = groups[group]!
    removed.push(
      ...stretches.slice(
        group === first.group ? first.index : 0,
        group === last.group ? last.index + 1 : stretches.length,
      ),
    )
  }
  const middle = [
    ...groups[first.group]!.stretches.slice(0, first.index),
    ...build(removed, last.to),
    ...groups[last.group]!.stretches.slice(last.index + 1),
  ]
  const regrouped: Group[] = []
  for (let i = 0; i < middle.length; i += groupSize)
    regrouped.push(groupOf(middle.slice(i, i + groupSize)))
  return {
    groups: [
      ...groups.slice(0, first.group),
      ...regrouped,
      ...groups.slice(last.group + 1),
    ],
    removed,
    end: last.to,
  }
}

function hashOf(label: string) {
  let hash = 0
  for (let i = 0; i < label.length; i++)
    hash = (hash * 31 + label.charCodeAt(i)) | 0
  return hash
}

/** The chunk that holds or would hold a label: the last one starting at or before it. */
function chunkOf({ chunks }: Collisions, label: string) {
  let low = 0,
    high = chunks.length - 1
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if ((chunks[middle]?.[0]?.[0] ?? '') <= label) low = middle
    else high = middle - 1
  }
  return low
}

/** How many times the note defines a label. */
function countOf(labels: Labels, label: string) {
  const hash = hashOf(label)
  let node: Labels | Leaf | Collisions | undefined = labels
  for (let shift = 0; Array.isArray(node); shift += bits)
    node = node[(hash >>> shift) & (fanOut - 1)]
  if (!node || node instanceof Map) return node?.get(label) ?? 0
  const chunk = node.chunks[chunkOf(node, label)]
  return chunk?.find(([key]) => key === label)?.[1] ?? 0
}

/** Change a label's count among labels whose hashes are equal, copying its chunk once. */
function collide(
  slot: Collisions | undefined,
  label: string,
  delta: number,
  copies: Set<object>,
) {
  let collisions = slot
  if (!collisions || !copies.has(collisions)) {
    collisions = { chunks: slot ? slot.chunks.slice() : [] }
    copies.add(collisions)
  }
  const { chunks } = collisions
  const at = chunkOf(collisions, label)
  let chunk = chunks[at] ?? []
  if (!copies.has(chunk)) {
    footnoteScan.copied += chunk.length
    chunk = chunk.slice()
    copies.add(chunk)
  }
  const found = chunk.findIndex(([key]) => key >= label)
  const index = found < 0 ? chunk.length : found
  const count = (chunk[index]?.[0] === label ? chunk[index][1] : 0) + delta
  chunk.splice(index, chunk[index]?.[0] === label ? 1 : 0)
  if (count > 0) chunk.splice(index, 0, [label, count])
  if (chunk.length > leafSize) {
    const halves = [chunk.slice(0, leafSize >> 1), chunk.slice(leafSize >> 1)]
    footnoteScan.copied += chunk.length
    for (const half of halves) copies.add(half)
    chunks.splice(at, 1, ...halves)
  } else if (chunk.length) chunks[at] = chunk
  else chunks.splice(at, 1)
  return chunks.length ? collisions : undefined
}

/** A node holding a full leaf's labels, by the next bits of their hashes. */
function split(leaf: Leaf, shift: number, copies: Set<object>) {
  const node: Labels = new Array(fanOut)
  copies.add(node)
  for (const [label, count] of leaf) {
    const index = (hashOf(label) >>> shift) & (fanOut - 1)
    // Hashes have 32 bits; past them, labels are told apart in sorted chunks.
    if (shift + bits >= 32) {
      node[index] = collide(
        node[index] as Collisions | undefined,
        label,
        count,
        copies,
      )
      continue
    }
    let child = node[index] as Leaf | undefined
    if (!child) {
      child = new Map()
      node[index] = child
      copies.add(child)
    }
    child.set(label, count)
  }
  footnoteScan.copied += leaf.size
  return node
}

/**
 * Apply per-label changes, skipping those that cancel out. Each node and leaf
 * on their paths is copied once, then changed in place.
 */
function apply(labels: Labels, deltas: ReadonlyMap<string, number>): Labels {
  const copies = new Set<object>()
  let root = labels
  for (const [label, delta] of deltas) {
    if (!delta) continue
    if (!copies.has(root)) {
      root = root.slice()
      copies.add(root)
    }
    const hash = hashOf(label)
    let node = root
    for (let shift = 0; ; shift += bits) {
      const index = (hash >>> shift) & (fanOut - 1)
      const child = node[index]
      if (Array.isArray(child)) {
        const copy = copies.has(child) ? child : child.slice()
        copies.add(copy)
        node[index] = copy
        node = copy
        continue
      }
      if (shift + bits >= 32) {
        node[index] = collide(
          child as Collisions | undefined,
          label,
          delta,
          copies,
        )
        break
      }
      let leaf = child as Leaf | undefined
      if (!leaf || !copies.has(leaf)) {
        footnoteScan.copied += leaf?.size ?? 0
        leaf = new Map(leaf)
        copies.add(leaf)
      }
      const count = (leaf.get(label) ?? 0) + delta
      if (count > 0) leaf.set(label, count)
      else leaf.delete(label)
      node[index] =
        leaf.size > leafSize
          ? split(leaf, shift + bits, copies)
          : leaf.size
            ? leaf
            : undefined
      break
    }
  }
  return root
}

/** Add stretches after the last, filling its group first. */
function append(groups: readonly Group[], stretches: readonly Stretch[]) {
  const tail = groups.at(-1)
  const open = tail && tail.stretches.length < groupSize
  const rest = open ? [...tail.stretches, ...stretches] : stretches
  const next = open ? groups.slice(0, -1) : groups.slice()
  for (let i = 0; i < rest.length; i += groupSize)
    next.push(groupOf(rest.slice(i, i + groupSize)))
  return next
}

type Index = {
  /** The syntax the stretches were read with. */
  configs: readonly MarkdownConfig[]
  /** Where stretches start, after a prefix such as frontmatter, which defines nothing. */
  start: number
  /** Stretches from `start` to `read`, each starting at a top-level block. */
  groups: readonly Group[]
  read: number
  /** Stretches to read again: from this stretch start until blocks start where they did, at or after `to`. */
  stale: { from: number; to: number } | null
  /** A stretch whose block runs past the windows read so far. */
  pending: Pending | null
  labels: Labels
}

type Lines = readonly { from: number; to: number }[]
/**
 * The stretch from `from` continues at line start `at`: parsing the lines in
 * `head`, the opening lines of the blocks open there, and then the text from
 * `at` should recreate the blocks open there, `chain`. When it did not,
 * `whole` reads from `from` again, twice as far each time. `labels` were
 * defined since `from`.
 */
type Pending = {
  from: number
  at: number
  /** Null until the first window has parsed; otherwise its continuation context. */
  head: Lines | null
  chain: string
  whole: boolean
  labels: readonly string[]
  ahead?: Lookahead | undefined
}

/** A window and its following lines, found a bounded part at a time. */
type Lookahead = {
  last: number
  end: number
  found: readonly number[]
  ranges: Lines
  blanks: number
}

const scanners = new WeakMap<readonly MarkdownConfig[], MarkdownParser>()
/** The view's block syntax without inline syntax, as the formatted view scans it. */
function scanner(configs: readonly MarkdownConfig[]) {
  let scan = scanners.get(configs)
  if (!scan) {
    const base = parser.configure([...configs])
    scan = new ChunkedMarkdownParser(base, base).scan
    scanners.set(configs, scan)
  }
  return scan
}

const prefixOf = (state: EditorState) =>
  Math.max(0, ...state.facet(formattedPrefix).map((prefix) => prefix(state)))

/**
 * Labels of the definitions starting in `from`-`to` of a window parsed from
 * `base`, whose tree positions start at the window, lowercased as references
 * match them.
 */
function labelsIn(
  tree: Tree,
  doc: Text,
  base: number,
  from: number,
  to: number,
) {
  const labels: string[] = []
  tree.iterate({
    from: from - base,
    to: to - base,
    enter(node) {
      if (node.name !== 'FootnoteDefinition') return
      const label = node.node.getChild('FootnoteLabel')
      if (label && node.from + base >= from && node.from + base < to)
        labels.push(
          doc.sliceString(label.from + base, label.to + base).toLowerCase(),
        )
    },
  })
  return labels
}

/** Find three following lines, retaining the edges of runs of empty lines. */
function lookAhead(doc: Text, value: Lookahead, budget: number): Lookahead {
  let { last, end, blanks } = value
  const found = [...value.found]
  const ranges = [...value.ranges]
  const keep = (line: { from: number; to: number }) => {
    const to = Math.min(doc.length, line.to + 1)
    const previous = ranges.at(-1)
    if (previous?.to === line.from)
      ranges[ranges.length - 1] = { from: previous.from, to }
    else ranges.push({ from: line.from, to })
  }
  for (
    let spent = 0;
    found.length < 3 && last < doc.lines && spent < budget;
  ) {
    const line = doc.line(++last)
    end = line.to
    const size = line.to - line.from + 1
    footnoteScan.scanned += size
    spent += size
    if (/^[ \t]*$/.test(line.text)) {
      // Two blank lines preserve empty-list and loose-list decisions. More
      // whitespace changes no block, so keep only the last line as well.
      if (++blanks <= 2) keep(line)
    } else {
      if (blanks > 2) keep(doc.line(last - 1))
      keep(line)
      blanks = 0
      found.push(last)
    }
  }
  if (last === doc.lines && blanks > 2) keep(doc.line(last))
  return { last, end, blanks, found, ranges }
}

/** The blocks open at line start `pos` of a tree parsed from `base`, innermost first. */
function* openAt(tree: Tree, doc: Text, base: number, pos: number) {
  for (
    let node: SyntaxNode | null = tree.resolveInner(pos - base, 1);
    node;
    node = node.parent
  )
    if (
      !node.type.isTop &&
      node.type.is('Block') &&
      doc.lineAt(base + node.from).from < pos
    )
      yield node
}

const chainAt = (tree: Tree, doc: Text, base: number, pos: number) =>
  [...openAt(tree, doc, base, pos)].map((node) => node.name).join('/')

/**
 * The opening lines of the blocks open at line start `pos`, and the blank
 * line before it that closed a paragraph there, in document order.
 */
function openingLines(tree: Tree, doc: Text, base: number, pos: number) {
  const lines: { from: number; to: number }[] = []
  const before = pos > 0 ? doc.lineAt(pos - 1) : null
  if (before && /^[ \t>]*$/.test(before.text))
    lines.push({ from: before.from, to: pos })
  for (const node of openAt(tree, doc, base, pos)) {
    const first = doc.lineAt(base + node.from)
    // A table stays one with its delimiter row.
    const count = node.name === 'Table' ? 2 : 1
    for (let n = first.number; n < first.number + count; n++) {
      const line = doc.line(n)
      if (line.from >= pos) break
      if (!lines.some((open) => open.from === line.from))
        lines.push({ from: line.from, to: Math.min(doc.length, line.to + 1) })
    }
  }
  return lines.sort((a, b) => a.from - b.from)
}

/**
 * Read for up to `budget` characters: stale stretches first, then the unread
 * rest. Blocks that start two lines before a window's end are where a
 * whole-note parse puts them, so reading cuts at the last of them, or at the
 * line after one that ended. A block that runs past a window goes on in the
 * next from its last lines, after the opening lines of the blocks open there,
 * so no text is parsed twice and lines longer than a window are the only
 * reads longer than one.
 */
function step(index: Index, doc: Text, budget: number): Index {
  let { groups, read, stale, pending } = index
  const { start } = index
  const scan = scanner(index.configs)
  const deltas = new Map<string, number>()
  const count = (labels: readonly string[], by: number) => {
    for (const label of labels) deltas.set(label, (deltas.get(label) ?? 0) + by)
  }
  // Stretches read past the rest, added at the end.
  const appended: Stretch[] = []
  for (let spent = 0; spent < budget && (stale || read < doc.length); ) {
    const from = stale ? stale.from : read
    if (from >= doc.length) {
      // Nothing is left past stale stretches that an edit emptied.
      if (stale) {
        const done = replace(groups, start, from, read, () => [])
        for (const stretch of done.removed) count(stretch.labels, -1)
        groups = done.groups
      }
      read = doc.length
      stale = null
      pending = null
      break
    }
    const going = pending?.from === from ? pending : null
    const replay = going && !going.whole && going.head ? going : null
    const at = replay?.at ?? from
    const head = replay?.head ?? []
    const reach = going?.whole
      ? from + Math.max(footnoteScan.window, 2 * (going.at - from))
      : at + footnoteScan.window
    // A blank run is decided by the line after it. Find that context in
    // slices, and omit the run's interior from the eventual parse too.
    const edge = doc.lineAt(Math.min(doc.length, reach))
    const scanned = footnoteScan.scanned
    const ahead = lookAhead(
      doc,
      going?.ahead ?? {
        last: edge.number,
        end: edge.to,
        found: [],
        ranges: [{ from: at, to: Math.min(doc.length, edge.to + 1) }],
        blanks: 0,
      },
      Math.max(footnoteScan.window, budget - spent),
    )
    spent += footnoteScan.scanned - scanned
    if (ahead.found.length < 3 && ahead.last < doc.lines) {
      pending = {
        from,
        at,
        head: replay?.head ?? null,
        chain: replay?.chain ?? '',
        whole: going?.whole ?? false,
        labels: replay?.labels ?? [],
        ahead,
      }
      continue
    }
    const end = ahead.end
    const last = end >= doc.length
    const ranges = [...head, ...ahead.ranges]
    ranges[ranges.length - 1] = { ...ranges.at(-1)!, to: end }
    const units = ranges.reduce((sum, line) => sum + line.to - line.from, 0)
    footnoteScan.parsed += units
    spent += units
    // The tree's positions start at its first range.
    const base = ranges[0]!.from
    const tree = scan.parse(new DocInput(doc), [], ranges)
    if (replay && chainAt(tree, doc, base, at) !== replay.chain) {
      // The opening lines did not recreate the blocks open there.
      pending = { ...replay, whole: true, ahead: undefined }
      continue
    }
    const limit = last
      ? doc.length
      : doc.line(Math.max(1, ahead.found.at(-2)! - 1)).from
    let cut = last ? doc.length : -1
    let resync = false
    // Stretches start at a block's line, since indentation before it can
    // decide what it is, or between blocks.
    const lowest = replay ? at : from + 1
    for (
      let child = tree.topNode.firstChild;
      child && !resync;
      child = child.nextSibling
    ) {
      const after = doc.lineAt(base + child.to).to + 1
      for (const point of [doc.lineAt(base + child.from).from, after]) {
        if (point < lowest || point > limit) continue
        if (!last) cut = point
        // Blocks start where a stretch read before starts: the rest is as it was.
        if (
          stale &&
          point >= stale.to &&
          point < read &&
          locate(groups, start, point)?.from === point
        ) {
          cut = point
          resync = true
          break
        }
      }
    }
    if (cut < 0) {
      // The block goes on past the window.
      pending = {
        from,
        at: limit,
        head: openingLines(tree, doc, base, limit),
        chain: chainAt(tree, doc, base, limit),
        whole: false,
        labels: [
          ...(replay?.labels ?? []),
          ...labelsIn(tree, doc, base, at, limit),
        ],
      }
      continue
    }
    pending = null
    const labels = [
      ...(replay?.labels ?? []),
      ...labelsIn(tree, doc, base, at, cut),
    ]
    count(labels, 1)
    if (from < read) {
      // A stretch running past the cut keeps its labels until it is read again.
      let rest = 0
      const done = replace(
        groups,
        start,
        from,
        Math.min(cut, read),
        (removed, end) => {
          for (const stretch of removed) count(stretch.labels, -1)
          const tail = end > cut ? removed.at(-1)! : null
          if (!tail) return [{ length: cut - from, labels }]
          rest = end
          count(tail.labels, 1)
          return [
            { length: cut - from, labels },
            { length: end - cut, labels: tail.labels },
          ]
        },
      )
      groups = done.groups
      if (cut >= read) {
        read = cut
        stale = null
      } else if (resync) stale = null
      else stale = { from: cut, to: Math.max(stale?.to ?? cut, rest) }
    } else {
      appended.push({ length: cut - from, labels })
      read = cut
    }
  }
  return {
    ...index,
    groups: appended.length ? append(groups, appended) : groups,
    read,
    stale,
    pending,
    labels: apply(index.labels, deltas),
  }
}

/** Reads about this many more characters of the note; formatted views dispatch it in idle time. */
export const readDefinitions = StateEffect.define<number>()

/** An index that has read nothing yet. */
function create(state: EditorState): Index {
  const start = prefixOf(state)
  return {
    configs: state.facet(formattedMarkdown),
    start,
    groups: [],
    read: start,
    stale: null,
    pending: null,
    labels: new Array(fanOut),
  }
}

/** One stretch stands for the edited text and the stretches it touched, keeping their labels until read again. */
function edit(index: Index, state: EditorState, changes: EditorStateChanges) {
  let { groups, read, stale, pending } = index
  const { start } = index
  const doc = state.doc
  let offset = 0
  for (const { fromA, toA, fromB, toB } of changes) {
    const size = toB - fromB - (toA - fromA)
    // A block read on past windows holds while edits come after its last read line.
    if (pending && fromA + offset <= (pending.ahead?.end ?? pending.at - 1))
      pending = null
    // Positions in this note's terms; later text still has the old offset.
    const from = fromA + offset,
      to = toA + offset
    if (stale) {
      if (stale.from >= to) stale = { ...stale, from: stale.from + size }
      if (stale.to >= to) stale = { ...stale, to: stale.to + size }
    }
    offset += size
    // Blocks can join across the two lines above an edit.
    const near = doc.line(Math.max(1, doc.lineAt(fromB).number - 2)).from
    if (near >= read) continue
    if (to > read) {
      // An edit past the read text: read again from the stretch before it.
      const cut = locate(groups, start, Math.max(start, near))?.from ?? start
      const deltas = new Map<string, number>()
      groups = replace(groups, start, cut, read, (removed) => {
        for (const stretch of removed)
          for (const label of stretch.labels)
            deltas.set(label, (deltas.get(label) ?? 0) - 1)
        return []
      }).groups
      index = { ...index, labels: apply(index.labels, deltas) }
      read = cut
      stale = stale && stale.from < cut ? { ...stale, to: cut } : null
      continue
    }
    const first = locate(groups, start, Math.max(start, near))
    if (!first) continue
    const done = replace(
      groups,
      start,
      first.from,
      Math.max(to, from + 1),
      (removed, end) => [
        {
          length: end - first.from + size,
          labels: removed.flatMap((stretch) => stretch.labels),
        },
      ],
    )
    groups = done.groups
    read += size
    const end = done.end + size
    stale = stale
      ? { from: Math.min(stale.from, first.from), to: Math.max(stale.to, end) }
      : { from: first.from, to: end }
  }
  return { ...index, groups, read, stale, pending }
}

type EditorStateChanges = readonly {
  fromA: number
  toA: number
  fromB: number
  toB: number
}[]

/** Groups are relative to start; unfinished reads also carry absolute offsets and line numbers. */
function shiftPrefix(index: Index, start: number, lines: number): Index {
  const size = start - index.start
  if (!size && !lines) return index
  const shift = (ranges: Lines) =>
    ranges.map(({ from, to }) => ({ from: from + size, to: to + size }))
  const { pending, stale } = index
  const ahead = pending?.ahead
  return {
    ...index,
    start,
    read: index.read + size,
    stale: stale ? { from: stale.from + size, to: stale.to + size } : null,
    pending: pending
      ? {
          ...pending,
          from: pending.from + size,
          at: pending.at + size,
          head: pending.head ? shift(pending.head) : null,
          ...(ahead
            ? {
                ahead: {
                  ...ahead,
                  last: ahead.last + lines,
                  end: ahead.end + size,
                  found: ahead.found.map((line) => line + lines),
                  ranges: shift(ahead.ranges),
                },
              }
            : {}),
        }
      : null,
  }
}

export const footnoteDefinitions = StateField.define<Index>({
  create,
  update(index, transaction) {
    const { state } = transaction
    const prefix = prefixOf(state)
    if (state.facet(formattedMarkdown) !== index.configs) return create(state)
    const changes: EditorStateChanges[number][] = []
    transaction.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
      changes.push({ fromA, toA, fromB, toB })
    })
    let next = index
    if (
      transaction.docChanged &&
      mappedPrefix(index.start, changes) === prefix
    ) {
      next = shiftPrefix(
        index,
        prefix,
        state.doc.lineAt(prefix).number -
          transaction.startState.doc.lineAt(index.start).number,
      )
    } else {
      // A changed prefix boundary or replacement of the body needs a fresh index.
      if (
        prefix !== index.start ||
        prefix !== transaction.changes.mapPos(index.start, -1)
      )
        return create(state)
      if (transaction.docChanged) {
        next = edit(index, state, changes)
        if (next.stale) next = step(next, state.doc, footnoteScan.slice >> 4)
      }
    }
    for (const effect of transaction.effects)
      if (effect.is(readDefinitions)) next = step(next, state.doc, effect.value)
    return next
  },
})

/** Whether the note defines a reference's label. */
export function defined(state: EditorState, label: string) {
  // A table cell's own state reads the index of the view that draws it.
  const index =
    state.field(footnoteDefinitions, false) ??
    state.facet(formattedOwner)?.field(footnoteDefinitions, false)
  return !!index && countOf(index.labels, label.toLowerCase()) > 0
}

/** Whether all of the note has been read. */
export function definitionsRead(state: EditorState) {
  const index = state.field(footnoteDefinitions, false)
  return !index || (!index.stale && index.read >= state.doc.length)
}

/** Whether `text` has `[^` from `from` to `to`, read in the document's own chunks. */
function referenceText(doc: Text, from: number, to: number) {
  let previous = ''
  for (const iter = doc.iterRange(from, to); !iter.next().done; ) {
    if ((previous + iter.value).includes('[^')) return true
    previous = iter.value.slice(-1)
  }
  return false
}

/**
 * Whether a footnote reference is in view. Tables draw their cells in
 * widgets, which leave their text out of the visible ranges, so a table in
 * the viewport counts when its text there has one.
 */
function referenceInView(view: EditorView) {
  const tree = formattedSyntaxTree(view.state)
  const { from, to } = view.viewport
  let found = false
  tree?.iterate({
    from,
    to,
    enter: (node) => {
      if (found) return false
      if (node.name === 'FootnoteReference') found = true
      else if (node.name === 'Table')
        found = referenceText(
          view.state.doc,
          Math.max(from, node.from),
          Math.min(to, node.to),
        )
      else return undefined
      return false
    },
  })
  return found
}

/**
 * Reads the note in idle time once a reference is in view, each slice what
 * its time allows, and draws references again when labels change.
 */
export const definitionReader = ViewPlugin.fromClass(
  class {
    private idle = 0
    /** Whether a reference has been in view; until then nothing is read. */
    private wanted = false
    private destroyed = false
    /** Characters read per millisecond, as the last slice measured. */
    private rate = footnoteScan.rate
    private readonly view: EditorView
    constructor(view: EditorView) {
      this.view = view
      this.schedule()
    }
    update(update: ViewUpdate) {
      this.schedule(
        update.docChanged ||
          update.viewportChanged ||
          formattedSyntaxTree(update.state) !==
            formattedSyntaxTree(update.startState),
      )
    }
    schedule(look = true) {
      if (!this.wanted && look && referenceInView(this.view)) {
        this.wanted = true
        // The start of the note before this frame paints, as much as an edit
        // reads, so a short note's references draw resolved; idle time reads
        // the rest.
        queueMicrotask(() => {
          if (!this.destroyed) this.read(footnoteScan.slice >> 4)
        })
        return
      }
      if (this.idle || !this.wanted || definitionsRead(this.view.state)) return
      this.idle = requestIdleCallback((deadline) => {
        this.idle = 0
        const budget = Math.min(
          footnoteScan.slice,
          Math.max(
            footnoteScan.window,
            Math.floor(this.rate * deadline.timeRemaining()),
          ),
        )
        const work = footnoteScan.parsed + footnoteScan.scanned
        const start = performance.now()
        this.read(budget)
        const spent = performance.now() - start
        if (spent >= 1)
          this.rate =
            (footnoteScan.parsed + footnoteScan.scanned - work) / spent
      })
    }
    /** Read about `budget` more characters; references draw again when labels change. */
    read(budget: number) {
      const { labels } = this.view.state.field(footnoteDefinitions)
      this.view.dispatch({ effects: readDefinitions.of(budget) })
      if (this.view.state.field(footnoteDefinitions).labels !== labels)
        this.view.dispatch({ effects: formattedRefresh.of(null) })
    }
    destroy() {
      this.destroyed = true
      if (this.idle) cancelIdleCallback(this.idle)
    }
  },
)
