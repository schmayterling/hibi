import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, WidgetType } from '@codemirror/view'
import '../../src/renderer/src/styles.css'
import type { ChunkedMarkdownProbe } from '../../src/renderer/src/chunked-markdown'
import { codeLanguages } from '../../src/renderer/src/code-languages'
import { formattedDocument } from '../../src/renderer/src/formatted-contributions'
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
const documentRevision = new Compartment()
const revisionOf = (revision: number) =>
  formattedDocument.of({ revision, tabId: null })

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
    async mount(
      doc: string,
      size?: { width: number; height: number },
      { editable, ...options }: { slice?: number; editable?: boolean } = {},
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
      syntax = formattedSyntax({ probe, ...options })
      view = new EditorView({
        parent: host,
        state: EditorState.create({
          doc,
          extensions: [
            livePreview(syntax),
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
    setRevision(revision: number) {
      view?.dispatch({
        effects: documentRevision.reconfigure(revisionOf(revision)),
      })
    },
    /** Scroll a position to the top of the viewport. */
    scrollTo(pos: number) {
      view?.dispatch({
        effects: EditorView.scrollIntoView(pos, { y: 'start' }),
      })
    },
    /** The formatted view's syntax tree. */
    tree: () => (view ? syntax.tree(view.state) : null),
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
