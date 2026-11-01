import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import {
  Compartment,
  EditorState,
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
import '../../src/renderer/src/styles.css'
import {
  type ChunkedMarkdownProbe,
  uncovered,
} from '../../src/renderer/src/chunked-markdown'
import * as formattedTables from '../../src/renderer/src/formatted/tables'
import {
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
const grow = StateEffect.define<number>()
/** Space at the note's start, standing in for text above whose height the view estimates again. */
const above = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    for (const effect of transaction.effects)
      if (effect.is(grow))
        return Decoration.set(
          Decoration.widget({
            widget: new Space(effect.value),
            block: true,
            side: -1,
          }).range(0),
        )
    return value.map(transaction.changes)
  },
  provide: (field) => EditorView.decorations.from(field),
})
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
              ? [history(), keymap.of([...defaultKeymap, ...historyKeymap])]
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
     * Whether the text in view is parsed. A viewport that moves during an
     * edit's reparse ends its settling first: the view then shows the text it
     * has not reached yet unparsed.
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
    growAbove(height: number) {
      if (!view) return
      keepReading(view)
      view.dispatch({ effects: grow.of(height) })
    },
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
