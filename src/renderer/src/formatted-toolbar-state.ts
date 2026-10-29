import type { ChangeSpec, EditorState, SelectionRange } from '@codemirror/state'
import {
  IterMode,
  type SyntaxNode,
  type SyntaxNodeRef,
  type Tree,
  type TreeCursor,
} from '@lezer/common'
import {
  formattedFormatting,
  formattedLiteral,
} from './formatted-contributions.ts'
import { blockSelected } from './formatted-text-end.ts'

/*
 * Toolbar states in the formatted view, read from its syntax tree the way the
 * rich editor reads its document. A caret takes the marks of the text before
 * it, or after it at the start of a block. A range is active for a mark all
 * of its text holds, and for a block that covers it, counted as the rich
 * editor counts positions: one per character of text and one for each
 * block's start and end. Syntax whose feature is off is literal text, an
 * atom that takes no marks, as the rich editor holds it.
 *
 * A caret reads the syntax around it. A range reads the syntax inside it, in
 * order, and stops once every action's state is known: on a selection of
 * mixed blocks and marks that is after a few of them, while a selection of
 * one kind of block, like the rich editor's own check, reads all of them.
 */

/** The toolbar's marks by the syntax that writes them. */
const markIds: Record<string, string> = {
  StrongEmphasis: 'bold',
  Emphasis: 'italic',
  Strikethrough: 'strike',
  Subscript: 'subscript',
  InlineCode: 'inline-code',
  Link: 'link',
  Autolink: 'link',
  URL: 'link',
}
const marks = ['bold', 'italic', 'strike', 'subscript', 'inline-code', 'link']
/** Each action's syntax, which a disabled syntax feature shows as text. */
const actionNodes: Record<string, string> = {
  bold: 'StrongEmphasis',
  italic: 'Emphasis',
  strike: 'Strikethrough',
  subscript: 'Subscript',
  'inline-code': 'InlineCode',
  link: 'Link',
  unlink: 'Link',
  quote: 'Blockquote',
  'bullet-list': 'BulletList',
  'numbered-list': 'OrderedList',
  'code-block': 'FencedCode',
  divider: 'HorizontalRule',
  'hard-break': 'HardBreak',
  ...Object.fromEntries(
    [1, 2, 3, 4, 5, 6].map((level) => [
      `heading-${level}`,
      `ATXHeading${level}`,
    ]),
  ),
}
const lists = ['bullet-list', 'numbered-list', 'checklist']
const containers = [
  'Document',
  'Blockquote',
  'BulletList',
  'OrderedList',
  'ListItem',
  'ContainerHTML',
  'Table',
  'TableHeader',
  'TableRow',
]

/** The text of inline formatting, between its opening and closing syntax. */
export function formattingText(state: EditorState, node: SyntaxNode) {
  // A bare web address is all text.
  if (node.name === 'URL') return { from: node.from, to: node.to }
  const first = node.firstChild
  let last = node.lastChild
  // A link's text ends at its `]`, a few nodes before its end.
  if (node.name === 'Link')
    while (
      last &&
      !(last.name === 'LinkMark' && state.sliceDoc(last.from, last.to) === ']')
    )
      last = last.prevSibling
  return first && last && first !== last && first.to <= last.from
    ? { from: first.to, to: last.from }
    : null
}

/** A link's own address, which belongs to the link around it. */
const linkAddress = (node: SyntaxNode) =>
  node.name === 'URL' &&
  (node.parent?.name === 'Autolink' || node.parent?.name === 'Link')

/** Syntax inside a block that the formatted view hides or draws as something else. */
const blockSyntax = (node: SyntaxNodeRef) =>
  node.name.endsWith('Mark') ||
  node.name === 'TaskMarker' ||
  node.name === 'CodeInfo' ||
  node.name === 'HardBreak' ||
  node.name === 'Image' ||
  node.name === 'TableDelimiter'

/** A text block, or a table cell, which holds a paragraph in the rich editor. */
const isLeaf = (node: SyntaxNodeRef) =>
  node.name === 'TableCell' ||
  (node.type.is('Block') && !containers.includes(node.name))

/** The rich editor's node for a block: an action, or the kind of container. */
function blockType(node: SyntaxNode) {
  const { name } = node
  if (name === 'Paragraph' || name === 'Task' || name === 'TableCell')
    return 'paragraph'
  if (/^(?:ATX|Setext)Heading[1-6]$/.test(name))
    return `heading-${name.slice(-1)}`
  if (name === 'FencedCode' || name === 'CodeBlock') return 'code-block'
  if (name === 'Subtext') return 'subtext'
  if (name === 'Blockquote') return 'quote'
  if (name === 'OrderedList') return 'numbered-list'
  if (name === 'BulletList')
    return node.firstChild ? listOf(node.firstChild) : 'bullet-list'
  if (containers.includes(name)) return name
  return 'other'
}

