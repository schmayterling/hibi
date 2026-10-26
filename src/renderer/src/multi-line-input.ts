import {
  Fragment,
  Mark,
  type ResolvedPos,
  type Node as RichNode,
} from '@tiptap/pm/model'
import { TextSelection, type Transaction } from '@tiptap/pm/state'
import { ReplaceStep } from '@tiptap/pm/transform'
import type { EditorView } from '@tiptap/pm/view'

/**
 * The edit the browser makes for a multi-line text input, built as one step.
 * Each line break is a newline in preformatted text, a new item in a list (a
 * break in an empty item ends the list and later lines become paragraphs), a
 * paragraph after the end of a heading, and otherwise a copy of the current
 * block. The text stays literal and takes the marks at the caret. Returns
 * null where the browser's result isn't modelled, so the browser applies it.
 */
export function multiLineInput(
  view: EditorView,
  data: string,
): Transaction | null {
  const { selection, schema, tr } = view.state
  const { $from, $to } = selection
  if (!(selection instanceof TextSelection) || !$from.sameParent($to))
    return null
  const text = data.replace(/\r\n?/g, '\n')
  const dom = view.domAtPos($from.pos).node
  if ((dom instanceof Element ? dom : dom.parentElement)?.closest('pre')) {
    tr.replaceWith($from.pos, $to.pos, schema.text(text))
    return tr
      .setSelection(TextSelection.create(tr.doc, $from.pos + text.length))
      .scrollIntoView()
  }
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
  const depth = $from.depth,
    block = $from.parent
  const after = block.content.cut($to.parentOffset)
  /** Line `index` as content; the last line ends with the text after the selection. */
  const line = (index: number) => {
    const value = lines[index]
    const content = value
      ? Fragment.from(schema.text(value, index ? lineMarks : firstMarks))
      : Fragment.empty
    return index < last ? content : content.append(after)
  }
  const first = block.copy(
    block.content.cut(0, $from.parentOffset).append(line(0)),
  )
  let itemDepth = depth - 1
  while (itemDepth > 0 && !$from.node(itemDepth - 1).type.isInGroup('list'))
    itemDepth--
  try {
    if (!itemDepth) {
      const heading = /^H[1-6]$/.test(
        view.nodeDOM($from.before())?.nodeName ?? '',
      )
      const type =
        heading && !after.size
          ? $from.node(depth - 1).contentMatchAt($from.indexAfter(depth - 1))
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
      return replaceChild(tr, $from, depth - 1, blocks, last, 1 + lastLength)
    }
    const item = $from.node(depth - 1),
      list = $from.node(depth - 2)
    if (
      itemDepth < depth - 1 ||
      block.type !== item.type.contentMatch.defaultType
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
      item.copy(item.content.replaceChild($from.index(depth - 1), first)),
    ]
    for (let index = 1; index <= (end > last ? last : end - 2); index++)
      items.push(
        item.type.createChecked(
          null,
          block.type.createChecked(null, line(index)),
        ),
      )
    if (end > last)
      return replaceChild(tr, $from, depth - 2, items, last, 2 + lastLength)
    // A list nested in an item moves up a level instead; not modelled.
    if (depth > 3 && $from.node(depth - 4).type.isInGroup('list')) return null
    const paragraph = $from
      .node(depth - 3)
      .contentMatchAt($from.indexAfter(depth - 3)).defaultType
    if (!paragraph) return null
    const head = list.content.cut(
      0,
      $from.posAtIndex($from.index(depth - 2), depth - 2) -
        $from.start(depth - 2),
    )
    const rest = list.content.cut(head.size + item.nodeSize)
    const kept = end > 1 ? head.append(Fragment.fromArray(items)) : head
    const blocks = kept.size ? [list.copy(kept)] : []
    const caret = blocks.length + last - end
    for (let index = end; index <= last; index++)
      blocks.push(paragraph.createChecked(null, line(index)))
    if (rest.size) blocks.push(list.copy(rest))
    return replaceChild(tr, $from, depth - 3, blocks, caret, 1 + lastLength)
  } catch {
    return null
  }
}

/**
 * Replaces the child of the node at `depth` that holds `$pos` with `nodes`, in
 * one step over the part that differs, and puts the caret `caretOffset` into
 * `nodes[caretNode]`.
 */
function replaceChild(
  tr: Transaction,
  $pos: ResolvedPos,
  depth: number,
  nodes: RichNode[],
  caretNode: number,
  caretOffset: number,
) {
  const parent = $pos.node(depth),
    start = $pos.start(depth),
    index = $pos.index(depth)
  const offset = $pos.posAtIndex(index, depth) - start
  const content = parent.content
    .cut(0, offset)
    .append(Fragment.fromArray(nodes))
    .append(parent.content.cut(offset + parent.child(index).nodeSize))
  const from = parent.content.findDiffStart(content),
    end = parent.content.findDiffEnd(content)
  if (from == null || !end) return null
  const overlap = Math.max(0, from - Math.min(end.a, end.b))
  tr.step(
    new ReplaceStep(
      start + from,
      start + end.a + overlap,
      parent.copy(content).slice(from, end.b + overlap),
    ),
  )
  let caret = start + offset + caretOffset
  for (const node of nodes.slice(0, caretNode)) caret += node.nodeSize
  return tr.setSelection(TextSelection.create(tr.doc, caret)).scrollIntoView()
}
