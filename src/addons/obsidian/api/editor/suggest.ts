import { Scope } from '../core/keymap.ts'
import type { App } from '../types'

/**
 * Obsidian's EditorSuggest, so plugins that subclass it still load.
 * Registration is refused: Hibi's completions are data-only items the host
 * applies itself, and cannot call a plugin's selectSuggestion with an editor.
 */
export abstract class EditorSuggest<T> {
  context: unknown = null
  limit = 100
  readonly scope = new Scope()
  readonly app: App
  constructor(app: App) {
    this.app = app
  }
  setInstructions(_instructions: unknown[]) {}
  open() {}
  close() {}
  abstract onTrigger(cursor: unknown, editor: unknown, file: unknown): unknown
  abstract getSuggestions(context: unknown): T[] | Promise<T[]>
  abstract renderSuggestion(value: T, el: HTMLElement): void
  abstract selectSuggestion(value: T, evt: MouseEvent | KeyboardEvent): void
}
