import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import {
  Compartment,
  EditorState,
  type Extension,
  Prec,
  StateEffect,
  StateField,
  Transaction,
} from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  WidgetType,
} from '@codemirror/view'
import { InlineContext } from '@lezer/markdown'
import '../../src/renderer/src/styles.css'
import {
  type ChunkedMarkdownProbe,
  uncovered,
} from '../../src/renderer/src/chunked-markdown'
import { cellParser } from '../../src/renderer/src/formatted/table-cells'
import * as formattedTables from '../../src/renderer/src/formatted/tables'
import {
  formattedBlockParser,
  formattedDocument,
  showMarkdownMarkers,
} from '../../src/renderer/src/formatted-contributions'
import { formattedSyntax } from '../../src/renderer/src/formatted-syntax'
import { livePreview } from '../../src/renderer/src/live-preview'
import { markdownSyntax } from '../../src/renderer/src/markdown-syntax'
import { keepReading } from '../../src/renderer/src/reading-position'
import {
  sourceFormatting,
  tableActions,
} from '../../src/renderer/src/source-formatting'
import {
  storedTableLayout,
  type TableLayout,
  type TableLayoutUpdate,
  updateTableLayout,
} from '../../src/shared/table-layout'

/** Table harness: the app's pane layout around a formatted view that can be read-only or editable. */
const probe: ChunkedMarkdownProbe = {
  parsedChunks: 0,
  parsedUnits: 0,
  scannedUnits: 0,
  reusedNodes: 0,
  builtGroups: 0,
}
let view: EditorView | null = null
let syntax: ReturnType<typeof formattedSyntax> | null = null
/** A second view of the same document, as another pane of the tab would be. */
let second: EditorView | null = null
// The workspace's table sizes, as the main process keeps and updates them.
const layouts = new Map<string, TableLayout[]>()
const writes: { tabId: string; input: TableLayout[] | TableLayoutUpdate }[] = []
/** While set, writes are applied but answered only when released, as a busy workspace would. */
let holding = false
const held: (() => void)[] = []
Object.assign(window, {
  hibi: {
    readTableLayout: async (tabId: string) => layouts.get(tabId) ?? [],
    writeTableLayout: async (
      tabId: string,
      input: TableLayout[] | TableLayoutUpdate,
    ) => {
      writes.push({ tabId, input: structuredClone(input) })
      const next = Array.isArray(input)
        ? input
        : updateTableLayout(layouts.get(tabId) ?? [], input)
      // The workspace's bound: at most 1,000 rows stored by index.
      if (
        next.some(
          (table) => (storedTableLayout(table).rowsAfter?.length ?? 0) > 1000,
        )
      )
        throw new Error('The table layout is invalid.')
      layouts.set(tabId, next)
      if (holding) await new Promise<void>((done) => held.push(done))
    },
  },
})
const editable = new Compartment()
class Space extends WidgetType {
  constructor(readonly height: number) {
    super()
  }
  override eq(other: Space) {
    return other.height === this.height
  }
  toDOM() {
    const space = document.createElement('div')
    space.style.height = `${this.height}px`
    return space
  }
  override get estimatedHeight() {
    return this.height
  }
}
const grow = StateEffect.define<{ at: number; height: number }>()
/**
 * Spaces in the note, standing in for text whose height the view estimates
 * again; each set again by its position, removed at a height of 0.
 */
const above = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    let set = value.map(transaction.changes)
    for (const effect of transaction.effects)
      if (effect.is(grow)) {
        const { at, height } = effect.value
        set = set.update({
          filterFrom: at,
          filterTo: at,
          filter: (from) => from !== at,
          add: height
            ? [
                Decoration.widget({
                  widget: new Space(height),
                  block: true,
                  side: -1,
                }).range(at),
              ]
            : [],
        })
      }
    return set
  },
  provide: (field) => EditorView.decorations.from(field),
})
/** A space of `height` px at `at`, kept as a parsing slice keeps the reader. */
function growAt(at: number, height: number) {
  if (!view) return
  keepReading(view)
  view.dispatch({ effects: grow.of({ at, height }) })
}
const access = (on: boolean) => [
  EditorState.readOnly.of(!on),
  EditorView.editable.of(on),
]

// The GitHub flavor's strikethrough setting, which the Markdown addon registers in the app.
markdownSyntax.register('markdown', {
  id: 'strike',
  label: 'Strikethrough',
  group: 'Markdown',
  level: 'inline',
  extensions: ['strike'],
  matches: (token: { type: string }) => token.type === 'del',
})

document.body.innerHTML =
  '<main class="editor-panes mode-normal"><div class="editor-content"><section class="rich-pane" aria-label="Formatted document"><div class="rich-editor-host"></div></section></div></main>'
const host = document.querySelector<HTMLElement>('.rich-editor-host')!
const panes = document.querySelector<HTMLElement>('.editor-panes')!
const settle = async () => {
  for (let frame = 0; frame < 3; frame++)
    await new Promise(requestAnimationFrame)
}

