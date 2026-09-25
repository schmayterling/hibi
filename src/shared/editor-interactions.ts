import type { ViewTarget } from './foundation-contracts'

/** Positions belong to the named editor, not to the Markdown source. */
export interface EditorInteractionRequest {
  readonly view: ViewTarget
  readonly contentVersion: number
  readonly editor: 'source' | 'rich'
  readonly documentLength: number
  readonly position: number
  readonly selection: { readonly anchor: number; readonly head: number }
  readonly before: string
  readonly after: string
  readonly selectedText: string
}

/** Plain text only. Hibi owns placement, presentation, and dismissal. */
export interface EditorHover {
  readonly label: string
  readonly detail?: string
}

export type EditorHoverProvider = (
  request: EditorInteractionRequest,
  signal: AbortSignal,
) => EditorHover | null | Promise<EditorHover | null>

/** Hibi validates and applies the proposed edit as one undoable operation. */
export interface EditorContextAction {
  readonly label: string
  readonly detail?: string
  readonly edit: {
    readonly from: number
    readonly to: number
    readonly insertText: string
  }
}

export type EditorContextActionProvider = (
  request: EditorInteractionRequest,
  signal: AbortSignal,
) => readonly EditorContextAction[] | Promise<readonly EditorContextAction[]>
