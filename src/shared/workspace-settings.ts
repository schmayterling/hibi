export const WORKSPACE_SETTINGS_CHANNELS = {
  get: 'workspace-settings:get',
  update: 'workspace-settings:update',
} as const
// ponytail: retained trees cap at 100,000 items; larger folders need incremental listing.
export const WORKSPACE_ENTRY_LIMITS = [20000, 50000, 100000] as const
export type WorkspaceEntryLimit = (typeof WORKSPACE_ENTRY_LIMITS)[number]
export type WorkspaceManifest = {
  version: 1
  name: string
  description: string
  icon: string
  defaultFile: string
}
export type WorkspacePreferences = {
  enabled: boolean
  showAllFiles: boolean
  entryLimit: WorkspaceEntryLimit
  path: string | null
  startup: 'empty' | 'managed' | 'folder'
  startupFolder: string | null
}
export type WorkspaceSettings = WorkspacePreferences & {
  defaultPath: string
  currentPath: string | null
  manifest: WorkspaceManifest | null
  manifestRevision: string | null
  ignore: string
}
export type WorkspaceSettingsAction =
  | { action: 'enable'; enabled: boolean }
  | { action: 'show-all-files'; enabled: boolean }
  | { action: 'entry-limit'; limit: WorkspaceEntryLimit }
  | { action: 'choose' | 'open' | 'relocate' | 'create-manifest' }
  | { action: 'startup'; startup: WorkspacePreferences['startup'] }
  | {
      action: 'save-manifest'
      manifest: WorkspaceManifest
      revision: string
      ignore: string
    }
