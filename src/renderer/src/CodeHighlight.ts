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
/** Milliseconds of windowed parsing per transaction or frame; idle periods add more. */
const parseBudget = 4

type Range = { from: number; to: number }
type HighlightState = {
  decorations: DecorationSet
  /** Document range near the viewport that windowed blocks decorate. */
  viewport: Range | null
  /** Positions of windowed blocks, in document order. */
  blocks: readonly number[]
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
    /** Parses up to `to` until `deadline`; unfinished work resumes later. */
    function parseTo(block: Parsed, node: Node, to: number, deadline: number) {
      try {
        while (block.parsedTo < to) {
          if (performance.now() >= deadline) return false
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
          }
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
    /** Windowed blocks parse until `deadline`, shared by every block in this pass. */
    function decorate(
      doc: Node,
      previous: DecorationSet,
      viewport: Range | null,
      deadline: number,
      from = 0,
      to = doc.content.size,
      include?: (node: Node) => boolean,
      edit?: Edit,
    ) {
      const decorations: Decoration[] = []
      const blocks: number[] = []
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
        blocks.push(pos)
        const block = language && parsedBlock(node, pos, language, edit)
        const visibleFrom = Math.max(viewport?.from ?? 0, start) - start
        const visibleTo =
          Math.min(viewport?.to ?? 0, start + node.content.size) - start
        if (
          block &&
          visibleFrom < visibleTo &&
          !parseTo(block, node, visibleTo, deadline)
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
      return { decorations: previous.add(doc, decorations), blocks }
    }
    /** Visible text of windowed blocks, widened by about a screen on each side. */
    function measureViewport(
      view: EditorView,
      current: Range | null,
      blocks: readonly number[],
    ) {
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
      const shown = blocks.flatMap((pos) => {
        const node = view.state.doc.nodeAt(pos)
        const box = (
          view.nodeDOM(pos) as HTMLElement | null
        )?.getBoundingClientRect()
        return node && box && box.top < bottom && box.bottom > top
          ? [{ start: pos + 1, end: pos + 1 + node.content.size, box }]
          : []
      })
      if (!shown.length) return null
      // Line geometry ignores horizontal scrolling and overlapping elements, unlike hit-testing.
      const lineTop = (at: number) => view.coordsAtPos(at).top
      const lineBottom = (at: number) => view.coordsAtPos(at).bottom
      if (
        current &&
        shown.every(
          ({ start, end, box }) =>
            (current.from <= start ||
              (box.top < top &&
                current.from < end &&
                lineTop(current.from) <= top)) &&
            (current.to >= end ||
              (box.bottom > bottom &&
                current.to > start &&
                lineBottom(current.to) >= bottom)),
        )
      )
        return current
      const first = (
        start: number,
        end: number,
        after: (at: number) => boolean,
      ) => {
        while (start < end) {
          const middle = (start + end) >> 1
          if (after(middle)) end = middle
          else start = middle + 1
        }
        return start
      }
      let from = Number.POSITIVE_INFINITY
      let to = Number.NEGATIVE_INFINITY
      for (const { start, end, box } of shown) {
        from = Math.min(
          from,
          box.top >= top
            ? start
            : first(start, end, (at) => lineBottom(at) > top),
        )
        to = Math.max(
          to,
          box.bottom <= bottom
            ? end
            : first(start, end, (at) => lineTop(at) >= bottom),
        )
      }
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
            ...decorate(state.doc, DecorationSet.empty, null, -Infinity),
            viewport: null,
          }),
          apply(transaction, value, oldState) {
            const refresh = transaction.getMeta(key) as Refresh | undefined
            if (!transaction.docChanged && !refresh) return value
            const doc = transaction.doc
            let { decorations, viewport, blocks } = value
            // Edits may parse windowed blocks briefly; refreshes show what frames already parsed.
            const update = (
              deadline: number,
              from: number,
              to: number,
              include?: (node: Node) => boolean,
              edit?: Edit,
            ) => {
              const result = decorate(
                doc,
                decorations,
                viewport,
                deadline,
                from,
                to,
                include,
                edit,
              )
              decorations = result.decorations
              return result.blocks
            }
            if (transaction.docChanged) {
              const { mapping } = transaction
              const deadline = performance.now() + parseBudget
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
              if (full) {
                decorations = DecorationSet.empty
                blocks = update(deadline, 0, doc.content.size)
              } else {
                decorations = decorations.map(mapping, doc)
                const found = update(
                  deadline,
                  Math.max(0, from - 1),
                  Math.min(doc.content.size, Math.max(from, end) + 1),
                  undefined,
                  { doc: oldState.doc, from, end },
                )
                // Blocks outside the edit keep their mapped positions.
                const kept = blocks.flatMap((pos) => {
                  const mapped = mapping.mapResult(pos, 1)
                  const node = mapped.deleted ? null : doc.nodeAt(mapped.pos)
                  return node && windowedBlock(node) ? [mapped.pos] : []
                })
                blocks = [...new Set([...kept, ...found])].sort((a, b) => a - b)
              }
            }
            const previous = viewport
            if (refresh && 'viewport' in refresh)
              viewport = refresh.viewport ?? null
            const keys = refresh?.keys
            if (keys)
              update(
                -Infinity,
                0,
                doc.content.size,
                (node) =>
                  node.type.name === 'codeBlock' &&
                  keys.has(codeLanguageKey(String(node.attrs.language ?? ''))),
              )
            // Windowed blocks in the previous or next range gain or drop tokens.
            if (refresh && 'viewport' in refresh)
              for (const pos of blocks) {
                const end = pos + (doc.nodeAt(pos)?.nodeSize ?? 0)
                if (
                  [previous, viewport].some(
                    (range) => range && pos < range.to && end > range.from,
                  )
                )
                  update(-Infinity, pos, end, windowedBlock)
              }
            return { decorations, viewport, blocks }
          },
        },
        props: { decorations: (state) => key.getState(state)?.decorations },
        view(view) {
          let frame = 0
          let idle = 0
          let measure = true
          let scrolling = false
          const run = (budget: number) => {
            const state = key.getState(view.state)
            if (!state) return
            // Hidden editors keep pending work until they have a size again.
            const box = view.dom.getBoundingClientRect()
            if (box.bottom <= box.top) return
            const refresh: Refresh = {}
            if (changed.size) {
              refresh.keys = new Set(changed)
              changed.clear()
            }
            if (state.blocks.length) {
              let next = state.viewport
              if (measure) {
                measure = false
                next = measureViewport(view, next, state.blocks)
              }
              let progressed = next !== state.viewport
              let waiting = false
              // One budget covers every block; unfinished ones continue later.
              const deadline = performance.now() + budget
              if (next)
                for (const pos of state.blocks) {
                  const node = view.state.doc.nodeAt(pos)
                  const block = node && parsed.get(node)
                  if (!node || !block || pos + node.nodeSize <= next.from)
                    continue
                  const to = Math.min(next.to - pos - 1, node.content.size)
                  if (
                    block.parsedTo >= to ||
                    block.language !==
                      codeLanguages.resolve(String(node.attrs.language ?? ''))
                  )
                    continue
                  const before = block.parsedTo
                  if (!parseTo(block, node, to, deadline)) waiting = true
                  progressed ||= block.parsedTo !== before
                }
              if (progressed) refresh.viewport = next
              // Frames keep progress steady while busy; idle periods finish sooner.
              if (waiting) {
                schedule()
                idle ||= requestIdleCallback((deadline) => {
                  idle = 0
                  run(deadline.timeRemaining())
                })
              }
            }
            if (refresh.keys || 'viewport' in refresh)
              view.dispatch(
                view.state.tr
                  .setMeta(key, refresh)
                  .setMeta('addToHistory', false),
              )
          }
          const schedule = () => {
            frame ||= requestAnimationFrame(() => {
              frame = 0
              run(parseBudget)
            })
          }
          const layout = () => {
            const blocks = key.getState(view.state)?.blocks.length
            if (blocks) measure = true
            if (blocks || changed.size) schedule()
          }
          // Only scrolling that moves this editor or its blocks changes what is visible.
          const scroll = (event: Event) => {
            // The document stands for the window.
            const target = event.target as Element | Document
            if (target.contains(view.dom) || view.dom.contains(target)) layout()
          }
          const watchScroll = () => {
            const active = !!key.getState(view.state)?.blocks.length
            if (active === scrolling) return
            scrolling = active
            if (active)
              document.addEventListener('scroll', scroll, {
                capture: true,
                passive: true,
              })
            else
              document.removeEventListener('scroll', scroll, { capture: true })
          }
          // One refresh per frame covers every language that arrived meanwhile.
          const unsubscribe = codeLanguages.subscribe((names) => {
            for (const name of names) changed.add(name)
            if (changed.size) schedule()
          })
          const resize = new ResizeObserver(layout)
          resize.observe(view.dom)
          window.addEventListener('resize', layout)
          watchScroll()
          if (changed.size || key.getState(view.state)?.blocks.length)
            schedule()
          return {
            update(_view, previous) {
              watchScroll()
              const state = key.getState(view.state)
              const before = key.getState(previous)
              if (!state?.blocks.length || state === before) return
              if (
                !before?.blocks.length ||
                (before.viewport && !state.viewport)
              )
                measure = true
              // Parsing that a transaction left unfinished continues in the next frame.
              schedule()
            },
            destroy() {
              unsubscribe()
              cancelAnimationFrame(frame)
              cancelIdleCallback(idle)
              resize.disconnect()
              if (scrolling)
                document.removeEventListener('scroll', scroll, {
                  capture: true,
                })
              window.removeEventListener('resize', layout)
            },
          }
        },
      }),
    ]
  },
})
