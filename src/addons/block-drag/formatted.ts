import { isolateHistory } from '@codemirror/commands'
import {
  ChangeSet,
  EditorSelection,
  type EditorState,
  Text,
  type TransactionSpec,
} from '@codemirror/state'
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import type { SyntaxNode, Tree } from '@lezer/common'
import { uncovered } from '../../renderer/src/chunked-markdown.ts'
import {
  type FormattedContribution,
  formattedBlockEdges,
  formattedSyntaxTree,
} from '../../renderer/src/formatted-contributions.ts'
import type { MenuApi } from '../api'

/*
 * Block dragging in the CodeMirror formatted view. A handle follows the block
 * under the pointer, as the rich view's drag handle does, and every move is
 * one source edit that takes a block from among its siblings and puts it
 * back at another place between them.
 */

/** What the formatted handle shares with the addon. */
export type BlockDragHost = {
  menus: MenuApi
  /** A formatted view gained focus, so the move commands act on it. */
  focus: (view: EditorView) => void
  /** A formatted view closed. */
  close: (view: EditorView) => void
}

type Block = { from: number; to: number; name: string }

const isList = (node: SyntaxNode) =>
  node.name === 'BulletList' || node.name === 'OrderedList'

const same = (a: SyntaxNode, b: Block) =>
  a.from === b.from && a.to === b.to && a.name === b.name

/** Source indentation belongs to the block, not the separator before it. */
function sourceFrom(state: EditorState, node: SyntaxNode): number | null {
  const line = state.doc.lineAt(node.from)
  const prefix = state.doc.sliceString(line.from, node.from)
  let container: SyntaxNode | null = null,
    quotes = 0
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.name === 'Blockquote') quotes++
    if (
      !container &&
      (parent.name === 'Blockquote' || parent.name === 'ListItem')
    )
      container = parent
  }
  let offset = quotePrefix(prefix, quotes)
  if (quotes && prefix.slice(0, offset).split('>').length - 1 !== quotes)
    return null
  if (container?.name === 'ListItem') {
    const mark = container.getChild('ListMark')
    if (!mark) return null
    const first = state.doc.lineAt(mark.from)
    // A same-line nested marker or tab-dependent prefix needs reindentation.
    if (!/^[ >]*$/.test(first.text.slice(0, mark.from - first.from)))
      return null
    const after = first.text.slice(mark.to - first.from)
    if (/^ *\t/.test(after)) return null
    const spaces = /^ */.exec(after)![0].length
    offset +=
      mark.to -
      first.from -
      quotePrefix(first.text, quotes) +
      (!after[spaces] || spaces > 4 ? 1 : spaces)
  }
  if (offset > prefix.length || !/^[ \t]*$/.test(prefix.slice(offset)))
    return null
  return line.from + offset
}

/** Quote markers stay in place when an item's continuation changes width. */
function quotePrefix(line: string, count: number) {
  let offset = 0
  for (let i = 0; i < count; i++) {
    const mark = /^[ \t]*>[ \t]?/.exec(line.slice(offset))
    if (!mark) break
    offset += mark[0].length
  }
  return offset
}

/** Footnotes are multiple parser blocks; leave their source together. */
function footnote(state: EditorState, node: SyntaxNode | null): boolean {
  if (!node) return false
  if (node.name === 'LinkReference')
    return state.doc.sliceString(node.from, node.from + 2) === '[^'
  if (node.name !== 'CodeBlock') return false
  let previous = node.prevSibling
  while (previous && !previous.type.is('Block')) previous = previous.prevSibling
  return footnote(state, previous)
}

/** Open raw blocks absorb anything placed after them. */
function closed(state: EditorState, node: SyntaxNode) {
  if (node.name === 'FencedCode')
    return (
      node.lastChild?.name === 'CodeMark' && node.lastChild.from > node.from
    )
  if (
    node.name !== 'HTMLBlock' &&
    node.name !== 'CommentBlock' &&
    node.name !== 'ProcessingInstructionBlock'
  )
    return true
  const first = state.doc
    .lineAt(node.from)
    .text.slice(node.from - state.doc.lineAt(node.from).from)
  const end = state.doc.lineAt(Math.max(node.from, node.to - 1)).text
  if (first.startsWith('<!--')) return end.includes('-->')
  if (first.startsWith('<?')) return end.includes('?>')
  if (first.startsWith('<![CDATA[')) return end.includes(']]>')
  if (first.startsWith('<!')) return end.includes('>')
  const raw = /^<(script|style|pre|textarea)(?:\s|>|$)/i.exec(first)
  return !raw || new RegExp(`</${raw[1]}\\s*>`, 'i').test(end)
}

