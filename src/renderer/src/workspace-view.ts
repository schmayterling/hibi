import type { DesktopApi } from '../../shared/desktop'
import type { WorkspaceEntry, WorkspaceState } from '../../shared/workspace'
import type {
  WorkspaceHeader,
  WorkspaceViewEntry,
} from '../../shared/workspace-view'

type Bridge = Pick<DesktopApi, 'getWorkspaceHeader' | 'readWorkspaceViewPage'>
type Location = { entry: WorkspaceEntry; parent: string; index: number }

function identity(header: WorkspaceHeader) {
  return JSON.stringify([header.target, header.treeRevision])
}

/** One paged read at a time; content signals refresh only the header. */
export function createWorkspaceView(
  bridge: Bridge,
  publish: (workspace: WorkspaceState | null) => void,
) {
  let requested = 0
  let task: Promise<WorkspaceState | null> | undefined
  let cachedTree = ''
  let cachedDraft = ''
  let baseEntries: WorkspaceEntry[] = []
  let locations = new Map<string, Location>()
  let visible: WorkspaceEntry[] = []

  function overlay(drafts: readonly WorkspaceViewEntry[]) {
    const copies = new Map<string, WorkspaceEntry[]>()
    function children(parent: string): WorkspaceEntry[] {
      const copied = copies.get(parent)
      if (copied) return copied
      const location = locations.get(parent)
      const entries = (location?.entry.children ?? baseEntries).slice()
      copies.set(parent, entries)
      if (location)
        children(location.parent)[location.index] = {
          ...location.entry,
          children: entries,
        }
      return entries
    }
    for (const draft of drafts) {
      const location = locations.get(draft.path)
      if (!location && !draft.pending) continue
      if (location && location.entry.kind !== 'file') continue
      const parent = draft.path.includes('/')
        ? draft.path.slice(0, draft.path.lastIndexOf('/'))
        : ''
      if (parent && !locations.get(parent)?.entry.children) continue
      const entry: WorkspaceEntry = {
        path: draft.path,
        name: draft.name,
        kind: 'file',
        ...(draft.dirty !== undefined ? { dirty: draft.dirty } : {}),
      }
      const siblings = children(parent)
      if (location) siblings[location.index] = entry
      else siblings.push(entry)
    }
    return copies.get('') ?? baseEntries
  }

  async function read(): Promise<WorkspaceState | null> {
    while (true) {
      const current = requested
      let header = await bridge.getWorkspaceHeader()
      if (current !== requested) continue
      if (!header?.target) {
        cachedTree = ''
        cachedDraft = ''
        baseEntries = []
        locations.clear()
        visible = []
        publish(null)
        return null
      }
      const target = header.target
      const key = identity(header)
      let retry = false
      if (key !== cachedTree) {
        const entries: WorkspaceEntry[] = []
        const next = new Map<string, Location>()
        let cursor: string | undefined
        do {
          const result = await bridge.readWorkspaceViewPage({
            target,
            treeRevision: header.treeRevision,
            draftRevision: header.draftRevision,
            ...(cursor !== undefined ? { cursor } : {}),
            limit: 200,
          })
          if (!result.ok) {
            if (result.code === 'stale' || result.code === 'resync-needed') {
              retry = true
              break
            }
            throw new Error(result.message)
          }
          for (const item of result.value.entries) {
            const entry: WorkspaceEntry = {
              path: item.path,
              name: item.name,
              kind: item.kind,
              ...(item.kind === 'folder' ? { children: [] } : {}),
            }
            const parent = item.path.includes('/')
              ? item.path.slice(0, item.path.lastIndexOf('/'))
              : ''
            const folder = next.get(parent)?.entry
            if (parent && !folder?.children) continue
            const siblings = folder?.children ?? entries
            next.set(item.path, { entry, parent, index: siblings.length })
            siblings.push(entry)
          }
          cursor = result.value.nextCursor ?? undefined
        } while (cursor)
        if (retry) continue
        const latest = await bridge.getWorkspaceHeader()
        if (!latest || identity(latest) !== key) continue
        baseEntries = entries
        locations = next
        cachedTree = key
        cachedDraft = ''
        header = latest
      }
      const draftKey = JSON.stringify([key, header.draftRevision])
      if (draftKey !== cachedDraft) {
        const drafts: WorkspaceViewEntry[] = []
        let cursor: string | undefined
        do {
          const result = await bridge.readWorkspaceViewPage({
            target,
            treeRevision: header.treeRevision,
            draftRevision: header.draftRevision,
            drafts: true,
            ...(cursor !== undefined ? { cursor } : {}),
            limit: 200,
          })
          if (!result.ok) {
            if (result.code === 'stale' || result.code === 'resync-needed') {
              retry = true
              break
            }
            throw new Error(result.message)
          }
          drafts.push(...result.value.entries)
          cursor = result.value.nextCursor ?? undefined
        } while (cursor)
        if (retry) continue
        const latest = await bridge.getWorkspaceHeader()
        if (
          !latest ||
          identity(latest) !== key ||
          latest.draftRevision !== header.draftRevision
        )
          continue
        visible = overlay(drafts)
        cachedDraft = draftKey
        header = latest
      }
      if (current !== requested) continue
      const state = { ...header, entries: visible }
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
