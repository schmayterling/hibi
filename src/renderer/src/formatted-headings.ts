import type { EditorView } from '@codemirror/view'
import type { OutlineHeading } from './OutlineSidebar'
import type { SourceOutline } from './source-outline'
import { editorPosition } from './source-view'
import './formatted-headings.css'

/** Entries and renderer slices, for scale tests. */
export const formattedHeadingWork = {
  created: 0,
  placed: 0,
  pending: 0,
  maximumSliceMs: 0,
  maximumCreated: 0,
}

const batchSize = 512

/** The outline model's id of a heading, which stays while the heading does. */
const modelId = (heading: OutlineHeading) =>
  heading.id.slice(0, heading.id.lastIndexOf(':'))

function entry(heading: OutlineHeading) {
  formattedHeadingWork.created++
  const element = document.createElement('div')
  element.className = 'formatted-heading'
  element.role = 'heading'
  element.ariaLevel = String(heading.level)
  // Activating it moves to the heading; it is no tab stop.
  const link = document.createElement('a')
  link.href = '#'
  link.tabIndex = -1
  link.textContent = heading.label
  element.append(link)
  return element
}

/**
 * Headings outside the drawn editor lines, in document order around the editor.
 * DOM work yields between bounded batches; a newer outline or viewport is
 * reconciled before settling, and unmount cancels all remaining work.
 */
export class FormattedHeadingList {
  private entries: HTMLElement[] = []
  private headings: readonly OutlineHeading[] = []
  private requested: readonly OutlineHeading[] = []
  private ids: string[] = []
  private from = 0
  private to = 0
  private target: readonly [number, number] = [0, 0]
  private measurement: {
    view: EditorView
    outline: SourceOutline
    doc: EditorView['state']['doc']
  } | null = null
  private work: Generator<void> | null = null
  private channel: MessageChannel | null = null
  private pending = false
  private disposed = false
  private readonly events = new AbortController()
  readonly before: HTMLElement
  readonly after: HTMLElement

  constructor(
    before: HTMLElement,
    after: HTMLElement,
    activate: (index: number) => void,
  ) {
    this.before = before
    this.after = after
    const click = (event: MouseEvent) => {
      const element = (event.target as Element).closest('.formatted-heading')
      if (!element) return
      event.preventDefault()
      // Entries from an older outline must never activate a newer heading.
      if (this.headings !== this.requested) return
      const index = this.entries.indexOf(element as HTMLElement)
      if (index >= 0) activate(index)
    }
    before.addEventListener('click', click, { signal: this.events.signal })
    after.addEventListener('click', click, { signal: this.events.signal })
  }

  update(headings: readonly OutlineHeading[]) {
    if (headings === this.requested) return
    this.requested = headings
    this.schedule()
  }

  /** The editor draws headings `from` to `to`, exclusive. */
  show(from: number, to: number) {
    this.measurement = null
    this.target = [from, to]
    this.schedule()
  }

  measure(view: EditorView, outline: SourceOutline) {
    this.measurement = { view, outline, doc: view.state.doc }
    this.schedule()
  }

  private schedule() {
    if (this.disposed || this.pending) return
    this.pending = true
    formattedHeadingWork.pending++
    if (!this.channel) {
      this.channel = new MessageChannel()
      this.channel.port1.onmessage = this.advance
    }
    this.channel.port2.postMessage(null)
  }

  private advance = () => {
    if (this.disposed) return
    const started = performance.now(),
      created = formattedHeadingWork.created
    try {
      this.work ??= this.reconcile()
      // At most four batches (2048 entries), also stopping after two ms.
      for (let steps = 0; steps < 4; steps++) {
        if (this.work.next().done) {
          this.work = null
          this.pending = false
          formattedHeadingWork.pending--
          return
        }
        if (performance.now() - started >= 2) break
      }
      this.channel?.port2.postMessage(null)
    } finally {
      formattedHeadingWork.maximumSliceMs = Math.max(
        formattedHeadingWork.maximumSliceMs,
        performance.now() - started,
      )
      formattedHeadingWork.maximumCreated = Math.max(
        formattedHeadingWork.maximumCreated,
        formattedHeadingWork.created - created,
      )
    }
  }

