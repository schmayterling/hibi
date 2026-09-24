export const APP_INFO_CHANNEL = 'app:info'
export const BOOTSTRAP_CHANNELS = {
  document: 'bootstrap:document',
  addons: 'bootstrap:addons',
} as const
export const DOCUMENT_CHANNELS = {
  get: 'document:get',
  update: 'document:update',
  append: 'document:append',
  recoveryHead: 'document:recovery-head',
  verifyCheckpoint: 'document:verify-checkpoint',
  flush: 'document:flush',
  flushed: 'document:flushed',
  open: 'document:open',
  external: 'document:external',
  externalPending: 'document:external-pending',
  new: 'document:new',
  save: 'document:save',
  autosave: 'document:autosave',
  selectTab: 'document:select-tab',
  closeTab: 'document:close-tab',
  moveTab: 'document:move-tab',
  tabsEnabled: 'document:tabs-enabled',
  rename: 'document:rename',
  image: 'document:image',
  navigate: 'document:navigate',
  link: 'document:link',
  remote: 'document:remote',
  requestRemote: 'document:request-remote',
} as const

export const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024
export type DocumentState = {
  /** Stable window-local tab identity, including across save and rename. */
  tabId: string
  tabs: DocumentTab[]
  /** False keeps only the active document open. */
  tabsEnabled: boolean
  /** Opaque identity for per-file preferences. Contains no filesystem path. */
  id: string
  /** Workspace draft with a target name but no file on disk yet. */
  ephemeral: boolean
  markdown: string
  savedMarkdown: string
  name: string
  dirty: boolean
  revision: number
  /** Advances on text changes within this tab and revision, including undo and redo. */
  contentVersion: number
  /** True only after this document has a real local save destination. */
  canAutosave: boolean
}
export type DocumentTab = { id: string; name: string; dirty: boolean }
export type AutosaveResult = {
  status: 'saved' | 'skipped' | 'conflict'
  document: DocumentState | null
}
export type DocumentCommand =
  | 'new'
  | 'open'
  | 'save'
  | 'saveAs'
  | 'undo'
  | 'redo'

export type AppInfo = {
  version: string
  electron: string
  platform: string
}

