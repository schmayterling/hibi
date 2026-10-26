import { DocInput } from '@codemirror/language'
import {
  type EditorState,
  StateEffect,
  StateField,
  type Text,
} from '@codemirror/state'
import { type EditorView, ViewPlugin } from '@codemirror/view'
import type { Tree } from '@lezer/common'
import {
  type MarkdownConfig,
  type MarkdownParser,
  parser,
} from '@lezer/markdown'
import { ChunkedMarkdownParser } from '../chunked-markdown.ts'
import {
  formattedMarkdown,
  formattedPrefix,
  formattedRefresh,
} from '../formatted-contributions.ts'

/*
 * The labels a note defines, so a footnote reference knows whether it
 * resolves. The note is read as Markdown blocks, without inline syntax, in
 * stretches that start at top-level blocks, so a definition counts where the
 * formatted view parses one: code, HTML and paragraph text define nothing,
 * list items and quotes can. Opening a note reads part of it and idle time
 * the rest. An edit reads again from the stretch before it until blocks start
 * where they did after it, usually within the next block, or further when,
 * say, a code fence opens above; stretches keep their labels until then.
 */

/** Work counters, slice and window sizes, for scale tests. */
export const footnoteScan = {
  /** Characters to parse per idle slice; an edit parses up to a sixteenth of it at once. */
  slice: 1 << 20,
  /** Characters a reading window covers, doubled while one block fills it. */
  window: 4096,
  /** Characters parsed. */
  parsed: 0,
  /** Label counts copied into leaves that changed. */
  copied: 0,
}

/** Stretches per group: changing one copies its group and the list of groups. */
const groupSize = 64

type Stretch = { readonly length: number; readonly labels: readonly string[] }
type Group = { readonly length: number; readonly stretches: readonly Stretch[] }
/** Label counts in a hash trie: a change copies the nodes and leaves on its labels' paths. */
type Leaf = Map<string, number>
type Labels = (Labels | Leaf | undefined)[]
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

/** How many times the note defines a label. */
function countOf(labels: Labels, label: string) {
  const hash = hashOf(label)
  let node: Labels | Leaf | undefined = labels
  for (let shift = 0; Array.isArray(node); shift += bits)
    node = node[(hash >>> shift) & (fanOut - 1)]
  return node?.get(label) ?? 0
}

/** A node holding a full leaf's labels, by the next bits of their hashes. */
function split(leaf: Leaf, shift: number, copies: Set<Labels | Leaf>) {
  const node: Labels = new Array(fanOut)
  copies.add(node)
  for (const [label, count] of leaf) {
    const index = (hashOf(label) >>> shift) & (fanOut - 1)
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
  const copies = new Set<Labels | Leaf>()
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
      let leaf = child
      if (!leaf || !copies.has(leaf)) {
        footnoteScan.copied += leaf?.size ?? 0
        leaf = new Map(leaf)
        copies.add(leaf)
      }
      const count = (leaf.get(label) ?? 0) + delta
      if (count > 0) leaf.set(label, count)
      else leaf.delete(label)
      // Hashes have 32 bits, so the deepest leaves grow instead.
      node[index] =
        leaf.size > leafSize && shift + bits < 32
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
  /** The next window's size. */
  window: number
  labels: Labels
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

/**
 * Read for up to `budget` characters: stale stretches first, then the unread
 * rest. Blocks that start two lines before a window's end are where a
 * whole-note parse puts them, so reading continues at the last of them.
 */
function step(index: Index, doc: Text, budget: number): Index {
  let { groups, read, stale, window } = index
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
      break
    }
    const end = doc.lineAt(Math.min(doc.length, from + window)).to
    const last = end >= doc.length
    footnoteScan.parsed += end - from
    spent += end - from
    const tree = scan.parse(new DocInput(doc), [], [{ from, to: end }])
    const limit = last
      ? doc.length
      : doc.line(Math.max(1, doc.lineAt(end).number - 2)).from
    let cut = last ? doc.length : -1
    let resync = false
    // The window's tree starts at the window. Stretches start at a block's
    // line, since indentation before it can decide what it is.
    for (
      let child = tree.topNode.firstChild;
      child;
      child = child.nextSibling
    ) {
      const at = doc.lineAt(from + child.from).from
      if (at <= from || at > limit) continue
      if (!last) cut = at
      // Blocks start where a stretch read before starts: the rest is as it was.
      if (stale && at >= stale.to && at < read) {
        if (locate(groups, start, at)?.from === at) {
          cut = at
          resync = true
          break
        }
      }
    }
    if (cut <= from) {
      // One block fills the window.
      window *= 2
      continue
    }
    window = footnoteScan.window
    const labels = labelsIn(tree, doc, from, from, cut)
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
    window,
    labels: apply(index.labels, deltas),
  }
}

