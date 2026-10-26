import { DocInput } from '@codemirror/language'
import {
  type ChangeDesc,
  type EditorState,
  type Extension,
  StateEffect,
  StateField,
  type Text,
} from '@codemirror/state'
import { type EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { type Tree, TreeFragment } from '@lezer/common'
import { GFM, type MarkdownExtension, parseCode, parser } from '@lezer/markdown'
import { createPlainTextRunExtension } from '../../shared/markdown-plain-text-runs.ts'
import {
  ChunkedMarkdownParser,
  type ChunkedMarkdownProbe,
  type Demand,
  uncovered,
} from './chunked-markdown.ts'
import { codeLanguages } from './code-languages.ts'

/**
 * The formatted view owns its syntax tree. Edits reparse their chunk inside
 * the transaction; scrolling and far jumps continue in idle slices, so no
 * shared background-parse budget can stall formatting near the viewport.
 */
type Syntax = { tree: Tree; demand: Demand; complete: boolean }

const setDemand = StateEffect.define<Demand>()
const resume = StateEffect.define<null>()

export type FormattedSyntaxOptions = {
  extensions?: MarkdownExtension
  probe?: ChunkedMarkdownProbe
  /** Milliseconds of parsing per transaction; the idle driver continues the rest. */
  slice?: number
}

function markdownParser(options: FormattedSyntaxOptions) {
  const base = parser.configure([GFM, options.extensions ?? []])
  const runs = createPlainTextRunExtension()
  const full = base.configure([
    runs.extension,
    parseCode({
      codeParser: (info) => codeLanguages.resolve(info)?.parser ?? null,
    }),
  ])
  runs.allow(full)
  return new ChunkedMarkdownParser(full, base, {
    ...(options.probe ? { probe: options.probe } : {}),
  })
}

const mapDemand = (demand: Demand, changes: ChangeDesc) => ({
  from: changes.mapPos(demand.from, -1),
  to: changes.mapPos(demand.to, 1),
})

function syntaxField(options: FormattedSyntaxOptions) {
  const chunked = markdownParser(options)
  const slice = options.slice ?? 8
  const run = (
    doc: Text,
    fragments: readonly TreeFragment[],
    demand: Demand,
  ) => {
    const parse = chunked.startChunkedParse(
      new DocInput(doc),
      fragments,
      demand,
    )
    const end = performance.now() + slice
    for (;;) {
      const tree = parse.advance()
      if (tree) return tree
      if (performance.now() > end) {
        // Keep the verified progress; the driver resumes in an idle slice.
        parse.stopAt(parse.parsedPos)
        for (;;) {
          const stopped = parse.advance()
          if (stopped) return stopped
        }
      }
    }
  }
  const syntax = (tree: Tree, demand: Demand): Syntax => ({
    tree,
    demand,
    complete: !uncovered(tree, demand.from, demand.to),
  })
  return StateField.define<Syntax>({
    create(state) {
      const demand = { from: 0, to: Math.min(state.doc.length, 8192) }
      return syntax(run(state.doc, [], demand), demand)
    },
    update(value, transaction) {
      let demand = value.demand,
        resumed = false
      for (const effect of transaction.effects) {
        if (effect.is(setDemand)) demand = effect.value
        else if (effect.is(resume)) resumed = true
      }
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
        const fragments = TreeFragment.applyChanges(
          TreeFragment.addTree(value.tree),
          ranges,
        )
        return syntax(run(transaction.state.doc, fragments, demand), demand)
      }
      if (demand === value.demand && !resumed) return value
      if (!uncovered(value.tree, demand.from, demand.to))
        return { tree: value.tree, demand, complete: true }
      return syntax(
        run(transaction.state.doc, TreeFragment.addTree(value.tree), demand),
        demand,
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
}

/** Chunked Markdown syntax for one formatted editor configuration. */
export function formattedSyntax(
  options: FormattedSyntaxOptions = {},
): FormattedSyntax {
  const field = syntaxField(options)
  return {
    extension: [field, driver(field)],
    tree: (state) => state.field(field).tree,
  }
}