  private *reconcile(): Generator<void> {
    for (;;) {
      if (this.headings !== this.requested) {
        const next = this.requested
        yield* this.replace(next)
        this.headings = next
        continue
      }
      const measured = this.measurement
      // An edit invalidates source positions until the next outline read.
      if (
        measured &&
        measured.doc === measured.view.state.doc &&
        measured.view.contentDOM.isConnected
      )
        this.target = this.drawn(measured.view, measured.outline)
      const [from, to] = this.target
      if (from === this.from && to === this.to) return
      yield* this.placeDrawn(from, to)
    }
  }

  private *replace(headings: readonly OutlineHeading[]): Generator<void> {
    const ids = headings.map(modelId),
      old = this.ids
    let head = 0,
      tail = 0
    while (head < ids.length && head < old.length && ids[head] === old[head]) {
      head++
      if (head % batchSize === 0) yield
    }
    while (
      tail < ids.length - head &&
      tail < old.length - head &&
      ids[ids.length - 1 - tail] === old[old.length - 1 - tail]
    ) {
      tail++
      if (tail % batchSize === 0) yield
    }
    const oldEnd = old.length - tail,
      newEnd = ids.length - tail
    if (head === oldEnd && head === newEnd) return
    yield* remove(this.entries.slice(head, oldEnd))
    const created: HTMLElement[] = []
    for (const heading of headings.slice(head, newEnd)) {
      created.push(entry(heading))
      if (created.length % batchSize === 0) yield
    }
    if (created.length % batchSize) yield
    this.entries.splice(head, oldEnd - head, ...created)
    this.ids = ids
    const shift = (index: number) =>
      index >= oldEnd ? index + newEnd - oldEnd : Math.min(index, head)
    this.from = shift(this.from)
    this.to = shift(this.to)
    const before = created.slice(0, Math.max(0, this.from - head)),
      after = created.slice(Math.max(0, this.to - head))
    yield* place(
      this.before,
      before,
      head + before.length < this.from
        ? (this.entries[head + before.length] ?? null)
        : null,
    )
    yield* place(
      this.after,
      after,
      newEnd >= this.to ? (this.entries[newEnd] ?? null) : null,
    )
  }

  private *placeDrawn(from: number, to: number): Generator<void> {
    const low = Math.min(from, this.from),
      high = Math.min(this.entries.length, Math.max(to, this.to))
    yield* remove(this.entries.slice(low, high))
    this.from = from
    this.to = to
    yield* place(this.before, this.entries.slice(low, Math.max(low, from)))
    yield* place(
      this.after,
      this.entries.slice(Math.min(high, Math.max(low, to)), high),
      this.after.firstChild,
    )
  }

  private drawn(
    view: EditorView,
    outline: SourceOutline,
  ): readonly [number, number] {
    const count = Math.min(outline.headings.length, this.entries.length),
      doc = view.state.doc
    const index = (pos: number) => {
      let low = 0,
        high = count
      while (low < high) {
        const middle = (low + high) >> 1
        const at = editorPosition(view, outline.position(middle))
        if (at !== null && doc.lineAt(at).from < pos) low = middle + 1
        else high = middle
      }
      return low
    }
    const drawn = view.contentDOM.querySelectorAll(':scope > [role="heading"]'),
      first = drawn[0],
      last = drawn[drawn.length - 1]
    if (!first || !last) {
      const at = index(doc.lineAt(view.visibleRanges[0]?.from ?? 0).from)
      return [at, at]
    }
    return [
      index(view.posAtDOM(first)),
      index(doc.lineAt(view.posAtDOM(last)).to + 1),
    ]
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.channel?.port1.close()
    this.channel?.port2.close()
    this.channel = null
    this.work?.return(undefined)
    this.work = null
    this.measurement = null
    if (this.pending) formattedHeadingWork.pending--
    this.pending = false
    this.events.abort()
    this.before.replaceChildren()
    this.after.replaceChildren()
    this.entries = []
    this.headings = this.requested = []
  }
}

function* remove(elements: readonly HTMLElement[]) {
  let count = 0
  for (const element of elements) {
    element.remove()
    if (++count % batchSize === 0) yield
  }
  if (count % batchSize) yield
}

function* place(
  parent: HTMLElement,
  elements: readonly HTMLElement[],
  anchor: ChildNode | null = null,
) {
  for (let i = 0; i < elements.length; i += batchSize) {
    const batch = elements.slice(i, i + batchSize),
      nodes = document.createDocumentFragment()
    nodes.append(...batch)
    parent.insertBefore(nodes, anchor)
    formattedHeadingWork.placed += batch.length
    yield
  }
}
