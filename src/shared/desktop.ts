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
  saveTarget: 'document:save-target',
  autosave: 'document:autosave',
  selectTab: 'document:select-tab',
  focusTab: 'document:focus-tab',
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
export type DocumentFocus = Omit<DocumentState, 'markdown' | 'savedMarkdown'>
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
  getBackgroundMode: () => Promise<boolean>
  setBackgroundMode: (enabled: boolean) => Promise<boolean>
  onOpenSettings: (callback: () => void) => () => void
  getAddonHotkeys: () => Promise<import('./addon-hotkeys').AddonHotkeyBinding[]>
  registerAddonHotkey: (
    registration: import('./addon-hotkeys').AddonHotkeyRegistration,
  ) => Promise<import('./addon-hotkeys').AddonHotkeyBinding[]>
  unregisterAddonHotkey: (id: string, token: string) => Promise<void>
  saveAddonHotkey: (
    id: string,
    shortcut: string,
  ) => Promise<import('./addon-hotkeys').AddonHotkeyBinding[]>
  resetAddonHotkey: (
    id: string,
  ) => Promise<import('./addon-hotkeys').AddonHotkeyBinding[]>
  onAddonHotkeysChanged: (
    callback: (
      bindings: import('./addon-hotkeys').AddonHotkeyBinding[],
    ) => void,
  ) => () => void
  onAddonCommand: (
    callback: (
      invocation: import('./addon-hotkeys').AddonCommandInvocation,
    ) => void,
  ) => () => void
  registerGlobalShortcut: (
    id: string,
    accelerator: string,
    token: string,
  ) => Promise<void>
  unregisterGlobalShortcut: (id: string, token: string) => Promise<void>
  openAddonWindow: (
    addonId: string,
    options: import('./addon-windows').AddonWindowOptions,
  ) => Promise<void>
  focusAddonWindow: (addonId: string, id: string) => Promise<void>
  closeAddonWindow: (addonId: string, id: string) => Promise<void>
  onAddonWindowClosed: (
    callback: (addonId: string, id: string) => void,
  ) => () => void
  /** Addons whose windows are open, loading, or kept alive while hidden. */
  getAddonWindowOwners: () => Promise<string[]>
  /** Source development only; validates metadata, then applies it after the renderer commits. */
  updateDevelopmentAddon?: (
    manifest: unknown,
    contract: string,
    apply?: boolean,
  ) => Promise<void>
  /** `styles` swaps package stylesheets and themes; `code` restarts the addon and its required consumers. */
  onAddonReload: (
    callback: (request: { id: string; scope: 'code' | 'styles' }) => void,
  ) => () => void
  onGlobalShortcut: (
    callback: (
      invocation: import('./global-shortcuts').GlobalShortcutInvocation,
    ) => void,
  ) => () => void
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
      /** Installed builds may show the first-run introduction unless launched with files; development and tests need --hibi-introduction. */
      introduction: boolean
    }>
    addons: () => Promise<{
      states: AddonState[]
      packages: import('./sideload').InstalledAddon[]
      notices: string[]
    }>
    recentWorkspaces: () => Promise<import('./workspace').RecentWorkspace[]>
    knownWorkspaces: () => Promise<import('./workspace').KnownWorkspace[]>
  }
  cancelWorkspaceImport: () => Promise<void>
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
  /** Internal cancellable display resolution; addon byte reads retain their existing bridge. */
  resolveDocumentMedia: (
    source: string,
    revision: number,
    request: string,
  ) => Promise<import('./media').DocumentMediaResolution | null>
  cancelDocumentMedia: (request: string) => Promise<void>
  onDocumentMediaScopeChanged: (
    callback: (revision: number) => void,
  ) => () => void
  openDroppedFile: (
    file: File,
    includeEntries?: boolean,
  ) => Promise<{
    document: DocumentState | null
    workspace?: WorkspaceState | null
  } | null>
  getInstalledAddons: () => Promise<import('./sideload').InstalledAddon[]>
  getAddonTrustSettings: () => Promise<
    import('./addon-trust').AddonTrustSettings
  >
  setAddonTrustSettings: (
    changes: import('./addon-trust').AddonTrustSettings,
  ) => Promise<import('./addon-trust').AddonTrustSettings>
  /** Revocations or trust settings changed in the main process; refetch addon states and installed addons. */
  onAddonTrustChanged: (callback: () => void) => () => void
  /** Declared stylesheets and themes read again from an installed addon's files. */
  getInstalledAddonResources: (
    id: string,
  ) => Promise<Pick<import('./sideload').InstalledAddon, 'styles' | 'themes'>>
  /** `openSettings` lists addons whose settings are on screen; a replacement of one is refused. */
  installAddon: (
    url?: string,
    openSettings?: readonly string[],
  ) => Promise<import('./sideload').AddonInstallSession | null>
  getAddonDirectory: (
    refresh?: boolean,
  ) => Promise<import('./addon-directory').AddonDirectory>
  installDirectoryAddon: (
    id: string,
    openSettings?: readonly string[],
  ) => Promise<import('./sideload').AddonInstallSession | null>
  onAddonGardenRequest: (
    callback: (request: import('./addon-directory').AddonGardenRequest) => void,
  ) => () => void
  installAddonSelection: (
    sessionId: string,
    candidateKeys: string[],
    openSettings?: readonly string[],
  ) => Promise<import('./sideload').AddonInstallResult[]>
  cancelAddonInstall: (sessionId: string) => Promise<void>
  openAddonsFolder: () => Promise<void>
  openAddonGarden: () => Promise<void>
  removeAddon: (id: string) => Promise<void>
  listVersions: () => Promise<import('./history').DocumentVersion[]>
  previewVersion: (id: string) => Promise<string>
  restoreVersion: (id: string) => Promise<DocumentState | null>
  /** `updates` notices lead to the update settings. */
  onNotice: (
    callback: (message: string, target?: 'updates') => void,
  ) => () => void
  getLicenses: () => Promise<import('./about').LicenseInfo[]>
  getLicense: (id: string) => Promise<string>
  openSponsor: () => Promise<void>
  setAppearance: (
    appearance: import('./colorschemes').NativeAppearance,
  ) => Promise<void>
  getAddonStates: () => Promise<AddonState[]>
  setAddonEnabled: (
    id: string,
    enabled: boolean,
    includeRequired?: boolean,
  ) => Promise<AddonState[]>
  readAddonStorage: (
    request: import('./addon-storage').AddonStorageReadRequest,
  ) => Promise<import('./addon-storage').AddonStorageReadResult>
  writeAddonStorage: (
    request: import('./addon-storage').AddonStorageWriteRequest,
  ) => Promise<import('./addon-storage').AddonStorageWriteResult>
  onAddonStorageChanged: (
    callback: (change: import('./addon-storage').AddonStorageChange) => void,
  ) => () => void
  selectUserText: (
    owner: string,
  ) => Promise<import('./selected-text').SelectedTextSelection>
  readSelectedText: (
    owner: string,
    handle: string,
  ) => Promise<import('./selected-text').SelectedTextRead>
  selectHostImport: (
    owner: string,
    choice?: import('./host-selected-io').HostImportChoice,
  ) => Promise<import('./host-selected-io').HostSelectedIoSelection>
  readHostImport: (
    owner: string,
    handle: string,
  ) => Promise<import('./host-selected-io').HostSelectedIoRead>
  selectHostExport: (
    owner: string,
    choice: import('./host-selected-io').HostExportChoice,
  ) => Promise<import('./host-selected-io').HostSelectedIoSelection>
  writeHostExport: (
    owner: string,
    handle: string,
    bytes: Uint8Array,
  ) => Promise<import('./host-selected-io').HostSelectedIoWrite>
  cancelHostSelectedIo: (
    owner: string,
    handle: string,
  ) => Promise<import('./host-selected-io').HostSelectedIoCancel>
  getHostText: (
    owner: string,
    request: import('./host-network').HostTextRequest,
  ) => Promise<import('./host-network').HostTextResult>
  requestHostText: (
    owner: string,
    request: import('./host-network').HostTextPostRequest,
  ) => Promise<import('./host-network').HostTextResult>
  storeHostCredential: (
    owner: string,
    request: import('./host-credentials').StoreCredentialRequest,
  ) => Promise<
    import('./host-credentials').CredentialResult<{
      mode: import('./host-credentials').CredentialMode
    }>
  >
  removeHostCredential: (
    owner: string,
    request: import('./host-credentials').CredentialKeyRequest,
  ) => Promise<
    import('./host-credentials').CredentialResult<{ removed: boolean }>
  >
  getHostCredentialStatus: (
    owner: string,
    request: import('./host-credentials').CredentialKeyRequest,
  ) => Promise<
    import('./host-credentials').CredentialResult<
      import('./host-credentials').CredentialStatus
    >
  >
  invokeAddon: (id: string, method: string, input?: unknown) => Promise<unknown>
  queryAddon: (id: string, method: string, input?: unknown) => Promise<unknown>
  getWorkspace: () => Promise<WorkspaceState | null>
  getWorkspaceHeader: () => Promise<
    import('./workspace-view').WorkspaceHeader | null
  >
  readWorkspaceViewPage: (
    request: import('./workspace-view').WorkspaceViewPageRequest,
  ) => Promise<import('./workspace-view').WorkspaceViewPageResult>
  onWorkspaceHeaderChanged: (
    callback: (change?: import('./workspace').WorkspaceChange) => void,
  ) => () => void
  getWorkspaceChangeSnapshot: () => Promise<
    import('./workspace').WorkspaceStreamSnapshot
  >
  listWorkspaceEntryPage: (
    owner: string,
    request: import('./workspace').WorkspaceEntryPageRequest,
  ) => Promise<import('./workspace').WorkspaceEntryPageResult>
  subscribeWorkspaceChanges: (
    callback: import('./workspace').WorkspaceChangeListener,
  ) => Promise<import('./workspace').WorkspaceChangeSubscription>
  /** Null when the document is not saved inside the open workspace. */
  readTableLayout: (
    tabId: string,
  ) => Promise<import('./table-layout').TableLayout[] | null>
  writeTableLayout: (
    tabId: string,
    tables: import('./table-layout').TableLayout[],
  ) => Promise<void>
  readWorkspaceText: (
    owner: string,
    target: import('./foundation-contracts').WorkspaceTarget,
    path: string,
  ) => Promise<
    import('./workspace').WorkspaceFileResult<
      import('./workspace').WorkspaceTextRead
    >
  >
  readWorkspaceBinary: (
    owner: string,
    target: import('./foundation-contracts').WorkspaceTarget,
    path: string,
  ) => Promise<
    import('./workspace').WorkspaceFileResult<
      import('./workspace').WorkspaceBinaryRead
    >
  >
  createWorkspaceText: (
    owner: string,
    target: import('./foundation-contracts').WorkspaceTarget,
    path: string,
    markdown: string,
  ) => Promise<
    import('./workspace').WorkspaceFileResult<
      import('./workspace').WorkspaceTextCreation
    >
  >
  createWorkspaceBinary: (
    owner: string,
    target: import('./foundation-contracts').WorkspaceTarget,
    path: string,
    bytes: Uint8Array,
  ) => Promise<
    import('./workspace').WorkspaceFileResult<
      import('./workspace').WorkspaceBinaryCreation
    >
  >
  updateWorkspaceText: (
    owner: string,
    target: import('./foundation-contracts').WorkspaceTarget,
    path: string,
    expectedVersion: string,
    markdown: string,
    options: import('./workspace').WorkspaceTextUpdateOptions,
  ) => Promise<
    import('./workspace').WorkspaceFileResult<
      import('./workspace').WorkspaceTextUpdate
    >
  >
  renameWorkspaceFile: (
    owner: string,
    target: import('./foundation-contracts').WorkspaceTarget,
    sourcePath: string,
    destinationPath: string,
    expectedVersion: import('./workspace').WorkspaceFileVersion,
  ) => Promise<
    import('./workspace').WorkspaceFileResult<
      import('./workspace').WorkspaceFileRename
    >
  >
  trashWorkspaceFile: (
    owner: string,
    target: import('./foundation-contracts').WorkspaceTarget,
    path: string,
    expectedVersion: import('./workspace').WorkspaceFileVersion,
  ) => Promise<
    import('./workspace').WorkspaceFileResult<
      import('./workspace').WorkspaceFileTrash
    >
  >
  queryWorkspaceReferences: (
    request: import('./workspace-query').WorkspaceReferenceQueryRequest,
  ) => Promise<
    import('./foundation-contracts').OperationResult<
      import('./workspace-query').WorkspaceReferenceQueryResult,
      import('./workspace-query').QueryFailure
    >
  >
  getWorkspaceSettings: () => Promise<
    import('./workspace-settings').WorkspaceSettings
  >
  updateWorkspaceSettings: (
    action: import('./workspace-settings').WorkspaceSettingsAction,
  ) => Promise<import('./workspace-settings').WorkspaceSettings>
  getRecentWorkspaces: () => Promise<import('./workspace').RecentWorkspace[]>
  getKnownWorkspaces: () => Promise<import('./workspace').KnownWorkspace[]>
  openRecentWorkspace: (
    id: string,
    includeEntries?: boolean,
  ) => Promise<WorkspaceState | null>
  setKnownWorkspace: (
    id: string,
    action: 'pin' | 'unpin' | 'hide',
  ) => Promise<import('./workspace').KnownWorkspace[]>
  deleteKnownWorkspace: (id: string) => Promise<boolean>
  getWorkspaceSnapshot: () => Promise<import('./workspace').WorkspaceSnapshot>
  /** Recheck every indexed file after focus if a filesystem watcher missed changes. */
  getWorkspaceIndex: (
    verifyAll?: boolean,
  ) => Promise<import('./workspace').WorkspaceIndex | null>
  workspaceAction: (
    action: import('./workspace').WorkspaceAction,
    includeEntries?: boolean,
  ) => Promise<import('./workspace').WorkspaceActionResult | null>
  openWorkspace: (includeEntries?: boolean) => Promise<WorkspaceState | null>
  refreshWorkspace: (includeEntries?: boolean) => Promise<WorkspaceState | null>
  /** `target` rejects the request if another workspace session replaced it. */
  openWorkspaceFile: (
    path: string,
    target?: import('./foundation-contracts').WorkspaceTarget,
  ) => Promise<DocumentState | null>
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
  focusDocumentTab: (
    id: string,
    expected: Pick<DocumentFocus, 'contentVersion' | 'revision'>,
  ) => Promise<DocumentFocus>
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
    callback: (
      tabId: string,
    ) => import('./document-checkpoint').JournalCheckpoint,
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
  saveTargetDocument: (
    owner: string,
    tabId: string,
    revision: number,
    contentVersion: number,
  ) => Promise<import('./document-edits').DocumentSaveResult>
  autosaveDocument: (tabId: string, revision: number) => Promise<AutosaveResult>
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
