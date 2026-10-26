import { Decoration, EditorView } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { deleteBackward } from '../../renderer/src/formatted-commands.ts'
import {
  type FormattedContribution,
  formattedFormatting,
  formattedSyntaxTree,
} from '../../renderer/src/formatted-contributions.ts'
import { markDecoded } from '../_shared/formatted-entities.ts'
import { subscriptSyntax, subtextSyntax } from './formatted-syntax.ts'

const flavor = 'text-extras.text-extras'

/** References in `node`'s text, outside the subscripts in it, which show their own. */
function entities(node: SyntaxNode, found: SyntaxNode[] = []) {
  for (let child = node.firstChild; child; child = child.nextSibling)
    if (child.name === 'Entity') found.push(child)
    else if (child.name !== 'Subscript') entities(child, found)
  return found
}

/** `~text~` reads as the rich view's `<sub>`; its tildes are syntax. */
const subscript: FormattedContribution = {
  id: 'text-extras.subscript',
  feature: 'text-extras.subscript',
  flavor,
  syntax: subscriptSyntax,
  inlineStops: true,
  views: [
    {
      nodes: ['Subscript'],
      decorate(node, out, { state, revealed }) {
        out.syntax(node.from, node.from + 1)
        markDecoded(
          state,
          out,
          node.from + 1,
          node.to - 1,
          { class: 'hibi-lp-subscript' },
          revealed,
          entities(node.node),
        )
        out.syntax(node.to - 1, node.to)
        return undefined
      },
    },
  ],
  // The browser's styles for `<sub>`, which only it gives the rich view's subscripts.
  extension: [
    // Enter inside a subscript closes it before the break and opens it after.
    formattedFormatting.of('Subscript'),
    EditorView.baseTheme({
      '.hibi-lp-subscript': { verticalAlign: 'sub', fontSize: 'smaller' },
    }),
  ],
}

/** Backspace treats small text as a paragraph, keeping its marker when lifting it. */
function backspace(view: EditorView) {
  const { state } = view
  const { main, ranges } = state.selection
  const tree = formattedSyntaxTree(state)
  if (
    state.readOnly ||
    view.composing ||
    !main.empty ||
    ranges.length !== 1 ||
    !tree
  )
    return false
  let node: SyntaxNode | null = tree.resolveInner(main.head, 1)
  while (node && node.name !== 'Subtext') node = node.parent
  if (!node || main.head !== node.from + 3) return false
  const line = state.doc.lineAt(node.from)
  // Let the shared command see the paragraph's start, behind its own marker.
  const prefix =
    line.from < node.from
      ? Decoration.set([Decoration.replace({}).range(line.from, node.from)])
      : Decoration.none
  const spec = deleteBackward(
    state.update({ selection: { anchor: node.from } }).state,
    tree,
    prefix,
  )
  if (!spec?.changes) return true
  let changes = spec.changes
  if (changes && 'from' in changes && changes.to === node.from) {
    const before = state.doc.lineAt(changes.from)
    // Joining paragraphs drops this marker; lifting out of a list or quote keeps it.
    if (changes.from === before.to && before.text.trim())
      changes = { ...changes, to: node.from + 3 }
  }
  view.dispatch({ changes, userEvent: 'delete.backward', scrollIntoView: true })
  return true
}

/** A `-# ` line is the rich view's small-text paragraph; its marker is syntax. */
const subtext: FormattedContribution = {
  id: 'text-extras.subtext',
  feature: 'text-extras.subtext',
  flavor,
  syntax: subtextSyntax,
  keys: [{ key: 'Backspace', run: backspace }],
  views: [
    {
      nodes: ['Subtext'],
      // A paragraph's `0 0 1em` margins at the addon's 0.85em size.
      space: { top: 0, bottom: 13.6 },
      decorate(node, out, { state, revealed }) {
        const line = state.doc.lineAt(node.from)
        const item = node.node.parent
        // Beside a list bullet, only the text is small: the rich view's
        // marker keeps its size and the line its height.
        const beside =
          item?.name === 'ListItem' &&
          state.doc.lineAt(item.from).number === line.number
        if (!beside) out.line(line.from, { class: 'markdown-subtext' })
        markDecoded(
          state,
          out,
          node.from + 3,
          node.to,
          beside ? { class: 'markdown-subtext' } : null,
          revealed,
          entities(node.node),
        )
        out.syntax(node.from, node.from + 3)
        return undefined
      },
    },
  ],
}

export const contributions = { subscript, subtext }
