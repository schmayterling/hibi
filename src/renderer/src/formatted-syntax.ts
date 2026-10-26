import { DocInput } from '@codemirror/language'
import {
  type ChangeDesc,
  type EditorState,
  type Extension,
  StateEffect,
  StateField,
} from '@codemirror/state'
import { type EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { type Tree, TreeFragment } from '@lezer/common'
import {
  type MarkdownConfig,
  type MarkdownExtension,
  parseCode,
  parser,
} from '@lezer/markdown'
import type { BoundaryReceive } from '../../shared/document-worker-protocol.ts'
import {
  type BoundaryConfig,
  boundaryKey,
  boundarySyntaxIds,
} from '../../shared/markdown-boundary-syntax.ts'
import { createPlainTextRunExtension } from '../../shared/markdown-plain-text-runs.ts'
import {
  BoundaryTree,
  ChunkedMarkdownParser,
  type ChunkedMarkdownProbe,
  type ChunkedPartialParse,
  type Demand,
  uncovered,
  unindexedFrom,
} from './chunked-markdown.ts'
import { codeLanguages } from './code-languages.ts'
import {
  formattedFlavors,
  formattedLiteral,
  formattedMarkdown,
  formattedOpaque,
  formattedPrefix,
  inlineStops,
} from './formatted-contributions.ts'

/**
 * The formatted view owns its syntax tree. A transaction parses for at most
 * one slice and keeps the unfinished parse, which idle slices continue, so no
 * shared background-parse budget can stall formatting near the viewport and no
 * edit runs a whole-document parse synchronously.
 */
type Syntax = {
  tree: Tree
  demand: Demand
  /** The document prefix that is not parsed as Markdown. */
  prefix: number
  complete: boolean
  /** The unfinished parse of this document, continued by the next slice. */
  parse: ChunkedPartialParse | null
  /**
   * The parse is an edit's reparse that did not finish: its tree lacks the
   * edited chunks' nodes until it does.
   */
  settling: boolean
}

const setDemand = StateEffect.define<Demand>()
const resume = StateEffect.define<boolean>()
const adoptBoundaries = StateEffect.define<{
  doc: EditorState['doc']
  key: string
  tree: Tree
  from: number
}>()

export type FormattedSyntaxOptions = {
  extensions?: MarkdownExtension
  boundaries?: {
    request: (
      config: BoundaryConfig,
      receive: BoundaryReceive,
      declined: (reason: 'stale' | 'mismatch') => void,
      from?: number,
    ) => void
    release: (retain?: boolean) => void
  }
  probe?: ChunkedMarkdownProbe
  /** Milliseconds of parsing per transaction or idle slice; each parse step reads a bounded range. */
  slice?: number
}

/**
 * CommonMark plus the Markdown extensions of the formatted view's
 * contributions, which add GitHub's syntax for documents of that flavor.
 */
function markdownParser(
  options: FormattedSyntaxOptions,
  contributed: readonly MarkdownConfig[],
  opaque: readonly string[],
) {
  const base = parser.configure([
    { defineNodes: [{ name: 'Frontmatter', block: true }] },
    ...contributed,
    options.extensions ?? [],
  ])
  const runs = createPlainTextRunExtension()
  const full = base.configure([
    runs.extension,
    parseCode({
      codeParser: (info) => codeLanguages.resolve(info)?.parser ?? null,
    }),
  ])
  // The plain-text shortcut stops only at the characters core inline syntax
  // starts with; contributed inline syntax that starts elsewhere turns it off.
  if (
    contributed.every(
      (config) => !config.parseInline?.length || inlineStops(config),
    )
  )
    runs.allow(full)
  return new ChunkedMarkdownParser(full, base, {
    opaque: new Set(opaque),
    ...(options.probe ? { probe: options.probe } : {}),
  })
}

const mapDemand = (demand: Demand, changes: ChangeDesc) => ({
  from: changes.mapPos(demand.from, -1),
  to: changes.mapPos(demand.to, 1),
})

function boundaryConfig(
  state: EditorState,
  options: FormattedSyntaxOptions,
  prefix: number,
): BoundaryConfig | null {
  const syntax = boundarySyntaxIds([
    ...state.facet(formattedMarkdown),
    options.extensions ?? [],
  ])
  return syntax
    ? {
        schema: 1,
        syntax,
        flavors: state.facet(formattedFlavors),
        literal: state.facet(formattedLiteral),
        opaque: state.facet(formattedOpaque),
        prefix,
        chunkSize: 4096,
        groupSize: 64,
        giantBlock: 65536,
      }
    : null
}

function syntaxField(options: FormattedSyntaxOptions) {
  // Contributions change the node set, so each set of extensions gets its own parser.
  const parsers = new WeakMap<
    readonly MarkdownConfig[],
    WeakMap<readonly string[], ChunkedMarkdownParser>
  >()
  const chunkedFor = (state: EditorState) => {
    const contributed = state.facet(formattedMarkdown),
      opaque = state.facet(formattedOpaque)
    let byOpaque = parsers.get(contributed)
    if (!byOpaque) {
      byOpaque = new WeakMap()
      parsers.set(contributed, byOpaque)
    }
    let chunked = byOpaque.get(opaque)
    if (!chunked) {
      chunked = markdownParser(options, contributed, opaque)
      byOpaque.set(opaque, chunked)
    }
    return chunked
  }
  const prefixOf = (state: EditorState) => {
    let prefix = 0
    for (const measure of state.facet(formattedPrefix))
      prefix = Math.max(prefix, measure(state))
    return Math.min(prefix, state.doc.length)
  }
  const slice = options.slice ?? 8
  const run = (
    parse: ChunkedPartialParse,
    demand: Demand,
    prefix: number,
    settling: boolean,
    oneStep = false,
  ): Syntax => {
    const end = performance.now() + slice
    for (;;) {
      const tree = parse.advance()
      if (tree)
        return {
          tree,
          demand,
          prefix,
          complete: !uncovered(tree, demand.from, demand.to),
          parse: null,
          settling: false,
        }
      // Keep the verified progress; the driver resumes in an idle slice.
      if (oneStep || performance.now() >= end)
        return {
          tree: parse.snapshot(),
          demand,
          prefix,
          complete: false,
          parse,
          settling,
        }
    }
  }
  const start = (
    state: EditorState,
    fragments: readonly TreeFragment[],
    demand: Demand,
    settling: boolean,
  ) => {
    const prefix = prefixOf(state)
    return run(
      chunkedFor(state).startChunkedParse(
        new DocInput(state.doc),
        fragments,
        demand,
        prefix,
      ),
      demand,
      prefix,
      settling,
    )
  }
  const field = StateField.define<Syntax>({
    create(state) {
      return start(
        state,
        [],
        { from: 0, to: Math.min(state.doc.length, 8192) },
        false,
      )
    },
    update(value, transaction) {
      let demand = value.demand,
        resumed = false,
        moved = false,
        oneStep = false
      for (const effect of transaction.effects) {
        if (effect.is(setDemand)) {
          demand = effect.value
          moved = true
        } else if (effect.is(resume)) {
          resumed = true
          oneStep = effect.value
        } else if (effect.is(adoptBoundaries)) {
          const adopted = effect.value
          const config = boundaryConfig(
            transaction.state,
            options,
            prefixOf(transaction.state),
          )
          if (
            adopted.doc === transaction.state.doc &&
            config &&
            adopted.key === boundaryKey(config)
          ) {
            const length = transaction.state.doc.length
            const fragments = adopted.from
              ? [
                  ...TreeFragment.applyChanges(
                    TreeFragment.addTree(value.tree),
                    [
                      {
                        fromA: adopted.from,
                        toA: length,
                        fromB: adopted.from,
                        toB: length,
                      },
                    ],
                    0,
                  ),
                  new TreeFragment(
                    adopted.from,
                    length,
                    adopted.tree,
                    -adopted.from,
                  ),
                ]
              : TreeFragment.addTree(adopted.tree)
            return start(transaction.state, fragments, demand, true)
          }
        }
      }
      // New syntax contributions or a new unparsed prefix parse the document again.
      const { state, startState } = transaction
      if (
        state.facet(formattedMarkdown) !==
          startState.facet(formattedMarkdown) ||
        state.facet(formattedOpaque) !== startState.facet(formattedOpaque) ||
        prefixOf(state) !== value.prefix
      )
        return start(
          transaction.state,
          [],
          transaction.docChanged
            ? mapDemand(demand, transaction.changes)
            : demand,
          false,
        )
      if (transaction.docChanged) {
        demand = mapDemand(demand, transaction.changes)
        const ranges: {
          fromA: number
          toA: number
          fromB: number
          toB: number
        }[] = []
        transaction.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
          ranges.push({ fromA, toA, fromB, toB })
        })
        // The unfinished parse belongs to the old text; its verified chunks are in the tree.
        const fragments = TreeFragment.applyChanges(
          TreeFragment.addTree(value.tree),
          ranges,
        )
        return start(transaction.state, fragments, demand, true)
      }
      if (demand === value.demand && !resumed) return value
      if (value.parse) {
        value.parse.setDemand(demand)
        // A new viewport shows chunks as they are parsed.
        return run(
          value.parse,
          demand,
          value.prefix,
          value.settling && !moved,
          oneStep,
        )
      }
      if (!uncovered(value.tree, demand.from, demand.to))
        return { ...value, demand, complete: true }
      return start(
        transaction.state,
        TreeFragment.addTree(value.tree),
        demand,
        false,
      )
    },
  })
  return { field, chunkedFor, prefixOf }
}

