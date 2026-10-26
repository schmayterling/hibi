import type { Text } from '@codemirror/state'
import type { SyntaxNode, Tree } from '@lezer/common'

/**
 * The line prefix of the quotes and list items around `pos`: the innermost
 * container's opening line up to its content, with list markers turned into
 * the item's indentation. Lazy continuation lines, which lack the markers,
 * still get their container's prefix.
 */
export function containerPrefix(doc: Text, tree: Tree, pos: number) {
  let container: SyntaxNode | null = null
  for (
    let node: SyntaxNode | null = tree.resolveInner(pos, -1);
    node;
    node = node.parent
  )
    if (node.name === 'Blockquote' || node.name === 'ListItem') {
      container = node
      break
    }
  if (!container) return ''
  const line = doc.lineAt(container.from)
  const mark = container.getChild(
    container.name === 'ListItem' ? 'ListMark' : 'QuoteMark',
  )
  if (!mark) return ''
  // The content starts after the marker and its spaces, at most four for a list item.
  const after = /^[ \t]*/.exec(doc.sliceString(mark.to, line.to))![0]
  const gap =
    container.name === 'Blockquote'
      ? Math.min(after.length, 1)
      : after.length > 4 || after.length === line.to - mark.to
        ? 1
        : after.length
  return doc.sliceString(line.from, mark.to + gap).replace(/[^>\t ]/g, ' ')
}

/**
 * Source for a formula inserted at the caret. Display math goes on its own
 * lines with the containers' `prefix`, so the formula and the text after it
 * stay in the quote or list item.
 */
export function mathInsertion(prefix: string, latex: string, block: boolean) {
  if (!block) return `$${latex}$`
  const blank = prefix.trimEnd()
  const body = latex
    .split('\n')
    .map((text) => prefix + text)
    .join('\n')
  return `\n${blank}\n${prefix}$$\n${body}\n${prefix}$$\n${blank}\n${prefix}`
}