/** The list item's list action: a task list, numbered or bulleted. */
function listOf(item: SyntaxNode) {
  if (item.parent?.name === 'OrderedList') return 'numbered-list'
  const mark = item.firstChild
  return mark && item.childAfter(mark.to)?.name === 'Task'
    ? 'checklist'
    : 'bullet-list'
}

type Block = { node: SyntaxNode | null; kind: string }

/** A block whose syntax is shown as text: a literal block of the rich editor. */
const literalBlock = (node: SyntaxNodeRef, literal: readonly string[]) =>
  literal.includes(node.name) &&
  (node.type.is('Block') || containers.includes(node.name))

/** The text block holding `node`, or the outermost literal block around it. */
function blockOf(node: SyntaxNode | null, literal: readonly string[]): Block {
  let block: Block = { node: null, kind: '' }
  for (let at = node; at; at = at.parent)
    if (literalBlock(at, literal)) block = { node: at, kind: 'literal' }
    else if (!block.node && isLeaf(at))
      block = { node: at, kind: blockType(at) }
  return block
}

/**
 * The block at `pos`, looking first to the side `side`; a line between
 * blocks takes a paragraph.
 */
export function blockAt(
  tree: Tree,
  pos: number,
  literal: readonly string[],
  side: -1 | 1 = 1,
): Block {
  const first = blockOf(tree.resolveInner(pos, side), literal)
  if (first.node) return first
  const other = blockOf(tree.resolveInner(pos, side === 1 ? -1 : 1), literal)
  return other.node ? other : { node: null, kind: 'paragraph' }
}

/** Where a text block's text starts, after its own markers. */
export function textStart(state: EditorState, block: SyntaxNode) {
  let at = block.from
  for (
    let child = block.firstChild;
    child && child.from <= at + 1 && blockSyntax(child);
    child = child.nextSibling
  )
    at = child.to
  while (at < block.to && /[ \t]/.test(state.sliceDoc(at, at + 1))) at++
  if (block.name === 'FencedCode' && state.sliceDoc(at, at + 1) === '\n') at++
  return at
}

export function textEnd(block: SyntaxNode) {
  const last = block.lastChild
  return block.name === 'FencedCode' && last?.name === 'CodeMark'
    ? Math.max(block.from, last.from - 1)
    : block.to
}

/** The formatting names that are not shown as text. */
function formattingNames(state: EditorState) {
  const literal = state.facet(formattedLiteral)
  return [...Object.keys(markIds), ...state.facet(formattedFormatting)].filter(
    (name) => !literal.includes(name),
  )
}

/**
 * The formatting holding the character at `pos`, innermost first, or the
 * formatting syntax that the character belongs to.
 */
function inlineAt(
  state: EditorState,
  tree: Tree,
  pos: number,
  formatting: readonly string[],
) {
  const found = new Map<string, SyntaxNode>()
  // A character in literal syntax belongs to that atom, which holds the marks around it.
  const atom = literalInline(state, tree, pos, pos + 1)
  for (
    let node: SyntaxNode | null = atom
      ? atom.parent
      : tree.resolveInner(pos, 1);
    node && !isLeaf(node) && !containers.includes(node.name);
    node = node.parent
  ) {
    if (!formatting.includes(node.name) || linkAddress(node)) continue
    const text = formattingText(state, node)
    if (!text) continue
    if (pos < text.from) return { syntax: { from: node.from, to: text.from } }
    if (pos >= text.to) return { syntax: { from: text.to, to: node.to } }
    const id = markIds[node.name]
    if (id && !found.has(id)) found.set(id, node)
  }
  return { marks: found }
}

/** The outermost literal inline syntax that holds `from`-`to`. */
function literalInline(
  state: EditorState,
  tree: Tree,
  from: number,
  to: number,
) {
  const literal = state.facet(formattedLiteral)
  if (!literal.length) return null
  let atom: SyntaxNode | null = null
  for (
    let node: SyntaxNode | null = tree.resolveInner(from, 1);
    node && !isLeaf(node) && !containers.includes(node.name);
    node = node.parent
  )
    if (literal.includes(node.name) && node.from <= from && node.to >= to)
      atom = node
  return atom
}

/**
 * The rich editor's marks at a caret: those of the text before it, or of the
 * text after it at the start of its block. A mark that typing at its end does
 * not extend, like subscript, holds only inside its text.
 */
