import { defaultKeymap, history } from '@codemirror/commands'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import '../../src/renderer/src/styles.css'
import type { ChunkedMarkdownProbe } from '../../src/renderer/src/chunked-markdown'
import { showMarkdownMarkers } from '../../src/renderer/src/formatted-contributions'
import { formattedSyntax } from '../../src/renderer/src/formatted-syntax'
import { livePreview } from '../../src/renderer/src/live-preview'
import { markdownSyntax } from '../../src/renderer/src/markdown-syntax'

/** Table harness: the app's pane layout around a formatted view that can be read-only or editable. */
const probe: ChunkedMarkdownProbe = {
  parsedChunks: 0,
  parsedUnits: 0,
  scannedUnits: 0,
  reusedNodes: 0,
  builtGroups: 0,
}
let view: EditorView | null = null

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
      options: { editable?: boolean } = {},
    ) {
      if (size)
        Object.assign(panes.style, {
          position: 'fixed',
          left: '0',
          top: '0',
          width: `${size.width}px`,
          height: `${size.height}px`,
        })
      view?.destroy()
      document.querySelector<HTMLElement>('.rich-pane')!.scrollTop = 0
      view = new EditorView({
        parent: host,
        state: EditorState.create({
          doc,
          extensions: [
            livePreview(formattedSyntax({ probe })),
            options.editable
              ? [history(), keymap.of(defaultKeymap)]
              : [EditorState.readOnly.of(true), EditorView.editable.of(false)],
            showMarkdownMarkers.of(true),
          ],
        }),
      })
      await document.fonts.ready
      view.requestMeasure()
      await settle()
    },
    view: () => view,
    setEnabled: (id: string, enabled: boolean) =>
      markdownSyntax.setEnabled(id, enabled),
    reset() {
      for (const key of Object.keys(probe) as (keyof ChunkedMarkdownProbe)[])
        probe[key] = 0
    },
    settle,
  },
})