/** Text between sibling blocks: line breaks, indentation and quote markers. */
const separator = /^[\s>]*$/

/**
 * The block next to `node` among its siblings, or null. Only parsed text is
 * read: a neighbor in text the view has not parsed is not looked for, and
 * one the tree skips text to reach is not a neighbor.
 */
function sibling(
  state: EditorState,
  tree: Tree,
  node: SyntaxNode,
  direction: -1 | 1,
) {
  const doc = state.doc
  const from = sourceFrom(state, node)
  if (from === null) return null
  let at = direction > 0 ? node.to : from
  for (;;) {
    if (direction > 0 ? at >= doc.length : at <= 0) return null
    if (uncovered(tree, Math.max(0, at - 1), Math.min(doc.length, at + 1)))
      return null
    const next = doc.sliceString(
      direction > 0 ? at : Math.max(0, at - 256),
      direction > 0 ? Math.min(doc.length, at + 256) : at,
    )
    const run = (direction > 0 ? /^[\s>]*/ : /[\s>]*$/).exec(next)![0].length
    at += direction * run
    if (run < next.length) break
  }
  if (
    uncovered(tree, at - (direction < 0 ? 1 : 0), at + (direction > 0 ? 1 : 0))
  )
    return null
  let found = direction > 0 ? node.nextSibling : node.prevSibling
  while (found && !found.type.is('Block'))
    found = direction > 0 ? found.nextSibling : found.prevSibling
  if (!found) return null
  const foundFrom = sourceFrom(state, found)
  if (foundFrom === null) return null
  const gap =
    direction > 0
      ? doc.sliceString(node.to, foundFrom)
      : doc.sliceString(found.to, from)
  return separator.test(gap) ? found : null
}

/** An item's first block. */
function firstBlock(item: SyntaxNode) {
  let first = item.firstChild
  while (first && !first.type.is('Block')) first = first.nextSibling
  return first
}

/** Frontmatter stays first; item openings and alert titles move with their containers. */
function fixed(node: SyntaxNode) {
  if (node.name === 'Frontmatter' || node.name === 'AlertTitle') return true
  const parent = node.parent
  return parent?.name === 'ListItem' && firstBlock(parent)?.from === node.from
}

/** The innermost block at `pos`, including one that starts or ends there. */
function blockAt(tree: Tree, pos: number) {
  let found: SyntaxNode | null = null
  for (const side of [1, -1] as const) {
    let node: SyntaxNode | null = tree.resolveInner(pos, side)
    while (node && node.name !== 'Document' && !node.type.is('Block'))
      node = node.parent
    if (
      node &&
      node.name !== 'Document' &&
      (!found || node.to - node.from < found.to - found.from)
    )
      found = node
  }
  return found
}

/** A block node of the tree by its range and name. */
export function blockNode(tree: Tree, block: Block) {
  for (let node = blockAt(tree, block.from); node; node = node.parent)
    if (same(node, block)) return node
  return null
}

/**
 * The block a handle at a line moves, as in the rich view: the innermost
 * block at `pos`, an item rather than its first block, and never a whole
 * list. A nested block whose left or top edge the pointer is at gives way to
 * the blocks around it, so the pointer can reach the handle beside an item.
 */
export function handleTarget(
  tree: Tree,
  pos: number,
  atEdge: (node: SyntaxNode) => boolean,
) {
  for (
    let node = blockAt(tree, pos);
    node && node.name !== 'Document';
    node = node.parent
  ) {
    if (isList(node) || fixed(node)) continue
    if (node.parent?.name !== 'Document' && atEdge(node)) continue
    return node
  }
  return null
}

/**
 * The sibling of `block` a drop at `pos` lands beside: the one at `pos`, or
 * the nearest one when `pos` is between them or outside their container.
 */
