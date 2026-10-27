import { StateEffect, StateField, type Text } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin } from '@codemirror/view'
import {
  frontmatterProbe,
  maximumFrontmatterUnits,
} from '../../shared/frontmatter.ts'
import {
  type FrontmatterBounds,
  type FrontmatterRead,
  keepUnclosedFrontmatterRead,
  readSourceFrontmatter,
} from '../../shared/source-frontmatter.ts'
import type { RawEdit } from '../../shared/source-operations.ts'
import { formattedPrefix } from './formatted-contributions.ts'

export { frontmatterProbe }

type Reading = {
  work?: Generator<void, FrontmatterRead> | undefined
  read?: FrontmatterRead
  searched: number
}
type Bounds = {
  open: boolean
  closer: number
  searched: number
  end: number
  prefix: number
  oversized: boolean
  complete: boolean
  read?: FrontmatterRead
}
const readings = new WeakMap<Text, Reading>()

function boundsOf(doc: Text, steps: number, known?: FrontmatterBounds): Bounds {
  let reading = readings.get(doc)
  if (!reading) {
    reading = { searched: 0 }
    readings.set(doc, reading)
    const progress = reading
    reading.work = readSourceFrontmatter(
      {
        utf16Length: doc.length,
        sliceRaw: (from, to) => {
          progress.searched = Math.max(progress.searched, to)
          return doc.sliceString(from, to)
        },
      },
      known,
    )
  }
  for (let step = 0; step < steps && reading.work; step++) {
    const next = reading.work.next()
    if (next.done) {
      reading.read = next.value
      reading.work = undefined
    }
  }
  const read = reading.read
  const closedTo = read?.closedTo ?? 0
  const closer =
    closedTo && doc.sliceString(closedTo - 1, closedTo) === '\n'
      ? closedTo - 1
      : closedTo
  return {
    open: read?.open ?? true,
    closer,
    searched: read?.inspectedTo ?? reading.searched,
    end:
      read?.bounds &&
      (closer === doc.length || doc.sliceString(closer, closer + 1) === '\n')
        ? closer
        : 0,
    prefix: read?.bounds?.contentFrom ?? 0,
    oversized: read?.oversized ?? false,
    complete: !!read,
    ...(read ? { read } : {}),
  }
}

/** standalone consumers share the same bounded read as installed fields. */
export function readFrontmatterBounds(doc: Text) {
  return boundsOf(doc, Number.POSITIVE_INFINITY)
}

export const frontmatterSearch = StateEffect.define<null>()
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
      if (this.idle || this.view.state.field(frontmatterBounds).complete) return
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

/** one cooperative, normalized prefix read serves formatted, source and tag views. */
export const frontmatterBounds = StateField.define<Bounds>({
  create: (state) => boundsOf(state.doc, frontmatterProbe.search / 4096),
  update(value, transaction) {
    const { doc } = transaction.state
    if (transaction.docChanged) {
      const read = value.read
      let reusable = !!read
      let bodyOnly =
        !!read?.bounds &&
        transaction.startState.doc.sliceString(
          read.bounds.headerTo - 1,
          read.bounds.headerTo,
        ) === '\n'
      transaction.changes.iterChangedRanges((from) => {
        if (read?.bounds && from < read.bounds.headerTo) bodyOnly = false
        if (
          read &&
          (from < read.inspectedTo ||
            (read.dependsOnEnd && from === read.inspectedTo))
        )
          reusable = false
      })
      if (reusable && read) {
        readings.set(doc, { read, searched: read.inspectedTo })
        return value
      }
      if (bodyOnly && read?.bounds)
        return boundsOf(doc, Number.POSITIVE_INFINITY, read.bounds)
      if (read && (read.unclosed || read.oversized)) {
        const changes: RawEdit[] = []
        let bounded = true
        transaction.changes.iterChanges((from, to, _fromB, _toB, insert) => {
          if (insert.length > maximumFrontmatterUnits) bounded = false
          else changes.push({ from, to, insert: insert.toString() })
        })
        const kept =
          bounded &&
          keepUnclosedFrontmatterRead(read, changes, {
            utf16Length: doc.length,
            lineCount: doc.lines,
            lineAt: (at) => doc.lineAt(at),
            sliceRaw: (from, to) => doc.sliceString(from, to),
          })
        if (kept) {
          readings.set(doc, { read: kept, searched: kept.inspectedTo })
          return boundsOf(doc, 0)
        }
      }
      return boundsOf(
        doc,
        value.complete
          ? Number.POSITIVE_INFINITY
          : frontmatterProbe.search / 4096,
      )
    }
    return transaction.effects.some((effect) => effect.is(frontmatterSearch))
      ? boundsOf(doc, frontmatterProbe.search / 4096)
      : value
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
