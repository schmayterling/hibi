import type { Text, Transaction } from '@codemirror/state'
import type { Input, SyntaxNode, Tree } from '@lezer/common'
import type { MarkdownParser } from '@lezer/markdown'
import { boundaryWindow } from '../../shared/chunked-markdown.ts'

type Range = { from: number; to: number }
const prose =
  /^(Paragraph|ATXHeading[1-6]|SetextHeading[12]|TableCell|Emphasis|StrongEmphasis|Strikethrough|Link)$/
const plain = (node: SyntaxNode) =>
  node.name === 'HibiPlainTextRun' ? node.parent : node

function leafAt(tree: Tree, from: number, to: number) {
  for (const side of [1, -1] as const) {
    let node: SyntaxNode | null = tree.resolveInner(from, side)
    while (node?.parent && !node.type.is('LeafBlock') && node.name !== 'Table')
      node = node.parent
    if (
      node &&
      (node.type.is('LeafBlock') || node.name === 'Table') &&
      from >= node.from &&
      to <= node.to
    )
      return node
  }
  return null
}

function inputFor(
  doc: Text,
  read: (from: number, to: number) => string,
): Input {
  return {
    length: doc.length,
    lineChunks: false,
    read,
    chunk: (from) => read(from, Math.min(doc.length, doc.lineAt(from).to + 1)),
  }
}

/** A table cell needs its row and header, not all other rows. */
function tableRanges(doc: Text, start: number, at: number) {
  const first = doc.lineAt(start)
  const headerEnd = Math.min(doc.length, doc.line(first.number + 1).to + 1)
  const row = doc.lineAt(at)
  return [
    { from: start, to: headerEnd },
    ...(row.from >= headerEnd ? [{ from: row.from, to: row.to }] : []),
  ]
}

