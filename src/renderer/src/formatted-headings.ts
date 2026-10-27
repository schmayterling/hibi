import type { EditorView } from '@codemirror/view'
import type { OutlineHeading } from './OutlineSidebar'
import type { SourceOutline } from './source-outline'
import { editorPosition } from './source-view'
import './formatted-headings.css'

/** Entries created and placed, for scale tests. */
export const formattedHeadingWork = { created: 0, placed: 0 }

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
 * Every heading of a formatted note, for assistive technology. The editor
 * draws the headings in view as headings in its text, which reading it line
 * by line announces; the other headings are entries in visually hidden lists
 * before and after the editor, in document order, so that heading navigation
 * reaches each heading once. Entries change only where the outline changed,
 * and move between the lists only where the editor's headings changed.
 */
export class FormattedHeadingList {
  private entries: HTMLElement[] = []
  private ids: string[] = []
  /** The headings the editor draws, which no entry stands for. */
  private from = 0
  private to = 0
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
      const index = element ? this.entries.indexOf(element as HTMLElement) : -1
      if (index < 0) return
      event.preventDefault()
      activate(index)
    }
    before.addEventListener('click', click)
    after.addEventListener('click', click)
  }

  /** The outline changed: replace the entries of the headings that did. */
  update(headings: readonly OutlineHeading[]) {
    const ids = headings.map(modelId)
    const old = this.ids
    let head = 0,
      tail = 0
    while (head < ids.length && head < old.length && ids[head] === old[head])
      head++
    while (
      tail < ids.length - head &&
      tail < old.length - head &&
      ids[ids.length - 1 - tail] === old[old.length - 1 - tail]
    )
      tail++
    const oldEnd = old.length - tail,
      newEnd = ids.length - tail
    if (head === oldEnd && head === newEnd) return
    for (const element of this.entries.slice(head, oldEnd)) element.remove()
    const created = headings.slice(head, newEnd).map(entry)
    this.entries.splice(head, oldEnd - head, ...created)
    this.ids = ids
    // The editor's headings keep their place past the change until it
    // reports them again.
    const shift = (index: number) =>
      index >= oldEnd ? index + newEnd - oldEnd : Math.min(index, head)
    this.from = shift(this.from)
    this.to = shift(this.to)
    const before = created.slice(0, Math.max(0, this.from - head))
    const after = created.slice(Math.max(0, this.to - head))
    this.before.insertBefore(
      fragment(before),
      head + before.length < this.from
        ? (this.entries[head + before.length] ?? null)
        : null,
    )
    this.after.insertBefore(
      fragment(after),
      newEnd >= this.to ? (this.entries[newEnd] ?? null) : null,
    )
    formattedHeadingWork.placed += before.length + after.length
  }

  /** The editor draws headings `from` to `to`, exclusive. */
  show(from: number, to: number) {
    if (from === this.from && to === this.to) return
    const low = Math.min(from, this.from),
      high = Math.min(this.entries.length, Math.max(to, this.to))
    // Entries from `low` end the list before and start the one after.
    for (const element of this.entries.slice(low, high)) element.remove()
    this.from = from
    this.to = to
    const before = this.entries.slice(low, Math.max(low, from)),
      after = this.entries.slice(Math.min(high, Math.max(low, to)), high)
    this.before.append(fragment(before))
    this.after.prepend(fragment(after))
    formattedHeadingWork.placed += before.length + after.length
  }

  /** Which headings the editor draws, from its heading elements. */
  measure(view: EditorView, outline: SourceOutline) {
    const count = Math.min(outline.headings.length, this.entries.length)
    const doc = view.state.doc
    // The first heading whose line starts at or after `pos`.
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
    const drawn = view.contentDOM.querySelectorAll(':scope > [role="heading"]')
    const first = drawn[0],
      last = drawn[drawn.length - 1]
    if (!first || !last) {
      const at = index(doc.lineAt(view.visibleRanges[0]?.from ?? 0).from)
      this.show(at, at)
    } else
      this.show(
        index(view.posAtDOM(first)),
        index(doc.lineAt(view.posAtDOM(last)).to + 1),
      )
  }
}

function fragment(elements: readonly HTMLElement[]) {
  const nodes = document.createDocumentFragment()
  nodes.append(...elements)
  return nodes
}
