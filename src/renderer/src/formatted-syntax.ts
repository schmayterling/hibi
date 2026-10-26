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
import { createPlainTextRunExtension } from '../../shared/markdown-plain-text-runs.ts'
import {
  ChunkedMarkdownParser,
  type ChunkedMarkdownProbe,
  type ChunkedPartialParse,
  type Demand,
  uncovered,
} from './chunked-markdown.ts'
import { codeLanguages } from './code-languages.ts'
import {
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
const resume = StateEffect.define<null>()

export type FormattedSyntaxOptions = {
  extensions?: MarkdownExtension
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
      if (performance.now() >= end)
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
  return StateField.define<Syntax>({
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
        moved = false
      for (const effect of transaction.effects) {
        if (effect.is(setDemand)) {
          demand = effect.value
          moved = true
        } else if (effect.is(resume)) resumed = true
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
        return run(value.parse, demand, value.prefix, value.settling && !moved)
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
}

/** Keeps the parsed region on the viewport, one idle slice at a time. */
function driver(field: StateField<Syntax>) {
  return ViewPlugin.fromClass(
    class {
      private timer: ReturnType<typeof setTimeout> | null = null
      private idle = 0
      private view: EditorView
      constructor(view: EditorView) {
        this.view = view
        this.schedule(true)
      }
      update(update: ViewUpdate) {
        if (update.viewportChanged) this.schedule(true)
        else if (!update.state.field(field).complete) this.schedule(false)
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
        view.dispatch({
          effects: same ? resume.of(null) : setDemand.of({ from, to }),
        })
      }
      destroy() {
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
  const field = syntaxField(options)
  return {
    extension: [field, driver(field)],
    tree: (state) => state.field(field).tree,
    settling: (state) => state.field(field).settling,
  }
}
