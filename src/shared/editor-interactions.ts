import type { ViewTarget } from './foundation-contracts'

/** Positions are opaque and editor-local. `editor: 'rich'` names either implementation, without an engine discriminator. Derive ranges from selection, before/after, and documentLength, never Markdown text or constants. CodeMirror uses normalized-source UTF-16 offsets; legacy rich uses ProseMirror positions, including node boundaries. */
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

export function sameInteraction(
  left: EditorInteractionRequest,
  right: EditorInteractionRequest | null,
) {
  return (
    !!right &&
    left.view.documentId === right.view.documentId &&
    left.view.documentGeneration === right.view.documentGeneration &&
    left.view.viewId === right.view.viewId &&
    left.view.viewGeneration === right.view.viewGeneration &&
    left.contentVersion === right.contentVersion &&
    left.editor === right.editor &&
    left.documentLength === right.documentLength &&
    left.position === right.position &&
    left.selection.anchor === right.selection.anchor &&
    left.selection.head === right.selection.head
  )
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
