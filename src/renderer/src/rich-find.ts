import type { Node } from '@tiptap/pm/model'
import {
  type Command,
  type EditorState,
  Plugin,
  PluginKey,
  TextSelection,
  type Transaction,
} from '@tiptap/pm/state'
import { type Mapping, StepMap } from '@tiptap/pm/transform'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'

type Range = { from: number; to: number }
type FindState = {
  query: string
  index: MatchIndex | null
  deco: DecorationSet
  /** Positions near the viewport whose matches are highlighted. */
  window: Range | null
  /** Null until every textblock has been scanned. */
  total: number | null
  /** One-based rank of the selected match, or 0. */
  current: number
  active: Range | null
}
type FindMeta = { query: string } | { window: Range } | { complete: MatchIndex }

const matchStyle = { class: 'ProseMirror-search-match' }
const activeStyle = { class: 'ProseMirror-active-search-match' }
// The block offset in the spec keeps neighboring highlights unequal, so the
// view restyles a match in place instead of reusing a neighbor's equal text
// node and rewriting the paragraph. Rescanned matches that did not move stay equal.
const highlight = (
  from: number,
  to: number,
  offset: number,
  style = matchStyle,
) => Decoration.inline(from, to, style, { style, offset })

// Offsets match document positions: inline leaves are one character and
// inline nodes with content gain a space for each boundary token.
function blockText(node: Node): string {
  let text = ''
  node.forEach((child) => {
    text += child.isText
      ? child.text
      : child.isLeaf
        ? '\ufffc'
        : ` ${blockText(child)} `
  })
  return text
}

// Fold each character the same way wherever it appears. Greek final sigma is
// the only lowercase mapping that depends on neighboring letters, so σ and ς
// compare equal instead of hiding a match behind its context.
const fold = (text: string) => text.toLowerCase().replaceAll('ς', 'σ')

/** Non-overlapping, case-insensitive literal matches as [from, to] offset pairs. */
function scan(text: string, needle: string) {
  const folded = fold(text)
  const found: number[] = []
  if (folded.length === text.length) {
    for (
      let at = folded.indexOf(needle);
      at >= 0;
      at = folded.indexOf(needle, at + needle.length)
    )
      found.push(at, at + needle.length)
    return found
  }
  // A few characters, such as İ, lengthen when lowercased. Map each folded
  // unit back to its source character so matches cover whole characters.
  const starts: number[] = []
  const ends: number[] = []
  let offset = 0
  for (const character of text) {
    for (let unit = character.toLowerCase().length; unit > 0; unit--) {
      starts.push(offset)
      ends.push(offset + character.length)
    }
    offset += character.length
  }
  for (let at = folded.indexOf(needle); at >= 0; ) {
    const to = ends[at + needle.length - 1]!
    found.push(starts[at]!, to)
    let next = at + needle.length
    while (next < folded.length && starts[next]! < to) next++
    at = folded.indexOf(needle, next)
  }
  return found
}

