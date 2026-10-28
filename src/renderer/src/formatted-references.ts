import {
  type EditorState,
  Facet,
  StateEffect,
  StateField,
  type Text,
} from '@codemirror/state'
import { type EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { formattedReferenceLink } from '../../shared/formatted-text-rules.ts'
import {
  formattedOwner,
  formattedRefresh,
  formattedRenderInputs,
} from './formatted-contributions.ts'
import type { SourceReferenceResult } from './source-view.ts'

/*
 * Reference links, `[text][label]`, `[label][]` and `[label]`, render as
 * links when the note defines their label. The host's reference service
 * answers for one label at a time; the view asks about the labels it draws
 * in its viewport, once per edit, and keeps drawing the last answers until
 * new ones arrive. Answers are a cache of the labels drawn most recently.
 */

/** Asks the note's definitions about a label; its host provides it. */
export type FormattedReferenceResolver = {
  /** Changes when labels may resolve differently, as with other syntax. */
  readonly syntax: () => string
  readonly resolve: (
    label: string,
    signal: AbortSignal,
  ) => Promise<SourceReferenceResult>
}
export const formattedReferences = Facet.define<
  FormattedReferenceResolver,
  FormattedReferenceResolver | null
>({ combine: (values) => values.at(-1) ?? null })

/** Work counters for scale tests. */
export const referenceWork = {
  requested: 0,
  resolved: 0,
  /** Answers stored because they changed. */
  stored: 0,
  /** Lookups dropped because their labels left the viewport. */
  aborted: 0,
}

/** Labels in flight at once, so the shared reference queue stays open to others. */
const inFlight = 32
/** Labels whose answers are kept: those drawn most recently, well past a viewport's. */
export const retainedLabels = 1024

/** A defined label's title, or null for one the note does not define. */
export type ReferenceAnswer = { readonly title: string | null } | null
type Entry = {
  answer: ReferenceAnswer | undefined
  checked: number
  definitive: boolean
}

/** The answers of one view, shared by its states as a cache rather than document state. */
class Answers {
  /** Per label, least recently drawn first. */
  readonly entries = new Map<string, Entry>()
  /** Drawn since the view last asked. */
  readonly drawn = new Set<string>()
  /**
   * Drawn in table cells, which draw again only when answers change, with
   * where each such cell is, so a label whose cells all scrolled away stops
   * asking.
   */
  readonly cells = new Map<string, Set<number>>()
}
const answered = StateEffect.define<null>()

const labels = StateField.define<{ readonly answers: Answers }>({
  create: () => ({ answers: new Answers() }),
  update(value, transaction) {
    // A note replaced whole starts over.
    if (transaction.docChanged) {
      let whole = false
      transaction.changes.iterChangedRanges((from, to) => {
        whole ||= from === 0 && to === transaction.startState.doc.length
      })
      if (whole) return { answers: new Answers() }
      for (const entry of value.answers.entries.values())
        entry.definitive = false
    }
    for (const effect of transaction.effects)
      if (effect.is(answered)) return { answers: value.answers }
    return value
  },
  // Cached layouts and table cells draw again when answers change.
  provide: (field) =>
    formattedRenderInputs.compute([field], (state) => state.field(field)),
})

const answersOf = (state: EditorState) =>
  // A table cell's own state reads the field of the view that draws it.
  (
    state.field(labels, false) ??
    state.facet(formattedOwner)?.field(labels, false)
  )?.answers

/**
 * The parts of a `Link` node written as a reference, or null for an inline
 * link. `end` is where its label ends: after `]` of a shortcut reference.
 */
export function referenceLink(doc: Text, node: SyntaxNode) {
  return formattedReferenceLink(node, (from, to) => doc.sliceString(from, to))
}

/**
 * The answer about a reference link drawn in the viewport, undefined until
 * one arrives. Drawing a label asks about it after each edit.
 */
export function drawReference(
  state: EditorState,
  label: string,
  cell?: number,
): ReferenceAnswer | undefined {
  const answers = answersOf(state)
  if (!answers) return undefined
  const { entries } = answers
  let entry = entries.get(label)
  if (entry) entries.delete(label)
  else entry = { answer: undefined, checked: -1, definitive: false }
  entries.set(label, entry)
  for (const oldest of entries.keys()) {
    if (entries.size <= retainedLabels) break
    entries.delete(oldest)
    answers.cells.delete(oldest)
  }
  answers.drawn.add(label)
  if (cell !== undefined) {
    const cells = answers.cells.get(label)
    if (cells) cells.add(cell)
    else answers.cells.set(label, new Set([cell]))
  }
  return entry.answer
}

/** A host answer, without asking; unavailable or never-requested labels stay unknown. */
export const knownReference = (state: EditorState, label: string) => {
  const entry = answersOf(state)?.entries.get(label)
  return entry?.definitive ? entry.answer : undefined
}

/** Labels kept for a view, for scale tests. */
export const retainedReferences = (state: EditorState) =>
  answersOf(state)?.entries.size ?? 0

const sameAnswer = (a: ReferenceAnswer | undefined, b: ReferenceAnswer) =>
  a === b || (!!a && !!b && a.title === b.title)

/** Asks about drawn labels: new ones before the next frame, others after each edit in idle time. */
const requests = ViewPlugin.fromClass(
  class {
    private generation = 0
    private readonly pending = new Map<string, AbortController>()
    private changed = false
    private scrolled = false
    private syntax: string | null
    private idle = 0
    private queued = false
    private destroyed = false
    private readonly view: EditorView
    constructor(view: EditorView) {
      this.view = view
      this.syntax = view.state.facet(formattedReferences)?.syntax() ?? null
      this.later()
    }
    update(update: ViewUpdate) {
      const syntax = update.state.facet(formattedReferences)?.syntax() ?? null
      const { answers } = update.state.field(labels)
      if (
        syntax !== this.syntax ||
        answers !== update.startState.field(labels).answers
      ) {
        this.abort(() => true)
        this.generation++
        if (syntax !== this.syntax) {
          this.syntax = syntax
          answers.entries.clear()
          answers.cells.clear()
          queueMicrotask(() => {
            if (!this.destroyed)
              this.view.dispatch({
                effects: [answered.of(null), formattedRefresh.of(null)],
              })
          })
        }
      } else if (update.docChanged) {
        this.generation++
        for (const [label, cells] of answers.cells)
          answers.cells.set(
            label,
            new Set([...cells].map((at) => update.changes.mapPos(at))),
          )
      } else if (update.viewportChanged) this.scrolled = true
      this.later()
    }
    /** Look at drawn labels once this update and the cells it draws are done. */
    later() {
      if (this.queued) return
      this.queued = true
      queueMicrotask(() => {
        this.queued = false
        if (!this.destroyed) this.schedule()
      })
    }
    abort(drop: (label: string) => boolean) {
      for (const [label, controller] of this.pending)
        if (drop(label)) {
          controller.abort()
          this.pending.delete(label)
          referenceWork.aborted++
        }
    }
    /** Ask now when a drawn label was never answered, otherwise when idle. */
    schedule() {
      const { drawn, cells, entries } = this.view.state.field(labels).answers
      // Lookups for labels scrolled away make room for those in view.
      if (this.scrolled) {
        this.scrolled = false
        const { from, to } = this.view.viewport
        for (const [label, places] of cells) {
          for (const at of places) if (at < from || at > to) places.delete(at)
          if (!places.size) cells.delete(label)
        }
        this.abort((label) => !drawn.has(label) && !cells.has(label))
      }
      this.flush()
      if (!drawn.size) return
      let unknown = false
      for (const label of drawn) {
        const entry = entries.get(label)
        if (
          entry?.answer === undefined &&
          entry?.checked !== this.generation &&
          !this.pending.has(label)
        )
          unknown = true
      }
      if (unknown) this.ask()
      else if (!this.idle)
        this.idle = requestIdleCallback(() => {
          this.idle = 0
          if (!this.destroyed) this.ask()
        })
    }
    ask() {
      const resolver = this.view.state.facet(formattedReferences)
      const { drawn, entries } = this.view.state.field(labels).answers
      if (!resolver) {
        drawn.clear()
        return
      }
      for (const label of drawn) {
        if (this.pending.size >= inFlight) return
        drawn.delete(label)
        const entry = entries.get(label)
        if (
          entry &&
          !this.pending.has(label) &&
          entry.checked !== this.generation
        )
          this.request(resolver, label)
      }
    }
    request(resolver: FormattedReferenceResolver, label: string) {
      const generation = this.generation,
        controller = new AbortController()
      this.pending.set(label, controller)
      referenceWork.requested++
      void resolver.resolve(label, controller.signal).then(
        (result) => this.settle(label, generation, controller, result),
        () =>
          this.settle(label, generation, controller, { status: 'unavailable' }),
      )
    }
    settle(
      label: string,
      generation: number,
      controller: AbortController,
      result: SourceReferenceResult,
    ) {
      if (this.destroyed || controller.signal.aborted) return
      this.pending.delete(label)
      const answers = this.view.state.field(labels).answers
      const entry = answers.entries.get(label)
      if (entry) {
        // A stale answer is asked for again after the next edit, as is any
        // answer to an earlier text, which shows until then.
        entry.checked = generation
        if (generation !== this.generation) answers.drawn.add(label)
        if (result.status !== 'stale') {
          entry.definitive =
            result.status === 'resolved' && generation === this.generation
          referenceWork.resolved++
          const answer =
            result.status === 'resolved' && result.value
              ? { title: result.value.title ?? null }
              : null
          if (!sameAnswer(entry.answer, answer)) {
            entry.answer = answer
            referenceWork.stored++
            this.changed = true
          }
        }
      }
      if (this.pending.size) return
      this.schedule()
    }
    /** One redraw for the answers to a batch of labels, once none is in flight. */
    flush() {
      if (!this.changed || this.pending.size) return
      this.changed = false
      this.view.dispatch({
        effects: [answered.of(null), formattedRefresh.of(null)],
      })
    }
    destroy() {
      this.destroyed = true
      this.abort(() => true)
      if (this.idle) cancelIdleCallback(this.idle)
    }
  },
)

/** Reference link state and requests for a formatted view. */
export const referenceLinks = [labels, requests]
