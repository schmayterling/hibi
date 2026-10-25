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
/** Milliseconds of windowed parsing and decoration per transaction or frame; idle periods add more. */
const parseBudget = 4
/** Characters decorated together, so the budget can stop between pieces. */
const pieceLength = 2_000

type Range = { from: number; to: number }
/** Line columns worth decorating in one windowed block, from its horizontal scroll position. */
type Columns = { pos: number; from: number; to: number }
type Viewport = Range & {
  /** Text on screen, decorated before the margin around it. */
  visible: Range
  columns: readonly Columns[]
}
type HighlightState = {
  decorations: DecorationSet
  /** Document range near the viewport that windowed blocks decorate. */
  viewport: Viewport | null
  /** Positions of windowed blocks, in document order. */
  blocks: readonly number[]
  /** Pieces decorated so far in windowed blocks that ran out of time. */
  progress: ReadonlyMap<number, number> | null
}
type Refresh = {
  keys?: ReadonlySet<string>
  viewport?: Viewport | null
  deadline: number
}
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

/** Pieces of the lines in `from`..`to`, limited to `columns`, those on screen first. */
function pieces(
  text: string,
  from: number,
  to: number,
  columns?: Columns,
  visible?: Range,
) {
  const all: Range[] = []
  const add = (start: number, end: number) => {
    const last = all.at(-1)
    // Neighbouring lines share a piece, up to its length.
    if (last && start - last.to <= 1 && end - last.from <= pieceLength)
      last.to = end
    else
      for (let at = start; at < end; at += pieceLength)
        all.push({ from: at, to: Math.min(end, at + pieceLength) })
  }
  if (!columns) add(from, to)
  else
    for (let line = from && text.lastIndexOf('\n', from - 1) + 1; line < to; ) {
      const newline = text.indexOf('\n', line)
      const end = newline < 0 ? text.length : newline
      const start = Math.max(from, line + columns.from)
      const stop = Math.min(to, end, line + columns.to)
      if (start < stop) add(start, stop)
      if (newline < 0) break
      line = newline + 1
    }
  const shown = (piece: Range) =>
    !!visible && piece.from < visible.to && piece.to > visible.from
  return [...all.filter(shown), ...all.filter((piece) => !shown(piece))]
}

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
    /**
     * Windowed blocks parse and decorate until `deadline`, shared by every
     * block in this pass; `resume` holds pieces they already decorated.
     */
    function decorate(
      doc: Node,
      previous: DecorationSet,
      viewport: Viewport | null,
      deadline: number,
      from = 0,
      to = doc.content.size,
      include?: (node: Node, pos: number) => boolean,
      edit?: Edit,
      resume?: ReadonlyMap<number, number>,
    ) {
      const decorations: Decoration[] = []
      const blocks: number[] = []
      const unfinished = new Map<number, number>()
      doc.nodesBetween(from, to, (node, pos) => {
        if (!node.isTextblock) return
        if (include && !include(node, pos)) return false
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
        const size = node.content.size
        const visibleFrom = Math.max(viewport?.from ?? 0, start) - start
        const visibleTo = Math.min(viewport?.to ?? 0, start + size) - start
        if (!block || visibleFrom >= visibleTo) {
          previous = previous.remove(existing)
          return false
        }
        // Mapped tokens from the same parser stay visible until replaced.
        previous = previous.remove(
          existing.filter((token) => token.spec.language !== language),
        )
        const first = resume?.get(pos) ?? 0
        if (!parseTo(block, node, visibleTo, deadline)) {
          unfinished.set(pos, first)
          return false
        }
        const tree = block.tree
        if (!tree) {
          previous = previous.remove(previous.find(start, start + size))
          return false
        }
        const list = pieces(
          node.textContent,
          visibleFrom,
          Math.min(visibleTo, block.parsedTo),
          viewport?.columns.find((columns) => columns.pos === pos),
          viewport
            ? {
                from: viewport.visible.from - start,
                to: viewport.visible.to - start,
              }
            : undefined,
        )
        let index = first
        for (const piece of list.slice(first)) {
          if (index > first && performance.now() >= deadline) break
          index++
          previous = previous.remove(
            previous
              .find(start + piece.from, start + piece.to)
              .filter(
                (token) =>
                  token.from < start + piece.to &&
                  token.to > start + piece.from,
              ),
          )
          for (const span of codeSpans(tree, piece.from, piece.to))
            decorations.push(
              Decoration.inline(
                start + span.from,
                start + span.to,
                { class: span.classes },
                spec,
              ),
            )
        }
        if (index < list.length) unfinished.set(pos, index)
        // Once the range is complete, tokens left from earlier ranges or versions go.
        else
          previous = previous.remove(
            previous
              .find(start, start + size)
              .filter(
                (token) =>
                  !list.some(
                    (piece) =>
                      start + piece.from <= token.from &&
                      token.to <= start + piece.to,
                  ),
              ),
          )
        return false
      })
      return {
        decorations: previous.add(doc, decorations),
        blocks,
        unfinished,
      }
    }
    /** Visible text of windowed blocks, widened by about a screen in each direction. */
    function measureViewport(
      view: EditorView,
      current: Viewport | null,
      blocks: readonly number[],
    ): Viewport | null {
      let { top, bottom, left, right } = view.dom.getBoundingClientRect()
      // Scrolling panes and other clipping ancestors bound what is visible.
      for (
        let element = view.dom.parentElement;
        element;
        element = element.parentElement
      ) {
        const style = getComputedStyle(element)
        if (style.overflowX === 'visible' && style.overflowY === 'visible')
          continue
        const box = element.getBoundingClientRect()
        top = Math.max(top, box.top)
        bottom = Math.min(bottom, box.bottom)
        left = Math.max(left, box.left)
        right = Math.min(right, box.right)
      }
      top = Math.max(top, 0)
      bottom = Math.min(bottom, window.innerHeight)
      left = Math.max(left, 0)
      right = Math.min(right, window.innerWidth)
      const shown = blocks.flatMap((pos) => {
        const node = view.state.doc.nodeAt(pos)
        const box = (
          view.nodeDOM(pos) as HTMLElement | null
        )?.getBoundingClientRect()
        return node &&
          box &&
          box.top < bottom &&
          box.bottom > top &&
          box.left < right &&
          box.right > left
          ? [
              {
                pos,
                node,
                start: pos + 1,
                end: pos + 1 + node.content.size,
                box,
              },
            ]
          : []
      })
      if (!shown.length) return null
      // Line geometry ignores horizontal scrolling and overlapping elements, unlike hit-testing.
      const coords = (at: number) => view.coordsAtPos(at)
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
      // Lines in a code block start at one x, so one line's character width gives every line's visible columns.
      const columns = shown.flatMap(({ pos, node, start, box }) => {
        const text = node.textContent
        for (let line = 0, lines = 0; lines < 64; lines++) {
          const newline = text.indexOf('\n', line)
          const length = (newline < 0 ? text.length : newline) - line
          if (length >= 16 || newline < 0) {
            const count = Math.min(length, 256)
            const head = coords(start + line)
            const tail = coords(start + line + count)
            const x = head.left
            const width = count > 0 ? (tail.left - x) / count : 0
            // Wrapped lines fit the pane; their rows are found vertically.
            if (width <= 0 || Math.abs(tail.top - head.top) >= 1) return []
            return [
              {
                pos,
                from: Math.max(
                  0,
                  Math.floor((Math.max(left, box.left) - x) / width),
                ),
                to: Math.ceil((Math.min(right, box.right) - x) / width),
              },
            ]
          }
          line = newline + 1
        }
        return []
      })
      if (
        current &&
        shown.every(
          ({ start, end, box }) =>
            (current.from <= start ||
              (box.top < top &&
                current.from < end &&
                coords(current.from).top <= top)) &&
            (current.to >= end ||
              (box.bottom > bottom &&
                current.to > start &&
                coords(current.to).bottom >= bottom)),
        ) &&
        columns.every((needed) => {
          const kept = current.columns.find(({ pos }) => pos === needed.pos)
          return !!kept && kept.from <= needed.from && needed.to <= kept.to
        })
      )
        return current
      let from = Number.POSITIVE_INFINITY
      let to = Number.NEGATIVE_INFINITY
      for (const { start, end, box } of shown) {
        from = Math.min(
          from,
          box.top >= top
            ? start
            : first(start, end, (at) => coords(at).bottom > top),
        )
        to = Math.max(
          to,
          box.bottom <= bottom
            ? end
            : first(start, end, (at) => coords(at).top >= bottom),
        )
      }
      const margin = Math.max(to - from, 2000)
      return {
        from: Math.max(0, from - margin),
        to: Math.min(view.state.doc.content.size, to + margin),
        visible: { from, to },
        // A visible width on each side keeps short horizontal scrolls covered.
        columns: columns.map(({ pos, from, to }) => {
          const width = Math.max(to - from, 40)
          return { pos, from: Math.max(0, from - width), to: to + width }
        }),
      }
    }
    return [
      new Plugin<HighlightState>({
        key,
        state: {
          init: (_config, state) => {
            const { decorations, blocks } = decorate(
              state.doc,
              DecorationSet.empty,
              null,
              -Infinity,
            )
            return { decorations, blocks, viewport: null, progress: null }
          },
          apply(transaction, value, oldState) {
            const refresh = transaction.getMeta(key) as Refresh | undefined
            if (!transaction.docChanged && !refresh) return value
            const doc = transaction.doc
            let { decorations, viewport, blocks } = value
            let progress = new Map(value.progress ?? [])
            const deadline =
              refresh?.deadline ?? performance.now() + parseBudget
            const update = (
              from: number,
              to: number,
              include?: (node: Node, pos: number) => boolean,
              edit?: Edit,
              resume?: ReadonlyMap<number, number>,
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
                resume,
              )
              decorations = result.decorations
              for (const pos of result.blocks) progress.delete(pos)
              for (const [pos, done] of result.unfinished)
                progress.set(pos, done)
              return result.blocks
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
                    : {
                        from: from.pos,
                        to: to.pos,
                        visible: {
                          from: mapping.map(viewport.visible.from, 1),
                          to: mapping.map(viewport.visible.to, -1),
                        },
                        columns: viewport.columns.flatMap((columns) => {
                          const mapped = mapping.mapResult(columns.pos, 1)
                          return mapped.deleted
                            ? []
                            : [{ ...columns, pos: mapped.pos }]
                        }),
                      }
              }
              progress = new Map(
                [...progress].flatMap(([pos, done]) => {
                  const mapped = mapping.mapResult(pos, 1)
                  return mapped.deleted ? [] : [[mapped.pos, done] as const]
                }),
              )
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
                progress = new Map()
                blocks = update(0, doc.content.size)
              } else {
                decorations = decorations.map(mapping, doc)
                const found = update(
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
            const keys = refresh?.keys
            if (keys)
              update(
                0,
                doc.content.size,
                (node) =>
                  node.type.name === 'codeBlock' &&
                  keys.has(codeLanguageKey(String(node.attrs.language ?? ''))),
              )
            if (refresh && 'viewport' in refresh) {
              const previous = viewport
              viewport = refresh.viewport ?? null
              const resumed = previous === viewport
              // A new range starts every windowed block in the old or new range afresh;
              // the same range resumes blocks that ran out of time.
              const active = resumed ? progress : null
              if (!resumed) progress = new Map()
              for (const pos of blocks) {
                const end = pos + (doc.nodeAt(pos)?.nodeSize ?? 0)
                if (
                  active
                    ? active.has(pos)
                    : [previous, viewport].some(
                        (range) => range && pos < range.to && end > range.from,
                      )
                )
                  update(
                    pos,
                    end,
                    (node) => windowedBlock(node),
                    undefined,
                    active ?? undefined,
                  )
              }
            }
            return {
              decorations,
              viewport,
              blocks,
              progress: progress.size ? progress : null,
            }
          },
        },
        props: { decorations: (state) => key.getState(state)?.decorations },
        view(view) {
          let frame = 0
          let idle = 0
          let measure = true
          let scrolling = false
          let revealing = false
          // Hidden panes keep their layout, so their visibility comes from the style.
          const hidden = () => {
            const box = view.dom.getBoundingClientRect()
            return (
              box.bottom <= box.top ||
              getComputedStyle(view.dom).visibility === 'hidden'
            )
          }
          const reveal = new MutationObserver(() => schedule())
          const run = (budget: number) => {
            const state = key.getState(view.state)
            if (!state) return
            if (hidden()) {
              // Pending work waits for a pane class, style, or attribute change that shows the editor.
              if (!revealing)
                for (
                  let element = view.dom.parentElement;
                  element;
                  element = element.parentElement
                )
                  reveal.observe(element, {
                    attributes: true,
                    attributeFilter: ['class', 'style', 'hidden', 'inert'],
                  })
              revealing = true
              return
            }
            if (revealing) {
              revealing = false
              reveal.disconnect()
            }
            // One budget covers parsing and decoration; unfinished work continues later.
            const deadline = performance.now() + budget
            const refresh: Refresh = { deadline }
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
              let progressed = next !== state.viewport || !!state.progress
              let waiting = !!state.progress
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
              // Parsing or decoration that a transaction left unfinished continues in the next frame.
              schedule()
            },
            destroy() {
              unsubscribe()
              cancelAnimationFrame(frame)
              cancelIdleCallback(idle)
              resize.disconnect()
              reveal.disconnect()
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