/** Matches for one query, cached by immutable node so unchanged blocks are never folded again. */
class MatchIndex {
  readonly #needle: string
  readonly #blocks = new WeakMap<Node, number[]>()
  readonly #counts = new WeakMap<Node, number>()
  constructor(query: string) {
    this.#needle = fold(query)
  }
  matches(block: Node) {
    let found = this.#blocks.get(block)
    if (!found) {
      found = scan(blockText(block), this.#needle)
      this.#blocks.set(block, found)
    }
    return found
  }
  count(node: Node): number {
    if (node.inlineContent) return this.matches(node).length / 2
    let count = this.#counts.get(node)
    if (count === undefined) {
      count = 0
      for (let child = 0; child < node.childCount; child++)
        count += this.count(node.child(child))
      this.#counts.set(node, count)
    }
    return count
  }
}

// Position of the first [from, to] pair whose `from` (side 0) or `to` (side 1) is at least `offset`.
function firstPair(found: readonly number[], side: 0 | 1, offset: number) {
  let low = 0
  let high = found.length / 2
  while (low < high) {
    const middle = (low + high) >> 1
    if (found[middle * 2 + side]! < offset) low = middle + 1
    else high = middle
  }
  return low * 2
}

/** First match starting at or after `pos`. */
function nextMatch(
  index: MatchIndex,
  node: Node,
  pos: number,
  start = 0,
): Range | null {
  if (node.inlineContent) {
    const found = index.matches(node)
    const at = firstPair(found, 0, pos - start)
    return at < found.length
      ? { from: start + found[at]!, to: start + found[at + 1]! }
      : null
  }
  for (let child = 0, offset = start; child < node.childCount; child++) {
    const next = node.child(child)
    const end = offset + next.nodeSize
    if (end > pos && index.count(next)) {
      const found = nextMatch(index, next, pos, offset + 1)
      if (found) return found
    }
    offset = end
  }
  return null
}

/** Last match ending at or before `pos`. */
function previousMatch(
  index: MatchIndex,
  node: Node,
  pos: number,
  start = 0,
): Range | null {
  if (node.inlineContent) {
    const found = index.matches(node)
    const at = firstPair(found, 1, pos - start + 1) - 2
    return at >= 0
      ? { from: start + found[at]!, to: start + found[at + 1]! }
      : null
  }
  for (
    let child = node.childCount - 1, end = start + node.content.size;
    child >= 0;
    child--
  ) {
    const previous = node.child(child)
    const offset = end - previous.nodeSize
    if (offset < pos && index.count(previous)) {
      const found = previousMatch(index, previous, pos, offset + 1)
      if (found) return found
    }
    end = offset
  }
  return null
}

/** Number of matches starting before `pos`. */
function matchesBefore(
  index: MatchIndex,
  node: Node,
  pos: number,
  start = 0,
): number {
  if (node.inlineContent)
    return firstPair(index.matches(node), 0, pos - start) / 2
  let count = 0
  for (
    let child = 0, offset = start;
    child < node.childCount && offset < pos;
    child++
  ) {
    const next = node.child(child)
    const end = offset + next.nodeSize
    count +=
      end <= pos
        ? index.count(next)
        : matchesBefore(index, next, pos, offset + 1)
    offset = end
  }
  return count
}

/** Offset of the match at [from, to] in its textblock, or -1. */
function matchOffset(index: MatchIndex, doc: Node, from: number, to: number) {
  if (from >= to) return -1
  const $from = doc.resolve(from)
  for (let depth = 1; depth <= $from.depth; depth++) {
    if (!$from.node(depth).inlineContent) continue
    const found = index.matches($from.node(depth))
    const offset = from - $from.start(depth)
    const at = firstPair(found, 0, offset)
    return found[at] === offset && found[at + 1] === to - from + offset
      ? offset
      : -1
  }
  return -1
}

/** Where a walk continues: the next child of each open ancestor and its position. */
type Walk = { node: Node; child: number; pos: number }[]

/** Calls `visit` for the remaining textblocks in order until it returns false; true once done. */
function walkBlocks(walk: Walk, visit: (block: Node, pos: number) => boolean) {
  while (walk.length) {
    const parent = walk.at(-1)!
    if (parent.child >= parent.node.childCount) {
      walk.pop()
      continue
    }
    const node = parent.node.child(parent.child++)
    const pos = parent.pos
    parent.pos += node.nodeSize
    if (node.inlineContent) {
      if (!visit(node, pos)) return false
    } else if (!node.isLeaf) walk.push({ node, child: 0, pos: pos + 1 })
  }
  return true
}

const none: FindState = {
  query: '',
  index: null,
  deco: DecorationSet.empty,
  window: null,
  total: 0,
  current: 0,
  active: null,
}

const overlaps = (shown: Range | null, range: Range) =>
  !!shown && range.from < shown.to && range.to > shown.from

function mapRange(mapping: Mapping, range: Range | null) {
  if (!range) return null
  const from = mapping.map(range.from, 1)
  const to = mapping.map(range.to, -1)
  return from < to ? { from, to } : null
}

/** Highlights the block's matches that overlap `shown`. */
function highlightBlock(
  decorations: Decoration[],
  index: MatchIndex,
  block: Node,
  pos: number,
  shown: Range,
) {
  const found = index.matches(block)
  const start = pos + 1
  for (
    let at = firstPair(found, 1, shown.from - start + 1);
    at < found.length && start + found[at]! < shown.to;
    at += 2
  )
    decorations.push(
      highlight(start + found[at]!, start + found[at + 1]!, found[at]!),
    )
}

/** Highlights only the matches in `shown`; `select` then restyles the selected one. */
function show(state: EditorState, find: FindState, shown: Range | null) {
  const decorations: Decoration[] = []
  if (shown)
    state.doc.nodesBetween(shown.from, shown.to, (node, pos) => {
      if (!node.inlineContent) return true
      highlightBlock(decorations, find.index!, node, pos, shown)
      return false
    })
  return {
    ...find,
    window: shown,
    deco: DecorationSet.create(state.doc, decorations),
    active: null,
  }
}

/** Map highlights and rescan only the textblocks the transaction touched. */
function update(
  tr: Transaction,
  before: EditorState,
  state: EditorState,
  find: FindState,
): FindState {
  const index = find.index!
  // One range covering every step's changes, in final document positions.
  let from = Number.POSITIVE_INFINITY
  let to = Number.NEGATIVE_INFINITY
  for (const map of tr.mapping.maps) {
    if (from <= to) {
      from = map.map(from, -1)
      to = map.map(to, 1)
    }
    map.forEach((_oldStart, _oldEnd, start, end) => {
      from = Math.min(from, start)
      to = Math.max(to, end)
    })
  }
  // Mark and attribute steps move nothing and keep the text.
  if (from > to) return find
  const shown = mapRange(tr.mapping, find.window)
  const replaced: number[] = []
  const decorations: Decoration[] = []
  let total = find.total
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.inlineContent) return true
    replaced.push(pos, node.nodeSize, node.nodeSize)
    if (total !== null) total += index.count(node)
    if (shown) highlightBlock(decorations, index, node, pos, shown)
    return false
  })
  // Outside the changed range both documents hold the same blocks, so the
  // total only trades the old blocks there for the new ones.
  if (total !== null) {
    const inverse = tr.mapping.invert()
    before.doc.nodesBetween(
      inverse.map(from, -1),
      inverse.map(to, 1),
      (node) => {
        if (!node.inlineContent) return true
        total! -= index.count(node)
        return false
      },
    )
  }
  // Replacing each touched textblock with itself drops its stale highlights in
  // one pass without moving other positions; removing them one by one is quadratic.
  const mapping = tr.mapping.slice()
  if (replaced.length) mapping.appendMap(new StepMap(replaced))
  return {
    ...find,
    deco: find.deco.map(mapping, state.doc).add(state.doc, decorations),
    window: shown,
    total,
    active: mapRange(tr.mapping, find.active),
  }
}

