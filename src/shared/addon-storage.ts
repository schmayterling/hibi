import type { WorkspaceTarget } from './foundation-contracts'

export type AddonStorageWorkspace = {
  id: string
  workspaceGeneration: number
}

/** Storage is owned by the addon that opens it. Workspace handles capture identity at open time. */
export type AddonStorageScope =
  | { kind: 'global' }
  | { kind: 'session' }
  | { kind: 'workspace'; target: WorkspaceTarget }

export type AddonStorageReadRequest = {
  owner: string
  scope: AddonStorageScope
  key: string
  version: number
}

export type AddonStorageReadResult<T = unknown> =
  | { status: 'missing'; revision: 0 }
  | { status: 'ready'; revision: number; value: T }
  | {
      status: 'version-mismatch'
      revision: number
      storedVersion: number
      value: unknown
    }
  | {
      status: 'unavailable'
      reason: 'corrupt' | 'newer-format' | 'stale-workspace'
    }

export type AddonStorageWriteRequest = AddonStorageReadRequest & {
  value: unknown
  /** Compare with revision returned by read or last successful write. Zero creates a new key. */
  baseRevision: number
  /** Explicitly replace a known older schema after validating its value. */
  migrateFromVersion?: number
}

export type AddonStorageWriteResult<T = unknown> =
  | { status: 'saved'; revision: number; value: T }
  | { status: 'conflict'; current: AddonStorageReadResult<T> }
  | { status: 'version-mismatch'; current: AddonStorageReadResult<T> }
  | {
      status: 'unavailable'
      reason: 'corrupt' | 'newer-format' | 'stale-workspace'
    }

export type AddonStorageChange = {
  owner: string
  scope: AddonStorageScope
  key: string
  version: number | null
  current: AddonStorageReadResult
}

/** Reads stay cached after open. A successful set means the atomic file rename completed. */
export type AddonStorageHandle<T = unknown> = {
  snapshot: () => AddonStorageReadResult<T>
  subscribe: (listener: () => void) => () => void
  /** Compare-and-set against this handle's last observed revision. Retry explicitly after conflict. */
  set: (
    value: T,
    options?: { migrateFromVersion?: number },
  ) => Promise<AddonStorageWriteResult<T>>
}

export type AddonStorageApi = {
  global: <T = unknown>(
    key: string,
    version: number,
  ) => Promise<AddonStorageHandle<T>>
  workspace: <T = unknown>(
    workspace: AddonStorageWorkspace,
    key: string,
    version: number,
  ) => Promise<AddonStorageHandle<T>>
  session: <T = unknown>(
    key: string,
    version: number,
  ) => Promise<AddonStorageHandle<T>>
}

export const ADDON_STORAGE_CHANNELS = {
  read: 'addon-storage:read',
  write: 'addon-storage:write',
  changed: 'addon-storage:changed',
} as const
