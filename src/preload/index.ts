import { contextBridge, ipcRenderer as transport, webUtils } from 'electron'
import { ADDON_CHANNELS } from '../addons/api'
import { ABOUT_CHANNELS } from '../shared/about'
import { ADDON_HOTKEY_CHANNELS } from '../shared/addon-hotkeys'
import { ADDON_STORAGE_CHANNELS } from '../shared/addon-storage'
import { ADDON_TRUST_CHANNELS } from '../shared/addon-trust'
import { ADDON_WINDOW_CHANNELS } from '../shared/addon-windows'
import { ANALYSIS_CHANNELS } from '../shared/analysis'
import { BACKGROUND_CHANNELS } from '../shared/background'
import { APPEARANCE_CHANNEL } from '../shared/colorschemes'
import { DEPENDENCY_CHANNELS } from '../shared/dependencies'
import {
  APP_INFO_CHANNEL,
  BOOTSTRAP_CHANNELS,
  type DesktopApi,
  DOCUMENT_CHANNELS,
  MAX_DOCUMENT_BYTES,
} from '../shared/desktop'
import type { JournalCheckpoint } from '../shared/document-checkpoint'
import { createDocumentJournal } from '../shared/document-journal'
import { ASSOCIATION_CHANNELS } from '../shared/file-associations'
import type {
  WorkspaceChangeEvent,
  WorkspaceTarget,
} from '../shared/foundation-contracts'
import { GLOBAL_SHORTCUT_CHANNELS } from '../shared/global-shortcuts'
import { HISTORY_CHANNELS } from '../shared/history'
import { HOST_CREDENTIAL_CHANNELS } from '../shared/host-credentials'
import { HOST_NETWORK_CHANNELS } from '../shared/host-network'
import { HOST_SELECTED_IO_CHANNELS } from '../shared/host-selected-io'
import { HOTKEY_CHANNELS } from '../shared/hotkeys'
import { IMPORT_CHANNELS } from '../shared/imports'
import { DIAGNOSTIC_CHANNEL } from '../shared/local-diagnostics'
import { MEDIA_CHANNELS } from '../shared/media'
import { SELECTED_TEXT_CHANNELS } from '../shared/selected-text'
import { SIDELOAD_CHANNELS } from '../shared/sideload'
import { TABLE_LAYOUT_CHANNELS } from '../shared/table-layout'
import { UI_CASE_CHANNEL } from '../shared/ui-case'
import { UPDATE_CHANNELS } from '../shared/updates'
import {
  type KnownWorkspace,
  toRecentWorkspaces,
  WORKSPACE_CHANNELS,
  type WorkspaceChange,
  type WorkspaceChangeListener,
  type WorkspaceState,
  type WorkspaceStreamSnapshot,
} from '../shared/workspace'
import { WORKSPACE_SETTINGS_CHANNELS } from '../shared/workspace-settings'
import { DiagnosticProducer } from './local-diagnostics'

