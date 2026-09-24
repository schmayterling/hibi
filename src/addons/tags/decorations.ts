import { syntaxTree, syntaxTreeAvailable } from '@codemirror/language'
import type { ChangeDesc, EditorState as SourceState } from '@codemirror/state'
import {
  type EditorView,
  Decoration as SourceDecoration,
  type DecorationSet as SourceDecorationSet,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { AddMarkStep, RemoveMarkStep } from '@tiptap/pm/transform'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { readFrontmatter } from '../../shared/frontmatter.ts'
import type { RichExtension, SourceExtension } from '../api'
import { tagMatches } from './syntax.ts'

export function richTags(browse: (tag: string) => void): RichExtension {
  return {
    id: 'highlights',
    attach(editor) {
      const key = new PluginKey<DecorationSet>('tags')
      function decorate(
        doc: typeof editor.state.doc,
        previous = DecorationSet.empty,
        from = 0,
        to = doc.content.size,
      ) {
        const marks: Decoration[] = []
        doc.nodesBetween(from, to, (block, position) => {
          if (!block.isTextblock) return
          previous = previous.remove(
            previous.find(position + 1, position + block.nodeSize - 1),
          )
          if (block.type.spec.code) return false
          block.descendants((node, offset) => {
            if (
              node.type.spec.code ||
              node.marks.some((mark) =>
                ['code', 'link'].includes(mark.type.name),
              )
            )
              return false
            if (node.isText)
              for (const match of tagMatches(node.text ?? ''))
                marks.push(
                  Decoration.inline(
                    position + 1 + offset + match.from,
                    position + 1 + offset + match.to,
                    {
                      class: 'hibi-tag',
                      'data-tag': match.tag,
                      'data-tooltip': `Shift-click to browse #${match.tag}`,
                    },
                  ),
                )
          })
          return false
        })
        return previous.add(doc, marks)
      }
      const plugin = new Plugin({
        key,
        state: {
          init: (_config, state) => decorate(state.doc),
          apply(transaction, previous) {
            if (!transaction.docChanged) return previous
            let from = transaction.doc.content.size
            let to = 0
            for (const [index, step] of transaction.steps.entries()) {
              const remaining = transaction.mapping.slice(index + 1)
              let mapped = false
              step.getMap().forEach((_oldFrom, _oldTo, start, end) => {
                mapped = true
                from = Math.min(from, remaining.map(start, -1))
                to = Math.max(to, remaining.map(end, 1))
              })
              if (!mapped) {
                if (
                  !(
                    step instanceof AddMarkStep ||
                    step instanceof RemoveMarkStep
                  )
                )
                  return decorate(transaction.doc)
                from = Math.min(from, remaining.map(step.from, -1))
                to = Math.max(to, remaining.map(step.to, 1))
              }
            }
            return decorate(
              transaction.doc,
              previous.map(transaction.mapping, transaction.doc),
              Math.max(0, from - 1),
              Math.min(transaction.doc.content.size, Math.max(from, to) + 1),
            )
          },
        },
        props: {
          decorations(state) {
            return key.getState(state)
          },
          handleDOMEvents: {
            click(_view, event) {
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
      })
      editor.registerPlugin(plugin)
      return () => {
        if (!editor.isDestroyed) editor.unregisterPlugin(key)
      }
    },
  }
}

type FrontmatterState = {
  prefix: number
  boundary: number
  unclosed: boolean
}

const openingFence = /^(?:\uFEFF)?---[ \t]*$/
const closingFence = /^(?:---|\.\.\.)[ \t]*$/

/** Only the metadata header needs YAML parsing; scrolling never reads the full source. */
export function frontmatterState(state: SourceState): FrontmatterState {
  const doc = state.doc
  const firstLine = doc.line(1)
  if (!openingFence.test(firstLine.text))
    return { prefix: 0, boundary: firstLine.to, unclosed: false }
  for (let line = 2; line <= doc.lines; line++) {
    if (!closingFence.test(doc.line(line).text)) continue
    let end = line < doc.lines ? doc.line(line + 1).from : doc.length
    for (let blank = line + 1; blank <= doc.lines; blank++) {
      if (!/^[ \t]*$/.test(doc.line(blank).text)) break
      end = blank < doc.lines ? doc.line(blank + 1).from : doc.length
    }
    return {
      prefix: readFrontmatter(doc.sliceString(0, end))?.prefix.length ?? 0,
      boundary: end,
      unclosed: false,
    }
  }
  return { prefix: 0, boundary: firstLine.to, unclosed: true }
}

export function frontmatterPrefix(state: SourceState) {
  return frontmatterState(state).prefix
}

export function updateFrontmatterState(
  previous: FrontmatterState,
  changes: ChangeDesc,
  state: SourceState,
): FrontmatterState {
  let refresh = false
  changes.iterChangedRanges((from, _to, nextFrom, nextTo) => {
    if (from <= previous.boundary) refresh = true
    if (!previous.unclosed || refresh) return
    const doc = state.doc
    const last = doc.lineAt(nextTo).number
    for (let line = doc.lineAt(nextFrom).number; line <= last; line++) {
      if (!closingFence.test(doc.line(line).text)) continue
      refresh = true
      break
    }
  })
  return refresh ? frontmatterState(state) : previous
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
    create: () =>
      ViewPlugin.fromClass(
        class {
          decorations: SourceDecorationSet = SourceDecoration.none
          frontmatter: FrontmatterState
          constructor(view: EditorView) {
            this.frontmatter = frontmatterState(view.state)
            this.highlight(view)
          }
          update(update: ViewUpdate) {
            if (update.docChanged)
              this.frontmatter = updateFrontmatterState(
                this.frontmatter,
                update.changes,
                update.state,
              )
            if (
              update.docChanged ||
              update.viewportChanged ||
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
  }
}
