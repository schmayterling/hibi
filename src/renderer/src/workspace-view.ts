import type { DesktopApi } from '../../shared/desktop'
import type {
  WorkspaceEntry,
  WorkspaceHeader,
  WorkspaceState,
} from '../../shared/workspace'

type Bridge = Pick<DesktopApi, 'getWorkspaceHeader' | 'readWorkspaceViewPage'>

function identity(header: WorkspaceHeader) {
  return JSON.stringify([header.target, header.sequence, header.draftRevision])
}

/** One paged read at a time; publish only a complete, current generation. */
export function createWorkspaceView(
  bridge: Bridge,
  publish: (workspace: WorkspaceState | null) => void,
) {
  let requested = 0
  let task: Promise<WorkspaceState | null> | undefined
  let cachedKey = ''
  let cachedEntries: WorkspaceEntry[] = []

  async function read(): Promise<WorkspaceState | null> {
    while (true) {
      const current = requested
      const header = await bridge.getWorkspaceHeader()
      if (current !== requested) continue
      if (!header?.target) {
        cachedKey = ''
        cachedEntries = []
        publish(null)
        return null
      }
      const key = identity(header)
      if (key === cachedKey) {
        const state = { ...header, entries: cachedEntries }
        publish(state)
        return state
      }
      const entries: WorkspaceEntry[] = []
      const byPath = new Map<string, WorkspaceEntry>()
      let retry = false
      for (const drafts of [false, true]) {
        let cursor: string | undefined
        do {
          const result = await bridge.readWorkspaceViewPage({
            target: header.target,
            sequence: header.sequence,
            draftRevision: header.draftRevision,
            drafts,
            ...(cursor !== undefined ? { cursor } : {}),
            limit: 200,
          })
          if (current !== requested) {
            retry = true
            break
          }
          if (!result.ok) {
            if (result.code === 'stale' || result.code === 'resync-needed') {
              retry = true
              break
            }
            throw new Error(result.message)
          }
          for (const item of result.value.entries) {
            const existing = byPath.get(item.path)
            if (existing) {
              if (item.dirty === undefined) delete existing.dirty
              else existing.dirty = item.dirty
              continue
            }
            const entry: WorkspaceEntry = {
              ...item,
              ...(item.kind === 'folder' ? { children: [] } : {}),
            }
            const parentPath = item.path.slice(0, item.path.lastIndexOf('/'))
            const parent = item.path.includes('/')
              ? byPath.get(parentPath)
              : undefined
            if (item.path.includes('/') && !parent?.children) continue
            const siblings = parent?.children ?? entries
            siblings.push(entry)
            byPath.set(item.path, entry)
          }
          cursor = result.value.nextCursor ?? undefined
        } while (cursor)
        if (retry) break
      }
      if (retry) continue
      const latest = await bridge.getWorkspaceHeader()
      if (current !== requested || !latest || identity(latest) !== key) continue
      cachedKey = key
      cachedEntries = entries
      const state = { ...latest, entries }
      publish(state)
      return state
    }
  }

  return {
    refresh(): Promise<WorkspaceState | null> {
      requested++
      if (!task) {
        const next = read().finally(() => {
          if (task === next) task = undefined
        })
        task = next
      }
      return task
    },
  }
}