if (process.isMainFrame) {
  try {
    const diagnostics = new DiagnosticProducer((operation, token, body) =>
      transport.invoke(DIAGNOSTIC_CHANNEL, operation, token, body),
    )
    contextBridge.exposeInMainWorld('hibiDiagnostics', {
      record: (wire: unknown) => diagnostics.record(wire),
      configuration: () => diagnostics.configuration,
    })
  } catch {
    /* Diagnostics cannot prevent the document bridge from starting. */
  }
  let checkpoint: ((tabId: string) => JournalCheckpoint) | undefined
  const journal = createDocumentJournal(
    (change) => transport.invoke(DOCUMENT_CHANNELS.append, change),
    {
      timeoutMs: 5000,
      retryDelays: [100, 500, 2000],
      maximumCheckpointUnits: MAX_DOCUMENT_BYTES,
      checkpoint: (tabId) => {
        if (!checkpoint)
          throw new Error('Document recovery is not ready. Retry saving.')
        return checkpoint(tabId)
      },
      head: (tabId) => transport.invoke(DOCUMENT_CHANNELS.recoveryHead, tabId),
      verify: (snapshot) =>
        transport.invoke(DOCUMENT_CHANNELS.verifyCheckpoint, snapshot),
    },
  )
  const invoke: typeof transport.invoke = (channel, ...args) =>
    journal.hasPending()
      ? journal.flush().then(() => transport.invoke(channel, ...args))
      : transport.invoke(channel, ...args)
  const ipcRenderer = {
    invoke,
    on: transport.on.bind(transport),
    removeListener: transport.removeListener.bind(transport),
  }
  function subscribe<T>(channel: string, callback: (payload: T) => void) {
    const listener = (_event: Electron.IpcRendererEvent, payload: T) =>
      callback(payload)
    ipcRenderer.on(channel, listener)
    return () => {
      ipcRenderer.removeListener(channel, listener)
    }
  }
  transport.on(DOCUMENT_CHANNELS.flush, (_event, token: string) => {
    void journal.flush().then(
      () => transport.send(DOCUMENT_CHANNELS.flushed, token, null),
      (error) =>
        transport.send(DOCUMENT_CHANNELS.flushed, token, String(error)),
    )
  })
  transport.send(DOCUMENT_CHANNELS.flushed, 'ready', null)
  let externalPending = false
  ipcRenderer.on(DOCUMENT_CHANNELS.externalPending, () => {
    externalPending = true
  })
  const startupDocument = ipcRenderer.invoke(BOOTSTRAP_CHANNELS.document)
  const startupAddons = ipcRenderer.invoke(BOOTSTRAP_CHANNELS.addons)
  const startupKnown: Promise<KnownWorkspace[]> = ipcRenderer.invoke(
    WORKSPACE_CHANNELS.known,
  )
  let legacyWorkspaceListeners = 0
  const setLegacyWorkspaceSubscription = (enabled: boolean) => {
    void ipcRenderer
      .invoke(WORKSPACE_CHANNELS.legacySubscribe, enabled)
      .catch((error: unknown) =>
        console.error('could not subscribe to workspace changes:', error),
      )
  }
  setLegacyWorkspaceSubscription(false)
  async function subscribeWorkspaceChanges(callback: WorkspaceChangeListener) {
    let pending: WorkspaceChangeEvent[] = []
    let latest: WorkspaceChangeEvent | null = null
    let overflow = false
    let ready = false
    let disposed = false
    let target: WorkspaceTarget | null = null
    let sequence = 0
    const sameTarget = (change: WorkspaceChangeEvent) =>
      target?.workspaceId === change.workspaceId &&
      target.workspaceGeneration === change.workspaceGeneration
    const deliver = (change: WorkspaceChangeEvent, forceResync = false) => {
      if (disposed || (sameTarget(change) && change.sequence <= sequence))
        return
      const gap = !sameTarget(change) || change.sequence !== sequence + 1
      target = {
        workspaceId: change.workspaceId,
        workspaceGeneration: change.workspaceGeneration,
      }
      sequence = change.sequence
      try {
        callback(
          forceResync || gap
            ? { ...change, kind: 'resync', paths: null }
            : change,
        )
      } catch (error) {
        console.error('Could not notify workspace change subscriber:', error)
      }
    }
    const listener = (
      _event: Electron.IpcRendererEvent,
      change: WorkspaceChangeEvent,
    ) => {
      if (!ready) {
        latest = change
        if (pending.length < 256) pending.push(change)
        else overflow = true
      } else deliver(change)
    }
    ipcRenderer.on(WORKSPACE_CHANNELS.changedV2, listener)
    try {
      const snapshot: WorkspaceStreamSnapshot = await ipcRenderer.invoke(
        WORKSPACE_CHANNELS.changeSnapshot,
      )
      if (disposed) return { snapshot, dispose: () => {} }
      target = snapshot.target
      sequence = snapshot.sequence
      ready = true
      if (overflow) {
        if (latest) deliver(latest, true)
      } else for (const change of pending) deliver(change)
      pending = []
      return {
        snapshot,
        dispose() {
          disposed = true
          ipcRenderer.removeListener(WORKSPACE_CHANNELS.changedV2, listener)
        },
      }
    } catch (error) {
      disposed = true
      ipcRenderer.removeListener(WORKSPACE_CHANNELS.changedV2, listener)
      throw error
    }
  }
  for (const pending of [startupDocument, startupAddons, startupKnown])
    void pending.catch(() => {})
  let backgroundSettingsReady = false
  contextBridge.exposeInMainWorld('hibi', {
    registerGlobalShortcut: (id, accelerator, token) =>
      ipcRenderer.invoke(
        GLOBAL_SHORTCUT_CHANNELS.register,
        id,
        accelerator,
        token,
      ),
    unregisterGlobalShortcut: (id, token) =>
      ipcRenderer.invoke(GLOBAL_SHORTCUT_CHANNELS.unregister, id, token),
    openAddonWindow: (addonId, options) =>
      ipcRenderer.invoke(ADDON_WINDOW_CHANNELS.open, addonId, options),
    focusAddonWindow: (addonId, id) =>
      ipcRenderer.invoke(ADDON_WINDOW_CHANNELS.focus, addonId, id),
    closeAddonWindow: (addonId, id) =>
      ipcRenderer.invoke(ADDON_WINDOW_CHANNELS.close, addonId, id),
    onAddonWindowClosed: (callback) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        addonId: string,
        id: string,
      ) => callback(addonId, id)
      ipcRenderer.on(ADDON_WINDOW_CHANNELS.closed, listener)
      return () => {
        ipcRenderer.removeListener(ADDON_WINDOW_CHANNELS.closed, listener)
      }
    },
    getAddonWindowOwners: () =>
      ipcRenderer.invoke(ADDON_WINDOW_CHANNELS.owners),
    ...(import.meta.env.DEV
      ? {
          updateDevelopmentAddon: (
            value: unknown,
            contract: string,
            apply = false,
          ) =>
            ipcRenderer.invoke(
              'addons:development-manifest',
              value,
              contract,
              apply,
            ),
        }
      : {}),
    onAddonReload: (callback) => subscribe(ADDON_CHANNELS.reload, callback),
    onGlobalShortcut: (callback) =>
      subscribe(GLOBAL_SHORTCUT_CHANNELS.invoked, callback),
    getBackgroundMode: () => transport.invoke(BACKGROUND_CHANNELS.get),
    setBackgroundMode: (enabled) =>
      transport.invoke(BACKGROUND_CHANNELS.set, enabled),
    onOpenSettings: (callback) => {
      const listener = () => callback()
      transport.on(BACKGROUND_CHANNELS.settings, listener)
      if (!backgroundSettingsReady) {
        backgroundSettingsReady = true
        void transport
          .invoke(BACKGROUND_CHANNELS.settingsReady)
          .catch(console.error)
      }
      return () => {
        transport.removeListener(BACKGROUND_CHANNELS.settings, listener)
      }
    },
    getUpdateState: () => transport.invoke(UPDATE_CHANNELS.get),
    setUpdateChannel: (channel) =>
      transport.invoke(UPDATE_CHANNELS.channel, channel),
    setUpdateStartupCheck: (enabled) =>
      transport.invoke(UPDATE_CHANNELS.startup, enabled),
    setUpdateCheckFrequency: (hours) =>
      transport.invoke(UPDATE_CHANNELS.frequency, hours),
    checkForUpdates: () => transport.invoke(UPDATE_CHANNELS.check),
    downloadUpdate: () => transport.invoke(UPDATE_CHANNELS.download),
    installUpdate: () => ipcRenderer.invoke(UPDATE_CHANNELS.install),
    onUpdateChanged: (callback) => subscribe(UPDATE_CHANNELS.changed, callback),
    getDependencies: (owner) =>
      transport.invoke(DEPENDENCY_CHANNELS.list, owner),
    checkDependency: (target) =>
      transport.invoke(DEPENDENCY_CHANNELS.check, target),
    installDependency: (target) =>
      transport.invoke(DEPENDENCY_CHANNELS.install, target),
    configureDependency: (key, action) =>
      transport.invoke(DEPENDENCY_CHANNELS.path, key, action),
    openDependencyGuide: (key) =>
      transport.invoke(DEPENDENCY_CHANNELS.guide, key),
    analyzeDocument: (owner, projection) =>
      ipcRenderer.invoke(ANALYSIS_CHANNELS.run, owner, projection),
    cancelAnalysis: (owner) =>
      ipcRenderer.invoke(ANALYSIS_CHANNELS.cancel, owner),
    appendDocumentChange: journal.append,
    appendSourceOperation: journal.appendOperation,
    admitSourceOperation: journal.assertCapacity,
    getDocumentRecoveryState: journal.state,
    onDocumentCheckpoint: (callback) => {
      checkpoint = callback
      return () => {
        if (checkpoint === callback) checkpoint = undefined
      }
    },
    flushDocumentChanges: journal.flush,
    bootstrap: {
      document: () => startupDocument,
      addons: () => startupAddons,
      knownWorkspaces: () => startupKnown,
      recentWorkspaces: () => startupKnown.then(toRecentWorkspaces),
    },
    getAddonDocumentation: (id, path) =>
      ipcRenderer.invoke(SIDELOAD_CHANNELS.documentation, id, path),
    openAddonDocumentationLink: (href) =>
      ipcRenderer.invoke(SIDELOAD_CHANNELS.link, href),
    getFileAssociations: () => ipcRenderer.invoke(ASSOCIATION_CHANNELS.get),
    setFileAssociation: (format) =>
      ipcRenderer.invoke(ASSOCIATION_CHANNELS.set, format),
    navigateDocument: (direction) =>
      ipcRenderer.invoke(DOCUMENT_CHANNELS.navigate, direction),
    openDocumentLink: (href, revision) =>
      ipcRenderer.invoke(DOCUMENT_CHANNELS.link, href, revision),
    openRemoteDocument: (url) =>
      ipcRenderer.invoke(DOCUMENT_CHANNELS.remote, url),
    onOpenRemote: (callback) => {
      const listener = () => callback()
      ipcRenderer.on(DOCUMENT_CHANNELS.requestRemote, listener)
      return () => {
        ipcRenderer.removeListener(DOCUMENT_CHANNELS.requestRemote, listener)
      }
    },
    attachMedia: (files, revision) =>
      ipcRenderer.invoke(
        MEDIA_CHANNELS.attach,
        files === null
          ? null
          : files.map((file) => webUtils.getPathForFile(file)),
        revision,
      ),
    readDocumentMedia: (source, revision) =>
      ipcRenderer.invoke(MEDIA_CHANNELS.read, source, revision),
    resolveDocumentMedia: (source, revision, request) =>
      ipcRenderer.invoke(MEDIA_CHANNELS.resolve, source, revision, request),
    cancelDocumentMedia: (request) =>
      ipcRenderer.invoke(MEDIA_CHANNELS.cancel, request),
    onDocumentMediaScopeChanged: (callback) =>
      subscribe(MEDIA_CHANNELS.scopeChanged, callback),
    openDroppedFile: (file, includeEntries = true) =>
      ipcRenderer.invoke(
        MEDIA_CHANNELS.open,
        webUtils.getPathForFile(file),
        includeEntries,
      ),
    getInstalledAddons: () => ipcRenderer.invoke(SIDELOAD_CHANNELS.list),
    getAddonTrustSettings: () => ipcRenderer.invoke(ADDON_TRUST_CHANNELS.get),
    setAddonTrustSettings: (changes) =>
      ipcRenderer.invoke(ADDON_TRUST_CHANNELS.set, changes),
    onAddonTrustChanged: (callback) => {
      const listener = () => callback()
      ipcRenderer.on(ADDON_TRUST_CHANNELS.changed, listener)
      return () => {
        ipcRenderer.removeListener(ADDON_TRUST_CHANNELS.changed, listener)
      }
    },
    getInstalledAddonResources: (id) =>
      ipcRenderer.invoke(SIDELOAD_CHANNELS.resources, id),
    installAddon: (url, openSettings) =>
      ipcRenderer.invoke(SIDELOAD_CHANNELS.install, url, openSettings),
    getAddonDirectory: (refresh) =>
      ipcRenderer.invoke(SIDELOAD_CHANNELS.directory, refresh),
    installDirectoryAddon: (id, openSettings) =>
      ipcRenderer.invoke(SIDELOAD_CHANNELS.directoryInstall, id, openSettings),
    onAddonGardenRequest: (callback) => {
      let active = true
      const listener = () => {
        void ipcRenderer
          .invoke(SIDELOAD_CHANNELS.gardenRequests)
          .then(
            (
              requests: import('../shared/addon-directory').AddonGardenRequest[],
            ) => {
              if (active) for (const request of requests) callback(request)
            },
          )
          .catch(console.error)
      }
      ipcRenderer.on(SIDELOAD_CHANNELS.gardenPending, listener)
      // StrictMode mounts, disposes, and mounts effects before this microtask.
      // A disposed subscription must not drain startup links for the live one.
      queueMicrotask(() => {
        if (active) listener()
      })
      return () => {
        active = false
        ipcRenderer.removeListener(SIDELOAD_CHANNELS.gardenPending, listener)
      }
    },
    installAddonSelection: (id, keys, openSettings) =>
      ipcRenderer.invoke(SIDELOAD_CHANNELS.selection, id, keys, openSettings),
    cancelAddonInstall: (id) =>
      ipcRenderer.invoke(SIDELOAD_CHANNELS.cancel, id),
    openAddonsFolder: () => ipcRenderer.invoke(SIDELOAD_CHANNELS.folder),
    openAddonGarden: () => ipcRenderer.invoke(SIDELOAD_CHANNELS.garden),
    removeAddon: (id) => ipcRenderer.invoke(SIDELOAD_CHANNELS.remove, id),
    listVersions: () => ipcRenderer.invoke(HISTORY_CHANNELS.list),
    previewVersion: (id) => ipcRenderer.invoke(HISTORY_CHANNELS.preview, id),
    restoreVersion: (id) => ipcRenderer.invoke(HISTORY_CHANNELS.restore, id),
    onNotice: (callback) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        message: string,
        target?: 'updates',
      ) => callback(message, target === 'updates' ? target : undefined)
      ipcRenderer.on(HISTORY_CHANNELS.notice, listener)
      return () => {
        ipcRenderer.removeListener(HISTORY_CHANNELS.notice, listener)
      }
    },
    getLicenses: () => ipcRenderer.invoke(ABOUT_CHANNELS.licenses),
    getLicense: (id) => ipcRenderer.invoke(ABOUT_CHANNELS.license, id),
    openSponsor: () => ipcRenderer.invoke(ABOUT_CHANNELS.sponsor),
    setAppearance: (appearance) =>
      ipcRenderer.invoke(APPEARANCE_CHANNEL, appearance),
    getAddonStates: () => ipcRenderer.invoke(ADDON_CHANNELS.states),
    setAddonEnabled: (id, enabled, includeRequired) =>
      ipcRenderer.invoke(ADDON_CHANNELS.enable, id, enabled, includeRequired),
    readAddonStorage: (request) =>
      transport.invoke(ADDON_STORAGE_CHANNELS.read, request),
    writeAddonStorage: (request) =>
      transport.invoke(ADDON_STORAGE_CHANNELS.write, request),
    onAddonStorageChanged: (callback) =>
      subscribe(ADDON_STORAGE_CHANNELS.changed, callback),
    selectUserText: (owner) =>
      transport.invoke(SELECTED_TEXT_CHANNELS.select, owner),
    readSelectedText: (owner, handle) =>
      transport.invoke(SELECTED_TEXT_CHANNELS.read, owner, handle),
    selectHostImport: (owner, choice) =>
      transport.invoke(HOST_SELECTED_IO_CHANNELS.selectImport, owner, choice),
    readHostImport: (owner, handle) =>
      transport.invoke(HOST_SELECTED_IO_CHANNELS.readImport, owner, handle),
    selectHostExport: (owner, choice) =>
      transport.invoke(HOST_SELECTED_IO_CHANNELS.selectExport, owner, choice),
    writeHostExport: (owner, handle, bytes) =>
      transport.invoke(
        HOST_SELECTED_IO_CHANNELS.writeExport,
        owner,
        handle,
        bytes,
      ),
    cancelHostSelectedIo: (owner, handle) =>
      transport.invoke(HOST_SELECTED_IO_CHANNELS.cancel, owner, handle),
    getHostText: (owner, request) =>
      transport.invoke(HOST_NETWORK_CHANNELS.getText, owner, request),
    requestHostText: (owner, request) =>
      transport.invoke(HOST_NETWORK_CHANNELS.requestText, owner, request),
    storeHostCredential: (owner, request) =>
      transport.invoke(HOST_CREDENTIAL_CHANNELS.store, owner, request),
    removeHostCredential: (owner, request) =>
      transport.invoke(HOST_CREDENTIAL_CHANNELS.remove, owner, request),
    getHostCredentialStatus: (owner, request) =>
      transport.invoke(HOST_CREDENTIAL_CHANNELS.status, owner, request),
    invokeAddon: (id, method, input) =>
      ipcRenderer.invoke(ADDON_CHANNELS.invoke, id, method, input),
    queryAddon: (id, method, input) =>
      ipcRenderer.invoke(ADDON_CHANNELS.query, id, method, input),
    invokeAddonProfile: (id, method, input) =>
      ipcRenderer.invoke(ADDON_CHANNELS.profile, id, method, input),
    getWorkspace: () => ipcRenderer.invoke(WORKSPACE_CHANNELS.get),
    getWorkspaceHeader: () => ipcRenderer.invoke(WORKSPACE_CHANNELS.header),
    readWorkspaceViewPage: (request) =>
      ipcRenderer.invoke(WORKSPACE_CHANNELS.viewPage, request),
    onWorkspaceHeaderChanged: (callback) =>
      subscribe(WORKSPACE_CHANNELS.headerChanged, callback),
    getWorkspaceChangeSnapshot: () =>
      ipcRenderer.invoke(WORKSPACE_CHANNELS.changeSnapshot),
    listWorkspaceEntryPage: (owner, request) =>
      ipcRenderer.invoke(WORKSPACE_CHANNELS.listPage, owner, request),
    subscribeWorkspaceChanges,
    readTableLayout: (tabId) =>
      ipcRenderer.invoke(TABLE_LAYOUT_CHANNELS.read, tabId),
    writeTableLayout: (tabId, tables) =>
      ipcRenderer.invoke(TABLE_LAYOUT_CHANNELS.write, tabId, tables),
    readWorkspaceText: (owner, target, path) =>
      ipcRenderer.invoke(WORKSPACE_CHANNELS.readText, owner, target, path),
    readWorkspaceBinary: (owner, target, path) =>
      ipcRenderer.invoke(WORKSPACE_CHANNELS.readBinary, owner, target, path),
    createWorkspaceText: (owner, target, path, markdown) =>
      ipcRenderer.invoke(
        WORKSPACE_CHANNELS.createText,
        owner,
        target,
        path,
        markdown,
      ),
    createWorkspaceBinary: (owner, target, path, bytes) =>
      ipcRenderer.invoke(
        WORKSPACE_CHANNELS.createBinary,
        owner,
        target,
        path,
        bytes,
      ),
    updateWorkspaceText: (
      owner,
      target,
      path,
      expectedVersion,
      markdown,
      options,
    ) =>
      ipcRenderer.invoke(
        WORKSPACE_CHANNELS.updateText,
        owner,
        target,
        path,
        expectedVersion,
        markdown,
        options,
      ),
    renameWorkspaceFile: (
      owner,
      target,
      sourcePath,
      destinationPath,
      expectedVersion,
    ) =>
      ipcRenderer.invoke(
        WORKSPACE_CHANNELS.renameFile,
        owner,
        target,
        sourcePath,
        destinationPath,
        expectedVersion,
      ),
    trashWorkspaceFile: (owner, target, path, expectedVersion) =>
      ipcRenderer.invoke(
        WORKSPACE_CHANNELS.trashFile,
        owner,
        target,
        path,
        expectedVersion,
      ),
    queryWorkspaceReferences: (request) =>
      ipcRenderer.invoke(WORKSPACE_CHANNELS.queryReferences, request),
    cancelWorkspaceImport: () => ipcRenderer.invoke(IMPORT_CHANNELS.cancel),
    listImporters: () => ipcRenderer.invoke(IMPORT_CHANNELS.list),
    importIntoWorkspace: (request) =>
      ipcRenderer.invoke(IMPORT_CHANNELS.run, request),
    getWorkspaceSettings: () =>
      ipcRenderer.invoke(WORKSPACE_SETTINGS_CHANNELS.get),
    updateWorkspaceSettings: (action) =>
      ipcRenderer.invoke(WORKSPACE_SETTINGS_CHANNELS.update, action),
    getRecentWorkspaces: () => ipcRenderer.invoke(WORKSPACE_CHANNELS.recent),
    getKnownWorkspaces: () => ipcRenderer.invoke(WORKSPACE_CHANNELS.known),
    openRecentWorkspace: (id, includeEntries = true) =>
      ipcRenderer.invoke(WORKSPACE_CHANNELS.openRecent, id, includeEntries),
    setKnownWorkspace: (id, action) =>
      ipcRenderer.invoke(WORKSPACE_CHANNELS.setKnown, id, action),
    deleteKnownWorkspace: (id) =>
      ipcRenderer.invoke(WORKSPACE_CHANNELS.deleteKnown, id),
    getWorkspaceSnapshot: () => ipcRenderer.invoke(WORKSPACE_CHANNELS.snapshot),
    getWorkspaceIndex: (verifyAll = false) =>
      ipcRenderer.invoke(WORKSPACE_CHANNELS.index, verifyAll),
    workspaceAction: (action, includeEntries = true) =>
      ipcRenderer.invoke(WORKSPACE_CHANNELS.action, action, includeEntries),
    openWorkspace: (includeEntries = true) =>
      ipcRenderer.invoke(WORKSPACE_CHANNELS.open, includeEntries),
    refreshWorkspace: (includeEntries = true) =>
      ipcRenderer.invoke(WORKSPACE_CHANNELS.refresh, includeEntries),
    openWorkspaceFile: (path, target) =>
      ipcRenderer.invoke(WORKSPACE_CHANNELS.openFile, path, target),
    onWorkspaceChanged: (callback) => {
      let active = true
      const listener = (
        _event: Electron.IpcRendererEvent,
        workspace: WorkspaceState | null,
        change?: WorkspaceChange,
      ) => callback(workspace, change)
      ipcRenderer.on(WORKSPACE_CHANNELS.changed, listener)
      if (++legacyWorkspaceListeners === 1) setLegacyWorkspaceSubscription(true)
      return () => {
        if (!active) return
        active = false
        ipcRenderer.removeListener(WORKSPACE_CHANNELS.changed, listener)
        if (--legacyWorkspaceListeners === 0)
          setLegacyWorkspaceSubscription(false)
      }
    },
    onWorkspaceListChanged: (callback) =>
      subscribe(WORKSPACE_CHANNELS.listChanged, callback),
    getAppInfo: () => ipcRenderer.invoke(APP_INFO_CHANNEL),
    setUiCase: (value) => ipcRenderer.invoke(UI_CASE_CHANNEL, value),
    getDocument: () => ipcRenderer.invoke(DOCUMENT_CHANNELS.get),
    selectDocumentTab: (id) =>
      ipcRenderer.invoke(DOCUMENT_CHANNELS.selectTab, id),
    focusDocumentTab: (id, expected) =>
      ipcRenderer.invoke(DOCUMENT_CHANNELS.focusTab, id, expected),
    closeDocumentTab: (id) =>
      ipcRenderer.invoke(DOCUMENT_CHANNELS.closeTab, id),
    moveDocumentTab: (id, beforeId) =>
      ipcRenderer.invoke(DOCUMENT_CHANNELS.moveTab, id, beforeId),
    setTabsEnabled: (enabled) =>
      ipcRenderer.invoke(DOCUMENT_CHANNELS.tabsEnabled, enabled),
    updateDocument: (markdown) =>
      ipcRenderer.invoke(DOCUMENT_CHANNELS.update, markdown),
    openDocument: () => ipcRenderer.invoke(DOCUMENT_CHANNELS.open),
    openExternalDocuments: () => {
      externalPending = false
      return ipcRenderer.invoke(DOCUMENT_CHANNELS.external)
    },
    onExternalDocuments: (callback) => {
      const listener = () => callback()
      ipcRenderer.on(DOCUMENT_CHANNELS.externalPending, listener)
      if (externalPending) queueMicrotask(callback)
      return () => {
        ipcRenderer.removeListener(DOCUMENT_CHANNELS.externalPending, listener)
      }
    },
    newDocument: () => ipcRenderer.invoke(DOCUMENT_CHANNELS.new),
    saveDocument: (saveAs) =>
      ipcRenderer.invoke(DOCUMENT_CHANNELS.save, saveAs),
    saveTargetDocument: (owner, tabId, revision, contentVersion) =>
      ipcRenderer.invoke(
        DOCUMENT_CHANNELS.saveTarget,
        owner,
        tabId,
        revision,
        contentVersion,
      ),
    autosaveDocument: (tabId, revision) =>
      ipcRenderer.invoke(DOCUMENT_CHANNELS.autosave, tabId, revision),
    renameDocument: (name) =>
      ipcRenderer.invoke(DOCUMENT_CHANNELS.rename, name),
    readDocumentImage: (source, revision) =>
      ipcRenderer.invoke(DOCUMENT_CHANNELS.image, source, revision),
    getHotkeys: () => ipcRenderer.invoke(HOTKEY_CHANNELS.get),
    getAddonHotkeys: () => ipcRenderer.invoke(ADDON_HOTKEY_CHANNELS.get),
    registerAddonHotkey: (registration) =>
      ipcRenderer.invoke(ADDON_HOTKEY_CHANNELS.register, registration),
    unregisterAddonHotkey: (id, token) =>
      ipcRenderer.invoke(ADDON_HOTKEY_CHANNELS.unregister, id, token),
    saveAddonHotkey: (id, shortcut) =>
      ipcRenderer.invoke(ADDON_HOTKEY_CHANNELS.save, id, shortcut),
    resetAddonHotkey: (id) =>
      ipcRenderer.invoke(ADDON_HOTKEY_CHANNELS.reset, id),
    onAddonHotkeysChanged: (callback) =>
      subscribe(ADDON_HOTKEY_CHANNELS.changed, callback),
    onAddonCommand: (callback) =>
      subscribe(ADDON_HOTKEY_CHANNELS.invoke, callback),
    saveHotkeys: (hotkeys) => ipcRenderer.invoke(HOTKEY_CHANNELS.save, hotkeys),
    setHotkeyRecording: (recording) =>
      ipcRenderer.invoke(HOTKEY_CHANNELS.record, recording),
    onCommand: (callback) => subscribe(HOTKEY_CHANNELS.command, callback),
  } satisfies DesktopApi)
}
