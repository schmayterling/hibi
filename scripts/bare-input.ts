import {
  history as codeMirrorHistory,
  redo as codeMirrorRedo,
  undo as codeMirrorUndo,
  defaultKeymap,
  historyKeymap,
} from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorState as CodeMirrorState } from '@codemirror/state'
import {
  EditorView as CodeMirrorView,
  keymap as codeMirrorKeymap,
  Direction,
  drawSelection,
} from '@codemirror/view'
import '../src/renderer/src/styles.css'
import '../src/renderer/src/toolbar.css'

declare global {
  interface Window {
    __bareConfig: {
      mode: 'source' | 'visual' | 'split'
      target: 'source' | 'visual'
      source: string
      markdownEnabled: boolean
    }
    __bareInput: {
      sourceView: CodeMirrorView | null
      codeMirror: {
        view: {
          EditorView: typeof CodeMirrorView
          Direction: typeof Direction
        }
      }
      getDocument: () => { markdown: string; contentVersion: number }
      undo: () => boolean
      redo: () => boolean
      engineMetadata: Record<string, unknown>
    }
  }
}

const { mode, target, source, markdownEnabled } = window.__bareConfig
// ponytail: only the source pane has a bare baseline; a formatted one needs a CodeMirror port.
if (mode !== 'source' || target !== 'source')
  throw new Error('The bare engine measures source view only.')

// Reuse only static Hibi typography and pane geometry, never its application code.
// Fixed chrome reserves 36px titlebar + 46px toolbar + 32px status bar.
document.body.innerHTML = `
  <div class="app">
    <header class="titlebar" aria-hidden="true"></header>
    <div class="editor-surface">
      <div class="toolbar-slot" data-hidden="false" aria-hidden="true">
        <div class="toolbar-clip">
          <nav class="editor-toolbar"><span style="height:var(--control-height)"></span></nav>
        </div>
      </div>
      <div class="editor-page">
        <main class="editor-panes mode-${mode === 'source' ? 'markdown' : mode === 'visual' ? 'normal' : 'side-by-side'}">
          <div class="editor-content"></div>
        </main>
        <div class="statusbar-slot" aria-hidden="true"><section class="app-statusbar"></section></div>
      </div>
    </div>
  </div>`
const content = document.querySelector('.editor-content')
if (!content) throw new Error('The benchmark editor surface is missing.')
let sourceView: CodeMirrorView | null = null
let contentVersion = 0

function requireSourceView() {
  if (!sourceView) throw new Error('The source engine is not mounted.')
  return sourceView
}

if (mode !== 'visual') {
  const pane = document.createElement('section')
  pane.className = 'source-pane'
  pane.setAttribute('aria-label', 'Markdown source')
  pane.inert = target !== 'source'
  const host = document.createElement('div')
  host.className = 'source-editor'
  pane.append(host)
  content.append(pane)
  sourceView = new CodeMirrorView({
    parent: host,
    state: CodeMirrorState.create({
      doc: source,
      extensions: [
        ...(markdownEnabled
          ? [markdown(), syntaxHighlighting(defaultHighlightStyle)]
          : []),
        codeMirrorHistory(),
        codeMirrorKeymap.of([...historyKeymap, ...defaultKeymap]),
        drawSelection(),
        CodeMirrorView.lineWrapping,
        CodeMirrorState.readOnly.of(target !== 'source'),
        CodeMirrorView.editable.of(target === 'source'),
        CodeMirrorView.contentAttributes.of({
          role: 'textbox',
          'aria-label': 'Document editor',
          spellcheck: 'false',
        }),
        CodeMirrorView.updateListener.of((update) => {
          if (update.docChanged) contentVersion += 1
        }),
      ],
    }),
  })
}

window.__bareInput = {
  sourceView,
  codeMirror: { view: { EditorView: CodeMirrorView, Direction } },
  getDocument() {
    // Materialize only at explicit harness checkpoints, never on an edit.
    return {
      markdown: requireSourceView().state.doc.toString(),
      contentVersion,
    }
  },
  undo: () => codeMirrorUndo(requireSourceView()),
  redo: () => codeMirrorRedo(requireSourceView()),
  engineMetadata: {
    baseline: markdownEnabled ? 'configured-markdown' : 'editing-floor',
    sourceMarkdownEnabled: markdownEnabled,
    source: markdownEnabled
      ? 'CodeMirror 6 with native markdown(), highlighting, history and line wrapping'
      : 'CodeMirror 6 with history and line wrapping; no language or highlighting extension',
    chrome:
      'fixed Hibi CSS geometry; titlebar 36px, toolbar 46px, status bar 32px',
    typography: 'Hibi static CSS fonts, wrapping and padding',
    saves: 'harness writes a snapshot; no application IPC or recovery journal',
  },
}