export function caretMarks(state: EditorState, tree: Tree, pos: number) {
  const { node: block, kind } = blockAt(
    tree,
    pos,
    state.facet(formattedLiteral),
  )
  const none = new Map<string, SyntaxNode>()
  if (!block || !takesMarks(kind) || insideLiteral(state, tree, pos))
    return none
  const formatting = formattingNames(state)
  const start = textStart(state, block),
    end = textEnd(block)
  let before: Map<string, SyntaxNode> | null = null,
    after: Map<string, SyntaxNode> | null = null
  for (let at = pos; at > start; ) {
    const found = inlineAt(state, tree, at - 1, formatting)
    if (found.marks) {
      before = found.marks
      break
    }
    at = found.syntax.from
  }
  for (let at = pos; at < end; ) {
    const found = inlineAt(state, tree, at, formatting)
    if (found.marks) {
      after = found.marks
      break
    }
    at = found.syntax.to
  }
  const main = before ?? after
  if (!main) return none
  const other = before ? after : null
  if (main.has('subscript') && !other?.has('subscript'))
    main.delete('subscript')
  return main
}

/** Blocks whose text takes marks. */
const takesMarks = (kind: string) =>
  kind !== 'code-block' && kind !== 'other' && kind !== 'literal'

/** A caret inside literal inline syntax, whose text takes no marks. */
function insideLiteral(state: EditorState, tree: Tree, pos: number) {
  const atom = literalInline(state, tree, pos, pos)
  return !!atom && atom.from < pos && pos < atom.to
}

const headings = [1, 2, 3, 4, 5, 6].map((level) => `heading-${level}`)
/** Block actions with a pressed state, and those that turn text blocks into their kind. */
const blockKinds = [
  'paragraph',
  ...headings,
  'code-block',
  'subtext',
  'quote',
  ...lists,
]
const textKinds = ['paragraph', 'subtext', ...headings, 'code-block']
const stop = Symbol('stop')

/**
 * The formatting whose text holds `pos`, innermost first: where typing at a
 * caret there goes, which can differ from the marks the toolbar shows.
 */
export function formattingAt(state: EditorState, tree: Tree, pos: number) {
  const formatting = formattingNames(state)
  const found = new Map<string, SyntaxNode>()
  for (
    let node: SyntaxNode | null = tree.resolveInner(pos, 1);
    node && !isLeaf(node) && !containers.includes(node.name);
    node = node.parent
  ) {
    if (!formatting.includes(node.name) || linkAddress(node)) continue
    const text = formattingText(state, node)
    const id = markIds[node.name]
    if (text && id && !found.has(id) && text.from <= pos && pos <= text.to)
      found.set(id, node)
  }
  return found
}

/** Formatting of mark `id` that ends at `pos`, so that text typed there can join it. */
export function formattingBefore(
  state: EditorState,
  tree: Tree,
  pos: number,
  id: string,
) {
  for (
    let node: SyntaxNode | null = tree.resolveInner(pos, -1);
    node && !isLeaf(node) && !containers.includes(node.name);
    node = node.parent
  )
    if (node.to === pos && markIds[node.name] === id)
      return formattingText(state, node)
  return null
}

/**
 * Walk the nodes that touch `from`-`to` in order, like `Tree.iterate`, until
 * `enter` or `leave` returns `stop`.
 */
function walk(
  tree: Tree,
  from: number,
  to: number,
  enter: (node: TreeCursor) => boolean | typeof stop | undefined,
  leave: (node: TreeCursor) => typeof stop | undefined,
) {
  const cursor = tree.cursor(IterMode.IncludeAnonymous)
  for (;;) {
    let entered = false
    if (cursor.from <= to && cursor.to >= from) {
      const go = cursor.type.isAnonymous || enter(cursor)
      if (go === stop) return
      if (go !== false) {
        if (cursor.firstChild()) continue
        entered = true
      }
    }
    for (;;) {
      if (entered && !cursor.type.isAnonymous && leave(cursor) === stop) return
      if (cursor.nextSibling()) break
      if (!cursor.parent()) return
      entered = true
    }
  }
}

/**
 * What a range holds, counted as the rich editor counts positions: whether
 * text without each mark, and positions outside each kind of block, are in
 * it, and whether it has text that can take marks and blocks that can
 * become each text kind. `known` lists the kinds of the containers that hold
 * the whole range. The walk stops once all of that is known.
 */
