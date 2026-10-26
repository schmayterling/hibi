import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import '../../src/renderer/src/styles.css'
import type { ChunkedMarkdownProbe } from '../../src/renderer/src/chunked-markdown'
import { codeLanguages } from '../../src/renderer/src/code-languages'
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