export function dropSibling(tree: Tree, block: SyntaxNode, pos: number) {
  const parent = block.parent
  if (!parent) return null
  for (let node = blockAt(tree, pos); node; node = node.parent)
    if (node.parent && same(node.parent, parent)) return node
  let near = parent.childBefore(
    Math.max(parent.from + 1, Math.min(pos, parent.to)),
  )
  while (near && !near.type.is('Block')) near = near.prevSibling
  if (near) return near
  near = parent.childAfter(Math.max(parent.from, Math.min(pos, parent.to)))
  while (near && !near.type.is('Block')) near = near.nextSibling
  return near
}

/** A separator with a blank line, so the blocks on either side stay apart. */
function apart(text: string) {
  if (/\n[ \t>]*\n/.test(text)) return text
  const prefix = text.slice(text.lastIndexOf('\n') + 1)
  return `\n${prefix.trimEnd()}${text}`
}

/**
 * A numbered item's text from its marker on with another marker, its later
 * lines following the marker's change of width.
 */
function remarked(state: EditorState, item: SyntaxNode, marker: string) {
  const mark = item.getChild('ListMark')
  const from = sourceFrom(state, item)
  if (!mark || from === null) return null
  const text = state.doc.sliceString(from, item.to)
  const by = marker.length - (mark.to - mark.from)
  const changes: Change[] = [
    { from: mark.from - from, to: mark.to - from, insert: marker },
  ]
  if (by) {
    let quotes = 0
    for (let parent = item.parent; parent; parent = parent.parent)
      if (parent.name === 'Blockquote') quotes++
    const first = state.doc.lineAt(mark.from)
    const prefix = first.text.slice(0, mark.from - first.from)
    // A marker on its parent's opening line or tab-aligned content needs
    // container-aware reindentation. Leave those width changes untouched.
    if (!/^[ >]*$/.test(prefix)) return null
    const after = first.text.slice(mark.to - first.from)
    if (/^ *\t/.test(after)) return null
    const spaces = /^ */.exec(after)![0].length
    const width =
      mark.to -
      first.from -
      quotePrefix(first.text, quotes) +
      (!after[spaces] || spaces > 4 ? 1 : spaces)
    for (
      let number = first.number + 1;
      number <= state.doc.lineAt(item.to).number;
      number++
    ) {
      const line = state.doc.line(number)
      const offset = quotePrefix(line.text, quotes)
      const content = line.text.slice(offset)
      if (/^[ \t]*$/.test(content)) continue
      if (/^ *\t/.test(content)) return null
      const leading = /^ */.exec(content)![0].length
      if (leading < width) continue
      const start = line.from + offset - from
      changes.push({
        from: start,
        to: start + Math.max(0, -by),
        insert: by > 0 ? ' '.repeat(by) : '',
      })
    }
  }
  const set = ChangeSet.of(changes, text.length)
  return { text: set.apply(Text.of(text.split('\n'))).toString(), changes: set }
}

type Change = { from: number; to: number; insert: string }

/**
 * Move `block` beside its sibling `target`, after it or before it, as one
 * edit: the block leaves its place, and goes in at the new place with the
 * separator it had on that side, as swapping it with each block it passes
 * would. Numbered items keep the number of each place. Blocks other than
 * items keep a blank line on either side, so they cannot run into their new
 * neighbors.
 */
