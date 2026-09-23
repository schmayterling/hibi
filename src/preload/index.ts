import { contextBridge, ipcRenderer as transport, webUtils } from 'electron'
import { ADDON_CHANNELS } from '../addons/api'
import { ABOUT_CHANNELS } from '../shared/about'
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
import { HISTORY_CHANNELS } from '../shared/history'
import { type AppCommand, HOTKEY_CHANNELS } from '../shared/hotkeys'
import { IMPORT_CHANNELS } from '../shared/imports'
import { DIAGNOSTIC_CHANNEL } from '../shared/local-diagnostics'
import { MEDIA_CHANNELS } from '../shared/media'
import { SIDELOAD_CHANNELS } from '../shared/sideload'
import { UI_CASE_CHANNEL } from '../shared/ui-case'
import { UPDATE_CHANNELS, type UpdateState } from '../shared/updates'
import { WORKSPACE_CHANNELS, type WorkspaceState } from '../shared/workspace'
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
  const startupRecent = ipcRenderer.invoke(WORKSPACE_CHANNELS.recent)
  for (const pending of [startupDocument, startupAddons, startupRecent])
    void pending.catch(() => {})
  contextBridge.exposeInMainWorld('hibi', {
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
      recentWorkspaces: () => startupRecent,
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
    invokeAddon: (id, method, input) =>
      ipcRenderer.invoke(ADDON_CHANNELS.invoke, id, method, input),
    queryAddon: (id, method, input) =>
      ipcRenderer.invoke(ADDON_CHANNELS.query, id, method, input),
    getWorkspace: () => ipcRenderer.invoke(WORKSPACE_CHANNELS.get),
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
    getWorkspaceIndex: () => ipcRenderer.invoke(WORKSPACE_CHANNELS.index),
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
      ) => callback(workspace)
      ipcRenderer.on(WORKSPACE_CHANNELS.changed, listener)
      return () => {
        ipcRenderer.removeListener(WORKSPACE_CHANNELS.changed, listener)
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
    autosaveDocument: (revision) =>
      ipcRenderer.invoke(DOCUMENT_CHANNELS.autosave, revision),
    renameDocument: (name) =>
      ipcRenderer.invoke(DOCUMENT_CHANNELS.rename, name),
    readDocumentImage: (source, revision) =>
      ipcRenderer.invoke(DOCUMENT_CHANNELS.image, source, revision),
    getHotkeys: () => ipcRenderer.invoke(HOTKEY_CHANNELS.get),
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
