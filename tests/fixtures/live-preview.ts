import { history, isolateHistory, redo, undo } from '@codemirror/commands'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, WidgetType } from '@codemirror/view'
import { contribution as frontmatter } from '../../src/addons/frontmatter/formatted'
import { DocumentWorkerClient } from '../../src/renderer/src/document-worker-client'
import {
  definitionsRead,
  footnoteDefinitions,
  footnoteScan,
} from '../../src/renderer/src/formatted/footnote-definitions'
import { DocumentSession } from '../../src/shared/document-session'
import '../../src/renderer/src/styles.css'
// The app's control styles, such as its thin scrollbars, so panes look alike.
import '../../src/ui/controls.css'
import {
  type ChunkedMarkdownProbe,
  uncovered,
} from '../../src/renderer/src/chunked-markdown'
import { codeLanguages } from '../../src/renderer/src/code-languages'
import {
  formattedDocument,
  formattedRefresh,
} from '../../src/renderer/src/formatted-contributions'
import { formattedRegistry } from '../../src/renderer/src/formatted-registry'
import { formattedSyntax } from '../../src/renderer/src/formatted-syntax'
import { livePreview } from '../../src/renderer/src/live-preview'

/** Formatted-view harness: the editor pane layout of the app around a read-only live preview. */
const probe: ChunkedMarkdownProbe = {
  parsedChunks: 0,
  parsedUnits: 0,
  scannedUnits: 0,
  reusedNodes: 0,
  builtGroups: 0,
}
let view: EditorView | null = null
let workerClient: DocumentWorkerClient | null = null
let workerSession: DocumentSession | null = null
const workerState = {
  ready: false,
  requests: 0,
  releases: 0,
  ranges: [] as number[],
  pages: 0,
  maxRecords: 0,
  errors: [] as string[],
}
function applyHistory(command: typeof undo) {
  if (!view) return false
  return command({
    state: view.state,
    dispatch(transaction) {
      const changes: { from: number; to: number; insert: string }[] = []
      transaction.changes.iterChanges((from, to, _fromB, _toB, insert) => {
        changes.push({ from, to, insert: insert.toString() })
      })
      workerSession?.edit(changes, 'source', 'test')
      view!.dispatch(transaction)
    },
  })
}
let revisionLayouts = 0
const documentRevision = new Compartment()
const frontmatterSlot = new Compartment()
const revisionOf = (revision: number, tabId: string | null = null) =>
  formattedDocument.of({ revision, tabId })

/** Shows the document revision a contributed layout saw. */
class RevisionWidget extends WidgetType {
  constructor(readonly revision: number) {
    super()
  }
  override eq(other: RevisionWidget) {
    return other.revision === this.revision
  }
  toDOM() {
    const span = document.createElement('span')
    span.className = 'test-revision'
    span.textContent = String(this.revision)
    return span
  }
}
let syntax = formattedSyntax({ probe })

document.body.innerHTML =
  '<main class="editor-panes mode-normal"><div class="editor-content"><section class="rich-pane" aria-label="Formatted document"><div class="rich-editor-host"></div></section></div></main>'
const host = document.querySelector<HTMLElement>('.rich-editor-host')!
const panes = document.querySelector<HTMLElement>('.editor-panes')!