export function moveBlock(
  state: EditorState,
  tree: Tree,
  block: SyntaxNode,
  target: SyntaxNode,
  after: boolean,
): TransactionSpec | null {
  if (
    state.readOnly ||
    same(target, block) ||
    fixed(block) ||
    !block.parent ||
    !target.parent ||
    !same(block.parent, target.parent) ||
    footnote(state, block) ||
    footnote(state, target) ||
    !closed(state, block)
  )
    return null
  const down = target.from > block.from
  const step = (node: SyntaxNode, direction: -1 | 1) =>
    sibling(state, tree, node, direction)
  // The sibling the block goes in next to: after it going down, before it going up.
  let at: SyntaxNode | null = target
  if (down && !after) at = step(target, -1)
  else if (!down && after) at = step(target, 1)
  if (!at || same(at, block) || (!down && fixed(at))) return null
  if (footnote(state, at) || (down && !closed(state, at))) return null
  const start = (node: SyntaxNode) => sourceFrom(state, node)!
  const blockFrom = sourceFrom(state, block)
  if (blockFrom === null || sourceFrom(state, at) === null) return null
  const items = block.name === 'ListItem'
  // The separator after `node`; frontmatter ends with its line break.
  const join = (node: SyntaxNode, text: string) =>
    items || node.name === 'Frontmatter' ? text : apart(text)
  const previous = step(block, -1),
    next = step(block, 1)
  if (!(down ? next : previous)) return null
  const before = previous ? state.doc.sliceString(previous.to, blockFrom) : '',
    following = next ? state.doc.sliceString(block.to, start(next)) : ''
  let text = state.doc.sliceString(blockFrom, block.to)
  let remarkedChanges: ChangeSet | null = null
  const changes: Change[] = []
  // The block's own place: its neighbors keep the separator on the far side
  // of the move between them.
  if (previous && next)
    changes.push({
      from: previous.to,
      to: start(next),
      insert: join(previous, down ? before : following),
    })
  else if (previous)
    changes.push({ from: previous.to, to: block.to, insert: '' })
  else if (next) changes.push({ from: blockFrom, to: start(next), insert: '' })
  // Numbered items keep each place's number: the block takes the number of
  // its new place and the items it passes move up or down one.
  if (block.parent?.name === 'OrderedList') {
    const marker = (item: SyntaxNode) => {
      const mark = item.getChild('ListMark')
      return mark ? state.doc.sliceString(mark.from, mark.to) : ''
    }
    let passed = marker(block)
    for (let item: SyntaxNode | null = down ? next : previous; ; ) {
      if (!item) return null
      const own = marker(item)
      if (own !== passed) {
        const changed = remarked(state, item, passed)
        if (!changed) return null
        changes.push({
          from: start(item),
          to: item.to,
          insert: changed.text,
        })
      }
      passed = own
      if (same(item, at)) break
      item = step(item, down ? 1 : -1)
    }
    const changed = remarked(state, block, passed)
    if (!changed) return null
    text = changed.text
    remarkedChanges = changed.changes
  }
  // The new place: the separator the block had on that side, and for blocks
  // other than items the one already there on the other.
  const far = step(at, down ? 1 : -1)
  let insert: Change & { offset: number }
  if (down) {
    const gap = join(at, following)
    insert =
      far && !items
        ? {
            from: at.to,
            to: start(far),
            insert:
              gap +
              text +
              join(block, state.doc.sliceString(at.to, start(far))),
            offset: gap.length,
          }
        : { from: at.to, to: at.to, insert: gap + text, offset: gap.length }
  } else {
    const gap = join(block, before)
    const head =
      far && !items ? join(far, state.doc.sliceString(far.to, start(at))) : ''
    insert =
      far && !items
        ? {
            from: far.to,
            to: start(at),
            insert: head + text + gap,
            offset: head.length,
          }
        : { from: start(at), to: start(at), insert: text + gap, offset: 0 }
  }
  changes.push(insert)
  // Changes are in document order; an insertion goes before a replacement
  // starting at the same place.
  changes.sort((a, b) => a.from - b.from || a.to - b.to)
  const set = state.changes(
    changes.map(({ from, to, insert }) => ({
      from,
      to,
      insert: Text.of(insert.split('\n')),
    })),
  )
  const from = set.mapPos(insert.from, -1) + insert.offset
  // A selection inside the block moves with it; otherwise the caret goes to
  // the block's start.
  const { anchor, head } = state.selection.main
  const inside = (pos: number) => pos >= blockFrom && pos <= block.to
  const place = (pos: number) =>
    from + (remarkedChanges?.mapPos(pos - blockFrom) ?? pos - blockFrom)
  return {
    changes: set,
    selection:
      inside(anchor) && inside(head)
        ? EditorSelection.single(place(anchor), place(head))
        : EditorSelection.cursor(place(block.from)),
    scrollIntoView: true,
    userEvent: 'move',
    annotations: isolateHistory.of('full'),
  }
}

