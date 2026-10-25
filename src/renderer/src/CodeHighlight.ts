import type { Language } from '@codemirror/language'
import { type PartialParse, type Tree, TreeFragment } from '@lezer/common'
import { Extension } from '@tiptap/core'
import type { Node } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import {
  type CodeSpan,
  codeLanguageKey,
  codeLanguages,
  codeSpans,
  highlightCode,
} from './code-languages.ts'

/** Longer blocks parse incrementally and decorate only text near the viewport. */
const windowedLength = 10_000
/** Milliseconds of windowed parsing per transaction or frame. */
const parseBudget = 4

type Range = { from: number; to: number }
type HighlightState = {
  decorations: DecorationSet
  /** Document range near the viewport that windowed blocks decorate. */
  viewport: Range | null
  windowed: boolean
}
type Refresh = { keys?: ReadonlySet<string>; viewport?: Range | null }
type Edit = { doc: Node; from: number; end: number }
type Parsed = {
  language: Language
  fragments: readonly TreeFragment[]
  tree: Tree | null
  /** The tree is valid up to this block offset. */
  parsedTo: number
  parse: PartialParse | null
}

const windowedBlock = (node: Node) =>
  node.type.name === 'codeBlock' && node.content.size > windowedLength

/** Decorations never change the document, Markdown serialization, selection, or history. */
export const CodeHighlight = Extension.create({
  name: 'codeHighlight',
  addProseMirrorPlugins() {
    const key = new PluginKey<HighlightState>('codeHighlight')
    // Spans and trees belong to one parser identity, so another language's arrival keeps them.
    const highlighted = new WeakMap<
      Node,
      { language: Language | null; spans: CodeSpan[] }
    >()
    const parsed = new WeakMap<Node, Parsed>()
    const changed = new Set<string>()

    function parsedBlock(
      node: Node,
      pos: number,
      language: Language,
      edit?: Edit,
    ) {
      const existing = parsed.get(node)
      if (existing?.language === language) return existing
      const result: Parsed = {
        language,
        fragments: [],
        tree: null,
        parsedTo: 0,
        parse: null,
      }
      // Reuse the previous version's tree around an edit inside this block.
      const old = edit && pos < edit.from ? edit.doc.nodeAt(pos) : null
      const before = old && parsed.get(old)
      if (edit && old && before?.language === language) {
        const start = pos + 1
        const size = node.content.size
        const fromB = edit.from - start
        const toB = Math.min(edit.end - start, size)
        const toA =
          toB === size ? old.content.size : toB - (size - old.content.size)
        if (fromB <= toA && toA <= old.content.size)
          result.fragments = TreeFragment.applyChanges(before.fragments, [
            { fromA: fromB, toA, fromB, toB },
          ])
      }
      parsed.set(node, result)
      return result
    }
    /** Parses up to `to` before `deadline`; incomplete work resumes later. */
    function parseTo(block: Parsed, node: Node, to: number, deadline: number) {
      try {
        while (block.parsedTo < to) {
          if (!block.parse || (block.parse.stoppedAt ?? Infinity) < to) {
            block.parse = block.language.parser.startParse(
              node.textContent,
              block.fragments,
            )
            if (to < node.content.size) block.parse.stopAt(to)
          }
          const tree = block.parse.advance()
          if (tree) {
            const stopped = block.parse.stoppedAt
            block.fragments = TreeFragment.addTree(
              tree,
              block.fragments,
              stopped !== null,
            )
            block.tree = tree
            block.parsedTo = stopped ?? node.content.size
            block.parse = null
          } else if (performance.now() > deadline) return false
        }
      } catch (error) {
        console.error(
          `code highlighting failed: ${node.attrs.language ?? ''}`,
          error,
        )
        Object.assign(block, { tree: null, parse: null, parsedTo: Infinity })
      }
      return true
    }
    function decorate(
      doc: Node,
      previous: DecorationSet,
      viewport: Range | null,
      from = 0,
      to = doc.content.size,
      include?: (node: Node) => boolean,
      edit?: Edit,
    ) {
      const decorations: Decoration[] = []
      let windowed = false
      doc.nodesBetween(from, to, (node, pos) => {
        if (!node.isTextblock) return
        if (include && !include(node)) return false
        const start = pos + 1
        const existing = previous.find(start, start + node.content.size)
        if (node.type.name !== 'codeBlock') {
          // Changed code blocks may now be paragraphs; remove their old tokens too.
          previous = previous.remove(existing)
          return false
        }
        const info = String(node.attrs.language ?? '')
        const language = codeLanguages.resolve(info)
        const spec = { language }
        if (!windowedBlock(node)) {
          previous = previous.remove(existing)
          let result = highlighted.get(node)
          if (result?.language !== language) {
            result = { language, spans: highlightCode(node.textContent, info) }
            highlighted.set(node, result)
          }
          for (const span of result.spans)
            decorations.push(
              Decoration.inline(
                start + span.from,
                start + span.to,
                { class: span.classes },
                spec,
              ),
            )
          return false
        }
        windowed = true
        const block = language && parsedBlock(node, pos, language, edit)
        const visibleFrom = Math.max(viewport?.from ?? 0, start) - start
        const visibleTo =
          Math.min(viewport?.to ?? 0, start + node.content.size) - start
        if (
          block &&
          visibleFrom < visibleTo &&
          !parseTo(block, node, visibleTo, performance.now() + parseBudget)
        ) {
          // Until the edited text is parsed, mapped tokens from the same parser stay visible.
          previous = previous.remove(
            existing.filter((token) => token.spec.language !== language),
          )
          return false
        }
        previous = previous.remove(existing)
        if (block?.tree && visibleFrom < visibleTo)
          for (const span of codeSpans(
            block.tree,
            visibleFrom,
            Math.min(visibleTo, block.parsedTo),
          ))
            decorations.push(
              Decoration.inline(
                start + span.from,
                start + span.to,
                { class: span.classes },
                spec,
              ),
            )
        return false
      })
      return { decorations: previous.add(doc, decorations), windowed }
    }
    /** Visible text of windowed blocks, widened by about a screen on each side. */
    function measureViewport(view: EditorView, current: Range | null) {
      let { top, bottom } = view.dom.getBoundingClientRect()
      // Scrolling panes and other clipping ancestors bound what is visible.
      for (
        let element = view.dom.parentElement;
        element;
        element = element.parentElement
      )
        if (getComputedStyle(element).overflowY !== 'visible') {
          const box = element.getBoundingClientRect()
          top = Math.max(top, box.top)
          bottom = Math.min(bottom, box.bottom)
        }
      top = Math.max(top, 0)
      bottom = Math.min(bottom, window.innerHeight)
      let from = Number.POSITIVE_INFINITY
      let to = Number.NEGATIVE_INFINITY
      let missed = false
      if (top < bottom)
        view.state.doc.descendants((node, pos) => {
          if (!windowedBlock(node)) return !node.isTextblock
          const block = view.nodeDOM(pos) as HTMLElement | null
          const box = block?.getBoundingClientRect()
          if (!block || !box || box.top >= bottom || box.bottom <= top)
            return false
          // Hit-test at the start of lines: points past a line's end can resolve to the block's end.
          const left = view.coordsAtPos(pos + 1).left + 1
          for (const y of [
            Math.max(box.top, top) + 1,
            Math.min(box.bottom, bottom) - 1,
          ]) {
            const caret = document.caretPositionFromPoint(left, y)
            if (!caret || !block.contains(caret.offsetNode)) missed = true
            else {
              const at = view.posAtDOM(caret.offsetNode, caret.offset)
              from = Math.min(from, at)
              to = Math.max(to, at)
            }
          }
          return false
        })
      // Covered points keep the previous range until the next measurement.
      if (missed) return current
      if (from > to) return null
      if (current && current.from <= from && to <= current.to) return current
      const margin = Math.max(to - from, 2000)
      return {
        from: Math.max(0, from - margin),
        to: Math.min(view.state.doc.content.size, to + margin),
      }
    }
    return [
      new Plugin<HighlightState>({
        key,
        state: {
          init: (_config, state) => ({
            ...decorate(state.doc, DecorationSet.empty, null),
            viewport: null,
          }),
          apply(transaction, value, oldState) {
            const refresh = transaction.getMeta(key) as Refresh | undefined
            if (!transaction.docChanged && !refresh) return value
            const doc = transaction.doc
            let { decorations, viewport, windowed } = value
            const update = (
              from: number,
              to: number,
              include?: (node: Node) => boolean,
              edit?: Edit,
            ) => {
              const result = decorate(
                doc,
                decorations,
                viewport,
                from,
                to,
                include,
                edit,
              )
              decorations = result.decorations
              windowed ||= result.windowed
            }
            if (transaction.docChanged) {
              const { mapping } = transaction
              if (viewport) {
                // Replaced content clears the range until the view measures again.
                const from = mapping.mapResult(viewport.from, 1)
                const to = mapping.mapResult(viewport.to, -1)
                viewport =
                  from.deletedAfter || to.deletedBefore || from.pos >= to.pos
                    ? null
                    : { from: from.pos, to: to.pos }
              }
              let from = doc.content.size
              let end = 0
              let full = false
              for (const [index, map] of mapping.maps.entries()) {
                const remaining = mapping.slice(index + 1)
                let changed = false
                map.forEach((_oldFrom, _oldTo, start, finish) => {
                  changed = true
                  from = Math.min(from, remaining.map(start, -1))
                  end = Math.max(end, remaining.map(finish, 1))
                })
                // Attribute/mark and custom steps can change syntax without moving positions.
                if (!changed) full = true
              }
              if (full)
                ({ decorations, windowed } = decorate(
                  doc,
                  DecorationSet.empty,
                  viewport,
                ))
              else {
                decorations = decorations.map(mapping, doc)
                update(
                  Math.max(0, from - 1),
                  Math.min(doc.content.size, Math.max(from, end) + 1),
                  undefined,
                  { doc: oldState.doc, from, end },
                )
              }
            }
            // Windowed blocks in the previous and next ranges gain or drop tokens.
            const ranges: Range[] = []
            if (refresh && 'viewport' in refresh) {
              if (viewport) ranges.push(viewport)
              viewport = refresh.viewport ?? null
              if (viewport) ranges.push(viewport)
            }
            const keys = refresh?.keys
            if (keys)
              update(
                0,
                doc.content.size,
                (node) =>
                  node.type.name === 'codeBlock' &&
                  keys.has(codeLanguageKey(String(node.attrs.language ?? ''))),
              )
            if (ranges.length)
              update(
                Math.min(...ranges.map((range) => range.from)),
                Math.max(...ranges.map((range) => range.to)),
                windowedBlock,
              )
            return { decorations, viewport, windowed }
          },
        },
        props: { decorations: (state) => key.getState(state)?.decorations },
        view(view) {
          let frame = 0
          let measure = true
          const run = () => {
            frame = 0
            const state = key.getState(view.state)
            if (!state) return
            const refresh: Refresh = {}
            if (changed.size) {
              refresh.keys = new Set(changed)
              changed.clear()
            }
            if (state.windowed) {
              let next = state.viewport
              if (measure) {
                measure = false
                next = measureViewport(view, next)
              }
              let progressed = next !== state.viewport
              let waiting = false
              const deadline = performance.now() + parseBudget
              if (next)
                view.state.doc.nodesBetween(next.from, next.to, (node, pos) => {
                  if (!node.isTextblock) return
                  const block = parsed.get(node)
                  const to = Math.min(next.to - pos - 1, node.content.size)
                  if (
                    block &&
                    block.parsedTo < to &&
                    block.language ===
                      codeLanguages.resolve(String(node.attrs.language ?? ''))
                  ) {
                    const before = block.parsedTo
                    if (!parseTo(block, node, to, deadline)) waiting = true
                    progressed ||= block.parsedTo !== before
                  }
                  return false
                })
              if (progressed) refresh.viewport = next
              if (waiting) schedule()
            }
            if (refresh.keys || 'viewport' in refresh)
              view.dispatch(
                view.state.tr
                  .setMeta(key, refresh)
                  .setMeta('addToHistory', false),
              )
          }
          const schedule = () => {
            frame ||= requestAnimationFrame(run)
          }
          const layout = () => {
            if (!key.getState(view.state)?.windowed) return
            measure = true
            schedule()
          }
          // One refresh per frame covers every language that arrived meanwhile.
          const unsubscribe = codeLanguages.subscribe((names) => {
            for (const name of names) changed.add(name)
            if (changed.size) schedule()
          })
          const resize = new ResizeObserver(layout)
          resize.observe(view.dom)
          document.addEventListener('scroll', layout, {
            capture: true,
            passive: true,
          })
          window.addEventListener('resize', layout)
          if (changed.size || key.getState(view.state)?.windowed) schedule()
          return {
            update(_view, previous) {
              const state = key.getState(view.state)
              const before = key.getState(previous)
              if (!state?.windowed || state === before) return
              if (!before?.windowed || (before.viewport && !state.viewport))
                measure = true
              // Parsing that a transaction left unfinished continues in the next frame.
              schedule()
            },
            destroy() {
              unsubscribe()
              cancelAnimationFrame(frame)
              resize.disconnect()
              document.removeEventListener('scroll', layout, { capture: true })
              window.removeEventListener('resize', layout)
            },
          }
        },
      }),
    ]
  },
})