function rangeContent(
  state: EditorState,
  tree: Tree,
  from: number,
  to: number,
  known: ReadonlySet<string>,
) {
  const literal = state.facet(formattedLiteral)
  const formatting = formattingNames(state)
  const seen = new Set<string>()
  const absent = new Set<string>()
  const uncovered = new Set<string>()
  const convertible = new Set<string>()
  const stack: string[] = []
  let units = 0,
    markable = 0,
    plain = 0,
    atoms = 0
  const add = (count: number) => {
    if (count <= 0) return
    units += count
    for (const kind of blockKinds)
      if (!uncovered.has(kind) && !stack.includes(kind)) uncovered.add(kind)
  }
  const open = (type: string, inside: boolean) => {
    stack.push(type)
    if (inside) add(1)
  }
  const close = (inside: boolean) => {
    if (inside) add(1)
    stack.pop()
  }
  const count = (start: number, end: number, ids: Set<string> | null) => {
    if (end <= start) return
    add(end - start)
    if (!ids) return
    markable += end - start
    if (!ids.has('inline-code')) plain += end - start
    // Inline code excludes the other marks, so its text counts for them.
    for (const id of marks)
      if (ids.has(id)) seen.add(id)
      else if (id === 'inline-code' || !ids.has('inline-code')) absent.add(id)
  }
  const leaf = (node: SyntaxNode, kind: string) => {
    const item = node.parent?.name === 'ListItem' ? node.parent : null
    // A list item starts with a paragraph, and literal atoms such as math stay.
    if (kind !== 'other' && !(item && firstInItem(item)?.from === node.from))
      for (const type of textKinds) if (type !== kind) convertible.add(type)
  }
  const done = () =>
    marks.every((id) => absent.has(id)) &&
    blockKinds.every((kind) => uncovered.has(kind) || known.has(kind)) &&
    textKinds.every((kind) => convertible.has(kind))
  // Text runs between the syntax of the block being read, with their marks,
  // and the closing syntax of open formatting, such as a link's destination.
  let runs: { id: string; to: number }[] = []
  let tails: { from: number; to: number }[] = []
  let block: {
    from: number
    to: number
    end: number
    cell: boolean
  } | null = null
  let cursor = from
  const flush = (until: number) => {
    if (!block) return
    const start = Math.max(cursor, from)
    const end = Math.min(until, to, block.end)
    if (end > start)
      count(
        start,
        end,
        new Set(runs.filter((mark) => mark.to > start).map(({ id }) => id)),
      )
    cursor = Math.max(cursor, until)
  }
  walk(
    tree,
    from,
    to,
    (node) => {
      if (!block && literalBlock(node, literal)) {
        // A literal block holds text that takes no marks.
        leaf(node.node, 'literal')
        open('literal', from < node.from)
        count(Math.max(node.from, from), Math.min(node.to, to), null)
        close(to > node.to)
        return done() ? stop : false
      }
      if (!block && isLeaf(node)) {
        const kind = blockType(node.node)
        leaf(node.node, kind)
        const start = textStart(state, node.node),
          end = textEnd(node.node)
        const cell = node.name === 'TableCell'
        if (cell) open('TableCell', from < start)
        open(kind, from < start)
        if (!takesMarks(kind)) {
          count(Math.max(start, from), Math.min(end, to), null)
          close(to > end)
          return done() ? stop : false
        }
        block = { from: node.from, to: node.to, end, cell }
        cursor = Math.max(from, start)
        runs = []
        tails = []
        return undefined
      }
      if (!block) {
        if (node.name !== 'Document' && containers.includes(node.name))
          open(blockType(node.node), node.from > from)
        return undefined
      }
      if (literal.includes(node.name)) {
        // Literal syntax is one atom, which can take marks but holds no marked text.
        flush(node.from)
        if (node.to > from && node.from < to) atoms++
        count(Math.max(node.from, from), Math.min(node.to, to, block.end), null)
        cursor = Math.max(cursor, node.to)
        return false
      }
      if (
        blockSyntax(node) ||
        tails.some((tail) => node.from >= tail.from && node.from < tail.to)
      ) {
        flush(node.from)
        cursor = Math.max(cursor, node.to)
        return false
      }
      if (!formatting.includes(node.name)) return undefined
      const inner = formattingText(state, node.node)
      if (!inner) return undefined
      flush(node.from)
      cursor = Math.max(cursor, inner.from)
      const id = markIds[node.name]
      if (id) runs.push({ id, to: inner.to })
      tails.push({ from: inner.to, to: node.to })
      return undefined
    },
    (node) => {
      if (block && node.from === block.from && node.to === block.to) {
        flush(block.end)
        close(to > block.end)
        if (block.cell) close(to > block.end)
        block = null
        return done() ? stop : undefined
      }
      if (!block) {
        if (node.name !== 'Document' && containers.includes(node.name))
          close(node.to < to)
        return undefined
      }
      if (!formatting.includes(node.name)) return undefined
      const inner = formattingText(state, node.node)
      if (!inner) return undefined
      flush(inner.to)
      runs = runs.filter((mark) => mark.to !== inner.to)
      tails = tails.filter((tail) => tail.to !== node.to)
      cursor = Math.max(cursor, node.to)
      return undefined
    },
  )
  return { units, markable, plain, atoms, seen, absent, uncovered, convertible }
}

