import {
  Fragment,
  Mark,
  type ResolvedPos,
  type Node as RichNode,
  Slice,
} from '@tiptap/pm/model'
import {
  AllSelection,
  Selection,
  TextSelection,
  type Transaction,
} from '@tiptap/pm/state'
import { ReplaceStep } from '@tiptap/pm/transform'
import type { EditorView } from '@tiptap/pm/view'

/**
 * The edit the browser makes for a multi-line text input, built as one step.
 * The browser deletes the selection, joining the text after it to the block
 * where it starts; then each line break is a newline in preformatted text, a
 * new item in a list (a break in an empty item ends the list and later lines
 * become paragraphs), a paragraph after the end of a heading, and otherwise a
 * copy of the current block. The text stays literal and takes the marks at the
 * caret. Returns null where the browser's result isn't modelled, so the
 * browser applies it.
 */
export function multiLineInput(
  view: EditorView,
  data: string,
): Transaction | null {
  // Without visible text, the browser's change can be read back as one Enter.
  if (!/\S/.test(data)) return null
  const { doc, schema, selection, tr } = view.state
  let { $from, $to } = selection
  if (selection instanceof AllSelection) {
    const start = Selection.atStart(doc),
      end = Selection.atEnd(doc)
    if (
      !(start instanceof TextSelection && end instanceof TextSelection) ||
      isolated(start.$from, 0) ||
      isolated(end.$to, 0)
    )
      return null
    $from = start.$from
    $to = end.$to
  } else if (!(selection instanceof TextSelection)) return null
  const text = data.replace(/\r\n?/g, '\n')
  // Typing's marks at the caret, but the browser types into a link only inside
  // it, and later lines keep a mark only if it continues after the selection
  // or is a style the browser copies to the new line (bold, italic, ...).
  const link = schema.marks.link,
    marksAfter = $to.nodeAfter?.marks ?? Mark.none
  const firstMarks = (
    selection.empty ? $from.marks() : ($from.marksAcross($to) ?? Mark.none)
  ).filter(
    (mark) =>
      mark.type !== link ||
      (mark.isInSet($from.nodeBefore?.marks ?? Mark.none) &&
        mark.isInSet(marksAfter)),
  )
  const lineMarks = firstMarks.filter(
    (mark) =>
      mark.type !== link &&
      (mark.isInSet(marksAfter) ||
        mark.type.spec.parseDOM?.some((rule) => 'style' in rule)),
  )
  const lines = text.split('\n'),
    last = lines.length - 1,
    lastLength = text.length - text.lastIndexOf('\n') - 1
  try {
    const deleted = $from.pos === $to.pos ? doc : withoutSelection($from, $to)
    if (!deleted) return null
    const $pos = deleted.resolve($from.pos),
      depth = $pos.depth,
      block = $pos.parent
    const dom = view.domAtPos($from.pos).node
    if ((dom instanceof Element ? dom : dom.parentElement)?.closest('pre'))
      return finish(
        tr,
        deleted.replace(
          $pos.pos,
          $pos.pos,
          new Slice(Fragment.from(schema.text(text)), 0, 0),
        ),
        $pos.pos + text.length,
      )
    const after = block.content.cut($pos.parentOffset)
    /** Line `index` as content; the last line ends with the text after the selection. */
    const line = (index: number) => {
      const value = lines[index]
      const content = value
        ? Fragment.from(schema.text(value, index ? lineMarks : firstMarks))
        : Fragment.empty
      return index < last ? content : content.append(after)
    }
    const first = block.copy(
      block.content.cut(0, $pos.parentOffset).append(line(0)),
    )
    let itemDepth = depth - 1
    while (itemDepth > 0 && !$pos.node(itemDepth - 1).type.isInGroup('list'))
      itemDepth--
    if (!itemDepth) {
      const heading = /^H[1-6]$/.test(
        view.nodeDOM($pos.before())?.nodeName ?? '',
      )
      const type =
        heading && !after.size
          ? $pos.node(depth - 1).contentMatchAt($pos.indexAfter(depth - 1))
              .defaultType
          : block.type
      if (!type) return null
      const blocks = [first]
      for (let index = 1; index <= last; index++)
        blocks.push(
          type.createChecked(
            type === block.type ? block.attrs : null,
            line(index),
          ),
        )
      return replaceChild(tr, $pos, depth - 1, blocks, last, 1 + lastLength)
    }
    const item = $pos.node(depth - 1),
      list = $pos.node(depth - 2)
    // A line break at the start of a non-empty item adds the new item before
    // it, keeping the item's state and children after; and items with more
    // than their blocks in the `<li>`, like tasks with their checkbox, follow
    // other rules. Neither is modelled.
    if (
      itemDepth < depth - 1 ||
      block.type !== item.type.contentMatch.defaultType ||
      (!first.content.size && after.size) ||
      view.nodeDOM($pos.before(depth))?.parentNode !==
        view.nodeDOM($pos.before(depth - 1))
    )
      return null
    // The first line break made in an empty item ends the list.
    let end = 1
    while (
      end <= last &&
      (after.size ||
        (end > 1 ? lines[end - 1] : item.childCount > 1 || first.content.size))
    )
      end++
    const items = [
      item.copy(item.content.replaceChild($pos.index(depth - 1), first)),
    ]
    for (let index = 1; index <= (end > last ? last : end - 2); index++)
      items.push(
        item.type.createChecked(
          null,
          block.type.createChecked(null, line(index)),
        ),
      )
    if (end > last)
      return replaceChild(tr, $pos, depth - 2, items, last, 2 + lastLength)
    // A list nested in an item moves up a level instead; not modelled.
    if (depth > 3 && $pos.node(depth - 4).type.isInGroup('list')) return null
    const paragraph = $pos
      .node(depth - 3)
      .contentMatchAt($pos.indexAfter(depth - 3)).defaultType
    if (!paragraph) return null
    const head = list.content.cut(
      0,
      $pos.posAtIndex($pos.index(depth - 2), depth - 2) - $pos.start(depth - 2),
    )
    const rest = list.content.cut(head.size + item.nodeSize)
    const kept = end > 1 ? head.append(Fragment.fromArray(items)) : head
    const blocks = kept.size ? [list.copy(kept)] : []
    const caret = blocks.length + last - end
    for (let index = end; index <= last; index++)
      blocks.push(paragraph.createChecked(null, line(index)))
    if (rest.size) blocks.push(list.copy(rest))
    return replaceChild(tr, $pos, depth - 3, blocks, caret, 1 + lastLength)
  } catch {
    return null
  }
}

