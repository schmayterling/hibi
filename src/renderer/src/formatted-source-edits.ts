import type { Transaction } from '@codemirror/state'
import type { SyntaxNode, Tree } from '@lezer/common'
import type { MarkdownParser } from '@lezer/markdown'
import { boundaryWindow } from '../../shared/chunked-markdown.ts'

const prose =
  /^(Paragraph|ATXHeading[1-6]|SetextHeading[12]|TableCell|Emphasis|StrongEmphasis|Strikethrough|Link)$/
const plain = (node: SyntaxNode) =>
  node.name === 'HibiPlainTextRun' ? node.parent : node

/** Complete block proof; null means its worker boundary index is still building. */
export function formattedLiteralEdits(
  transaction: Transaction,
  parser: MarkdownParser,
  tree: Tree,
) {
  const before = transaction.startState
  const blocks = new Map<number, { from: number; to: number }>()
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
    let block: { from: number; to: number } | null = null
    for (const side of [1, -1] as const) {
      let node: SyntaxNode | null = tree.resolveInner(from, side)
      while (node?.parent && node.parent.name !== 'Document') node = node.parent
      if (
        node &&
        node.name !== 'Document' &&
        node.type.is('Block') &&
        from >= node.from &&
        to <= node.to
      ) {
        if (
          node.type.is('LeafBlock') &&
          !/^(Paragraph|ATXHeading[1-6]|SetextHeading[12]|Table)$/.test(
            node.name,
          )
        ) {
          valid = false
          return
        }
        block = node
        break
      }
    }
    if (!block) {
      const indexed = boundaryWindow(tree, from, to)
      if (indexed?.opaque) {
        valid = false
        return
      }
      block = indexed
    }
    if (!block) {
      pending = true
      return
    }
    blocks.set(block.from, block)
  })
  if (!valid) return false
  if (pending) return null
  for (const block of blocks.values()) {
    const nextFrom = transaction.changes.mapPos(block.from, -1)
    const nextTo = transaction.changes.mapPos(block.to, 1)
    const oldText = before.sliceDoc(block.from, block.to)
    const nextText = transaction.newDoc.sliceString(nextFrom, nextTo)
    const oldTree = parser.parse(oldText),
      nextTree = parser.parse(nextText)
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
    transaction.changes.iterChangedRanges((from, to) => {
      if (
        from >= block.from &&
        to <= block.to &&
        !literal(from - block.from, to - block.from)
      )
        valid = false
    })
    if (!valid) return false
    const shape = (
      parsed: Tree,
      text: string,
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
        const label = end ? text.slice(end.from, end.to) : ''
        const reference =
          end &&
          (label === ']' ||
            (end.name === 'LinkLabel' && /^\[\s*\]$/.test(label)))
        const token =
          reference || (!isBlock && !prose.test(cursor.name))
            ? text.slice(cursor.from, cursor.to)
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
    const oldShape = shape(oldTree, oldText, block.from, true)
    const nextShape = shape(nextTree, nextText, nextFrom, false)
    if (
      oldShape.length !== nextShape.length ||
      oldShape.some((value, i) => value !== nextShape[i])
    )
      return false
  }
  return true
}