/** A block's ancestors as the rich editor nests them: a table cell holds its paragraph. */
function ancestors(block: SyntaxNode | null) {
  const out: SyntaxNode[] = []
  if (block?.name === 'TableCell') out.push(block)
  for (let at = block?.parent ?? null; at; at = at.parent) out.push(at)
  return out
}

/** The first block of a list item, after its marker. */
const firstInItem = (item: SyntaxNode) =>
  item.firstChild ? item.childAfter(item.firstChild.to) : null

/** Toolbar states from the formatted view's syntax tree. */
export function formattedStates(
  state: EditorState,
  tree: Tree,
  range: SelectionRange,
  pending?: readonly string[] | null,
) {
  const literal = state.facet(formattedLiteral)
  const unsupported = (id: string) =>
    !!actionNodes[id] && literal.includes(actionNodes[id])
  // A block selected whole, as the rich editor's node selection, takes a
  // quote around it, a divider after it or an image in its place.
  if (blockSelected(state, range.from, range.to)) {
    const node = blockAt(tree, range.from, literal).node
    const item = node?.parent?.name === 'ListItem' ? node.parent : null
    return {
      pressed: (id: string) =>
        !!item && !unsupported(id) && id === listOf(item),
      disabled: (id: string) =>
        unsupported(id) ||
        !(
          [
            'quote',
            'divider',
            'image',
            'hard-break',
            'unlink',
            'table',
          ].includes(id) ||
          (item &&
            (lists.includes(id) ||
              id === 'outdent' ||
              (id === 'indent' && !!item.prevSibling)))
        ),
    }
  }
  // The blocks at the selection's ends, as the rich editor ranges blocks.
  const first = blockAt(tree, range.from, literal)
  const last = range.empty ? first : blockAt(tree, range.to, literal, -1)
  const chain = ancestors(first.node)
  const holds = (node: SyntaxNode) =>
    !last.node || (node.from <= last.node.from && node.to >= last.node.to)
  const known = new Set(chain.filter(holds).map((node) => blockType(node)))
  const content = range.empty
    ? null
    : rangeContent(state, tree, range.from, range.to, known)
  // A range of syntax alone is a caret in the rich editor.
  const caret = !content?.units
  const atCaret = caret ? caretMarks(state, tree, range.from) : null
  // A selection that starts inside literal syntax and stays in its block.
  const inAtom =
    insideLiteral(state, tree, range.from) &&
    (range.empty ||
      first.node === last.node ||
      first.node?.from === last.node?.from)
  // The node whose children the selection's blocks are.
  const parent =
    chain.find((node) => holds(node) || node.name === 'Document') ?? null
  /** The child of that node that holds the selection's start. */
  const head = parent ? (chain[chain.indexOf(parent) - 1] ?? first.node) : null
  const blockActive = (type: string) =>
    caret || !content
      ? first.kind === type || chain.some((node) => blockType(node) === type)
      : known.has(type) ||
        (blockKinds.includes(type) && !content.uncovered.has(type))
  const caretHas = (id: string) =>
    range.empty && pending ? pending.includes(id) : !!atCaret?.has(id)
  const markActive = (id: string) =>
    atCaret
      ? caretHas(id)
      : !!content?.markable && content.seen.has(id) && !content.absent.has(id)
  const pressed = (id: string): boolean =>
    !unsupported(id) && (marks.includes(id) ? markActive(id) : blockActive(id))
  const canMark = (id: string) => {
    if (atCaret)
      return (
        takesMarks(first.kind) &&
        !insideLiteral(state, tree, range.from) &&
        (id === 'inline-code' || caretHas(id) || !caretHas('inline-code'))
      )
    if (content?.atoms) return true
    return id === 'inline-code'
      ? (content?.markable ?? 0) > 0
      : (content?.plain ?? 0) > 0
  }
  /**
   * A block of the selection that can become `type`. Literal atoms, such as
   * math, stay, and a list item starts with a paragraph.
   */
  const convertible = (type: string) =>
    content && !caret
      ? content.convertible.has(type)
      : first.kind !== type &&
        first.kind !== 'other' &&
        !(
          first.node?.parent?.name === 'ListItem' &&
          firstInItem(first.node.parent)?.from === first.node.from
        )
  const listAbove = chain.find(
    (node) => node.name === 'BulletList' || node.name === 'OrderedList',
  )
  /** The list holding the whole selection whose items are, or are not, tasks. */
  const itemList = () => {
    const tasks = pressed('checklist')
    return chain.find(
      (node) =>
        (node.name === 'BulletList' || node.name === 'OrderedList') &&
        holds(node) &&
        (blockType(node) === 'checklist') === tasks,
    )
  }
  const disabled = (id: string): boolean => {
    if (unsupported(id)) return true
    if (marks.includes(id)) return !pressed(id) && !canMark(id)
    if (id === 'paragraph' || id === 'subtext') return !convertible(id)
    if (id.startsWith('heading-') || id === 'code-block')
      return !pressed(id) && !convertible(id)
    // From inside literal syntax the rich editor ranges no blocks to wrap or lift.
    if ((id === 'quote' || lists.includes(id)) && inAtom) return true
    if (id === 'quote') {
      if (pressed(id)) return false
      // A quote wraps the parent's blocks where the parent can hold one.
      if (!parent) return false
      if (parent.name === 'ListItem')
        return head?.from === firstInItem(parent)?.from
      return [
        'BulletList',
        'OrderedList',
        'Table',
        'TableHeader',
        'TableRow',
      ].includes(parent.name)
    }
    if (lists.includes(id)) {
      // In a list, the action lifts its items or changes the list's kind.
      if (
        listAbove &&
        parent &&
        parent.name !== 'Document' &&
        chain.indexOf(listAbove) - chain.indexOf(parent) <= 1
      )
        return false
      // Otherwise it wraps the blocks, and a list item starts with a paragraph.
      return !(
        head === first.node &&
        first.kind === 'paragraph' &&
        (first.node?.name !== 'TableCell' || parent === first.node)
      )
    }
    if (id === 'indent') {
      // An item indents under the item before it, in the same list.
      const items = itemList()
      const item = items && chain[chain.indexOf(items) - 1]
      return !item || item.from <= (items?.from ?? 0)
    }
    if (id === 'outdent') return !itemList()
    return false
  }
  return { pressed, disabled }
}