/** Move a block one place up or down among its siblings. */
export function blockStep(
  state: EditorState,
  tree: Tree,
  block: SyntaxNode,
  direction: -1 | 1,
) {
  const target = sibling(state, tree, block, direction)
  return target && moveBlock(state, tree, block, target, direction > 0)
}

/**
 * Move up or down the innermost block at the selection that can move: the
 * selected block, or the blocks around the selection's start, as the rich
 * view's commands do.
 */
export function selectionStep(
  state: EditorState,
  tree: Tree,
  direction: -1 | 1,
) {
  const { from, to } = state.selection.main
  let node = blockAt(tree, from)
  for (let outer = node; outer; outer = outer.parent)
    if (outer.from === from && outer.to === to && outer.name !== 'Document')
      node = outer
  for (; node && node.name !== 'Document'; node = node.parent) {
    const spec = blockStep(state, tree, node, direction)
    if (spec) return spec
  }
  return null
}

const editable = (view: EditorView) =>
  !view.state.readOnly && view.state.facet(EditorView.editable)

/** Run a move in a formatted view, then return focus to it. */
function moveIn(view: EditorView, spec: TransactionSpec | null) {
  if (!spec || !editable(view) || view.composing) return false
  view.dispatch(spec)
  view.focus()
  return true
}

/** The palette's move commands in a formatted view. */
export function formattedStep(view: EditorView, direction: -1 | 1) {
  const tree = formattedSyntaxTree(view.state)
  return moveIn(view, tree && selectionStep(view.state, tree, direction))
}

/** The line or block widget element drawn at `pos`, if it is drawn. */
function lineElement(view: EditorView, pos: number) {
  const { node, offset } = view.domAtPos(pos)
  let current: Node | null =
    node === view.contentDOM
      ? (node.childNodes[offset] ?? node.childNodes[offset - 1] ?? null)
      : node
  while (current && current.parentNode !== view.contentDOM)
    current = current.parentNode
  return current instanceof HTMLElement ? current : null
}

/** A block's first or last line that is drawn, past lines the view hides. */
function shownLine(view: EditorView, block: SyntaxNode, last: boolean) {
  const from = Math.max(block.from, view.viewport.from)
  const to = Math.min(block.to, view.viewport.to)
  for (let pos = last ? to : from; pos >= from && pos <= to; ) {
    const line = view.lineBlockAt(pos)
    if (line.height > 0.5) return lineElement(view, line.from)
    pos = last ? line.from - 1 : line.to + 1
    if (pos < block.from || pos > block.to) break
  }
  return null
}

/** The top and bottom of a block's box, without the space above it. */
function blockBox(view: EditorView, block: SyntaxNode) {
  const first = shownLine(view, block, false),
    last = shownLine(view, block, true)
  if (!first || !last) return null
  return {
    // A line's own top padding is the space between blocks.
    top:
      first.getBoundingClientRect().top +
      (Number.parseFloat(first.style.paddingTop) || 0),
    bottom: last.getBoundingClientRect().bottom,
  }
}

/** The text column of a formatted view. */
function column(view: EditorView) {
  const rect = view.contentDOM.getBoundingClientRect()
  const style = getComputedStyle(view.contentDOM)
  return {
    left: rect.left + Number.parseFloat(style.paddingLeft),
    right: rect.right - Number.parseFloat(style.paddingRight),
  }
}

/** A block's drawn edge, including contributed container widths and controls. */
function blockLeft(view: EditorView, block: SyntaxNode) {
  const line = shownLine(view, block, false)
  let depth = 0
  for (let parent = block.parent; parent; parent = parent.parent)
    if (parent.name === block.name) depth++
  const edge = line?.querySelector(
    `[data-hibi-block-edge="${block.name}:${depth}"]`,
  )
  const text = line?.classList.contains('cm-line')
    ? line
    : (line?.querySelector('.cm-line') ?? line)
  return (edge ?? text)?.getBoundingClientRect().left ?? column(view).left
}

/**
 * A copy of a block's lines in view with their computed styles, like the
 * rich view's drag image.
 */
