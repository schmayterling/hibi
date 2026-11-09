import type { ViewTarget } from '../../../../shared/foundation-contracts'
import { Component } from '../core/component.ts'
import type { App } from '../types'
import type { Editor } from './editor.ts'
import type { EditorRuntime } from './extensions.ts'

/** What the workspace's leaf tells the editor about its pane. */
export type LeafLike = {
  target(): ViewTarget | null
  file(): unknown
}

/**
 * A Hibi note pane as Obsidian's MarkdownView. Source mode is Hibi's source
 * view; the formatted view is live preview, so its mode is also 'source', as
 * in Obsidian. Hibi's preview pane is 'preview'.
 */
export class MarkdownView extends Component {
  readonly app: App
  readonly previewMode: {
    containerEl: HTMLElement | null
    rerender: () => void
  }
  #fallback: { container: HTMLElement; content: HTMLElement } | null = null

  readonly leaf: LeafLike
  readonly editor: Editor
  private readonly runtime: EditorRuntime
  private readonly paneTarget: ViewTarget

  constructor(
    leaf: LeafLike,
    runtime: EditorRuntime,
    paneTarget: ViewTarget,
    editor: Editor,
  ) {
    super()
    this.leaf = leaf
    this.runtime = runtime
    this.paneTarget = paneTarget
    this.editor = editor
    this.app = runtime.context.app
    this.previewMode = { containerEl: null, rerender: () => {} }
  }

  get file() {
    return this.leaf.file()
  }
  getViewType() {
    return 'markdown'
  }
  getDisplayText() {
    const file = this.file as { basename?: string } | null
    return file?.basename ?? ''
  }
  /** 'preview' only while the pane shows Hibi's read-only preview. */
  getMode(): 'source' | 'preview' {
    const selection = this.runtime.context.hibi.editorViews.getSelection(
      this.paneTarget,
    )
    return selection.ok ? 'source' : 'preview'
  }
  getViewData() {
    return this.editor.getValue()
  }
  setViewData(data: string, _clear?: boolean) {
    this.editor.setValue(data)
  }
  get data() {
    return this.editor.getValue()
  }
  #elements() {
    const cm = this.editor.cm
    if (cm?.dom.parentElement)
      return { container: cm.dom.parentElement, content: cm.dom }
    this.#fallback ??= (() => {
      const container = document.createElement('div')
      const content = container.appendChild(document.createElement('div'))
      return { container, content }
    })()
    return this.#fallback
  }
  get containerEl() {
    return this.#elements().container
  }
  get contentEl() {
    return this.#elements().content
  }
  /** Hibi saves notes itself; requests are already covered by autosave. */
  requestSave() {}
  async save() {}
}

const views = new WeakMap<LeafLike, MarkdownView>()

/** The leaf's MarkdownView, the same object until its pane or note changes. */
export function markdownViewFor(
  leaf: LeafLike,
  runtime: EditorRuntime,
): MarkdownView | null {
  const target = leaf.target()
  if (!target) return null
  const editor = runtime.editorFor(target)
  const current = views.get(leaf)
  if (current?.editor === editor) return current
  const view = new MarkdownView(leaf, runtime, target, editor)
  views.set(leaf, view)
  runtime.trackView(target.viewId, view)
  return view
}
