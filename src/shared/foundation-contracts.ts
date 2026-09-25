/** A live workspace. Its ID may change when the folder moves. */
export type WorkspaceId = string & { readonly __workspaceId: unique symbol }

/** A file entry within a workspace; rename, move, or deletion invalidates it. */
export type FileId = string & { readonly __fileId: unique symbol }

/** A live document session, independent of focus and invalid after close. */
export type DocumentId = string & { readonly __documentId: unique symbol }

/** One editor instance; distinct from addon UI view handles. */
export type ViewId = string & { readonly __viewId: unique symbol }

/** An addon manifest identity; activation generations distinguish restarts. */
export type AddonId = string & { readonly __addonId: unique symbol }

/** An in-flight transport request, used to cancel work across IPC. */
export type RequestId = string & { readonly __requestId: unique symbol }

export interface WorkspaceTarget {
  readonly workspaceId: WorkspaceId
  readonly workspaceGeneration: number
}

export interface FileTarget extends WorkspaceTarget {
  readonly fileId: FileId
  readonly path: string
  readonly kind: 'file' | 'folder'
}

export interface DocumentTarget {
  readonly documentId: DocumentId
  readonly documentGeneration: number
}

export interface VersionedDocumentTarget extends DocumentTarget {
  readonly contentVersion: number
}

export interface ViewTarget extends DocumentTarget {
  readonly viewId: ViewId
  readonly viewGeneration: number
}

export interface AddonOwner {
  readonly addonId: AddonId
  readonly activationGeneration: number
}

export type OwnerScope =
  | (AddonOwner & { readonly kind: 'addon' })
  | (AddonOwner & {
      readonly kind: 'workspace'
      readonly target: WorkspaceTarget
    })
  | (AddonOwner & {
      readonly kind: 'document'
      readonly target: DocumentTarget
    })
  | (AddonOwner & { readonly kind: 'view'; readonly target: ViewTarget })

/** Captured at invocation; a later focus change cannot retarget the command. */
export interface CommandExecutionContext {
  readonly source:
    | 'palette'
    | 'shortcut'
    | 'global-shortcut'
    | 'menu'
    | 'toolbar'
    | 'api'
  readonly workspace?: WorkspaceTarget
  readonly file?: FileTarget
  readonly document?: DocumentTarget
  readonly view?: ViewTarget
  /** Captured editor selection; offsets belong to the named editor, not Markdown source. */
  readonly selection?: {
    readonly targetId: string
    readonly editor: 'source' | 'rich'
    readonly contentVersion: number
    readonly position: number
    readonly anchor: number
    readonly head: number
    /** Preview capped at 256 characters. Use the selected-text service for more. */
    readonly selectedText: string
  }
}

/** Ordered within one workspace generation. A null path set requires resync. */
export interface WorkspaceChangeEvent extends WorkspaceTarget {
  readonly sequence: number
  readonly kind: 'content' | 'tree' | 'resync'
  readonly paths: readonly string[] | null
}

export type Dispose = () => void

export type FailureCode =
  | 'cancelled'
  | 'disposed'
  | 'not-found'
  | 'stale'
  | 'conflict'
  | 'busy'
  | 'unsupported'
  | 'permission-denied'
  | 'limit-exceeded'
  | 'resync-needed'

/** Services can narrow the failure codes they return. */
export type OperationResult<T, Code extends FailureCode = FailureCode> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: Code; readonly message: string }
