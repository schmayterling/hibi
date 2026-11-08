import * as autocomplete from '@codemirror/autocomplete'
import * as commands from '@codemirror/commands'
import * as language from '@codemirror/language'
import * as lint from '@codemirror/lint'
import * as search from '@codemirror/search'
import type { Extension } from '@codemirror/state'
import * as state from '@codemirror/state'
import * as view from '@codemirror/view'
import * as common from '@lezer/common'
import * as highlight from '@lezer/highlight'
import * as lr from '@lezer/lr'
import type { CommandExecutionContext } from '../../../../shared/foundation-contracts'
import { registerObsidianApi, registerObsidianHostModule } from '../registry.ts'
import type { ApiContext, PluginInstance } from '../types'
import { Editor } from './editor.ts'
import {
  EditorRuntime,
  editorInfoField,
  editorLivePreviewField,
} from './extensions.ts'
import {
  type LeafLike,
  MarkdownView,
  markdownViewFor,
} from './markdown-view.ts'
import {
  type CodeBlockProcessor,
  type MarkdownPostProcessor,
  MarkdownRenderChild,
  MarkdownRenderer,
  Processors,
} from './render.ts'
import { EditorSuggest } from './suggest.ts'

// Plugins share Hibi's own CodeMirror and Lezer: their classes must be the editor's.
for (const [name, module] of Object.entries({
  '@codemirror/autocomplete': autocomplete,
  '@codemirror/commands': commands,
  '@codemirror/language': language,
  '@codemirror/lint': lint,
  '@codemirror/search': search,
  '@codemirror/state': state,
  '@codemirror/view': view,
  '@lezer/common': common,
  '@lezer/highlight': highlight,
  '@lezer/lr': lr,
}))
  registerObsidianHostModule(name, module)

type Workspace = {
  setMarkdownViewFactory?: (factory: (leaf: LeafLike) => unknown) => () => void
  updateOptions?: () => void
}

export function createEditorApi(context: ApiContext) {
  const { app, hibi } = context
  const runtime = new EditorRuntime(context)
  const activeFile = () => {
    const active = hibi.editorViews.getActive()
    return active ? runtime.fileOf(active.viewId) : null
  }
  const processors = new Processors(
    app,
    (markdown) =>
      hibi.editor.renderMarkdown(
        markdown,
        hibi.editorViews.getActive()?.documentId,
      ).html,
    () => (activeFile() as { path?: string } | null)?.path ?? '',
  )
  context.register(() => processors.dispose())
  const reported = new Set<string>()
  const unsupported = (plugin: PluginInstance, feature: string) => {
    const key = `${plugin.manifest.id}\n${feature}`
    if (reported.has(key)) return
    reported.add(key)
    hibi.notify(
      `${plugin.manifest.name}: ${feature} are not supported in Hibi.`,
    )
  }
  // Every service is in place once plugins load.
  let hooked = false
  const hook = () => {
    if (hooked) return
    hooked = true
    const workspace = app.workspace as Workspace
    const remove = workspace.setMarkdownViewFactory?.((leaf) =>
      markdownViewFor(leaf, runtime),
    )
    if (remove) context.register(remove)
    if (typeof workspace.updateOptions !== 'function') {
      workspace.updateOptions = () => runtime.refresh()
      context.register(() => delete workspace.updateOptions)
    }
  }
  // Panes the workspace has no leaf for, such as a command's captured pane.
  const leaves = new Map<string, LeafLike>()
  const commandEditor = (execution: CommandExecutionContext) => {
    const target = execution.view
    if (!target || !hibi.editorViews.getSelection(target).ok) return null
    const tracked = runtime.markdownViewOf(target.viewId)
    const editor = runtime.editorFor(target)
    if (tracked instanceof MarkdownView && tracked.editor === editor)
      return { editor, view: tracked }
    let leaf = leaves.get(target.viewId)
    if (!leaf) {
      leaf = {
        target: () =>
          hibi.editorViews
            .list()
            .find((view) => view.viewId === target.viewId) ?? null,
        file: () => null,
      }
      leaves.set(target.viewId, leaf)
    }
    const view = markdownViewFor(leaf, runtime)
    return view ? { editor: view.editor, view } : null
  }
  return {
    commandEditor,
    exports: {
      Editor,
      EditorSuggest,
      MarkdownRenderChild,
      MarkdownRenderer,
      MarkdownView,
      editorInfoField,
      editorLivePreviewField,
      editorViewField: editorInfoField,
    },
    extendPlugin(plugin: PluginInstance) {
      hook()
      Object.assign(plugin, {
        registerEditorExtension: (extension: Extension) =>
          runtime.register(plugin, extension),
        registerMarkdownCodeBlockProcessor: (
          name: string,
          handler: CodeBlockProcessor,
        ) => processors.registerCode(plugin, name, handler),
        registerMarkdownPostProcessor: (
          processor: MarkdownPostProcessor,
          sortOrder?: number,
        ) => {
          if (sortOrder !== undefined) processor.sortOrder = sortOrder
          return processors.registerPost(plugin, processor)
        },
        registerEditorSuggest: () => unsupported(plugin, 'editor suggestions'),
      })
    },
  }
}

registerObsidianApi({ id: 'editor', create: createEditorApi })