/** Complete leaf proof; null means its worker boundary index is still building. */
export function formattedLiteralEdits(
  transaction: Transaction,
  parser: MarkdownParser,
  tree: Tree,
) {
  const before = transaction.startState
  const oldInput = inputFor(before.doc, (from, to) => before.sliceDoc(from, to))
  const nextInput = inputFor(transaction.newDoc, (from, to) =>
    transaction.newDoc.sliceString(from, to),
  )
  const blocks = new Map<
    number,
    { ranges: Range[]; marks: Range[]; edits: Range[] }
  >()
  let valid = true,
    pending = false
  transaction.changes.iterChanges((from, to, _fromB, _toB, insert) => {
    if (!valid) return
    if (
      /[\r\n]/.test(insert.toString()) ||
      /[\r\n]/.test(before.sliceDoc(from, to))
    ) {
      valid = false
      return
    }
    let context = tree,
      offset = 0,
      node = leafAt(tree, from, to)
    if (!node) {
      const indexed = boundaryWindow(tree, from, to)
      if (indexed === 'building') {
        pending = true
        return
      }
      if (!indexed || indexed.opaque) {
        valid = false
        return
      }
      const ranges = indexed.table
        ? tableRanges(before.doc, indexed.from, from)
        : indexed.ranges
      offset = ranges[0]!.from
      context = parser.parse(oldInput, [], ranges)
      node = leafAt(context, from - offset, to - offset)
    }
    if (
      !node ||
      !/^(Paragraph|ATXHeading[1-6]|SetextHeading[12]|Table)$/.test(node.name)
    ) {
      valid = false
      return
    }
    const start = offset + node.from
    const key = node.name === 'Table' ? before.doc.lineAt(from).from : start
    const known = blocks.get(key)
    if (known) {
      known.edits.push({ from, to })
      return
    }
    const ranges =
      node.name === 'Table'
        ? tableRanges(before.doc, start, from)
        : [{ from: start, to: offset + node.to }]
    // The tree identifies container markup inside a multiline leaf. Parsing
    // discontiguous ranges omits those prefixes and retains source coordinates.
    const marks: Range[] = []
    for (const range of ranges) {
      const cursor = context.cursorAt(range.from - offset, 1)
      do {
        if (cursor.name !== 'QuoteMark' || cursor.from + offset < range.from)
          continue
        let end = offset + cursor.to
        if (
          /^[ \t]$/.test(
            before.sliceDoc(end, Math.min(end + 1, before.doc.length)),
          )
        )
          end++
        marks.push({ from: offset + cursor.from, to: end })
      } while (cursor.next() && cursor.from + offset < range.to)
    }
    blocks.set(key, { ranges, marks, edits: [{ from, to }] })
  })
  if (!valid) return false
  if (pending) return null
  for (const block of blocks.values()) {
    let protectedIndex = 0
    for (const edit of block.edits) {
      while (
        block.marks[protectedIndex] &&
        block.marks[protectedIndex]!.to <= edit.from
      )
        protectedIndex++
      const mark = block.marks[protectedIndex]
      if (mark && edit.to >= mark.from) return false
    }
    const ranges: Range[] = []
    let markIndex = 0
    for (const range of block.ranges) {
      let from = range.from
      while (
        markIndex < block.marks.length &&
        block.marks[markIndex]!.from < range.to
      ) {
        const mark = block.marks[markIndex++]!
        if (mark.from > from) ranges.push({ from, to: mark.from })
        from = mark.to
      }
      if (from < range.to) ranges.push({ from, to: range.to })
    }
    const nextRanges = ranges.map((range) => ({
      from: transaction.changes.mapPos(range.from, -1),
      to: transaction.changes.mapPos(range.to, 1),
    }))
    const oldBase = ranges[0]!.from,
      nextBase = nextRanges[0]!.from
    const oldTree = parser.parse(oldInput, [], ranges),
      nextTree = parser.parse(nextInput, [], nextRanges)
    const literal = (from: number, to: number) => {
      const left = [
        plain(oldTree.resolveInner(from, 1)),
        plain(oldTree.resolveInner(from, -1)),
      ]
      const right = from === to ? left : [plain(oldTree.resolveInner(to, -1))]
      return left.some(
        (a) =>
          a &&
          prose.test(a.name) &&
          right.some(
            (b) => b && a.type === b.type && a.from === b.from && a.to === b.to,
          ),
      )
    }
    for (const edit of block.edits)
      if (!literal(edit.from - oldBase, edit.to - oldBase)) return false
    const shape = (
      parsed: Tree,
      input: Input,
      offset: number,
      map: boolean,
    ) => {
      const result: (string | number)[] = []
      const cursor = parsed.cursor()
      do {
        if (cursor.name === 'HibiPlainTextRun') continue
        const isBlock =
          cursor.name === 'Document' ||
          cursor.type.is('Block') ||
          /^Table(Cell|Row|Header)$/.test(cursor.name)
        const from = offset + cursor.from,
          to = offset + cursor.to
        const end = cursor.name === 'Link' ? cursor.node.lastChild : null
        const label = end ? input.read(offset + end.from, offset + end.to) : ''
        const reference =
          end &&
          (label === ']' ||
            (end.name === 'LinkLabel' && /^\[\s*\]$/.test(label)))
        const token =
          reference || (!isBlock && !prose.test(cursor.name))
            ? input.read(from, to)
            : ''
        result.push(
          cursor.name,
          map ? transaction.changes.mapPos(from, isBlock ? -1 : 1) : from,
          map ? transaction.changes.mapPos(to, isBlock ? 1 : -1) : to,
          token,
        )
      } while (cursor.next())
      return result
    }
    const oldShape = shape(oldTree, oldInput, oldBase, true)
    const nextShape = shape(nextTree, nextInput, nextBase, false)
    if (
      oldShape.length !== nextShape.length ||
      oldShape.some((value, i) => value !== nextShape[i])
    )
      return false
  }
  return true
}