/** Restyle only the previously and newly selected highlights. */
function select(state: EditorState, find: FindState): FindState {
  const index = find.index!
  const { from, to } = state.selection
  const offset = matchOffset(index, state.doc, from, to)
  const selected = offset < 0 ? null : { from, to }
  const stale: Decoration[] = []
  const fresh: Decoration[] = []
  const styled = (range: Range, style: typeof matchStyle) =>
    find.deco
      .find(range.from, range.to, (spec) => spec.style === style)
      .filter((deco) => deco.from === range.from && deco.to === range.to)
  const previous = find.active
  if (previous && (previous.from !== from || previous.to !== to)) {
    const found = styled(previous, activeStyle)
    stale.push(...found)
    // Outside the window, a match is highlighted only while it is selected.
    if (found.length && overlaps(find.window, previous))
      fresh.push(highlight(previous.from, previous.to, found[0]!.spec.offset))
  }
  if (selected && !styled(selected, activeStyle).length) {
    stale.push(...styled(selected, matchStyle))
    fresh.push(highlight(from, to, offset, activeStyle))
  }
  return {
    ...find,
    deco:
      stale.length || fresh.length
        ? find.deco.remove(stale).add(state.doc, fresh)
        : find.deco,
    active: selected,
    current:
      selected && find.total !== null
        ? matchesBefore(index, state.doc, from) + 1
        : 0,
  }
}

/** Document positions at the top and bottom of the editor's visible area. */
function visibleRange(view: EditorView): Range | null {
  const box = view.dom.getBoundingClientRect()
  let top = Math.max(box.top, 0)
  let bottom = Math.min(box.bottom, window.innerHeight)
  // Scrolling panes and other clipping ancestors bound what is visible.
  for (
    let element = view.dom.parentElement;
    element;
    element = element.parentElement
  )
    if (getComputedStyle(element).overflowY !== 'visible') {
      const clip = element.getBoundingClientRect()
      top = Math.max(top, clip.top)
      bottom = Math.min(bottom, clip.bottom)
    }
  if (top >= bottom) return null
  // Hit-test at the start of lines: a point past a line's end can resolve to
  // the end of its block.
  const left =
    box.left + Number.parseFloat(getComputedStyle(view.dom).paddingLeft) + 1
  const at = (y: number, step: number) => {
    // Overlays such as the find bar can cover a point, so look past them.
    for (let tries = 0; tries < 8 && y > top && y < bottom; tries++) {
      const caret = document.caretPositionFromPoint(left, y)
      if (caret && view.dom.contains(caret.offsetNode)) {
        try {
          return view.posAtDOM(caret.offsetNode, caret.offset)
        } catch {
          // Markup a node view owns has no document position; look further.
        }
      }
      y += step
    }
    return null
  }
  const from = at(top + 1, 24)
  const to = at(bottom - 1, -24)
  return from === null || to === null || from > to ? null : { from, to }
}

export const richFindKey = new PluginKey<FindState>('richFind')

/**
 * Highlights literal, case-insensitive matches of the find query near the
 * viewport. Counts and navigation cover the whole document.
 */
