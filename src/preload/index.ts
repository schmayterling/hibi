import { contextBridge, ipcRenderer as transport, webUtils } from 'electron'
import { ADDON_CHANNELS } from '../addons/api'
import { ABOUT_CHANNELS } from '../shared/about'
import {
  ADDON_HOTKEY_CHANNELS,
  type AddonCommandInvocation,
  type AddonHotkeyBinding,
} from '../shared/addon-hotkeys'
import {
  ADDON_STORAGE_CHANNELS,
  type AddonStorageChange,
} from '../shared/addon-storage'
import { ANALYSIS_CHANNELS } from '../shared/analysis'
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
import {
  GLOBAL_SHORTCUT_CHANNELS,
  type GlobalShortcutInvocation,
} from '../shared/global-shortcuts'
import { HISTORY_CHANNELS } from '../shared/history'
import { type AppCommand, HOTKEY_CHANNELS } from '../shared/hotkeys'
import { IMPORT_CHANNELS } from '../shared/imports'
import { DIAGNOSTIC_CHANNEL } from '../shared/local-diagnostics'
import { MEDIA_CHANNELS } from '../shared/media'
import { SELECTED_TEXT_CHANNELS } from '../shared/selected-text'
import { SIDELOAD_CHANNELS } from '../shared/sideload'
import { UI_CASE_CHANNEL } from '../shared/ui-case'
import { UPDATE_CHANNELS, type UpdateState } from '../shared/updates'
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
  let checkpoint: (() => JournalCheckpoint) | undefined
  const journal = createDocumentJournal(
    (change) => transport.invoke(DOCUMENT_CHANNELS.append, change),
    {
      timeoutMs: 5000,
      retryDelays: [100, 500, 2000],
      maximumCheckpointUnits: MAX_DOCUMENT_BYTES,
      checkpoint: () => {
        if (!checkpoint)
          throw new Error('Document recovery is not ready. Retry saving.')
        return checkpoint()
      },
      head: () => transport.invoke(DOCUMENT_CHANNELS.recoveryHead),
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
    onGlobalShortcut: (callback) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        invocation: GlobalShortcutInvocation,
      ) => callback(invocation)
      ipcRenderer.on(GLOBAL_SHORTCUT_CHANNELS.invoked, listener)
      return () =>
        ipcRenderer.removeListener(GLOBAL_SHORTCUT_CHANNELS.invoked, listener)
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
    onUpdateChanged: (callback) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        state: UpdateState,
      ) => callback(state)
      transport.on(UPDATE_CHANNELS.changed, listener)
      return () => {
        transport.removeListener(UPDATE_CHANNELS.changed, listener)
      }
    },
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
    openDroppedFile: (file) =>
      ipcRenderer.invoke(MEDIA_CHANNELS.open, webUtils.getPathForFile(file)),
    getInstalledAddons: () => ipcRenderer.invoke(SIDELOAD_CHANNELS.list),
    installAddon: (url) => ipcRenderer.invoke(SIDELOAD_CHANNELS.install, url),
    openAddonsFolder: () => ipcRenderer.invoke(SIDELOAD_CHANNELS.folder),
    openAddonGarden: () => ipcRenderer.invoke(SIDELOAD_CHANNELS.garden),
    removeAddon: (id) => ipcRenderer.invoke(SIDELOAD_CHANNELS.remove, id),
    listVersions: () => ipcRenderer.invoke(HISTORY_CHANNELS.list),
    previewVersion: (id) => ipcRenderer.invoke(HISTORY_CHANNELS.preview, id),
    restoreVersion: (id) => ipcRenderer.invoke(HISTORY_CHANNELS.restore, id),
    onNotice: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, message: string) =>
        callback(message)
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
    setAddonEnabled: (id, enabled) =>
      ipcRenderer.invoke(ADDON_CHANNELS.enable, id, enabled),
    readAddonStorage: (request) =>
      transport.invoke(ADDON_STORAGE_CHANNELS.read, request),
    writeAddonStorage: (request) =>
      transport.invoke(ADDON_STORAGE_CHANNELS.write, request),
    onAddonStorageChanged: (callback) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        change: AddonStorageChange,
      ) => callback(change)
      transport.on(ADDON_STORAGE_CHANNELS.changed, listener)
      return () =>
        transport.removeListener(ADDON_STORAGE_CHANNELS.changed, listener)
    },
    selectUserText: (owner) =>
      transport.invoke(SELECTED_TEXT_CHANNELS.select, owner),
    readSelectedText: (owner, handle) =>
      transport.invoke(SELECTED_TEXT_CHANNELS.read, owner, handle),
    invokeAddon: (id, method, input) =>
      ipcRenderer.invoke(ADDON_CHANNELS.invoke, id, method, input),
    queryAddon: (id, method, input) =>
      ipcRenderer.invoke(ADDON_CHANNELS.query, id, method, input),
    getWorkspace: () => ipcRenderer.invoke(WORKSPACE_CHANNELS.get),
    getWorkspaceChangeSnapshot: () =>
      ipcRenderer.invoke(WORKSPACE_CHANNELS.changeSnapshot),
    subscribeWorkspaceChanges,
    readWorkspaceText: (owner, target, path) =>
      ipcRenderer.invoke(WORKSPACE_CHANNELS.readText, owner, target, path),
    createWorkspaceText: (owner, target, path, markdown) =>
      ipcRenderer.invoke(
        WORKSPACE_CHANNELS.createText,
        owner,
        target,
        path,
        markdown,
      ),
    queryWorkspaceReferences: (request) =>
      ipcRenderer.invoke(WORKSPACE_CHANNELS.queryReferences, request),
    listImporters: () => ipcRenderer.invoke(IMPORT_CHANNELS.list),
    importIntoWorkspace: (request) =>
      ipcRenderer.invoke(IMPORT_CHANNELS.run, request),
    getWorkspaceSettings: () =>
      ipcRenderer.invoke(WORKSPACE_SETTINGS_CHANNELS.get),
    updateWorkspaceSettings: (action) =>
      ipcRenderer.invoke(WORKSPACE_SETTINGS_CHANNELS.update, action),
    getRecentWorkspaces: () => ipcRenderer.invoke(WORKSPACE_CHANNELS.recent),
    getKnownWorkspaces: () => ipcRenderer.invoke(WORKSPACE_CHANNELS.known),
    openRecentWorkspace: (id) =>
      ipcRenderer.invoke(WORKSPACE_CHANNELS.openRecent, id),
    setKnownWorkspace: (id, action) =>
      ipcRenderer.invoke(WORKSPACE_CHANNELS.setKnown, id, action),
    deleteKnownWorkspace: (id) =>
      ipcRenderer.invoke(WORKSPACE_CHANNELS.deleteKnown, id),
    getWorkspaceSnapshot: () => ipcRenderer.invoke(WORKSPACE_CHANNELS.snapshot),
    getWorkspaceIndex: (verifyAll = false) =>
      ipcRenderer.invoke(WORKSPACE_CHANNELS.index, verifyAll),
    workspaceAction: (action) =>
      ipcRenderer.invoke(WORKSPACE_CHANNELS.action, action),
    openWorkspace: () => ipcRenderer.invoke(WORKSPACE_CHANNELS.open),
    refreshWorkspace: () => ipcRenderer.invoke(WORKSPACE_CHANNELS.refresh),
    openWorkspaceFile: (path) =>
      ipcRenderer.invoke(WORKSPACE_CHANNELS.openFile, path),
    onWorkspaceChanged: (callback) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        workspace: WorkspaceState | null,
        change?: WorkspaceChange,
      ) => callback(workspace, change)
      ipcRenderer.on(WORKSPACE_CHANNELS.changed, listener)
      return () => {
        ipcRenderer.removeListener(WORKSPACE_CHANNELS.changed, listener)
      }
    },
    onWorkspaceListChanged: (callback) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        known: KnownWorkspace[],
      ) => callback(known)
      ipcRenderer.on(WORKSPACE_CHANNELS.listChanged, listener)
      return () => {
        ipcRenderer.removeListener(WORKSPACE_CHANNELS.listChanged, listener)
      }
    },
    getAppInfo: () => ipcRenderer.invoke(APP_INFO_CHANNEL),
    setUiCase: (value) => ipcRenderer.invoke(UI_CASE_CHANNEL, value),
    getDocument: () => ipcRenderer.invoke(DOCUMENT_CHANNELS.get),
    selectDocumentTab: (id) =>
      ipcRenderer.invoke(DOCUMENT_CHANNELS.selectTab, id),
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
      return () =>
        ipcRenderer.removeListener(DOCUMENT_CHANNELS.externalPending, listener)
    },
    newDocument: () => ipcRenderer.invoke(DOCUMENT_CHANNELS.new),
    saveDocument: (saveAs) =>
      ipcRenderer.invoke(DOCUMENT_CHANNELS.save, saveAs),
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
    onAddonHotkeysChanged: (callback) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        bindings: AddonHotkeyBinding[],
      ) => callback(bindings)
      ipcRenderer.on(ADDON_HOTKEY_CHANNELS.changed, listener)
      return () =>
        ipcRenderer.removeListener(ADDON_HOTKEY_CHANNELS.changed, listener)
    },
    onAddonCommand: (callback) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        invocation: AddonCommandInvocation,
      ) => callback(invocation)
      ipcRenderer.on(ADDON_HOTKEY_CHANNELS.invoke, listener)
      return () =>
        ipcRenderer.removeListener(ADDON_HOTKEY_CHANNELS.invoke, listener)
    },
    saveHotkeys: (hotkeys) => ipcRenderer.invoke(HOTKEY_CHANNELS.save, hotkeys),
    setHotkeyRecording: (recording) =>
      ipcRenderer.invoke(HOTKEY_CHANNELS.record, recording),
    onCommand: (callback) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        command: AppCommand,
      ) => callback(command)
      ipcRenderer.on(HOTKEY_CHANNELS.command, listener)
      return () => {
        ipcRenderer.removeListener(HOTKEY_CHANNELS.command, listener)
      }
    },
  } satisfies DesktopApi)
}
