import { StateEffect, StateField, type Text } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin } from '@codemirror/view'
import { readFrontmatter } from '../../shared/frontmatter.ts'
import { formattedPrefix } from './formatted-contributions.ts'

/** The first line, after a byte order mark the source keeps. */
const opening = /^﻿?---[ \t]*$/
const closing = /^(?:---|\.\.\.)[ \t]*$/

/** Lines read, YAML parses and the characters one search reads, for scale tests. */
export const frontmatterProbe = { lines: 0, parses: 0, search: 1 << 16 }

/**
 * Search about `size` characters of lines from line start `from` for a
 * closing line: its end, or 0 and the end of the last line read.
 */
function search(doc: Text, from: number, size: number) {
  let at = from
  for (
    const iter = doc.iterLines(doc.lineAt(from).number);
    !iter.next().done;
  ) {
    frontmatterProbe.lines++
    const end = at + iter.value.length
    if (closing.test(iter.value)) return { closer: end, searched: end }
    at = end + 1
    if (at - from >= size) return { closer: 0, searched: end }
  }
  return { closer: 0, searched: doc.length }
}

/** The closing line's end when the lines before it are frontmatter as the properties read it: a metadata mapping. */
function recognized(doc: Text, closer: number) {
  if (!closer) return 0
  frontmatterProbe.parses++
  return readFrontmatter(doc.sliceString(0, closer)) ? closer : 0
}

type Bounds = {
  /** Line 1 opens frontmatter. */
  open: boolean
  /** The end of the first closing line after the opening one, or 0. */
  closer: number
  /** Without a closing line, lines are read up to this one's end. */
  searched: number
  /** Where frontmatter ends: the closing line's end when it closes a metadata mapping, else 0. */
  end: number
}

const none: Bounds = { open: false, closer: 0, searched: 0, end: 0 }

function boundsOf(doc: Text): Bounds {
  if (doc.lines < 2 || !opening.test(doc.line(1).text)) return none
  const { closer, searched } = search(
    doc,
    doc.line(2).from,
    frontmatterProbe.search,
  )
  return { open: true, closer, searched, end: recognized(doc, closer) }
}

/** Reads on for a closing line; views dispatch it in idle time. */
export const frontmatterSearch = StateEffect.define<null>()

/** Searches the rest of a long note for a closing line in idle slices. */
const searcher = ViewPlugin.fromClass(
  class {
    private idle = 0
    private readonly view: EditorView
    constructor(view: EditorView) {
      this.view = view
      this.schedule()
    }
    update() {
      this.schedule()
    }
    schedule() {
      const { open, closer, searched } =
        this.view.state.field(frontmatterBounds)
      if (
        this.idle ||
        !open ||
        closer ||
        searched >= this.view.state.doc.length
      )
        return
      this.idle = requestIdleCallback(() => {
        this.idle = 0
        this.view.dispatch({ effects: frontmatterSearch.of(null) })
      })
    }
    destroy() {
      if (this.idle) cancelIdleCallback(this.idle)
    }
  },
)

/**
 * The end of the first closing line after an opening one, and where
 * frontmatter ends: there when the lines between are a metadata mapping,
 * else 0. Opening a note and each idle slice read about one search's worth
 * of lines, so a divider at the top of a long note never reads it all at
 * once. Edits after the closing line keep both; without one, only edited
 * lines that were read can close it.
 */
export const frontmatterBounds = StateField.define<Bounds>({
  create: (state) => boundsOf(state.doc),
  update(value, transaction) {
    const { doc } = transaction.state
    let next = value
    if (transaction.docChanged) {
      if (doc.lines < 2 || !opening.test(doc.line(1).text)) return none
      let first = Number.POSITIVE_INFINITY
      transaction.changes.iterChangedRanges((_fromA, _toA, from) => {
        first = Math.min(first, from)
      })
      if (value.closer && first > value.closer) {
        const closer = transaction.changes.mapPos(value.closer)
        next = { ...value, closer, searched: closer, end: value.end && closer }
      } else if (!value.open || first <= doc.line(1).to)
        // An edit to the opening line may open or end frontmatter.
        next = boundsOf(doc)
      else if (value.closer) {
        // The lines before an edit hold no closing line, so the old one
        // holds unless an edit reaches it or an edited line closes earlier.
        const old = transaction.startState.doc.lineAt(value.closer)
        let reached = false
        transaction.changes.iterChangedRanges((fromA, toA) => {
          if (toA >= old.from && fromA <= old.to) reached = true
        })
        if (reached) {
          const found = search(
            doc,
            doc.lineAt(first).from,
            frontmatterProbe.search,
          )
          next = { open: true, ...found, end: recognized(doc, found.closer) }
        } else {
          let closer = transaction.changes.mapPos(value.closer)
          transaction.changes.iterChangedRanges((_fromA, _toA, from, to) => {
            const stop = doc.lineAt(to).number
            for (
              let number = Math.max(2, doc.lineAt(from).number);
              number <= stop;
              number++
            ) {
              frontmatterProbe.lines++
              const line = doc.line(number)
              if (closing.test(line.text)) {
                closer = Math.min(closer, line.to)
                break
              }
            }
          })
          next = {
            open: true,
            closer,
            searched: closer,
            end: recognized(doc, closer),
          }
        }
      } else {
        const searched = transaction.changes.mapPos(value.searched, -1)
        let closer = 0
        transaction.changes.iterChangedRanges((_fromA, _toA, from, to) => {
          if (from > searched) return
          const stop = doc.lineAt(Math.min(to, searched)).number
          for (
            let number = Math.max(2, doc.lineAt(from).number);
            number <= stop;
            number++
          ) {
            frontmatterProbe.lines++
            const line = doc.line(number)
            if (closing.test(line.text)) {
              if (!closer || line.to < closer) closer = line.to
              break
            }
          }
        })
        next = {
          open: true,
          closer,
          searched: closer || searched,
          end: recognized(doc, closer),
        }
      }
    }
    if (
      next.open &&
      !next.closer &&
      next.searched < doc.length &&
      transaction.effects.some((effect) => effect.is(frontmatterSearch))
    ) {
      const { closer, searched } = search(
        doc,
        next.searched + 1,
        frontmatterProbe.search,
      )
      next = { open: true, closer, searched, end: recognized(doc, closer) }
    }
    return next
  },
  provide: () => searcher,
})

const hidden = Decoration.replace({ block: true })

/**
 * With a properties editor above the formatted view, frontmatter is one node
 * there, not Markdown, and its lines collapse.
 */
export const formattedFrontmatter = [
  frontmatterBounds,
  formattedPrefix.of((state) => state.field(frontmatterBounds).end),
  EditorView.decorations.compute([frontmatterBounds], (state) => {
    const { end } = state.field(frontmatterBounds)
    return end ? Decoration.set(hidden.range(0, end)) : Decoration.none
  }),
  EditorView.atomicRanges.of((view) => {
    const { end } = view.state.field(frontmatterBounds)
    return end
      ? Decoration.set(
          hidden.range(0, Math.min(view.state.doc.length, end + 1)),
        )
      : Decoration.none
  }),
]
