import type { ViewTarget } from './foundation-contracts'

/** Positions are editor-local: CodeMirror and ProseMirror offsets are distinct. */
export interface CompletionRequest {
  readonly view: ViewTarget
  readonly contentVersion: number
  readonly editor: 'source' | 'rich'
  readonly documentLength: number
  readonly selection: { readonly anchor: number; readonly head: number }
  readonly before: string
  readonly after: string
  readonly trigger:
    | { readonly kind: 'explicit' }
    | { readonly kind: 'input'; readonly character: string }
}

/** Data only; the host validates and applies an accepted edit in one undo step. */
export interface CompletionItem {
  readonly label: string
  readonly detail?: string
  readonly insertText: string
  readonly from: number
  readonly to: number
  readonly rank?: number
}

export type CompletionProvider = (
  request: CompletionRequest,
  signal: AbortSignal,
) => readonly CompletionItem[] | Promise<readonly CompletionItem[]>

export interface CompletionUpdate {
  readonly request: CompletionRequest
  readonly items: readonly CompletionItem[]
  readonly done: boolean
}