/** Reads the next slice of the note; formatted views dispatch it in idle time. */
export const readDefinitions = StateEffect.define<null>()

function create(state: EditorState): Index {
  const start = prefixOf(state)
  return step(
    {
      configs: state.facet(formattedMarkdown),
      start,
      groups: [],
      read: start,
      stale: null,
      window: footnoteScan.window,
      labels: new Array(fanOut),
    },
    state.doc,
    footnoteScan.slice,
  )
}

/** One stretch stands for the edited text and the stretches it touched, keeping their labels until read again. */
function edit(index: Index, state: EditorState, changes: EditorStateChanges) {
  let { groups, read, stale } = index
  const { start } = index
  const doc = state.doc
  let offset = 0
  for (const { fromA, toA, fromB, toB } of changes) {
    const size = toB - fromB - (toA - fromA)
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
  return { ...index, groups, read, stale }
}

type EditorStateChanges = readonly {
  fromA: number
  toA: number
  fromB: number
  toB: number
}[]

export const footnoteDefinitions = StateField.define<Index>({
  create,
  update(index, transaction) {
    const { state } = transaction
    // Other syntax, or a prefix that appeared or went away, reads the note again.
    if (
      state.facet(formattedMarkdown) !== index.configs ||
      prefixOf(state) !== transaction.changes.mapPos(index.start, -1)
    )
      return create(state)
    let next = index
    if (transaction.docChanged) {
      const changes: {
        fromA: number
        toA: number
        fromB: number
        toB: number
      }[] = []
      transaction.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
        changes.push({ fromA, toA, fromB, toB })
      })
      next = edit(index, state, changes)
      if (next.stale) next = step(next, state.doc, footnoteScan.slice >> 4)
    }
    if (transaction.effects.some((effect) => effect.is(readDefinitions)))
      next = step(next, state.doc, footnoteScan.slice)
    return next
  },
})

/** Whether the note defines a reference's label. */
export function defined(state: EditorState, label: string) {
  const index = state.field(footnoteDefinitions, false)
  return !!index && countOf(index.labels, label.toLowerCase()) > 0
}

/** Whether all of the note has been read. */
export function definitionsRead(state: EditorState) {
  const index = state.field(footnoteDefinitions, false)
  return !index || (!index.stale && index.read >= state.doc.length)
}

/** Reads the rest of a long note in idle slices, and draws references again when labels change. */
export const definitionReader = ViewPlugin.fromClass(
  class {
    private idle = 0
    private readonly view: EditorView
    constructor(view: EditorView) {
      this.view = view
      this.schedule()
    }
    update() {
      this.schedule()
    }
    schedule() {
      if (this.idle || definitionsRead(this.view.state)) return
      this.idle = requestIdleCallback(() => {
        this.idle = 0
        const { labels } = this.view.state.field(footnoteDefinitions)
        this.view.dispatch({ effects: readDefinitions.of(null) })
        if (this.view.state.field(footnoteDefinitions).labels !== labels)
          this.view.dispatch({ effects: formattedRefresh.of(null) })
      })
    }
    destroy() {
      if (this.idle) cancelIdleCallback(this.idle)
    }
  },
)
