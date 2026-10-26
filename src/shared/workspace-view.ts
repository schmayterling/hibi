import type { OperationResult } from './foundation-contracts'
import type {
  WorkspaceEntryPage,
  WorkspaceEntryPageRequest,
  WorkspaceListedEntry,
  WorkspaceState,
  WorkspaceStreamSnapshot,
} from './workspace'

/** Private explorer state; content events do not replace its tree. */
export interface WorkspaceHeader
  extends Omit<WorkspaceState, 'entries'>,
    Omit<WorkspaceStreamSnapshot, 'entries'> {
  readonly treeRevision: number
  readonly draftRevision: number
}

export interface WorkspaceViewPageRequest
  extends Omit<WorkspaceEntryPageRequest, 'sequence'> {
  readonly treeRevision: number
  readonly draftRevision: number
  readonly drafts?: boolean
}

export interface WorkspaceViewEntry extends WorkspaceListedEntry {
  readonly dirty?: boolean
  readonly pending?: boolean
}

export type WorkspaceViewPageResult = OperationResult<
  Omit<WorkspaceEntryPage, 'entries'> & {
    readonly entries: readonly WorkspaceViewEntry[]
  },
  'stale' | 'resync-needed' | 'limit-exceeded'
>
