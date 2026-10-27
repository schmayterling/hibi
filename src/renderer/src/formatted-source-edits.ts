import type { Transaction } from '@codemirror/state'
import type { SyntaxNode, Tree } from '@lezer/common'

type Syntax = Pick<Tree, 'resolveInner' | 'cursorAt'>
const prose =
  /^(Paragraph|ATXHeading[1-6]|SetextHeading[12]|TableCell|Emphasis|StrongEmphasis|Strikethrough|Link)$/
const plain = (node: SyntaxNode) =>
  node.name === 'HibiPlainTextRun' ? node.parent : node

/** Prove changed text stays in one literal prose run, with the same surrounding syntax. */
export function formattedLiteralEdits(
  transaction: Transaction,
  before: Syntax,
  after: Syntax,
) {
  const literal = (tree: Syntax, from: number, to: number) => {
    const left = plain(tree.resolveInner(from, 1))
    const right = from === to ? left : plain(tree.resolveInner(to, -1))
    if (
      !left ||
      !right ||
      !prose.test(left.name) ||
      left.type !== right.type ||
      left.from !== right.from ||
      left.to !== right.to
    )
      return null
    const cursor = tree.cursorAt(from, 1)
    for (
      let more = cursor.childAfter(from) || cursor.next(false);
      more && cursor.from < to;
      more = cursor.next()
    ) {
      if (
        cursor.to > from &&
        cursor.from >= from &&
        cursor.to <= to &&
        cursor.name !== 'HibiPlainTextRun' &&
        !(
          cursor.type === left.type &&
          cursor.from === left.from &&
          cursor.to === left.to
        )
      )
        return null
    }
    return left
  }
  let valid = true
  transaction.changes.iterChanges((from, to, fromB, toB, insert) => {
    if (!valid) return
    if (
      /[\r\n]/.test(insert.toString()) ||
      /[\r\n]/.test(transaction.startState.sliceDoc(from, to))
    ) {
      valid = false
      return
    }
    const previous = literal(before, from, to)
    const next = literal(after, fromB, toB)
    let left = previous,
      right = next
    if (!left || !right) valid = false
    while (left && right) {
      if (
        left.type !== right.type ||
        transaction.changes.mapPos(left.from, -1) !== right.from ||
        transaction.changes.mapPos(left.to, 1) !== right.to
      )
        valid = false
      left = left.parent
      right = right.parent
    }
    if (left || right) valid = false
  })
  return valid
}
