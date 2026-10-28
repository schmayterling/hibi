import type { EditorState, Text, Transaction } from '@codemirror/state'
import type { Input, SyntaxNode, Tree } from '@lezer/common'
import type { MarkdownParser } from '@lezer/markdown'
import { boundaryWindow, readAheadFrom } from '../../shared/chunked-markdown.ts'
import { formattedPrefix } from './formatted-contributions.ts'

type Range = { from: number; to: number }
const prose =
  /^(Paragraph|Task|ATXHeading[1-6]|SetextHeading[12]|TableCell|Emphasis|StrongEmphasis|Strikethrough|Link)$/
const plain = (node: SyntaxNode) =>
  node.name === 'HibiPlainTextRun' ? node.parent : node
const leaf = (node: SyntaxNode) =>
  node.type.is('LeafBlock') || node.name === 'Table' || node.name === 'Task'

function literalAt(tree: Tree, from: number, to: number) {
  const left = [
    plain(tree.resolveInner(from, 1)),
    plain(tree.resolveInner(from, -1)),
  ]
  const right = from === to ? left : [plain(tree.resolveInner(to, -1))]
  return left.some(
    (a) =>
      a &&
      prose.test(a.name) &&
      right.some(
        (b) => b && a.type === b.type && a.from === b.from && a.to === b.to,
      ),
  )
}

function leafAt(tree: Tree, from: number, to: number) {
  for (const side of [1, -1] as const) {
    let node: SyntaxNode | null = tree.resolveInner(from, side)
    while (node?.parent && !leaf(node)) node = node.parent
    if (node && leaf(node) && from >= node.from && to <= node.to) return node
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
    chunk: (from) =>
      read(from, Math.min(doc.length, from + 4096, doc.lineAt(from).to + 1)),
  }
}

/** A table cell needs its row and header, not all other rows. */
function tableRanges(doc: Text, start: number, at: number) {
  let first = doc.lineAt(start)
  while (first.to < at && /^[\t ]*$/.test(first.text)) {
    first = doc.line(first.number + 1)
    start = first.from
  }
  const headerEnd = Math.min(doc.length, doc.line(first.number + 1).to + 1)
  const row = doc.lineAt(at)
  return [
    { from: start, to: headerEnd },
    ...(row.from >= headerEnd ? [{ from: row.from, to: row.to }] : []),
  ]
}

function merged(ranges: Range[]) {
  const result: Range[] = []
  for (const range of ranges) {
    const previous = result.at(-1)
    if (previous && previous.to >= range.from)
      previous.to = Math.max(previous.to, range.to)
    else result.push({ ...range })
  }
  return result
}

/** Replay only proven container prefixes, never the intervening list items. */
function containerRanges(
  node: SyntaxNode,
  offset: number,
  state: EditorState,
  prefix: number,
  ranges: Range[],
) {
  const heads: {
    to: number
    line: number
    newline: number | null
  }[] = []
  const limits = new Map<number, number>()
  const remember = (from: number, to: number) =>
    limits.set(from, Math.max(limits.get(from) ?? from, to))
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.name !== 'ListItem' && parent.name !== 'Blockquote') {
      if (
        parent.type.is('Block') &&
        !/^(Document|BulletList|OrderedList)$/.test(parent.name)
      )
        return null
      continue
    }
    const marker = parent.firstChild
    if (
      !marker ||
      marker.name !== (parent.name === 'ListItem' ? 'ListMark' : 'QuoteMark')
    )
      return null
    const from = offset + marker.from
    const line = state.doc.lineAt(from)
    let to = offset + marker.to,
      newline: number | null = null
    if (parent.name === 'Blockquote') {
      if (/^[ \t]$/.test(state.sliceDoc(to, Math.min(line.to, to + 1)))) to++
      if (to === line.to) newline = line.to
    } else {
      const content = marker.nextSibling
      if (
        content &&
        offset + content.from <= line.to &&
        content.name !== 'CodeBlock'
      ) {
        if (offset + content.from - to > 4) return null
        to = offset + content.from
      } else newline = line.to
    }
    if (newline === state.doc.length) return null
    const start = Math.max(line.from, prefix)
    remember(start, to)
    heads.push({ to, line: start, newline })
  }
  if (!heads.length) return { head: [], ranges }
  const line = state.doc.lineAt(ranges[0]!.from)
  const start = Math.max(line.from, prefix)
  remember(start, ranges[0]!.from)
  const columns = new Map<number, { at: number[]; column: number[] }>()
  for (const [from, to] of limits) {
    const text = state.sliceDoc(from, to)
    const at = [0],
      column = [0]
    let current = 0
    for (let i = 0; i < text.length; i++) {
      const next =
        text.charCodeAt(i) === 9 ? current + 4 - (current % 4) : current + 1
      while (current < next) at[current++] = i
      at[current] = i + 1
      column.push(current)
    }
    columns.set(from, { at, column })
  }
  const head: Range[] = []
  let column = 0
  for (const range of heads.reverse()) {
    const values = columns.get(range.line)!
    const at = values.at[column]
    if (at === undefined) return null
    head.push({ from: range.line + at, to: range.to })
    column = values.column[range.to - range.line]!
    if (range.newline !== null) {
      head.push({ from: range.newline, to: range.newline + 1 })
      column = 0
    }
  }
  const at = columns.get(start)!.at[column]
  if (at === undefined) return null
  return {
    head: merged(head),
    ranges: [{ from: start + at, to: ranges[0]!.to }, ...ranges.slice(1)],
  }
}

