import type {
  AddonStorageApi,
  AddonStorageChange,
  AddonStorageHandle,
  AddonStorageReadRequest,
  AddonStorageReadResult,
  AddonStorageScope,
  AddonStorageWorkspace,
  AddonStorageWriteRequest,
  AddonStorageWriteResult,
} from '../../shared/addon-storage'
import type {
  WorkspaceId,
  WorkspaceTarget,
} from '../../shared/foundation-contracts'

export type AddonStorageBridge = {
  readAddonStorage: (
    request: AddonStorageReadRequest,
  ) => Promise<AddonStorageReadResult>
  writeAddonStorage: (
    request: AddonStorageWriteRequest,
  ) => Promise<AddonStorageWriteResult>
  onAddonStorageChanged: (
    listener: (change: AddonStorageChange) => void,
  ) => () => void
}

type OpenHandle = {
  scope: AddonStorageScope
  key: string
  version: number
  current: AddonStorageReadResult
  changedWhileLoading: boolean
  changeCounter: number
  listeners: Set<() => void>
}

function sameScope(left: AddonStorageScope, right: AddonStorageScope): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind !== 'workspace' || right.kind !== 'workspace') return true
  return (
    left.target.workspaceId === right.target.workspaceId &&
    left.target.workspaceGeneration === right.target.workspaceGeneration
  )
}

/** One scope per activation. Persistent state survives dispose; subscriptions do not. */
export function createAddonStorageScope(
  owner: string,
  isActive: () => boolean,
  bridge: AddonStorageBridge,
): { api: AddonStorageApi; dispose: () => void } {
  let disposed = false
  const handles = new Map<string, OpenHandle>()
  const pending = new Map<string, Promise<AddonStorageHandle>>()
  const active = () => !disposed && isActive()
  const requireActive = () => {
    if (!active())
      throw new Error('Enable this addon in Settings → Addons first.')
  }
  const release = bridge.onAddonStorageChanged((change) => {
    if (!active() || change.owner !== owner) return
    for (const handle of handles.values()) {
      if (handle.key !== change.key || !sameScope(handle.scope, change.scope))
        continue
      handle.changedWhileLoading = true
      handle.changeCounter++
      handle.current =
        change.current.status === 'ready' &&
        change.version !== null &&
        change.version !== handle.version
          ? {
              status: 'version-mismatch',
              revision: change.current.revision,
              storedVersion: change.version,
              value: change.current.value,
            }
          : change.current
      for (const listener of handle.listeners) listener()
    }
  })

  function open<T>(
    scope: AddonStorageScope,
    key: string,
    version: number,
  ): Promise<AddonStorageHandle<T>> {
    requireActive()
    const identity = JSON.stringify([scope, key, version])
    let loading = pending.get(identity)
    if (!loading) {
      const handle: OpenHandle = {
        scope,
        key,
        version,
        current: { status: 'missing', revision: 0 },
        changedWhileLoading: false,
        changeCounter: 0,
        listeners: new Set(),
      }
      handles.set(identity, handle)
      loading = (async (): Promise<AddonStorageHandle> => {
        try {
          const initial = await bridge.readAddonStorage({
            owner,
            scope,
            key,
            version,
          })
          requireActive()
          if (!handle.changedWhileLoading) handle.current = initial
        } catch (error) {
          handles.delete(identity)
          pending.delete(identity)
          throw error
        }
        return {
          snapshot: () => structuredClone(handle.current),
          subscribe(listener) {
            requireActive()
            handle.listeners.add(listener)
            return () => handle.listeners.delete(listener)
          },
          async set(value, options) {
            requireActive()
            if (handle.current.status === 'unavailable') return handle.current
            if (
              handle.current.status === 'version-mismatch' &&
              options?.migrateFromVersion !== handle.current.storedVersion
            )
              return { status: 'version-mismatch', current: handle.current }
            const before = handle.changeCounter
            const result = await bridge.writeAddonStorage({
              owner,
              scope,
              key,
              version,
              value,
              baseRevision: handle.current.revision,
              ...options,
            })
            if (!active()) return result
            if (before !== handle.changeCounter) return result
            if (result.status === 'saved')
              handle.current = {
                status: 'ready',
                revision: result.revision,
                value: result.value,
              }
            else if ('current' in result) handle.current = result.current
            for (const listener of handle.listeners) listener()
            return result
          },
        }
      })()
      pending.set(identity, loading)
    }
    return loading as Promise<AddonStorageHandle<T>>
  }

  const api: AddonStorageApi = {
    global: <T>(key: string, version: number) =>
      open<T>({ kind: 'global' }, key, version),
    workspace: <T>(
      workspace: AddonStorageWorkspace,
      key: string,
      version: number,
    ) => {
      if (
        !/^[a-f0-9]{64}$/.test(workspace.id) ||
        !Number.isSafeInteger(workspace.workspaceGeneration) ||
        workspace.workspaceGeneration < 0
      )
        throw new Error('Open a workspace before using workspace storage.')
      const target: WorkspaceTarget = {
        workspaceId: workspace.id as WorkspaceId,
        workspaceGeneration: workspace.workspaceGeneration,
      }
      return open<T>({ kind: 'workspace', target }, key, version)
    },
    session: <T>(key: string, version: number) =>
      open<T>({ kind: 'session' }, key, version),
  }
  return {
    api,
    dispose() {
      disposed = true
      release()
      for (const handle of handles.values()) handle.listeners.clear()
      handles.clear()
      pending.clear()
    },
  }
}
