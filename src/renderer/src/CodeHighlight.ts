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
/** Milliseconds of windowed work per frame; idle periods add more. */
const parseBudget = 4
/** Characters decorated together, so the budget can stop between pieces. */
const pieceLength = 2_000
/** Lines up to this length are decorated whole instead of measured. */
const shortLine = 256

type Range = { from: number; to: number }
type Viewport = Range & {
  /** First position on screen, where decorating starts. */
  visible: number
}
type Block = {
  pos: number
  /** Kept while mapping keeps the block; moved or restored blocks get a new one. */
  id: object
}
type HighlightState = {
  decorations: DecorationSet
  /** Document range within about a screen of the visible text that windowed blocks decorate. */
  viewport: Viewport | null
  /** Windowed blocks, in document order. */
  blocks: readonly Block[]
}
/** Replaces the tokens in `from`..`to`. */
type Patch = Range & { tokens: Decoration[] }
type Refresh = {
  keys?: ReadonlySet<string>
  viewport?: Viewport | null
  patches?: readonly Patch[]
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
/** Decoration of one version of a windowed block for one range, planned line by line. */
type Work = {
  block: Parsed
  text: string
  /** Block offsets of the range. */
  from: number
  to: number
  /** Horizontal pixels around the line starts that clipped lines cover, or null when lines are whole. */
  window: Range | null
  /** Offsets still to plan, visible lines and those below first; `line` starts the next line in the first. */
  plan: Range[]
  line: number
  /** Columns of the last measured line, checked first for the next one. */
  guess: Range | null
  pieces: Range[]
  done: number
  clean: boolean
  /** Measured columns by line text for this window, passed to the block's next work; `used` marks this plan's lines. */
  lines: Map<string, Range>
  used: Set<string>
}

const windowedBlock = (node: Node) =>
  node.type.name === 'codeBlock' && node.content.size > windowedLength

/** Smallest index in `start`..`end` where `after` holds, assuming it holds from some index on. */
function first(start: number, end: number, after: (index: number) => boolean) {
  while (start < end) {
    const middle = (start + end) >> 1
    if (after(middle)) end = middle
    else start = middle + 1
  }
  return start
}

/** Offset of the line containing `at`. */
const lineStart = (text: string, at: number) =>
  at && text.lastIndexOf('\n', at - 1) + 1

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
    /** Parses up to `to` while `spend` allows; unfinished work resumes later. */
    function parseTo(
      block: Parsed,
      node: Node,
      to: number,
      spend: () => boolean,
    ) {
      try {
        while (block.parsedTo < to) {
          if (!spend()) return false
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
    /** Short blocks highlight here; windowed blocks keep tokens of their parser for the view to replace. */
    function decorate(
      doc: Node,
      previous: DecorationSet,
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
        if (windowedBlock(node)) {
          blocks.push(pos)
          if (language) parsedBlock(node, pos, language, edit)
          previous = previous.remove(
            existing.filter((token) => token.spec.language !== language),
          )
          return false
        }
        previous = previous.remove(existing)
        let result = highlighted.get(node)
        if (result?.language !== language) {
          result = { language, spans: highlightCode(node.textContent, info) }
          highlighted.set(node, result)
        }
        const spec = { language }
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
      })
      return { decorations: previous.add(doc, decorations), blocks }
    }
    /** Pixels of `view` not clipped by scrolling panes or the window. */
    function clipped(view: EditorView) {
      let { top, bottom, left, right } = view.dom.getBoundingClientRect()
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
      return {
        top: Math.max(top, 0),
        bottom: Math.min(bottom, window.innerHeight),
        left: Math.max(left, 0),
        right: Math.min(right, window.innerWidth),
      }
    }
    /** Text of windowed blocks within a screen above and below the visible text. */
    function measureViewport(
      view: EditorView,
      current: Viewport | null,
      blocks: readonly Block[],
    ): Viewport | null {
      const { top, bottom, left, right } = clipped(view)
      const height = bottom - top
      const near = blocks.flatMap(({ pos }) => {
        const node = view.state.doc.nodeAt(pos)
        const box = (
          view.nodeDOM(pos) as HTMLElement | null
        )?.getBoundingClientRect()
        return node &&
          box &&
          box.top < bottom + height &&
          box.bottom > top - height &&
          box.left < right &&
          box.right > left
          ? [{ start: pos + 1, end: pos + 1 + node.content.size, box }]
          : []
      })
      if (!near.length) return null
      const shown = near.filter(
        ({ box }) => box.top < bottom && box.bottom > top,
      )
      // Line geometry ignores horizontal scrolling and overlapping elements, unlike hit-testing.
      const coords = (at: number) => view.coordsAtPos(at)
      if (
        current &&
        shown.length &&
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
        )
      )
        return current
      let from = Number.POSITIVE_INFINITY
      let to = Number.NEGATIVE_INFINITY
      let visible = Number.POSITIVE_INFINITY
      for (const { start, end, box } of near) {
        // The first position on a line ending below `y`, or starting at or below it.
        const ending = (y: number, highest = end) =>
          box.top >= y
            ? start
            : first(start, highest, (at) => coords(at).bottom > y)
        const starting = (y: number, lowest = start) =>
          box.bottom <= y
            ? end
            : first(lowest, end, (at) => coords(at).top >= y)
        const onScreen =
          box.top < bottom && box.bottom > top ? ending(top) : null
        if (onScreen !== null) visible = Math.min(visible, onScreen)
        from = Math.min(from, ending(top - height, onScreen ?? end))
        to = Math.max(to, starting(bottom + height, onScreen ?? start))
      }
      return { from, to, visible: Number.isFinite(visible) ? visible : from }
    }
    return [
      new Plugin<HighlightState>({
        key,
        state: {
          init: (_config, state) => {
            const { decorations, blocks } = decorate(
              state.doc,
              DecorationSet.empty,
            )
            return {
              decorations,
              viewport: null,
              blocks: blocks.map((pos) => ({ pos, id: {} })),
            }
          },
          apply(transaction, value, oldState) {
            const refresh = transaction.getMeta(key) as Refresh | undefined
            if (!transaction.docChanged && !refresh) return value
            const doc = transaction.doc
            let { decorations, viewport, blocks } = value
            const update = (
              from: number,
              to: number,
              include?: (node: Node) => boolean,
              edit?: Edit,
            ) => {
              const result = decorate(doc, decorations, from, to, include, edit)
              decorations = result.decorations
              return result.blocks
            }
            if (transaction.docChanged) {
              const { mapping } = transaction
              decorations = decorations.map(mapping, doc)
              if (viewport) {
                // Text typed at either end joins the range; replaced content clears it until the view measures again.
                const from = mapping.mapResult(viewport.from, -1)
                const to = mapping.mapResult(viewport.to, 1)
                viewport =
                  from.deletedAfter || to.deletedBefore || from.pos >= to.pos
                    ? null
                    : {
                        from: from.pos,
                        to: to.pos,
                        visible: mapping.map(viewport.visible),
                      }
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
              // Mapped blocks stay the same; moved or restored ones lost their tokens and start over.
              const kept = new Map<number, object>()
              for (const { pos, id } of blocks) {
                const mapped = mapping.mapResult(pos, 1)
                const node = mapped.deleted ? null : doc.nodeAt(mapped.pos)
                if (node && windowedBlock(node)) kept.set(mapped.pos, id)
              }
              const found = full
                ? update(0, doc.content.size)
                : update(
                    Math.max(0, from - 1),
                    Math.min(doc.content.size, Math.max(from, end) + 1),
                    undefined,
                    { doc: oldState.doc, from, end },
                  )
              // Blocks outside the edit keep their mapped positions.
              blocks = [...new Set([...(full ? [] : kept.keys()), ...found])]
                .sort((a, b) => a - b)
                .map((pos) => ({ pos, id: kept.get(pos) ?? {} }))
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
            if (refresh && 'viewport' in refresh)
              viewport = refresh.viewport ?? null
            if (refresh?.patches) {
              const removed: Decoration[] = []
              const added: Decoration[] = []
              for (const { from, to, tokens } of refresh.patches) {
                for (const token of decorations.find(from, to))
                  if (token.from < to && token.to > from) removed.push(token)
                added.push(...tokens)
              }
              decorations = decorations.remove(removed).add(doc, added)
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
          let revealing = false
          const works = new Map<object, Work>()
          const drop = (id: object) => {
            works.get(id)?.lines.clear()
            works.delete(id)
          }
          // Hidden panes keep their layout, so their visibility comes from the style.
          const hidden = () => {
            const box = view.dom.getBoundingClientRect()
            return (
              box.bottom <= box.top ||
              getComputedStyle(view.dom).visibility === 'hidden'
            )
          }
          /**
           * Adds the next line of `work` to its pieces: whole, or for unwrapped
           * long lines the characters inside the window, found on the line's
           * own geometry so tabs and wide characters count. Returns false when
           * that measurement has to wait for more time.
           */
          function plan(work: Work, start: number, spend: () => boolean) {
            const range = work.plan[0]
            if (!range) return false
            const { text, line, window } = work
            const newline = text.indexOf('\n', line)
            const end = newline < 0 ? text.length : newline
            let columns: Range = { from: 0, to: end - line }
            if (window && end - line > shortLine) {
              const content = text.slice(line, end)
              const known = work.lines.get(content)
              if (!known && !spend()) return false
              columns =
                known ?? clip(start + line, end - line, window, work.guess)
              work.lines.set(content, columns)
              work.used.add(content)
              work.guess = columns
            }
            const from = Math.max(range.from, line + columns.from)
            const to = Math.min(range.to, line + columns.to)
            const last = work.pieces.at(-1)
            // Neighbouring lines share a piece, up to its length.
            if (
              last &&
              last.to <= from &&
              from <= last.to + 1 &&
              from < to &&
              to - last.from <= pieceLength
            )
              last.to = to
            else
              for (let at = from; at < to; at += pieceLength)
                work.pieces.push({
                  from: at,
                  to: Math.min(to, at + pieceLength),
                })
            if (newline >= 0 && newline + 1 < range.to) work.line = newline + 1
            else {
              work.plan.shift()
              const next = work.plan[0]
              if (next) work.line = lineStart(text, next.from)
              else {
                // Measurements of lines that left the range go with them.
                for (const content of work.lines.keys())
                  if (!work.used.has(content)) work.lines.delete(content)
                work.used.clear()
              }
            }
            return true
          }
          /**
           * Characters of the line at `line` whose boxes meet `range`
           * (pixels from the line start), from binary searches over the
           * line's caret positions. A neighbouring line's answer is checked first.
           */
          function clip(
            line: number,
            length: number,
            range: Range,
            guess: Range | null,
          ): Range {
            const origin = view.coordsAtPos(line).left
            const x = (offset: number) =>
              view.coordsAtPos(line + offset, offset < length ? 1 : -1).left -
              origin
            if (x(length) <= range.from) return { from: length, to: length }
            if (
              guess &&
              guess.from < length &&
              (!guess.from || x(guess.from) <= range.from) &&
              (guess.to >= length || x(guess.to) >= range.to)
            )
              return { from: guess.from, to: Math.min(guess.to, length) }
            const from = Math.max(
              0,
              first(0, length, (offset) => x(offset) > range.from) - 1,
            )
            return {
              from,
              to: first(from, length, (offset) => x(offset) >= range.to),
            }
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
            const refresh: Refresh = {}
            const patches: Patch[] = []
            if (changed.size) {
              const keys = new Set(changed)
              refresh.keys = keys
              changed.clear()
              // The refresh drops tokens of another parser, so their work starts over.
              for (const { pos, id } of state.blocks) {
                const node = view.state.doc.nodeAt(pos)
                if (
                  node &&
                  keys.has(codeLanguageKey(String(node.attrs.language ?? '')))
                )
                  drop(id)
              }
            }
            if (state.blocks.length) {
              // One budget covers measuring, parsing, and decorating every block.
              // The first item of a frame always runs, so work keeps progressing.
              const deadline = performance.now() + budget
              let free = true
              const spend = () => {
                const late = performance.now() >= deadline
                if (late && !free) return false
                free = false
                return true
              }
              const remeasure = measure
              let next = state.viewport
              if (measure) {
                measure = false
                free = false
                next = measureViewport(view, next, state.blocks)
              }
              if (next !== state.viewport) {
                refresh.viewport = next
                // Blocks leaving the range drop their tokens and their work.
                for (const { pos, id } of state.blocks) {
                  const node = view.state.doc.nodeAt(pos)
                  if (!node) continue
                  const end = pos + node.nodeSize
                  const inside = (range: Range | null) =>
                    !!range && pos < range.to && end > range.from
                  if (inside(state.viewport) && !inside(next)) {
                    patches.push({ from: pos + 1, to: end - 1, tokens: [] })
                    drop(id)
                  }
                }
              }
              let waiting = false
              let area: ReturnType<typeof clipped> | null = null
              for (const { pos, id } of next ? state.blocks : []) {
                const node = view.state.doc.nodeAt(pos)
                const language =
                  node &&
                  codeLanguages.resolve(String(node.attrs.language ?? ''))
                const block = node && parsed.get(node)
                if (!node || !next || !block || block.language !== language)
                  continue
                const start = pos + 1
                const size = node.content.size
                const from = Math.max(next.from, start) - start
                const to = Math.min(next.to, start + size) - start
                if (from >= to) continue
                if (!parseTo(block, node, to, spend)) {
                  waiting = true
                  continue
                }
                const tree = block.tree
                if (!tree) continue
                let work = works.get(id)
                const element = view.nodeDOM(pos) as HTMLElement | null
                let window: Range | null = work?.window ?? null
                if (!work || remeasure) {
                  // Unwrapped lines clip to the columns near the visible ones; wrapped rows were found vertically.
                  const text = element?.firstElementChild ?? element
                  const wraps =
                    !text ||
                    !/^(?:pre|nowrap)$/.test(getComputedStyle(text).whiteSpace)
                  window = null
                  if (!wraps && element) {
                    area ??= clipped(view)
                    const clip = area
                    const box = element.getBoundingClientRect()
                    const origin = view.coordsAtPos(start).left
                    const left = Math.max(clip.left, box.left) - origin
                    const right = Math.min(clip.right, box.right) - origin
                    const width = Math.max(right - left, 0)
                    const covered =
                      work?.window &&
                      work.window.from <= left &&
                      right <= work.window.to
                    window = covered
                      ? (work?.window ?? null)
                      : { from: left - width, to: right + width }
                  }
                }
                if (
                  !work ||
                  work.block !== block ||
                  work.from !== from ||
                  work.to !== to ||
                  work.window !== window
                ) {
                  const text = node.textContent
                  // Visible lines go first, then those below and above them.
                  const visible = next.visible - start
                  const split =
                    visible > from && visible < to
                      ? Math.max(from, lineStart(text, visible))
                      : from
                  // Measured columns hold while the window does.
                  const lines =
                    work && work.window === window ? work.lines : new Map()
                  if (work && work.lines !== lines) work.lines.clear()
                  work = {
                    block,
                    text,
                    from,
                    to,
                    window,
                    plan:
                      split > from
                        ? [
                            { from: split, to },
                            { from, to: split },
                          ]
                        : [{ from, to }],
                    line: lineStart(text, split),
                    guess: null,
                    pieces: [],
                    done: 0,
                    clean: false,
                    lines,
                    used: new Set(),
                  }
                  works.set(id, work)
                }
                const spec = { language }
                for (;;) {
                  // The last piece can still grow while lines remain.
                  if (
                    work.done >=
                    work.pieces.length - (work.plan.length ? 1 : 0)
                  ) {
                    if (work.plan.length && plan(work, start, spend)) continue
                    break
                  }
                  if (!spend()) break
                  const piece = work.pieces[work.done++]
                  if (!piece) break
                  patches.push({
                    from: start + piece.from,
                    to: start + piece.to,
                    tokens: codeSpans(tree, piece.from, piece.to).map((span) =>
                      Decoration.inline(
                        start + span.from,
                        start + span.to,
                        { class: span.classes },
                        spec,
                      ),
                    ),
                  })
                }
                if (work.plan.length || work.done < work.pieces.length)
                  waiting = true
                else if (!work.clean) {
                  // Once the range is complete, tokens left from earlier ranges or versions go.
                  work.clean = true
                  let at = 0
                  for (const piece of [...work.pieces].sort(
                    (a, b) => a.from - b.from,
                  )) {
                    if (at < piece.from)
                      patches.push({
                        from: start + at,
                        to: start + piece.from,
                        tokens: [],
                      })
                    at = Math.max(at, piece.to)
                  }
                  if (at < size)
                    patches.push({
                      from: start + at,
                      to: start + size,
                      tokens: [],
                    })
                }
              }
              if (patches.length) refresh.patches = patches
              // Frames keep progress steady while busy; idle periods finish sooner.
              if (waiting) {
                schedule()
                idle ||= requestIdleCallback((deadline) => {
                  idle = 0
                  run(deadline.timeRemaining())
                })
              }
            }
            if (refresh.keys || refresh.patches || 'viewport' in refresh)
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
              if (!state || state === before) return
              // Work of blocks that left, moved, or came back goes with its measurements.
              const live = new Set(state.blocks.map(({ id }) => id))
              for (const id of works.keys()) if (!live.has(id)) drop(id)
              if (!state.blocks.length) return
              // Blocks that became long, moved, or left change what the range must cover.
              if (
                before?.blocks.length !== state.blocks.length ||
                before.blocks.some(({ id }) => !live.has(id)) ||
                (before.viewport && !state.viewport)
              )
                measure = true
              // Edits and unfinished work continue in the next frame.
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