export type DesktopApi = {
  getUpdateState: () => Promise<import('./updates').UpdateState>
  setUpdateChannel: (
    channel: import('./updates').UpdateChannel,
  ) => Promise<import('./updates').UpdateState>
  setUpdateStartupCheck: (
    enabled: boolean,
  ) => Promise<import('./updates').UpdateState>
  setUpdateCheckFrequency: (
    hours: import('./updates').UpdateCheckFrequency,
  ) => Promise<import('./updates').UpdateState>
  checkForUpdates: () => Promise<import('./updates').UpdateState>
  downloadUpdate: () => Promise<import('./updates').UpdateState>
  installUpdate: () => Promise<void>
  onUpdateChanged: (
    callback: (state: import('./updates').UpdateState) => void,
  ) => () => void
  getDependencies: (
    owner?: string,
  ) => Promise<import('./dependencies').DependencyState[]>
  checkDependency: (
    target: string | { addon: string; id: string },
  ) => Promise<import('./dependencies').DependencyState>
  installDependency: (
    target: string | { addon: string; id: string },
  ) => Promise<import('./dependencies').DependencyState>
  configureDependency: (
    key: string,
    action: 'choose' | 'reset' | { path: string },
  ) => Promise<import('./dependencies').DependencyState>
  openDependencyGuide: (key: string) => Promise<void>
  analyzeDocument: (
    owner: string,
    projection: import('./document-projection').TextProjection,
  ) => Promise<import('./analysis').AnalysisResult>
  cancelAnalysis: (owner: string) => Promise<void>
  /** Independent snapshots requested by preload while renderer modules load. */
  bootstrap: {
    document: () => Promise<{
      info: AppInfo
      document: DocumentState
      hotkeys: Hotkeys
      workspace: WorkspaceState | null
      externalPending: boolean
    }>
    addons: () => Promise<{
      states: AddonState[]
      packages: import('./sideload').InstalledAddon[]
      notices: string[]
    }>
    recentWorkspaces: () => Promise<import('./workspace').RecentWorkspace[]>
    knownWorkspaces: () => Promise<import('./workspace').KnownWorkspace[]>
  }
  listImporters: () => Promise<import('./imports').Importer[]>
  importIntoWorkspace: (
    request: import('./imports').ImportRequest,
  ) => Promise<import('./imports').ImportResult | null>
  getAddonDocumentation: (
    id: string,
    path: string,
  ) => Promise<import('./sideload').AddonDocument>
  openAddonDocumentationLink: (href: string) => Promise<void>
  getFileAssociations: () => Promise<
    import('./file-associations').FileAssociationState
  >
  setFileAssociation: (format: string) => Promise<void>
  navigateDocument: (
    direction: 'back' | 'forward',
  ) => Promise<DocumentState | null>
  openDocumentLink: (
    href: string,
    revision: number,
  ) => Promise<DocumentState | null>
  openRemoteDocument: (url: string) => Promise<DocumentState | null>
  onOpenRemote: (callback: () => void) => () => void
  attachMedia: (
    files: File[] | null,
    revision: number,
  ) => Promise<import('./media').AttachmentResult | null>
  readDocumentMedia: (
    source: string,
    revision: number,
  ) => Promise<import('./media').DocumentMedia | null>
  openDroppedFile: (file: File) => Promise<{
    document: DocumentState | null
    workspace?: WorkspaceState | null
  } | null>
  getInstalledAddons: () => Promise<import('./sideload').InstalledAddon[]>
  installAddon: (url?: string) => Promise<void>
  openAddonsFolder: () => Promise<void>
  openAddonGarden: () => Promise<void>
  removeAddon: (id: string) => Promise<void>
  listVersions: () => Promise<import('./history').DocumentVersion[]>
  previewVersion: (id: string) => Promise<string>
  restoreVersion: (id: string) => Promise<DocumentState | null>
  onNotice: (callback: (message: string) => void) => () => void
  getLicenses: () => Promise<import('./about').LicenseInfo[]>
  getLicense: (id: string) => Promise<string>
  openSponsor: () => Promise<void>
  setAppearance: (
    appearance: import('./colorschemes').NativeAppearance,
  ) => Promise<void>
  getAddonStates: () => Promise<AddonState[]>
  setAddonEnabled: (id: string, enabled: boolean) => Promise<AddonState[]>
  invokeAddon: (id: string, method: string, input?: unknown) => Promise<unknown>
  queryAddon: (id: string, method: string, input?: unknown) => Promise<unknown>
  getWorkspace: () => Promise<WorkspaceState | null>
  getWorkspaceSettings: () => Promise<
    import('./workspace-settings').WorkspaceSettings
  >
  updateWorkspaceSettings: (
    action: import('./workspace-settings').WorkspaceSettingsAction,
  ) => Promise<import('./workspace-settings').WorkspaceSettings>
  getRecentWorkspaces: () => Promise<import('./workspace').RecentWorkspace[]>
  getKnownWorkspaces: () => Promise<import('./workspace').KnownWorkspace[]>
  openRecentWorkspace: (id: string) => Promise<WorkspaceState | null>
  setKnownWorkspace: (
    id: string,
    action: 'pin' | 'unpin' | 'hide',
  ) => Promise<import('./workspace').KnownWorkspace[]>
  deleteKnownWorkspace: (id: string) => Promise<boolean>
  getWorkspaceSnapshot: () => Promise<import('./workspace').WorkspaceSnapshot>
  getWorkspaceIndex: () => Promise<import('./workspace').WorkspaceIndex | null>
  workspaceAction: (
    action: import('./workspace').WorkspaceAction,
  ) => Promise<import('./workspace').WorkspaceActionResult | null>
  openWorkspace: () => Promise<WorkspaceState | null>
  refreshWorkspace: () => Promise<WorkspaceState | null>
  openWorkspaceFile: (path: string) => Promise<DocumentState | null>
  onWorkspaceChanged: (
    callback: (
      workspace: WorkspaceState | null,
      change?: import('./workspace').WorkspaceChange,
    ) => void,
  ) => () => void
  onWorkspaceListChanged: (
    callback: (known: import('./workspace').KnownWorkspace[]) => void,
  ) => () => void
  getAppInfo: () => Promise<AppInfo>
  setUiCase: (value: import('./ui-case').UiCase) => Promise<void>
  getDocument: () => Promise<DocumentState>
  selectDocumentTab: (id: string) => Promise<DocumentState>
  closeDocumentTab: (id: string) => Promise<DocumentState | null>
  moveDocumentTab: (
    id: string,
    beforeId: string | null,
  ) => Promise<DocumentState>
  setTabsEnabled: (enabled: boolean) => Promise<DocumentState>
  updateDocument: (markdown: string) => Promise<void>
  appendDocumentChange: (
    change: import('./document-journal').DocumentChange,
  ) => Promise<import('./document-journal').DocumentAcknowledgment>
  appendSourceOperation: (
    operation: import('./source-operations').SourceOperation,
  ) => Promise<import('./document-journal').DocumentAcknowledgment>
  admitSourceOperation: (
    operation: import('./source-operations').SourceOperation,
  ) => void
  onDocumentCheckpoint: (
    callback: () => import('./document-checkpoint').JournalCheckpoint,
  ) => () => void
  getDocumentRecoveryState: () => ReturnType<
    ReturnType<
      typeof import('./document-journal').createDocumentJournal
    >['state']
  >
  flushDocumentChanges: () => Promise<void>
  openDocument: () => Promise<DocumentState | null>
  openExternalDocuments: () => Promise<{
    document: DocumentState | null
    errors: string[]
  }>
  onExternalDocuments: (callback: () => void) => () => void
  newDocument: () => Promise<DocumentState | null>
  saveDocument: (saveAs: boolean) => Promise<DocumentState | null>
  autosaveDocument: (revision: number) => Promise<AutosaveResult>
  renameDocument: (name: string) => Promise<DocumentState>
  readDocumentImage: (
    source: string,
    revision: number,
  ) => Promise<string | null>
  getHotkeys: () => Promise<Hotkeys>
  saveHotkeys: (hotkeys: Hotkeys) => Promise<Hotkeys>
  setHotkeyRecording: (recording: boolean) => Promise<void>
  onCommand: (callback: (command: AppCommand) => void) => () => void
}

import type { AddonState } from '../addons/api'
import type { AppCommand, Hotkeys } from './hotkeys'
import type { WorkspaceState } from './workspace'