/** Keeps the parsed region on the viewport, one idle slice at a time. */
function driver(
  { field, chunkedFor, prefixOf }: ReturnType<typeof syntaxField>,
  options: FormattedSyntaxOptions,
) {
  return ViewPlugin.fromClass(
    class {
      private timer: ReturnType<typeof setTimeout> | null = null
      private idle = 0
      private view: EditorView
      private boundaryIdle = 0
      private boundaryDoc: EditorState['doc'] | null = null
      private boundaryKey: string | null = null
      private boundaryStream: string | null = null
      private boundarySeeded = false
      private boundaryFrom: number | null = null
      private boundaryTree: BoundaryTree | null = null
      private destroyed = false
      constructor(view: EditorView) {
        this.view = view
        this.schedule(true)
        this.followBoundaries()
      }
      update(update: ViewUpdate) {
        this.followBoundaries()
        if (update.viewportChanged) this.schedule(true)
        else if (!update.state.field(field).complete) this.schedule(false)
      }
      private declined = () => {
        const probe = options.probe
        if (probe) probe.adoptionDeclined = (probe.adoptionDeclined ?? 0) + 1
      }
      private followBoundaries() {
        if (!options.boundaries) return
        const { state } = this.view
        const config = boundaryConfig(state, options, prefixOf(state))
        const key = config ? boundaryKey(config) : null
        const sameConfig = key === this.boundaryKey
        const syntax = state.field(field)
        // Retain mapped boundaries; only an unscanned tail needs another seed.
        const from =
          sameConfig && this.boundarySeeded
            ? syntax.parse && !syntax.parse.scanningContext
              ? null
              : unindexedFrom(syntax.tree)
            : 0
        if (
          state.doc === this.boundaryDoc &&
          sameConfig &&
          (from === null || this.boundaryFrom !== null)
        )
          return
        this.boundaryDoc = state.doc
        this.boundaryKey = key
        this.boundaryStream = null
        if (!sameConfig) this.boundarySeeded = false
        this.boundaryFrom = null
        this.boundaryTree = null
        if (this.boundaryIdle) cancelIdleCallback(this.boundaryIdle)
        this.boundaryIdle = 0
        if (!config) {
          this.declined()
          options.boundaries.release()
          return
        }
        if (from === null) {
          options.boundaries.release(true)
          return
        }
        this.boundaryFrom = from
        const doc = state.doc
        options.boundaries.request(
          config,
          (page, acknowledge) => {
            if (
              this.destroyed ||
              this.view.state.doc !== doc ||
              this.boundaryKey !== page.key
            ) {
              this.declined()
              return
            }
            const stream = `${page.epoch}:${page.id}`
            if (stream !== this.boundaryStream) {
              this.boundaryStream = stream
              this.boundaryTree = null
              if (this.boundaryIdle) cancelIdleCallback(this.boundaryIdle)
              this.boundaryIdle = 0
            }
            // The sender waits for this idle slice before sending another page.
            this.boundaryIdle = requestIdleCallback(
              () => {
                if (
                  this.destroyed ||
                  this.view.state.doc !== doc ||
                  this.boundaryKey !== page.key ||
                  this.boundaryStream !== stream
                ) {
                  this.declined()
                  return
                }
                this.boundaryIdle = 0
                try {
                  this.boundaryTree ??= new BoundaryTree(
                    chunkedFor(this.view.state),
                    page.length - (page.from ?? 0),
                  )
                  this.boundaryTree.append(page.records)
                  const probe = options.probe
                  if (probe) {
                    probe.adoptedRecords =
                      (probe.adoptedRecords ?? 0) + page.records.length
                    probe.adoptionSlices = (probe.adoptionSlices ?? 0) + 1
                  }
                  if (page.done) {
                    const tree = this.boundaryTree.finish()
                    this.boundaryTree = null
                    this.boundarySeeded = true
                    this.view.dispatch({
                      effects: adoptBoundaries.of({
                        doc,
                        key: page.key,
                        tree,
                        from: page.from ?? 0,
                      }),
                    })
                  }
                  acknowledge()
                  if (page.done && this.boundaryStream === stream) {
                    this.boundaryFrom = null
                    options.boundaries?.release(true)
                  }
                } catch {
                  this.declined()
                  this.boundaryTree = null
                  options.boundaries?.release()
                }
              },
              { timeout: 200 },
            )
          },
          this.declined,
          from,
        )
      }
      /** A changed viewport parses on the next task; leftover work waits for idle time. */
      schedule(soon: boolean) {
        if (this.timer !== null || this.idle) return
        if (soon) this.timer = setTimeout(() => this.run(), 0)
        else this.idle = requestIdleCallback(() => this.run(), { timeout: 200 })
      }
      run() {
        this.timer = null
        this.idle = 0
        const { view } = this
        const { from, to } = view.viewport
        const syntax = view.state.field(field)
        const same = syntax.demand.from === from && syntax.demand.to === to
        if (same && syntax.complete) return
        // While the worker repairs a changed context, keep the local fallback
        // moving one bounded parse step rather than duplicating a full scan.
        const bounded = this.boundarySeeded && this.boundaryFrom !== null
        view.dispatch({
          effects: [
            ...(same ? [] : [setDemand.of({ from, to })]),
            resume.of(bounded),
          ],
        })
      }
      destroy() {
        this.destroyed = true
        if (this.boundaryIdle) cancelIdleCallback(this.boundaryIdle)
        this.boundaryTree = null
        options.boundaries?.release()
        if (this.timer !== null) clearTimeout(this.timer)
        if (this.idle) cancelIdleCallback(this.idle)
      }
    },
  )
}

export type FormattedSyntax = {
  extension: Extension
  /** The formatted view's syntax tree for a state that includes this extension. */
  tree: (state: EditorState) => Tree
  /**
   * An edit's reparse has not finished, so renderers keep what they drew,
   * mapped through the edit, instead of rendering the edited chunks bare.
   */
  settling: (state: EditorState) => boolean
}

/** Chunked Markdown syntax for one formatted editor configuration. */
export function formattedSyntax(
  options: FormattedSyntaxOptions = {},
): FormattedSyntax {
  const syntax = syntaxField(options)
  const { field } = syntax
  return {
    extension: [field, driver(syntax, options)],
    tree: (state) => state.field(field).tree,
    settling: (state) => state.field(field).settling,
  }
}
