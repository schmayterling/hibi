export const WORKSPACE_SETTINGS_CHANNELS = {
  get: 'workspace-settings:get',
  update: 'workspace-settings:update',
} as const
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
  | { action: 'choose' | 'open' | 'relocate' | 'create-manifest' }
  | { action: 'startup'; startup: WorkspacePreferences['startup'] }
  | {
      action: 'save-manifest'
      manifest: WorkspaceManifest
      revision: string
      ignore: string
    }