/**
 * Changes that remove the link around a caret, or the links of a range's
 * text, keeping that text. Like the rich editor, a range leaves the link on
 * the text outside it, and formatting the split cuts closes and opens again:
 * `[ab**c**](u)**de**[**f**gh](u)` from `de` in `[ab**cdef**gh](u)`.
 * References keep their label, spelled out where the text was the label
 * (`[ab][r]cd[ef][r]`), and an autolink's kept parts link to its address.
 */
export function unlinkChanges(
  state: EditorState,
  tree: Tree,
  range: SelectionRange,
): ChangeSpec[] {
  const changes: { from: number; to?: number; insert?: string }[] = []
  // Where escaped punctuation is turned off, a backslash would show, so a
  // character reference spells the character instead.
  const escapes = !state.facet(formattedLiteral).includes('Escape')
  const reference = (char: string) => `&#${char.codePointAt(0)};`
  const literal = (from: number, char: string) =>
    char === '&'
      ? { from: from + 1, insert: 'amp;' }
      : escapes
        ? { from, insert: '\\' }
        : { from, to: from + char.length, insert: reference(char) }
  const unlink = (node: SyntaxNode) => {
    const bare = node.name === 'URL'
    const autolink = bare || node.name === 'Autolink'
    const text = bare
      ? node
      : autolink
        ? node.getChild('URL')
        : formattingText(state, node)
    if (!text) return
    // An autolink's address is literal text. As Markdown text it needs its
    // Markdown characters escaped. Text no longer linked also needs escaped
    // what would make it a web address or email again, outside code and
    // other literal syntax.
    const escapeText = (from: number, to: number, linked: boolean) => {
      const syntax = autolink
        ? linked
          ? /[\\`*_~[\]&$^=|!]/g
          : /[\\`*_~[\]&$^=|!@]|(?<=https?|ftp):(?=\/\/)|(?<=www)\./gi
        : !linked && /@|(?<=https?|ftp):(?=\/\/)|(?<=www)\./gi
      if (!syntax) return
      const parts: [number, number][] = []
      let at = from
      if (!autolink)
        tree.iterate({
          from,
          to,
          enter: (node) => {
            if (node.to <= at || node.from >= to) return false
            if (!literalSyntax.includes(node.name)) return undefined
            if (node.from > at) parts.push([at, node.from])
            at = node.to
            return false
          },
        })
      if (at < to) parts.push([at, to])
      for (const [start, end] of parts)
        for (const match of state.sliceDoc(start, end).matchAll(syntax))
          changes.push(literal(start + match.index, match[0]))
    }
    const whole = () => {
      changes.push({ from: node.from, to: text.from })
      escapeText(text.from, text.to, false)
      changes.push({ from: text.to, to: node.to })
    }
    if (range.empty) {
      whole()
      return
    }
    const start = autolink
      ? {
          at: Math.max(range.from, text.from),
          close: '',
          open: '',
          code: null,
          spaces: [],
        }
      : cut(state, tree, node, text, Math.max(range.from, text.from))
    const end = autolink
      ? {
          at: Math.min(range.to, text.to),
          close: '',
          open: '',
          code: null,
          spaces: [],
        }
      : cut(state, tree, node, text, Math.min(range.to, text.to))
    if (end.at <= start.at) return
    if (start.at <= text.from && end.at >= text.to) {
      whole()
      return
    }
    const replace = (from: number, to: number, insert: string) => {
      if (state.sliceDoc(from, to) !== insert)
        changes.push({ from, to, insert })
    }
    // A cut in code ends the code and starts it again, each part with the
    // fence and padding that keep its text.
    const same = start.code && start.code.from === end.code?.from
    for (const side of [start, end]) {
      const code = side.code
      const inner = code && codeText(state, code)
      if (!code || !inner) continue
      const from = side === end && same ? start.at : inner.from
      const to = side === start && same ? end.at : inner.to
      const left = codeFence(state.sliceDoc(from, side.at))
      const right = codeFence(state.sliceDoc(side.at, to))
      side.close = left.close + side.close
      side.open += right.open
      if (from === inner.from) replace(code.from, inner.from, left.open)
      if (to === inner.to) replace(inner.to, code.to, right.close)
    }
    for (const at of new Set([...start.spaces, ...end.spaces]))
      replace(at, at + 1, `&#${state.sliceDoc(at, at + 1).codePointAt(0)};`)
    // What follows each kept part's text: the link's own destination or
    // label, a label for a shortcut or collapsed reference, or an
    // autolink's address, where one without a scheme is an email.
    const tail = state.sliceDoc(text.to, node.to)
    const url = state.sliceDoc(text.from, text.to)
    const href = (
      /^[a-z][a-z\d+.-]{1,31}:/i.test(url)
        ? url
        : /^www\./i.test(url)
          ? `http://${url}`
          : `mailto:${url}`
    ).replace(/[\\`*_~[\]&$^=|!]/g, (char) =>
      char === '&' ? '&amp;' : escapes ? `\\${char}` : reference(char),
    )
    const after = autolink
      ? `](${/[\s()]/.test(href) ? `<${href}>` : href})`
      : tail.startsWith('](') || /^\]\[[^\]]/.test(tail)
        ? tail
        : `][${state.sliceDoc(text.from, text.to)}]`
    const kept = start.at > text.from
    replace(node.from, text.from, kept ? '[' : '')
    escapeText(text.from, start.at, true)
    if (kept)
      changes.push({ from: start.at, insert: start.close + after + start.open })
    escapeText(start.at, end.at, false)
    if (end.at < text.to) {
      changes.push({ from: end.at, insert: `${end.close}[${end.open}` })
      escapeText(end.at, text.to, true)
      replace(text.to, node.to, after)
    } else replace(text.to, node.to, '')
  }
  if (range.empty) {
    const link = caretMarks(state, tree, range.from).get('link')
    if (link) unlink(link)
    return changes
  }
  tree.iterate({
    from: range.from,
    to: range.to,
    enter: (node) => {
      if (node.to <= range.from || node.from >= range.to) return false
      if (node.name === 'Link' || node.name === 'Autolink') {
        unlink(node.node)
        return false
      }
      return undefined
    },
  })
  // Changes in the order of the text, so ones at the same place keep theirs.
  return changes.sort(
    (a, b) => a.from - b.from || (a.to ?? a.from) - (b.to ?? b.from),
  )
}

/**
 * Where a split of `link`'s text at `at` goes, and the formatting it closes
 * before the split and opens after it, innermost closed first. A cut in a
 * formatting node's delimiters, or at an edge of its text, moves outside the
 * node, so the node stays whole and no empty formatting is left behind, and
 * a cut does not split an escape or other literal syntax.
 */
function cut(
  state: EditorState,
  tree: Tree,
  link: SyntaxNode,
  text: { from: number; to: number },
  at: number,
) {
  const formatting = formattingNames(state)
  for (let moved = true; moved; ) {
    moved = false
    for (
      let node: SyntaxNode | null = tree.resolveInner(at, 1);
      node && node.from > link.from;
      node = node.parent
    ) {
      if (node.from >= at || node.to <= at) continue
      if (node.name !== 'InlineCode' && literalSyntax.includes(node.name)) {
        at = node.from
        moved = true
        break
      }
      if (!formatting.includes(node.name)) continue
      const inner =
        node.name === 'InlineCode'
          ? codeText(state, node)
          : formattingText(state, node)
      if (!inner) continue
      if (at <= inner.from || at >= inner.to) {
        // The cut is at an edge of this formatting's text: keep it whole.
        at = at <= inner.from ? node.from : node.to
        at = Math.min(Math.max(at, text.from), text.to)
        moved = true
        break
      }
    }
  }
  let close = '',
    open = '',
    code: SyntaxNode | null = null
  for (
    let node: SyntaxNode | null = tree.resolveInner(at, 1);
    node && node.from > link.from;
    node = node.parent
  ) {
    if (!formatting.includes(node.name) || node.from >= at || node.to <= at)
      continue
    // Code is spelled again around the cut by its caller.
    if (node.name === 'InlineCode') {
      code = node
      continue
    }
    const inner = formattingText(state, node)
    const first = node.firstChild,
      last = node.lastChild
    if (!inner || !first || !last) continue
    close += state.sliceDoc(last.from, last.to)
    open = state.sliceDoc(first.from, first.to) + open
  }
  // Delimiters next to a space would not close or open formatting, so the
  // caller spells that space as a character reference.
  const spaces: number[] = []
  if (!code) {
    if (close && /[^\S\n]/.test(state.sliceDoc(at - 1, at))) spaces.push(at - 1)
    if (open && /[^\S\n]/.test(state.sliceDoc(at, at + 1))) spaces.push(at)
  }
  return { at, close, open, code, spaces }
}

/** Syntax inside a link's text that stays as written when it is unlinked. */
const literalSyntax = [
  'InlineCode',
  'Escape',
  'Entity',
  'HTMLTag',
  'Comment',
  'Image',
  'Autolink',
]

/** The text of inline code, inside the spaces that pad it. */
function codeText(state: EditorState, node: SyntaxNode) {
  const inner = formattingText(state, node)
  const text = inner && state.sliceDoc(inner.from, inner.to).replace(/\n/g, ' ')
  return inner && text && padded(text)
    ? { from: inner.from + 1, to: inner.to - 1 }
    : inner
}

/** Whether inline code drops a space at each end of `text`. */
const padded = (text: string) =>
  text.length > 2 &&
  text.startsWith(' ') &&
  text.endsWith(' ') &&
  /[^ ]/.test(text)

/** The fence and padding that spell `text` as inline code. */
function codeFence(text: string) {
  const plain = text.replace(/\n/g, ' ')
  // A fence longer than any run of backticks in the text.
  let longest = 0
  for (const run of plain.matchAll(/`+/g))
    longest = Math.max(longest, run[0].length)
  const fence = '`'.repeat(longest + 1)
  const pad =
    plain.startsWith('`') || plain.endsWith('`') || padded(plain) ? ' ' : ''
  return { open: fence + pad, close: pad + fence }
}

/** Changes that turn the fenced code blocks of a selection back into text. */
export function unfenceChanges(
  tree: Tree,
  range: SelectionRange,
): ChangeSpec[] | null {
  const fences: SyntaxNode[] = []
  if (range.empty) {
    const block = blockAt(tree, range.from, []).node
    if (block) fences.push(block)
  } else
    tree.iterate({
      from: range.from,
      to: range.to,
      enter: (node) => {
        if (!isLeaf(node)) return undefined
        fences.push(node.node)
        return false
      },
    })
  if (!fences.length || fences.some((node) => node.name !== 'FencedCode'))
    return null
  return fences.flatMap((node) => {
    // The code between the fences keeps the containers' markers on its lines.
    let text = node.firstChild
    while (text && text.name !== 'CodeText') text = text.nextSibling
    let end = node.lastChild
    while (end && end.name !== 'CodeText') end = end.prevSibling
    if (!text || !end) return [{ from: node.from, to: node.to }]
    return [
      { from: node.from, to: text.from },
      { from: end.to, to: node.to },
    ]
  })
}
