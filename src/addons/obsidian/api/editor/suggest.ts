import { closeCompletion } from '@codemirror/autocomplete'
import type { ViewTarget } from '../../../../shared/foundation-contracts'
import { reportError } from '../core/events.ts'
import { Scope } from '../core/keymap.ts'
import type { App, PluginInstance } from '../types'
import type { Editor, EditorPosition } from './editor.ts'
import type { EditorRuntime } from './extensions.ts'

export type EditorSuggestTriggerInfo = {
  start: EditorPosition
  end: EditorPosition
  query: string
}
export type EditorSuggestContext = EditorSuggestTriggerInfo & {
  editor: Editor
  file: unknown
}

/** Hibi's suggestion list takes at most this many items from one source. */
const MAX_ITEMS = 20
const closers = new WeakMap<object, () => void>()

/**
 * Obsidian's EditorSuggest over Hibi's completion list: the list's keys pick
 * and close it, and Hibi's own sources show beside the plugin's.
 */
export abstract class EditorSuggest<T> {
  context: EditorSuggestContext | null = null
  limit = 100
  readonly scope = new Scope()
  readonly app: App
  constructor(app: App) {
    this.app = app
  }
  /** Hibi's list shows its own key hints. */
  setInstructions(_instructions: unknown[]) {}
  open() {}
  close() {
    this.context = null
    closers.get(this)?.()
  }
  abstract onTrigger(
    cursor: EditorPosition,
    editor: Editor,
    file: unknown,
  ): EditorSuggestTriggerInfo | null
  abstract getSuggestions(context: EditorSuggestContext): T[] | Promise<T[]>
  abstract renderSuggestion(value: T, el: HTMLElement): void
  abstract selectSuggestion(value: T, evt: MouseEvent | KeyboardEvent): void
}

/** A value's accessible label: the text its own rendering shows. */
function labelOf<T>(suggest: EditorSuggest<T>, value: T, index: number) {
  let text = ''
  const element = globalThis.document?.createElement('div')
  if (element)
    try {
      suggest.renderSuggestion(value, element)
      text = element.textContent ?? ''
    } catch (error) {
      reportError(error)
    }
  text = (text || (typeof value === 'string' ? value : '')).trim()
  return (text || `Suggestion ${index + 1}`).slice(0, 256)
}

export function registerEditorSuggest<T>(
  runtime: EditorRuntime,
  plugin: PluginInstance,
  suggest: EditorSuggest<T>,
) {
  const { hibi } = runtime.context
  let values = new Map<string, T>()
  let run = 0
  let view: ViewTarget | null = null
  closers.set(suggest, () => {
    const cm = view && runtime.viewOf(view)
    if (cm) closeCompletion(cm)
  })
  let removed = false
  let remove = () => {}
  plugin.register(() => {
    removed = true
    remove()
    closers.delete(suggest)
    suggest.context = null
  })
  void hibi.editor
    .registerCompletionProvider(
      async (request, signal) => {
        const { anchor, head } = request.selection
        if (anchor !== head || !runtime.isLive(request.view)) return []
        const editor = runtime.editorFor(request.view)
        const file = runtime.fileOf(request.view.viewId)
        const info = suggest.onTrigger(editor.offsetToPos(head), editor, file)
        if (!info) {
          suggest.context = null
          return []
        }
        const context = { ...info, editor, file }
        suggest.context = context
        view = request.view
        const found = await suggest.getSuggestions(context)
        if (signal.aborted || suggest.context !== context || !found?.length)
          return []
        const start = editor.posToOffset(info.start)
        const end = editor.posToOffset(info.end)
        const shown = new Map<string, T>()
        const id = ++run
        values = shown
        return found
          .slice(0, Math.max(0, Math.min(suggest.limit, MAX_ITEMS)))
          .map((value, index) => {
            const data = `${id}:${index}`
            shown.set(data, value)
            return {
              label: labelOf(suggest, value, index),
              // The plugin's selectSuggestion makes the edit.
              insertText: '',
              from: Math.min(start, end, head),
              to: Math.max(start, end, head),
              data,
            }
          })
      },
      {
        onSelect: (_request, item) => {
          const value =
            item.data === undefined ? undefined : values.get(item.data)
          if (value === undefined || !suggest.context) return
          const event = globalThis.KeyboardEvent
            ? new KeyboardEvent('keydown', { key: 'Enter' })
            : ({ key: 'Enter' } as KeyboardEvent)
          try {
            suggest.selectSuggestion(value, event)
          } finally {
            suggest.context = null
          }
        },
        render: (item, element) => {
          const value =
            item.data === undefined ? undefined : values.get(item.data)
          if (value !== undefined) suggest.renderSuggestion(value, element)
        },
      },
    )
    .then((dispose) => {
      if (removed) dispose()
      else remove = dispose
    }, reportError)
}