function dragImage(view: EditorView, block: SyntaxNode) {
  const image = document.createElement('div')
  image.style.cssText = 'position: absolute; top: -10000px; left: 0'
  const to = Math.min(block.to, view.viewport.to)
  for (let pos = Math.max(block.from, view.viewport.from); pos <= to; ) {
    const line = view.lineBlockAt(pos)
    const element = line.height > 0.5 && lineElement(view, line.from)
    if (element) {
      const clone = element.cloneNode(true) as HTMLElement
      const targets = [clone, ...clone.getElementsByTagName('*')]
      ;[element, ...element.getElementsByTagName('*')].forEach(
        (source, index) => {
          const style = getComputedStyle(source)
          let css = ''
          for (let i = 0; i < style.length; i++)
            css += `${style[i]}:${style.getPropertyValue(style[i]!)};`
          ;(targets[index] as HTMLElement).style.cssText = css
        },
      )
      clone.style.margin = '0'
      clone.style.paddingTop = '0'
      image.append(clone)
    }
    pos = line.to + 1
  }
  return image
}

class BlockHandle {
  readonly wrapper = document.createElement('div')
  readonly handle = document.createElement('button')
  readonly indicator = document.createElement('div')
  /** The block the handle moves. */
  target: Block | null = null
  dragged: Block | null = null
  menu: { close: () => void } | undefined
  image: HTMLElement | null = null
  frame = 0
  pointer: { x: number; y: number } | null = null

  readonly view: EditorView
  readonly host: BlockDragHost

  constructor(view: EditorView, host: BlockDragHost) {
    this.view = view
    this.host = host
    const { wrapper, handle, indicator } = this
    // The rich view's handle markup, so the addon's styles apply alike.
    wrapper.style.cssText =
      'position: absolute; top: 0; left: 0; z-index: 10; pointer-events: none'
    handle.type = 'button'
    handle.className = 'block-drag-handle'
    handle.setAttribute('aria-label', 'Drag block or open block actions')
    handle.dataset.tooltip = 'Drag to move · click for block actions'
    handle.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="5" r="1.5"/><circle cx="15" cy="5" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="19" r="1.5"/><circle cx="15" cy="19" r="1.5"/></svg>'
    handle.draggable = true
    handle.dataset.dragging = 'false'
    handle.style.position = 'absolute'
    indicator.className = 'block-drag-drop'
    indicator.setAttribute('aria-hidden', 'true')
    indicator.hidden = true
    wrapper.append(handle, indicator)
    view.dom.append(wrapper)
    this.hide()
    view.dom.addEventListener('mousemove', this.move)
    view.dom.addEventListener('mouseleave', this.leave)
    view.contentDOM.addEventListener('keydown', this.keydown, true)
    view.dom.addEventListener('dragover', this.dragover, true)
    view.dom.addEventListener('drop', this.dropped, true)
    view.dom.addEventListener('dragleave', this.dragleave)
    handle.addEventListener('click', this.open)
    handle.addEventListener('dragstart', this.dragstart)
    handle.addEventListener('dragend', this.dragend)
    if (view.hasFocus) host.focus(view)
  }

  update(update: ViewUpdate) {
    if (!editable(this.view)) return this.hide()
    if (update.docChanged) {
      const map = (block: Block | null) =>
        block && {
          ...block,
          from: update.changes.mapPos(block.from, 1),
          to: update.changes.mapPos(block.to, -1),
        }
      this.target = map(this.target)
      this.dragged = map(this.dragged)
      this.indicator.hidden = true
    }
    // The handle follows its block when the text or the layout changes.
    if (
      (update.docChanged || update.geometryChanged) &&
      this.handle.style.visibility !== 'hidden'
    )
      this.place()
  }

  hide() {
    this.handle.style.visibility = 'hidden'
    this.handle.style.pointerEvents = 'none'
  }

  show() {
    if (!editable(this.view)) return this.hide()
    this.handle.style.visibility = ''
    this.handle.style.pointerEvents = 'auto'
  }

  /** A block in the view's tree now. */
  node(block: Block | null) {
    const tree = formattedSyntaxTree(this.view.state)
    return block && tree && blockNode(tree, block)
  }

