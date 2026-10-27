import { syntaxTree, syntaxTreeAvailable } from '@codemirror/language'
import type { ChangeDesc, EditorState as SourceState } from '@codemirror/state'
import {
  type EditorView,
  Decoration as SourceDecoration,
  type DecorationSet as SourceDecorationSet,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view'
import {
  frontmatterBounds,
  readFrontmatterBounds,
} from '../../renderer/src/formatted-frontmatter.ts'
import type { SourceExtension } from '../api'
import { tagMatches } from './syntax.ts'

type FrontmatterState = {
  prefix: number
  boundary: number
  unclosed: boolean
}

export function frontmatterState(state: SourceState): FrontmatterState {
  const bounds =
    state.field(frontmatterBounds, false) ?? readFrontmatterBounds(state.doc)
  return {
    prefix:
      bounds.oversized || !bounds.complete ? state.doc.length : bounds.prefix,
    boundary: bounds.read?.unclosed ? state.doc.line(1).to : bounds.searched,
    unclosed: bounds.read?.unclosed ?? false,
  }
}

export function frontmatterPrefix(state: SourceState) {
  return frontmatterState(state).prefix
}

export function updateFrontmatterState(
  previous: FrontmatterState,
  changes: ChangeDesc,
  state: SourceState,
): FrontmatterState {
  let refresh = !!state.field(frontmatterBounds, false)
  changes.iterChangedRanges((from, _to, nextFrom, nextTo) => {
    if (from <= previous.boundary) refresh = true
    if (!previous.unclosed || refresh) return
    const last = state.doc.lineAt(nextTo).number
    for (let line = state.doc.lineAt(nextFrom).number; line <= last; line++) {
      if (/^(?:---|\.\.\.)[ \t]*$/.test(state.doc.line(line).text))
        refresh = true
    }
  })
  if (!refresh) return previous
  const next = frontmatterState(state)
  return next.prefix === previous.prefix &&
    next.boundary === previous.boundary &&
    next.unclosed === previous.unclosed
    ? previous
    : next
}

export function sourceTagRanges(
  state: SourceState,
  visibleRanges: readonly { from: number; to: number }[],
  prefix: number,
): SourceDecorationSet {
  const doc = state.doc
  const tree = syntaxTree(state)
  const scan: { from: number; to: number }[] = []
  for (const visible of visibleRanges) {
    const from = doc.lineAt(visible.from).from
    const to = doc.lineAt(visible.to).to
    const last = scan.at(-1)
    if (last && from <= last.to) last.to = Math.max(last.to, to)
    else scan.push({ from, to })
  }
  const ranges = []
  for (const { from, to } of scan) {
    for (const match of tagMatches(doc.sliceString(from, to))) {
      const start = from + match.from
      if (
        start < prefix ||
        tree.length < from + match.to ||
        !syntaxTreeAvailable(state, from + match.to)
      )
        continue
      let allowed = true
      for (
        let node: ReturnType<typeof tree.resolveInner> | null =
          tree.resolveInner(start, 1);
        node;
        node = node.parent
      )
        if (/Code|Link|URL|HTML|Escape/.test(node.name)) {
          allowed = false
          break
        }
      if (allowed)
        ranges.push(
          SourceDecoration.mark({
            class: 'hibi-tag',
            attributes: {
              'data-tag': match.tag,
              'data-tooltip': `Shift-click to browse #${match.tag}`,
            },
          }).range(start, from + match.to),
        )
    }
  }
  return SourceDecoration.set(ranges)
}

export function sourceTags(
  browse: (tag: string) => void,
  enabled: () => boolean,
): SourceExtension {
  return {
    id: 'highlights',
    create: () => [
      frontmatterBounds,
      ViewPlugin.fromClass(
        class {
          decorations: SourceDecorationSet = SourceDecoration.none
          frontmatter: FrontmatterState
          constructor(view: EditorView) {
            this.frontmatter = frontmatterState(view.state)
            this.highlight(view)
          }
          update(update: ViewUpdate) {
            if (
              update.docChanged ||
              update.state.field(frontmatterBounds) !==
                update.startState.field(frontmatterBounds)
            )
              this.frontmatter = updateFrontmatterState(
                this.frontmatter,
                update.changes,
                update.state,
              )
            if (
              update.docChanged ||
              update.viewportChanged ||
              update.state.field(frontmatterBounds) !==
                update.startState.field(frontmatterBounds) ||
              syntaxTree(update.state) !== syntaxTree(update.startState)
            )
              this.highlight(update.view)
          }
          highlight(view: EditorView) {
            this.decorations = enabled()
              ? sourceTagRanges(
                  view.state,
                  view.visibleRanges,
                  this.frontmatter.prefix,
                )
              : SourceDecoration.none
          }
        },
        {
          decorations: (value) => value.decorations,
          eventHandlers: {
            click(event) {
              const tag =
                event.target instanceof Element
                  ? event.target.closest<HTMLElement>('.hibi-tag')?.dataset.tag
                  : undefined
              if (!tag || !event.shiftKey) return false
              event.preventDefault()
              browse(tag)
              return true
            },
          },
        },
      ),
    ],
  }
}
