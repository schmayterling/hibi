import type { EditorState } from '@codemirror/state'
import { ViewPlugin } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import {
  type FormattedContribution,
  formattedLiteral,
} from '../../renderer/src/formatted-contributions.ts'
import { tagMatches } from './syntax.ts'

/** Blocks whose text holds tags: the rich view's text blocks outside code. */
const blocks = [
  'Paragraph',
  'Task',
  ...[1, 2, 3, 4, 5, 6].flatMap((level) => [
    `ATXHeading${level}`,
    `SetextHeading${level}`,
  ]),
]

/** Inline syntax whose text is never a tag, like the rich view's code and link marks. */
const opaque = /Code|Link|link|URL|HTML|Image|Embed|Math|Comment|Escape/

const nameEnd = /[\p{L}\p{N}_/-]$/u
const nameStart = /^[\p{L}\p{N}_/-]/u

/** Syntax that is off, per facet value: it shows as written and holds no tags. */
const literals = new WeakMap<readonly string[], ReadonlySet<string>>()
function literalNodes(state: EditorState) {
  const names = state.facet(formattedLiteral)
  let found = literals.get(names)
  if (!found) {
    found = new Set(names)
    literals.set(names, found)
  }
  return found
}

/**
 * Tags in a block's text between `from` and `to`, as the rich view finds them
 * in its text nodes: inline syntax starts a new text node, so a tag can start
 * right after formatting markers. Entities stay part of the text around
 * them, as in the workspace index. Only text near `from`–`to` is read, so a
 * long block costs its visible part.
 */
function blockTags(
  block: SyntaxNode,
  from: number,
  to: number,
  read: (from: number, to: number) => string,
  literal: ReadonlySet<string>,
  found: (from: number, to: number, match: { tag: string }) => void,
) {
  /**
   * Code, links, HTML, escapes and syntax that is off hold no tags. Reference
   * links show as written for now, so their text holds tags like the rich
   * view's text where the note defines no such reference.
   */
  const skip = (node: SyntaxNode) => {
    if (literal.has(node.name)) return true
    if (node.name !== 'Link' && node.name !== 'Image')
      return opaque.test(node.name)
    for (let mark = node.firstChild; mark; mark = mark.nextSibling)
      if (mark.name === 'LinkMark' && read(mark.from, mark.to) === ']')
        return read(mark.to, mark.to + 1) === '('
    return false
  }
  /** Tags in the text run `start`–`end`, a rich text node. */
  const run = (start: number, end: number) => {
    const before = (at: number) =>
      nameEnd.exec(read(Math.max(start, at - 2), at))?.[0].length ?? 0
    const after = (at: number) =>
      nameStart.exec(read(at, Math.min(end, at + 2)))?.[0].length ?? 0
    // A tag that starts before the window: back over its name, then over its
    // # and the character before it, which decide whether it is one.
    let begin = Math.max(start, from)
    for (let step = before(begin); step; step = before(begin)) begin -= step
    begin = Math.max(start, begin - 2)
    let finish = Math.min(end, to)
    for (let step = after(finish); step; step = after(finish)) finish += step
    for (const match of tagMatches(read(begin, finish))) {
      const tagFrom = Math.max(from, begin + match.from),
        tagTo = Math.min(to, begin + match.to)
      if (tagTo > tagFrom) found(tagFrom, tagTo, match)
    }
  }
  const visit = (parent: SyntaxNode) => {
    // The first child ending after the window start, and where the run before it starts.
    let child = parent.childAfter(from)
    let previous = child ? child.prevSibling : parent.lastChild
    while (previous?.name === 'Entity') previous = previous.prevSibling
    let start = previous ? previous.to : parent.from
    for (;;) {
      while (child?.name === 'Entity') child = child.nextSibling
      const end = child ? child.from : parent.to
      if (end > start && end > from && start < to) run(start, end)
      if (!child || child.from >= to) return
      if (!skip(child) && child.firstChild) visit(child)
      start = child.to
      child = child.nextSibling
    }
  }
  visit(block)
}

/** `#tags` in the formatted view, styled and browsed as in the rich view. */
export function formattedTags(
  browse: (tag: string) => void,
): FormattedContribution {
  return {
    id: 'tags.highlights',
    views: [
      {
        nodes: blocks,
        decorate(node, out, { state, visible }) {
          if (!visible) return
          blockTags(
            node.node,
            Math.max(node.from, visible.from),
            Math.min(node.to, visible.to),
            (from, to) => state.sliceDoc(from, to),
            literalNodes(state),
            (from, to, match) =>
              out.mark(from, to, {
                class: 'hibi-tag',
                'data-tag': match.tag,
                'data-tooltip': `Shift-click to browse #${match.tag}`,
              }),
          )
          return undefined
        },
      },
    ],
    // Clicks in widgets, such as table cells, skip the editor's event
    // handlers, so shift-click is heard on the content itself.
    extension: ViewPlugin.define((view) => {
      const click = (event: MouseEvent) => {
        const tag =
          event.target instanceof Element
            ? event.target.closest<HTMLElement>('.hibi-tag')?.dataset.tag
            : undefined
        if (!tag || !event.shiftKey) return
        event.preventDefault()
        browse(tag)
      }
      view.contentDOM.addEventListener('click', click)
      return {
        destroy: () => view.contentDOM.removeEventListener('click', click),
      }
    }),
  }
}
