import {
  type EditorState,
  Facet,
  StateEffect,
  StateField,
  type Text,
} from '@codemirror/state'
import { type EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import {
  formattedOwner,
  formattedRefresh,
  formattedRenderInputs,
} from './formatted-contributions.ts'
import type { SourceReferenceResult } from './source-view.ts'

/*
 * Reference links, `[text][label]`, `[label][]` and `[label]`, render as
 * links when the note defines their label. The host's reference service
 * answers for one label at a time; the view asks for the labels it draws,
 * once per edit, and keeps drawing the last answers until new ones arrive.
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
export const referenceWork = { requested: 0, resolved: 0 }

/** Labels in flight at once, so the shared reference queue stays open to others. */
const inFlight = 32

type Labels = {
  /** Whether each label asked about is defined, as last answered. */
  readonly defined: ReadonlyMap<string, boolean>
  /** Labels drawn since the view last asked about them. */
  readonly drawn: Set<string>
}
const answered = StateEffect.define<ReadonlyMap<string, boolean> | null>()

const labels = StateField.define<Labels>({
  create: () => ({ defined: new Map(), drawn: new Set() }),
  update(value, transaction) {
    for (const effect of transaction.effects)
      if (effect.is(answered)) {
        const defined = new Map(effect.value ? value.defined : [])
        for (const [label, known] of effect.value ?? [])
          defined.set(label, known)
        value = { defined, drawn: value.drawn }
      }
    return value
  },
  // Cached layouts and table cells draw again when answers change.
  provide: (field) =>
    formattedRenderInputs.compute(
      [field],
      (state) => state.field(field).defined,
    ),
})

/** The label a reference link resolves, normalized as definitions are. */
const normalize = (label: string) => label.replace(/\s+/g, ' ').toLowerCase()

/**
 * The parts of a `Link` node written as a reference, or null for an inline
 * link. `end` is where its label ends: after `]` of a shortcut reference.
 */
export function referenceLink(doc: Text, node: SyntaxNode) {
  const marks = node.getChildren('LinkMark')
  const open = marks[0]
  const close = marks.find(
    (mark) => doc.sliceString(mark.from, mark.to) === ']',
  )
  if (
    !open ||
    !close ||
    doc.sliceString(open.from, open.to) !== '[' ||
    doc.sliceString(close.to, close.to + 1) === '('
  )
    return null
  const written = node.getChild('LinkLabel')
  const text =
    written && written.to - written.from > 2
      ? doc.sliceString(written.from + 1, written.to - 1)
      : doc.sliceString(open.to, close.from)
  // Longer labels never match a definition.
  if (text.length > 999 || !text.trim()) return null
  return { open, close, end: node.to, label: normalize(text) }
}

/**
 * Whether the note defines a reference link's label, as last answered.
 * Drawing a label asks about it again after an edit.
 */
export function referenceDefined(state: EditorState, label: string) {
  // A table cell's own state reads the field of the view that draws it.
  const value =
    state.field(labels, false) ??
    state.facet(formattedOwner)?.field(labels, false)
  if (!value) return false
  value.drawn.add(label)
  return value.defined.get(label) === true
}

/** Asks about drawn labels: new ones before the next frame, others after each edit in idle time. */
const requests = ViewPlugin.fromClass(
  class {
    private generation = 0
    /** The generation each label was last answered in. */
    private readonly checked = new Map<string, number>()
    private readonly pending = new Set<string>()
    private answers = new Map<string, boolean>()
    private controller = new AbortController()
    private syntax: string | null
    private idle = 0
    private queued = false
    private destroyed = false
    constructor(private readonly view: EditorView) {
      this.syntax = view.state.facet(formattedReferences)?.syntax() ?? null
      this.later()
    }
    update(update: ViewUpdate) {
      const syntax = update.state.facet(formattedReferences)?.syntax() ?? null
      if (syntax !== this.syntax) {
        this.syntax = syntax
        this.controller.abort()
        this.controller = new AbortController()
        this.pending.clear()
        this.checked.clear()
        this.answers = new Map()
        this.generation++
        queueMicrotask(() => {
          if (!this.destroyed)
            this.view.dispatch({
              effects: [answered.of(null), formattedRefresh.of(null)],
            })
        })
        return
      }
      if (update.docChanged) this.generation++
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
    /** Ask now when a drawn label was never answered, otherwise when idle. */
    schedule() {
      const value = this.view.state.field(labels)
      if (!value.drawn.size) return
      let unknown = false
      for (const label of value.drawn)
        if (
          !value.defined.has(label) &&
          !this.pending.has(label) &&
          this.checked.get(label) !== this.generation
        )
          unknown = true
      if (unknown) this.ask()
      else if (!this.idle)
        this.idle = requestIdleCallback(() => {
          this.idle = 0
          if (!this.destroyed) this.ask()
        })
    }
    ask() {
      const resolver = this.view.state.facet(formattedReferences)
      const { drawn } = this.view.state.field(labels)
      if (!resolver) {
        drawn.clear()
        return
      }
      for (const label of drawn) {
        if (this.pending.size >= inFlight) return
        drawn.delete(label)
        if (
          this.pending.has(label) ||
          this.checked.get(label) === this.generation
        )
          continue
        this.request(resolver, label)
      }
    }
    request(resolver: FormattedReferenceResolver, label: string) {
      const generation = this.generation,
        { signal } = this.controller
      this.pending.add(label)
      referenceWork.requested++
      void resolver.resolve(label, signal).then(
        (result) => this.settle(label, generation, signal, result),
        () => this.settle(label, generation, signal, { status: 'unavailable' }),
      )
    }
    settle(
      label: string,
      generation: number,
      signal: AbortSignal,
      result: SourceReferenceResult,
    ) {
      if (this.destroyed || signal.aborted) return
      this.pending.delete(label)
      // A stale answer is asked for again after the next edit, as is any
      // answer to an earlier text, which shows until then.
      this.checked.set(label, generation)
      if (generation !== this.generation)
        this.view.state.field(labels).drawn.add(label)
      if (result.status !== 'stale') {
        referenceWork.resolved++
        this.answers.set(label, result.status === 'resolved' && !!result.value)
      }
      if (this.pending.size) return
      // One redraw for the answers to a batch of labels.
      const current = this.view.state.field(labels).defined
      const changed = [...this.answers].some(
        ([key, known]) => current.get(key) !== known,
      )
      const answers = this.answers
      this.answers = new Map()
      if (changed)
        this.view.dispatch({
          effects: [answered.of(answers), formattedRefresh.of(null)],
        })
      this.schedule()
    }
    destroy() {
      this.destroyed = true
      this.controller.abort()
      if (this.idle) cancelIdleCallback(this.idle)
    }
  },
)

/** Reference link state and requests for a formatted view. */
export const referenceLinks = [labels, requests]