export function richFind() {
  return new Plugin<FindState>({
    key: richFindKey,
    state: {
      init: () => none,
      apply(tr, find, before, state) {
        const meta: FindMeta | undefined = tr.getMeta(richFindKey)
        if (meta && 'query' in meta) {
          if (!meta.query) return none
          const index = new MatchIndex(meta.query)
          const query = { ...none, query: meta.query, index, total: null }
          // Matches near the viewport show at once; a scan completes the total.
          return select(
            state,
            show(state, query, mapRange(tr.mapping, find.window)),
          )
        }
        if (!find.index || (!tr.docChanged && !tr.selectionSet && !meta))
          return find
        let next = tr.docChanged ? update(tr, before, state, find) : find
        if (meta && 'window' in meta) next = show(state, next, meta.window)
        if (meta && 'complete' in meta && meta.complete === next.index)
          next = { ...next, total: meta.complete.count(state.doc) }
        return select(state, next)
      },
    },
    props: { decorations: (state) => richFindKey.getState(state)?.deco },
    view(view) {
      let frame = 0
      // Measured once per frame, after scrolling, layout, or find changes.
      const measure = () => {
        frame = 0
        const find = richFindKey.getState(view.state)
        if (!find?.index) return
        const visible = visibleRange(view)
        const shown = find.window
        if (
          !visible ||
          (shown && shown.from <= visible.from && visible.to <= shown.to)
        )
          return
        // About a screen of text on each side keeps scrolling ahead of updates.
        const margin = Math.max(visible.to - visible.from, 2000)
        view.dispatch(
          view.state.tr
            .setMeta(richFindKey, {
              window: {
                from: Math.max(0, visible.from - margin),
                to: Math.min(view.state.doc.content.size, visible.to + margin),
              },
            })
            .setMeta('addToHistory', false),
        )
      }
      const schedule = () => {
        if (richFindKey.getState(view.state)?.index)
          frame ||= requestAnimationFrame(measure)
      }
      const resize = new ResizeObserver(schedule)
      resize.observe(view.dom)
      document.addEventListener('scroll', schedule, {
        capture: true,
        passive: true,
      })
      window.addEventListener('resize', schedule)
      return {
        update(_view, previous) {
          if (
            richFindKey.getState(view.state) !== richFindKey.getState(previous)
          )
            schedule()
        },
        destroy() {
          cancelAnimationFrame(frame)
          resize.disconnect()
          document.removeEventListener('scroll', schedule, { capture: true })
          window.removeEventListener('resize', schedule)
        },
      }
    },
  })
}

export const setRichFindQuery = (tr: Transaction, query: string) =>
  tr.setMeta(richFindKey, { query })

/**
 * Scans every textblock for the current query in short slices, so long notes
 * stay responsive. `first` receives the document's first match as soon as it
 * is known. Returns a function that stops the scan; a new query stops it too.
 */
export function scanRichFind(view: EditorView, first: (match: Range) => void) {
  const index = richFindKey.getState(view.state)?.index
  if (!index) return () => {}
  let doc: Node | null = null
  let walk: Walk = []
  let found = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const run = () => {
    timer = undefined
    if (view.isDestroyed || richFindKey.getState(view.state)?.index !== index)
      return
    // After an edit, walk again; scanned blocks are cached and cost one lookup.
    if (view.state.doc !== doc) {
      doc = view.state.doc
      walk = [{ node: doc, child: 0, pos: 0 }]
    }
    // Yield after about half a frame so input and painting keep up.
    const deadline = performance.now() + 8
    const done = walkBlocks(walk, (block, pos) => {
      const matches = index.matches(block)
      if (!found && matches.length) {
        found = true
        first({ from: pos + 1 + matches[0]!, to: pos + 1 + matches[1]! })
      }
      return performance.now() < deadline
    })
    if (!done) timer = setTimeout(run, 0)
    else if (richFindKey.getState(view.state)?.index === index)
      view.dispatch(
        view.state.tr
          .setMeta(richFindKey, { complete: index })
          .setMeta('addToHistory', false),
      )
  }
  run()
  return () => clearTimeout(timer)
}

/** Moves wait for a complete count: finishing the scan synchronously would stall. */
function findCommand(direction: 'next' | 'previous'): Command {
  return (state, dispatch) => {
    const find = richFindKey.getState(state)
    const index = find?.index
    if (!index || find.total === null) return false
    const { doc } = state
    const { from, to } = state.selection
    let found: Range | null
    if (direction === 'next') {
      // Wrap to the first match only when it ends before the selection.
      found = nextMatch(index, doc, to)
      const first = found ? null : nextMatch(index, doc, 0)
      if (first && first.to <= from) found = first
    } else {
      found = previousMatch(index, doc, from)
      const last = found ? null : previousMatch(index, doc, doc.content.size)
      if (last && last.from >= to) found = last
    }
    if (!found) return false
    dispatch?.(
      state.tr
        .setSelection(TextSelection.create(doc, found.from, found.to))
        .scrollIntoView(),
    )
    return true
  }
}

export const findNext = findCommand('next')
export const findPrev = findCommand('previous')
