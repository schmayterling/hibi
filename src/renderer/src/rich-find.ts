import type { Node } from '@tiptap/pm/model'
import {
  type Command,
  type EditorState,
  Plugin,
  PluginKey,
  TextSelection,
  type Transaction,
} from '@tiptap/pm/state'
import { StepMap } from '@tiptap/pm/transform'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

type Range = { from: number; to: number }
type FindState = {
  query: string
  index: MatchIndex | null
  deco: DecorationSet
  total: number
  /** One-based rank of the selected match, or 0. */
  current: number
  active: Range | null
}

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

function isMatch(index: MatchIndex, doc: Node, from: number, to: number) {
  if (from >= to) return false
  const $from = doc.resolve(from)
  for (let depth = 1; depth <= $from.depth; depth++) {
    if (!$from.node(depth).inlineContent) continue
    const found = index.matches($from.node(depth))
    const start = $from.start(depth)
    const at = firstPair(found, 0, from - start)
    return found[at] === from - start && found[at + 1] === to - start
  }
  return false
}

const none: FindState = {
  query: '',
  index: null,
  deco: DecorationSet.empty,
  total: 0,
  current: 0,
  active: null,
}

function highlightBlock(
  decorations: Decoration[],
  index: MatchIndex,
  block: Node,
  pos: number,
) {
  const found = index.matches(block)
  for (let at = 0; at < found.length; at += 2)
    decorations.push(
      highlight(pos + 1 + found[at]!, pos + 1 + found[at + 1]!, found[at]!),
    )
}

function rebuild(state: EditorState, query: string) {
  const index = new MatchIndex(query)
  const decorations: Decoration[] = []
  state.doc.descendants((node, pos) => {
    if (!node.inlineContent) return true
    highlightBlock(decorations, index, node, pos)
    return false
  })
  return {
    query,
    index,
    deco: DecorationSet.create(state.doc, decorations),
    total: index.count(state.doc),
    current: 0,
    active: null,
  }
}

/** Map highlights and rescan only the textblocks the transaction touched. */
function update(tr: Transaction, state: EditorState, find: FindState) {
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
  if (from > to) return { ...find, total: index.count(state.doc) }
  const replaced: number[] = []
  const decorations: Decoration[] = []
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.inlineContent) return true
    replaced.push(pos, node.nodeSize, node.nodeSize)
    highlightBlock(decorations, index, node, pos)
    return false
  })
  // Replacing each touched textblock with itself drops its stale highlights in
  // one pass without moving other positions; removing them one by one is quadratic.
  const mapping = tr.mapping.slice()
  if (replaced.length) mapping.appendMap(new StepMap(replaced))
  const active = find.active && {
    from: tr.mapping.map(find.active.from, 1),
    to: tr.mapping.map(find.active.to, -1),
  }
  return {
    ...find,
    deco: find.deco.map(mapping, state.doc).add(state.doc, decorations),
    total: index.count(state.doc),
    active: active && active.from < active.to ? active : null,
  }
}

/** Restyle only the previously and newly selected highlights. */
function select(state: EditorState, find: FindState): FindState {
  const index = find.index!
  const { from, to } = state.selection
  const selected = isMatch(index, state.doc, from, to) ? { from, to } : null
  const stale: Decoration[] = []
  const fresh: Decoration[] = []
  const restyle = (
    range: Range,
    before: typeof matchStyle,
    after: typeof matchStyle,
  ) => {
    const found = find.deco
      .find(range.from, range.to, (spec) => spec.style === before)
      .filter((deco) => deco.from === range.from && deco.to === range.to)
    if (!found.length) return
    stale.push(...found)
    fresh.push(highlight(range.from, range.to, found[0]!.spec.offset, after))
  }
  if (find.active && (find.active.from !== from || find.active.to !== to))
    restyle(find.active, activeStyle, matchStyle)
  if (selected) restyle(selected, matchStyle, activeStyle)
  return {
    ...find,
    deco: stale.length
      ? find.deco.remove(stale).add(state.doc, fresh)
      : find.deco,
    active: selected,
    current: selected ? matchesBefore(index, state.doc, from) + 1 : 0,
  }
}

export const richFindKey = new PluginKey<FindState>('richFind')

/** Highlights literal, case-insensitive matches of the find query in rich text. */
export function richFind() {
  return new Plugin<FindState>({
    key: richFindKey,
    state: {
      init: () => none,
      apply(tr, find, _before, state) {
        const query: string | undefined = tr.getMeta(richFindKey)
        if (query !== undefined)
          return query ? select(state, rebuild(state, query)) : none
        if (!find.index || (!tr.docChanged && !tr.selectionSet)) return find
        return select(state, tr.docChanged ? update(tr, state, find) : find)
      },
    },
    props: { decorations: (state) => richFindKey.getState(state)?.deco },
  })
}

export const setRichFindQuery = (tr: Transaction, query: string) =>
  tr.setMeta(richFindKey, query)

export function firstRichMatch(state: EditorState) {
  const index = richFindKey.getState(state)?.index
  return index ? nextMatch(index, state.doc, 0) : null
}

function findCommand(direction: 'next' | 'previous'): Command {
  return (state, dispatch) => {
    const index = richFindKey.getState(state)?.index
    if (!index) return false
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
