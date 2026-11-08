import { type Extension, StateField } from '@codemirror/state'
import { EditorView, ViewPlugin } from '@codemirror/view'
import type { ViewTarget } from '../../../../shared/foundation-contracts'
import type { ApiContext, App, PluginInstance } from '../types'
import { Editor } from './editor.ts'

export type MarkdownFileInfo = {
  app: App
  readonly file: unknown
  readonly editor: Editor | undefined
}

/** `{ app, file, editor }` of the pane a CodeMirror view belongs to. */
export const editorInfoField = StateField.define<MarkdownFileInfo>({
  // Views outside a vault's note panes have no app, file or editor.
  create: () => ({
    app: undefined as unknown as App,
    file: null,
    editor: undefined,
  }),
  update: (value) => value,
})
/** True in the formatted view, Hibi's live preview. */
export const editorLivePreviewField = StateField.define<boolean>({
  create: () => false,
  update: (value) => value,
})

type Presentation = 'source' | 'formatted'
type Entry = { extension: Extension; remove: () => void }

/**
 * One vault host's editors: each plugin extension is its own Hibi editor
 * feature in every current and future source and formatted view, so Hibi's
 * fault isolation removes only the extension that fails.
 */
export class EditorRuntime {
  private readonly views = new Map<string, EditorView>()
  private readonly entries = new Set<Entry>()
  private readonly editors = new Map<string, Editor>()
  private sequence = 0
  /** The workspace's Markdown view of each pane, for its file. */
  private readonly markdownViews = new Map<string, { file: unknown }>()

  readonly context: ApiContext

  constructor(context: ApiContext) {
    this.context = context
    const { hibi } = context
    const core = (presentation: Presentation) =>
      ({
        id: 'obsidian-core',
        create: (view?: { viewId: string }) =>
          view ? this.core(view.viewId, presentation) : [],
      }) as const
    context.register(hibi.editor.registerSource(core('source')))
    context.register(hibi.editor.registerFormatted(core('formatted')))
  }

  private core(viewId: string, presentation: Presentation): Extension {
    const key = `${viewId}:${presentation}`
    const runtime = this
    const info: MarkdownFileInfo = {
      app: this.context.app,
      get file() {
        return runtime.fileOf(viewId)
      },
      get editor() {
        const target = runtime.targetOf(viewId)
        return target ? runtime.editorFor(target) : undefined
      },
    }
    return [
      editorInfoField.init(() => info),
      editorLivePreviewField.init(() => presentation === 'formatted'),
      ViewPlugin.define((view) => {
        this.views.set(key, view)
        return {
          destroy: () => {
            if (this.views.get(key) === view) this.views.delete(key)
          },
        }
      }),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return
        const workspace = this.context.app.workspace as {
          trigger?: (name: string, ...data: unknown[]) => void
        }
        workspace.trigger?.('editor-change', info.editor, info)
      }),
    ]
  }

  trackView(viewId: string, view: { file: unknown }) {
    this.markdownViews.set(viewId, view)
  }
  markdownViewOf(viewId: string) {
    return this.markdownViews.get(viewId) ?? null
  }
  fileOf(viewId: string) {
    return this.markdownViews.get(viewId)?.file ?? null
  }

  targetOf(viewId: string): ViewTarget | null {
    return (
      this.context.hibi.editorViews
        .list()
        .find((view) => view.viewId === viewId) ?? null
    )
  }

  /** The CodeMirror view of the pane's current editor. */
  viewOf(target: ViewTarget): EditorView | null {
    const selection = this.context.hibi.editorViews.getSelection(target)
    const kind = selection.ok
      ? selection.value.editor === 'rich'
        ? 'formatted'
        : 'source'
      : null
    return (
      (kind && this.views.get(`${target.viewId}:${kind}`)) ??
      this.views.get(`${target.viewId}:source`) ??
      this.views.get(`${target.viewId}:formatted`) ??
      null
    )
  }

  /** One Editor per pane and document generation. */
  editorFor(target: ViewTarget) {
    const key = `${target.viewId}:${target.viewGeneration}:${target.documentId}:${target.documentGeneration}`
    let editor = this.editors.get(key)
    if (!editor) {
      for (const old of this.editors.keys())
        if (old.startsWith(`${target.viewId}:`)) this.editors.delete(old)
      editor = new Editor(
        { hibi: this.context.hibi, viewOf: (view) => this.viewOf(view) },
        target,
      )
      this.editors.set(key, editor)
    }
    return editor
  }

  private install(extension: Extension) {
    const id = `obsidian-${++this.sequence}`
    // Plugins may change their array and call updateOptions.
    const create = () => (Array.isArray(extension) ? [...extension] : extension)
    const { editor } = this.context.hibi
    const source = editor.registerSource({ id, create })
    const formatted = editor.registerFormatted({ id, create })
    return () => {
      source()
      formatted()
    }
  }

  register(plugin: PluginInstance, extension: Extension) {
    const entry: Entry = { extension, remove: this.install(extension) }
    this.entries.add(entry)
    plugin.register(() => {
      if (!this.entries.delete(entry)) return
      entry.remove()
    })
  }

  /** `workspace.updateOptions()`: reinstall extensions from their current arrays. */
  refresh() {
    for (const entry of this.entries) {
      entry.remove()
      entry.remove = this.install(entry.extension)
    }
  }
}
