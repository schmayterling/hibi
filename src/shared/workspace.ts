export const WORKSPACE_CHANNELS = {
  get: 'workspace:get',
  open: 'workspace:open',
  refresh: 'workspace:refresh',
  openFile: 'workspace:open-file',
  changed: 'workspace:changed',
  listChanged: 'workspace:list-changed',
  action: 'workspace:action',
  snapshot: 'workspace:snapshot',
  index: 'workspace:index',
  recent: 'workspace:recent',
  known: 'workspace:known',
  openRecent: 'workspace:open-recent',
  setKnown: 'workspace:set-known',
  deleteKnown: 'workspace:delete-known',
} as const

export type RecentWorkspace = {
  /** Host-issued identity for reopening a previously chosen directory. */
  id: string
  path: string
}

export type WorkspaceEntry = {
  path: string
  name: string
  kind: 'file' | 'folder'
  dirty?: boolean
  children?: WorkspaceEntry[]
}

export type WorkspaceState = {
  /** Present when this folder contains a workspace manifest in .hibi/workspace.json (or legacy .hibi.json). */
  manifest?: import('./workspace-settings').WorkspaceManifest | null
  /** Opaque identity; changes when a different folder is opened. */
  id?: string
  name: string
  entries: WorkspaceEntry[]
  activePath: string | null
  /** Read-only signal for a vault containing an ordinary .obsidian directory. */
  obsidian?: { externalAddons: boolean }
}

/** Workspace-relative paths use forward slashes; null means the changed paths are unknown. */
export type WorkspaceChange = {
  kind: 'content' | 'tree'
  paths: string[] | null
}

export type ExplorerDecoration = {
  /** Workspace-relative file or folder path. Empty string decorates the workspace heading. */
  path: string
  label: string
  badge?: string
  color?: import('./colorschemes').ColorToken
}
export type ExplorerDecorationProvider = {
  id: string
  /** Called after workspace changes. Return a complete replacement set. */
  provide: (workspace: WorkspaceState) => Promise<readonly ExplorerDecoration[]>
}

export type WorkspaceAction = {
  action:
    | 'new-file'
    | 'new-folder'
    | 'rename'
    | 'copy'
    | 'move'
    | 'duplicate'
    | 'delete'
  /** Relative source path, or parent directory for new entries. Empty = root. */
  path: string
  /** New basename for rename; complete relative destination for copy/move. */
  destination?: string
}
export type WorkspaceActionResult = {
  workspace: WorkspaceState | null
  document: import('./desktop').DocumentState
  path: string
}

export type WorkspacePage = {
  id?: string
  path: string
  markdown: string
  /** Pre-rendered by the enabled flavor pipeline. Always sanitized by the site. */
  html?: string
  /** Local Markdown image references mapped to embedded image data URLs. */
  images?: Record<string, string>
}
export type WorkspaceSnapshot = {
  css?: string
  name: string
  pages: WorkspacePage[]
  appearance?: import('./colorschemes').ThemePreferences
}

/** Lightweight note data for sidebar indexes; never embeds media. */
export type WorkspaceIndex = {
  workspace: WorkspaceState
  pages: WorkspacePage[]
}

export type KnownWorkspace = RecentWorkspace & {
  pinned: boolean
  hidden: boolean
}

export function toRecentWorkspaces(
  known: readonly KnownWorkspace[],
): RecentWorkspace[] {
  return known
    .filter((item) => !item.hidden)
    .slice(0, 5)
    .map(({ id, path }) => ({ id, path }))
}