Object.assign(window, {
  tables: {
    probe,
    async mount(
      doc: string,
      size?: { width: number; height: number },
      /** `tabId` gives the view a tab with table sizes; `add` mounts a second view of the tab beside the first. */
      options: {
        editable?: boolean
        tabId?: string
        add?: boolean
        slice?: number
        /** History's `newGroupDelay`, for runs that must not depend on their pace. */
        historyGroupDelay?: number
      } = {},
    ) {
      if (size)
        Object.assign(panes.style, {
          position: 'fixed',
          left: '0',
          top: '0',
          width: `${size.width}px`,
          height: `${size.height}px`,
        })
      if (!options.add) {
        view?.destroy()
        second?.destroy()
        second = null
      }
      document.querySelector<HTMLElement>('.rich-pane')!.scrollTop = 0
      syntax = formattedSyntax({ probe, slice: options.slice })
      const mounted = new EditorView({
        parent: host,
        state: EditorState.create({
          doc,
          extensions: [
            livePreview(syntax),
            options.editable
              ? [
                  history({ newGroupDelay: options.historyGroupDelay }),
                  keymap.of([...defaultKeymap, ...historyKeymap]),
                ]
              : [],
            editable.of(access(!!options.editable)),
            above,
            showMarkdownMarkers.of(true),
            options.tabId
              ? formattedDocument.of({ revision: 0, tabId: options.tabId })
              : [],
          ],
        }),
      })
      if (options.add) second = mounted
      else view = mounted
      await document.fonts.ready
      mounted.requestMeasure()
      await settle()
    },
    view: () => view,
    /** Count real block-proof work without a clock or replacing the grammar. */
    watchBlockProofs() {
      const current = view!
      const grammar = current.state.facet(formattedBlockParser)(current.state)
      const work = { calls: 0, units: 0 }
      const measured = Object.assign(Object.create(grammar), {
        parse(text: string) {
          work.calls++
          work.units += text.length
          return grammar.parse(text)
        },
      })
      current.dispatch({
        effects: StateEffect.appendConfig.of(
          Prec.highest(formattedBlockParser.of(() => measured)),
        ),
      })
      return work
    },
    /** Count real inline parsing; restore the shared grammar after each measurement. */
    watchInlineParses() {
      const grammar = cellParser(view!.state)
      const parse = grammar.parse
      const char = InlineContext.prototype.char
      const work = { calls: 0, units: 0, steps: 0 }
      grammar.parse = (...args) => {
        work.calls++
        work.units += args[0].length
        InlineContext.prototype.char = function (position) {
          work.steps++
          return char.call(this, position)
        }
        try {
          return parse.apply(grammar, args)
        } finally {
          InlineContext.prototype.char = char
        }
      }
      return {
        work,
        stop: () => {
          grammar.parse = parse
        },
      }
    },
    /** install source extensions, as a format addon does. */
    extend(extension: Extension) {
      view?.dispatch({ effects: StateEffect.appendConfig.of(extension) })
    },
    /** Apply another view's edit without recording it in this view's history. */
    echo(insert: string) {
      if (!view) return
      view.update([
        view.state.update({
          changes: { from: view.state.doc.length, insert },
          annotations: Transaction.addToHistory.of(false),
        }),
      ])
    },
    settling: () => view && syntax?.settling(view.state),
    /**
     * Whether the text in view has its current parsed layout, including
     * after a viewport move during an edit's unfinished reparse.
     */
    parsed: () =>
      !!view &&
      !!syntax &&
      !syntax.settling(view.state) &&
      !uncovered(syntax.tree(view.state), view.viewport.from, view.viewport.to),
    second: () => second,
    /** How many column and row positions table size tracking mapped. */
    sizeProbe: () =>
      (formattedTables as { tableSizeProbe?: { mapped: number } })
        .tableSizeProbe,
    /** Hold the workspace's answers to writes, or answer every held one and stop holding. */
    holdWrites(hold: boolean) {
      holding = hold
      if (!hold) for (const done of held.splice(0)) done()
    },
    /** What views wrote to the workspace's table sizes for a tab, in order. */
    writes: (tabId: string) =>
      writes.filter((write) => write.tabId === tabId).map(({ input }) => input),
    /** The table sizes the workspace stores for a tab, or sets them. */
    layouts: (tabId: string, tables?: TableLayout[]) => {
      if (tables) layouts.set(tabId, tables)
      return layouts.get(tabId) ?? []
    },
    /** Run a toolbar table action at the selection, as the toolbar does. */
    runTableAction(id: string) {
      const current = view
      return (
        !!current &&
        current.state
          .facet(tableActions)
          .some((actions) => actions.run(current, id))
      )
    },
    /** Run a toolbar formatting action, as the toolbar does. */
    runFormatting: (id: string) => !!view && sourceFormatting(view).run(id),
    /**
     * Give the text above `height` px more, keeping the reader as a parsing
     * slice does, as when the view estimates text it has not drawn again.
     */
    growAbove: (height: number) => growAt(0, height),
    /** The same with the space at `at`, or without it at a height of 0. */
    growAt,
    /** Make the mounted editor read-only and not editable, or editable again. */
    setEditable: (on: boolean) =>
      view?.dispatch({ effects: editable.reconfigure(access(on)) }),
    setEnabled: (id: string, enabled: boolean) =>
      markdownSyntax.setEnabled(id, enabled),
    reset() {
      for (const key of Object.keys(probe) as (keyof ChunkedMarkdownProbe)[])
        probe[key] = 0
    },
    settle,
  },
})