/**
 * The document after the browser deletes a selection across blocks: the text
 * after it joins the block where it starts, and the block it ends in leaves
 * its containers, which go too when that empties them. Null where the browser
 * keeps blocks apart (tables) or restyles the joined text (other block types).
 */
function withoutSelection($from: ResolvedPos, $to: ResolvedPos) {
  if ($from.sameParent($to))
    return $from.doc.replace($from.pos, $to.pos, Slice.empty)
  const depth = $from.sharedDepth($to.pos)
  const after = $to.parent.content.cut($to.parentOffset)
  if (
    (after.size && $to.parent.type !== $from.parent.type) ||
    isolated($from, depth) ||
    isolated($to, depth)
  )
    return null
  const parent = $from.node(depth),
    first = $from.index(depth),
    last = $to.index(depth)
  const start = $from.posAtIndex(first, depth),
    end = $to.posAtIndex(last, depth)
  const joined = (node: RichNode): RichNode => {
    const child = node.lastChild
    return node.isTextblock || !child
      ? node.copy(node.content.append(after))
      : node.copy(node.content.replaceChild(node.childCount - 1, joined(child)))
  }
  const left = joined(parent.child(first).cut(0, $from.pos - start - 1))
  const emptied = (node: RichNode): RichNode | null => {
    const child = node.firstChild
    if (node.isTextblock || !child) return null
    const rest = emptied(child)
    const content = rest
      ? node.content.replaceChild(0, rest)
      : node.content.cut(child.nodeSize)
    return content.size ? node.copy(content) : null
  }
  const right = emptied(parent.child(last).cut($to.pos - end - 1))
  left.check()
  right?.check()
  return $from.doc.replace(
    start,
    end + parent.child(last).nodeSize,
    new Slice(Fragment.from(right ? [left, right] : [left]), 0, 0),
  )
}

/** Whether `$pos` is inside an isolating node (a table) below `depth`. */
function isolated($pos: ResolvedPos, depth: number) {
  for (let d = depth + 1; d <= $pos.depth; d++)
    if ($pos.node(d).type.spec.isolating) return true
  return false
}

/**
 * Replaces the child of the node at `depth` that holds `$pos` with `nodes`,
 * with the caret `caretOffset` into `nodes[caretNode]`.
 */
function replaceChild(
  tr: Transaction,
  $pos: ResolvedPos,
  depth: number,
  nodes: RichNode[],
  caretNode: number,
  caretOffset: number,
) {
  let caret = $pos.posAtIndex($pos.index(depth), depth)
  const doc = $pos.doc.replace(
    caret,
    caret + $pos.node(depth + 1).nodeSize,
    new Slice(Fragment.fromArray(nodes), 0, 0),
  )
  caret += caretOffset
  for (const node of nodes.slice(0, caretNode)) caret += node.nodeSize
  return finish(tr, doc, caret)
}

/** Turns the document into `doc` in one step over the part that differs. */
function finish(tr: Transaction, doc: RichNode, caret: number) {
  const from = tr.doc.content.findDiffStart(doc.content),
    end = tr.doc.content.findDiffEnd(doc.content)
  if (from == null || !end) return null
  const overlap = Math.max(0, from - Math.min(end.a, end.b))
  tr.step(
    new ReplaceStep(from, end.a + overlap, doc.slice(from, end.b + overlap)),
  )
  return tr.setSelection(TextSelection.create(tr.doc, caret)).scrollIntoView()
}