Object.assign(window, {
  livePreview: {
    probe,
    workerState,
    footnoteScan,
    definitionIndex: () => view?.state.field(footnoteDefinitions, false),
    definitionsReady: () => {
      const state = view?.state
      return (
        !!state?.field(footnoteDefinitions, false) && definitionsRead(state)
      )
    },
    async mount(
      doc: string,
      size?: { width: number; height: number },
      {
        editable,
        worker = false,
        frontmatter: withFrontmatter = false,
        history: withHistory = false,
        ...options
      }: {
        slice?: number
        editable?: boolean
        worker?: boolean
        frontmatter?: boolean
        history?: boolean
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
      await Promise.all(
        ['js', 'css', 'python'].map((language) =>
          codeLanguages.ensure(language),
        ),
      )
      view?.destroy()
      workerClient?.dispose()
      workerSession?.dispose()
      workerClient = null
      workerSession = null
      Object.assign(workerState, {
        ready: false,
        requests: 0,
        releases: 0,
        ranges: [],
        pages: 0,
        maxRecords: 0,
        errors: [],
      })
      if (worker) {
        workerSession = new DocumentSession(
          doc,
          { tabId: 'worker-fixture', revision: 0 },
          0,
          {
            enqueue: () => {},
            onError: (error) => workerState.errors.push(String(error)),
          },
        )
        workerClient = new DocumentWorkerClient(workerSession, {
          changed: () => {},
          pending: () => {},
          result: () => {},
          error: (error) => workerState.errors.push(error),
        })
      }
      syntax = formattedSyntax({
        probe,
        ...options,
        ...(worker
          ? {
              boundaries: {
                request: (config, receive, declined, from, baseVersion) => {
                  workerState.requests++
                  workerState.ranges.push(from ?? 0)
                  workerState.ready = false
                  workerClient!.boundaries(
                    config,
                    (page, ack) => {
                      workerState.pages++
                      workerState.maxRecords = Math.max(
                        workerState.maxRecords,
                        page.records.length,
                      )
                      receive(page, () => {
                        workerState.ready = page.done
                        ack()
                      })
                    },
                    declined,
                    from,
                    baseVersion,
                  )
                },
                release: (retain) => {
                  workerState.releases++
                  workerClient?.releaseBoundaries(retain)
                },
              },
            }
          : {}),
      })
      view = new EditorView({
        parent: host,
        state: EditorState.create({
          doc,
          extensions: [
            livePreview(syntax),
            frontmatterSlot.of(withFrontmatter ? frontmatter.extension : []),
            withHistory ? history() : [],
            documentRevision.of(revisionOf(0)),
            editable
              ? []
              : [EditorState.readOnly.of(true), EditorView.editable.of(false)],
          ],
        }),
      })
      await document.fonts.ready
      view.requestMeasure()
      await new Promise(requestAnimationFrame)
      await new Promise(requestAnimationFrame)
    },
    view: () => view,
    setFrontmatter: (enabled: boolean) =>
      view?.dispatch({
        effects: frontmatterSlot.reconfigure(
          enabled ? frontmatter.extension : [],
        ),
      }),
    /** An external canonical edit mirrored to the formatted surface. */
    edit(from: number, to: number, insert: string, addon = false) {
      workerSession?.edit([{ from, to, insert }], 'source', 'test')
      view?.dispatch({
        changes: { from, to, insert },
        annotations: isolateHistory.of('full'),
        ...(addon ? { userEvent: 'input.addon' } : {}),
      })
    },
    undo: () => applyHistory(undo),
    redo: () => applyHistory(redo),
    sourceMatchesView: () =>
      !workerSession ||
      view?.state.doc.toString() === workerSession.snapshot().materialize(),
    /** An unknown block grammar must keep its main-thread parser. */
    unknownBlock: () =>
      formattedRegistry.register({
        id: 'test.unknown-block',
        load: () => ({
          id: 'test.unknown-block',
          syntax: {
            defineNodes: [{ name: 'UnknownBlock', block: true }],
            parseBlock: [
              {
                name: 'UnknownBlock',
                before: 'FencedCode',
                parse(cx, line) {
                  if (line.text.slice(line.pos) !== '%%') return false
                  cx.addElement(
                    cx.elt(
                      'UnknownBlock',
                      cx.parsedPos,
                      cx.parsedPos + line.text.length,
                    ),
                  )
                  cx.nextLine()
                  return true
                },
              },
            ],
          },
        }),
      }),
    revisionLayouts: () => revisionLayouts,
    /** A contributed layout that shows the document revision before each paragraph; returns its removal. */
    showRevisions: () =>
      formattedRegistry.register({
        id: 'test.revision',
        load: () => ({
          id: 'test.revision',
          views: [
            {
              nodes: ['Paragraph'],
              layout(node, out, { state }) {
                revisionLayouts++
                out.widget(
                  node.from,
                  new RevisionWidget(state.facet(formattedDocument).revision),
                )
              },
            },
          ],
        }),
      }),
    /** The note's files or media changed. */
    setRevision(revision: number, tabId: string | null = null) {
      view?.dispatch({
        effects: documentRevision.reconfigure(revisionOf(revision, tabId)),
      })
    },
    /** Redraw the formatted view's decorations. */
    refresh() {
      view?.dispatch({ effects: formattedRefresh.of(null) })
    },
    /** Scroll a position to the top of the viewport. */
    scrollTo(pos: number) {
      view?.dispatch({
        effects: EditorView.scrollIntoView(pos, { y: 'start' }),
      })
    },
    /** The formatted view's syntax tree. */
    tree: () => (view ? syntax.tree(view.state) : null),
    /** The shown syntax tree has parsed text from `from` to `to`. */
    covered: (from: number, to: number) =>
      !!view && !uncovered(syntax.tree(view.state), from, to),
    /** An edit's reparse is still running. */
    settling: () => (view ? syntax.settling(view.state) : false),
    reset() {
      for (const key of Object.keys(probe) as (keyof ChunkedMarkdownProbe)[])
        probe[key] = 0
    },
    async settle() {
      await new Promise(requestAnimationFrame)
      await new Promise(requestAnimationFrame)
    },
  },
})
