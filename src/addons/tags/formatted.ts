import type { EditorState, Text } from '@codemirror/state'
import { ViewPlugin, type ViewUpdate } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import {
  type FormattedContribution,
  formattedLiteral,
  formattedOpaque,
  formattedRefresh,
} from '../../renderer/src/formatted-contributions.ts'
import { TagLabels } from './formatted-labels.ts'
import { tagMatches } from './syntax.ts'

/**
 * Leaf blocks whose text the rich view does not show as text: code, HTML,
 * comments, processing instructions, link definitions, frontmatter, alert
 * titles, display math and rules. Every other leaf block holds tags, such as
 * paragraphs, headings, tasks and small text, whichever syntax adds it.
 */
const sourceBlocks = new Set([
  'CodeBlock',
  'FencedCode',
  'HTMLBlock',
  'CommentBlock',
  'ProcessingInstructionBlock',
  'LinkReference',
  'Frontmatter',
  'AlertTitle',
  'BlockMath',
  'HorizontalRule',
])

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
  labels: TagLabels,
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
    const close = node.lastChild
    return close?.name === 'LinkMark' && read(close.from, close.to) === ')'
  }
  /** Tags in the text run `start`–`end`, a rich text node. */
  const run = (start: number, end: number) => {
    const emit = (matches: ReturnType<typeof tagMatches>, offset = 0) => {
      for (const match of matches) {
        const tagFrom = Math.max(from, offset + match.from)
        const tagTo = Math.min(to, offset + match.to)
        if (tagTo > tagFrom) found(tagFrom, tagTo, match)
      }
    }
    const cached = labels.get(
      start,
      end,
      Math.max(start, from),
      Math.min(end, to),
    )
    if (cached) {
      emit(cached)
      return
    }
    const defer = () =>
      labels.request({
        start,
        end,
        from: Math.max(start, from),
        to: Math.min(end, to),
      })
    const before = (at: number) =>
      nameEnd.exec(read(Math.max(start, at - 2), at))?.[0].length ?? 0
    const after = (at: number) =>
      nameStart.exec(read(at, Math.min(end, at + 2)))?.[0].length ?? 0
    // A tag that starts before the window: back over its name, then over its
    // # and the character before it, which decide whether it is one.
    const split = (at: number) =>
      /[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(
        read(Math.max(start, at - 1), Math.min(end, at + 1)),
      )
    let begin = Math.max(start, from),
      finish = Math.min(end, to),
      scanned = 0
    if (begin > start && split(begin)) begin--
    if (finish < end && split(finish)) finish++
    // Ordinary names resolve now; a long name is completed off the input path.
    for (let step = before(begin); step; step = before(begin)) {
      scanned += step
      if (scanned > 512) {
        defer()
        return
      }
      begin -= step
    }
    begin = Math.max(start, begin - 2)
    for (let step = after(finish); step; step = after(finish)) {
      scanned += step
      if (scanned > 512) {
        defer()
        return
      }
      finish += step
    }
    emit(tagMatches(read(begin, finish)), begin)
  }
  const visit = (parent: SyntaxNode) => {
    // The first child ending after the window start, and where the run before it starts.
    let child = parent.childAfter(from)
    const previous = child ? child.prevSibling : parent.lastChild
    let start = previous
      ? previous.name === 'Entity'
        ? previous.from
        : previous.to
      : parent.from
    for (;;) {
      while (child?.name === 'Entity' && child.from < to)
        child = child.nextSibling
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
  const caches = new WeakMap<Text, TagLabels>()
  const labelsFor = (doc: Text) => {
    let labels = caches.get(doc)
    if (!labels) {
      labels = new TagLabels(doc)
      caches.set(doc, labels)
    }
    return labels
  }
  return {
    id: 'tags.highlights',
    views: [
      {
        nodes: ['LeafBlock'],
        decorate(node, out, { state, visible }) {
          // Opaque nodes, such as tables, render their text themselves.
          if (
            !visible ||
            sourceBlocks.has(node.name) ||
            state.facet(formattedOpaque).includes(node.name)
          )
            return
          blockTags(
            node.node,
            Math.max(node.from, visible.from),
            Math.min(node.to, visible.to),
            (from, to) => state.sliceDoc(from, to),
            literalNodes(state),
            labelsFor(state.doc),
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
      let doc = view.state.doc
      const subscribe = () => {
        const current = view.state.doc
        return labelsFor(current).subscribe(() => {
          if (view.state.doc === current)
            view.dispatch({ effects: formattedRefresh.of(null) })
        })
      }
      let unsubscribe = subscribe()
      const guard = (event: MouseEvent) => {
        if (
          event.button !== 0 ||
          !event.shiftKey ||
          !(event.target instanceof Element) ||
          !event.target.closest('.hibi-tag')
        )
          return
        event.preventDefault()
        event.stopPropagation()
      }
      const click = (event: MouseEvent) => {
        const tag =
          event.target instanceof Element
            ? event.target.closest<HTMLElement>('.hibi-tag')?.dataset.tag
            : undefined
        if (!tag || !event.shiftKey) return
        event.preventDefault()
        browse(tag)
      }
      view.contentDOM.addEventListener('pointerdown', guard, true)
      view.contentDOM.addEventListener('mousedown', guard, true)
      view.contentDOM.addEventListener('click', click)
      return {
        update(update: ViewUpdate) {
          if (update.state.doc === doc) return
          unsubscribe()
          doc = update.state.doc
          unsubscribe = subscribe()
        },
        destroy() {
          unsubscribe()
          view.contentDOM.removeEventListener('pointerdown', guard, true)
          view.contentDOM.removeEventListener('mousedown', guard, true)
          view.contentDOM.removeEventListener('click', click)
        },
      }
    }),
  }
}