/** Complete leaf proof; null means its worker boundary index is still building. */
export function formattedLiteralEdits(
  transaction: Transaction,
  parser: MarkdownParser,
  tree: Tree,
) {
  const before = transaction.startState
  let prefix = 0
  for (const measure of before.facet(formattedPrefix))
    prefix = Math.max(prefix, measure(before))
  prefix = Math.min(prefix, before.doc.length)
  const oldInput = inputFor(before.doc, (from, to) => before.sliceDoc(from, to))
  const nextInput = inputFor(transaction.newDoc, (from, to) =>
    transaction.newDoc.sliceString(from, to),
  )
  const blocks = new Map<
    number,
    { head: Range[]; ranges: Range[]; edits: Range[]; kind: string }
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
      // Locate the leaf without parsing inline text in neighboring items.
      const scan = Object.assign(parser.configure({}), {
        parseInline: () => [],
      })
      const tail = ranges.at(-1)!
      const line = before.doc.lineAt(to)
      let stop = indexed.table
        ? tail.to
        : Math.min(
            tail.to,
            line.to < before.doc.length
              ? before.doc.lineAt(line.to + 1).to + 1
              : before.doc.length,
          )
      for (;;) {
        ranges[ranges.length - 1] = { from: tail.from, to: stop }
        context = scan.parse(oldInput, [], ranges)
        node = leafAt(context, from - offset, to - offset)
        // A following physical line proves the leaf ended before the cut.
        if (
          stop === tail.to ||
          (node && offset + node.to < before.doc.lineAt(stop - 1).from)
        )
          break
        stop = Math.min(tail.to, tail.from + (stop - tail.from) * 2)
      }
      if (indexed.table && node?.name !== 'Table') {
        valid = false
        return
      }
    }
    if (
      !node ||
      !/^(Paragraph|Task|ATXHeading[1-6]|SetextHeading[12]|Table)$/.test(
        node.name,
      ) ||
      !literalAt(context, from - offset, to - offset)
    ) {
      valid = false
      return
    }
    const start = offset + node.from
    const reads = readAheadFrom(tree, from, (left, right) => {
      // Boundary chunks retain reach, but their local parse has decision lines.
      const indexed = boundaryWindow(tree, left, left)
      if (
        !indexed ||
        indexed === 'building' ||
        indexed.opaque ||
        indexed.from !== left ||
        indexed.to !== right ||
        indexed.ranges.length !== 1
      )
        return null
      const scan = Object.assign(parser.configure({}), {
        parseInline: () => [],
      })
      const parsed =
        offset === left && context !== tree && node?.name !== 'Table'
          ? context
          : scan.parse(oldInput, [], indexed.ranges)
      // The parser records read decisions in the original input's coordinates.
      return readAheadFrom(parsed, from)
    })
    if (reads === null || reads.some((at) => at < start)) {
      valid = false
      return
    }
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
    const proof = containerRanges(node, offset, before, prefix, ranges)
    if (!proof) {
      valid = false
      return
    }
    blocks.set(key, { ...proof, edits: [{ from, to }], kind: node.name })
  })
  if (!valid) return false
  if (pending) return null
  for (const block of blocks.values()) {
    const ranges = merged([...block.head, ...block.ranges])
    const nextRanges = merged([
      ...block.head.map((range) => ({
        from: transaction.changes.mapPos(range.from, -1),
        to: transaction.changes.mapPos(range.to, -1),
      })),
      ...block.ranges.map((range) => ({
        from: transaction.changes.mapPos(range.from, -1),
        to: transaction.changes.mapPos(range.to, 1),
      })),
    ])
    const oldBase = ranges[0]!.from,
      nextBase = nextRanges[0]!.from
    const oldTree = parser.parse(oldInput, [], ranges),
      nextTree = parser.parse(nextInput, [], nextRanges)
    const edit = block.edits[0]!
    if (
      leafAt(oldTree, edit.from - oldBase, edit.to - oldBase)?.name !==
        block.kind ||
      !block.edits.every((edit) =>
        literalAt(oldTree, edit.from - oldBase, edit.to - oldBase),
      )
    )
      return false
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