  /** Tab targets the caret's block even when another block was last hovered. */
  activateCaret() {
    const tree = formattedSyntaxTree(this.view.state)
    const node =
      tree &&
      handleTarget(tree, this.view.state.selection.main.head, () => false)
    if (!node) return this.hide()
    this.target = { from: node.from, to: node.to, name: node.name }
    // Native focus scrolls to the button before the next measurement frame.
    this.positioned(this.position(this.view))
  }

  readonly keydown = (event: KeyboardEvent) => {
    if (event.key === 'Tab' && !event.shiftKey) this.activateCaret()
    else this.hide()
  }

  readonly move = (event: MouseEvent) => {
    if (this.dragged || this.wrapper.contains(event.target as Node)) return
    this.pointer = { x: event.clientX, y: event.clientY }
    this.frame ||= requestAnimationFrame(() => {
      this.frame = 0
      const pointer = this.pointer
      this.pointer = null
      if (pointer) this.hover(pointer.x, pointer.y)
    })
  }

  /** Put the handle beside the block under the pointer. */
  hover(x: number, y: number) {
    const { view } = this
    const tree = formattedSyntaxTree(view.state)
    if (!tree || !editable(view) || this.dragged) return
    const text = column(view)
    // The margin beside a block finds it, as in the rich view.
    const inside = Math.min(Math.max(x, text.left + 5), text.right - 5)
    const pos = view.posAtCoords({ x: inside, y }, false)
    const node = handleTarget(tree, pos, (node) => {
      if (inside < blockLeft(view, node) + 12) return true
      const box = blockBox(view, node)
      return !!box && y < box.top + 12
    })
    if (!node) return
    if (
      this.target &&
      same(node, this.target) &&
      this.handle.style.visibility !== 'hidden'
    )
      return
    this.target = { from: node.from, to: node.to, name: node.name }
    this.place()
  }

  position(view: EditorView) {
    const node = this.node(this.target)
    const box = node && blockBox(view, node)
    if (!node || !box) return null
    const base = view.dom.getBoundingClientRect()
    return {
      left: blockLeft(view, node) - this.handle.offsetWidth - base.left,
      top: box.top - base.top,
    }
  }

  positioned(position: { left: number; top: number } | null) {
    if (!position) return this.hide()
    this.handle.style.left = `${position.left}px`
    this.handle.style.top = `${position.top}px`
    this.show()
  }

  /** Place the handle left of its block's first line, as the rich view does. */
  place() {
    this.view.requestMeasure({
      key: this,
      read: (view) => this.position(view),
      write: (position) => this.positioned(position),
    })
  }

  readonly leave = (event: MouseEvent) => {
    if (
      this.wrapper.contains(event.relatedTarget as Node) ||
      document.activeElement === this.handle
    )
      return
    this.hide()
  }

  readonly open = () => {
    const { view } = this
    const node = this.node(this.target)
    if (!editable(view) || !node) return
    const block = { from: node.from, to: node.to, name: node.name }
    const step = (direction: -1 | 1) => {
      const tree = formattedSyntaxTree(view.state)
      const current = tree && blockNode(tree, block)
      return current && blockStep(view.state, tree, current, direction)
    }
    this.menu?.close()
    this.menu = this.host.menus.open({
      label: 'Block actions',
      anchor: this.handle,
      items: ([-1, 1] as const).map((direction) => ({
        id: direction < 0 ? 'up' : 'down',
        label: direction < 0 ? 'Move block up' : 'Move block down',
        disabled: !step(direction),
        onSelect: () => {
          moveIn(view, step(direction))
        },
      })),
    })
  }

  readonly dragstart = (event: DragEvent) => {
    const node = this.node(this.target)
    if (
      !event.dataTransfer ||
      !node ||
      !editable(this.view) ||
      sourceFrom(this.view.state, node) === null ||
      footnote(this.view.state, node) ||
      !closed(this.view.state, node)
    ) {
      event.preventDefault()
      return
    }
    this.dragged = { from: node.from, to: node.to, name: node.name }
    this.image = dragImage(this.view, node)
    document.body.append(this.image)
    event.dataTransfer.clearData()
    event.dataTransfer.setData(
      'text/plain',
      this.view.state.sliceDoc(sourceFrom(this.view.state, node)!, node.to),
    )
    event.dataTransfer.effectAllowed = 'copyMove'
    event.dataTransfer.setDragImage(this.image, 0, 0)
    this.handle.dataset.dragging = 'true'
    // Drag events reach the text under the handle.
    setTimeout(() => {
      if (this.dragged) this.handle.style.pointerEvents = 'none'
    })
  }

  readonly dragend = () => {
    this.dragged = null
    this.indicator.hidden = true
    this.image?.remove()
    this.image = null
    this.handle.dataset.dragging = 'false'
    this.hide()
  }

  /** Where a drop at the pointer puts the dragged block: beside which sibling, and on which side. */
  dropAt(x: number, y: number) {
    const { view } = this
    const tree = formattedSyntaxTree(view.state)
    const block = this.node(this.dragged)
    if (!tree || !block) return null
    const text = column(view)
    const inside = Math.min(Math.max(x, text.left + 5), text.right - 5)
    const near = dropSibling(
      tree,
      block,
      view.posAtCoords({ x: inside, y }, false),
    )
    if (!near) return null
    // The lower half of a block drops after it.
    const top = view.lineBlockAt(near.from).top,
      bottom = view.lineBlockAt(near.to).bottom
    const after =
      y - view.documentTop > (top + bottom) / 2 ||
      near.name === 'Frontmatter' ||
      near.name === 'AlertTitle'
    return { tree, block, near, after, text }
  }

  readonly dragover = (event: DragEvent) => {
    if (!this.dragged) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    const { clientX: x, clientY: y } = event
    this.view.requestMeasure({
      key: this.indicator,
      read: (view) => {
        const found = this.dropAt(x, y)
        const box = found && blockBox(view, found.near)
        if (!found || !box) return null
        const { tree, near, after, text } = found
        const neighbor = sibling(view.state, tree, near, after ? 1 : -1)
        const other = neighbor && blockBox(view, neighbor)
        const edge = after ? box.bottom : box.top
        // Between two blocks, the line is halfway across the space between them.
        const middle = other
          ? (edge + (after ? other.top : other.bottom)) / 2
          : edge
        const base = view.dom.getBoundingClientRect()
        const left = blockLeft(view, near)
        return {
          left: left - base.left,
          width: text.right - left,
          top: middle - base.top,
        }
      },
      write: (line) => {
        this.indicator.hidden = !line
        if (!line) return
        this.indicator.style.left = `${line.left}px`
        this.indicator.style.width = `${line.width}px`
        this.indicator.style.top = `${line.top - 0.5}px`
      },
    })
  }

  readonly dragleave = (event: DragEvent) => {
    if (!this.view.dom.contains(event.relatedTarget as Node))
      this.indicator.hidden = true
  }

  readonly dropped = (event: DragEvent) => {
    if (!this.dragged) return
    // The block moves; CodeMirror's own drop would insert a copy of its text.
    event.preventDefault()
    event.stopPropagation()
    const found = this.dropAt(event.clientX, event.clientY)
    this.dragend()
    if (found)
      moveIn(
        this.view,
        moveBlock(
          this.view.state,
          found.tree,
          found.block,
          found.near,
          found.after,
        ),
      )
  }

  destroy() {
    cancelAnimationFrame(this.frame)
    this.menu?.close()
    this.image?.remove()
    const { view } = this
    view.dom.removeEventListener('mousemove', this.move)
    view.dom.removeEventListener('mouseleave', this.leave)
    view.contentDOM.removeEventListener('keydown', this.keydown, true)
    view.dom.removeEventListener('dragover', this.dragover, true)
    view.dom.removeEventListener('drop', this.dropped, true)
    view.dom.removeEventListener('dragleave', this.dragleave)
    this.wrapper.remove()
    this.host.close(view)
  }
}

/** The drag handle in each formatted view. */
export function blockDragContribution(
  host: BlockDragHost,
): FormattedContribution {
  const handles = ViewPlugin.define((view) => new BlockHandle(view, host))
  return {
    id: 'block-drag.handle',
    extension: [
      formattedBlockEdges.of(true),
      handles,
      EditorView.domEventObservers({
        focus(_, view) {
          host.focus(view)
        },
      }),
    ],
  }
}
