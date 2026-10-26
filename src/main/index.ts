import { randomUUID } from 'node:crypto'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { serialize } from 'node:v8'
import type { IpcMainInvokeEvent, MenuItemConstructorOptions } from 'electron'
import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  net,
  protocol,
  safeStorage,
  session,
  shell,
  systemPreferences,
} from 'electron'
import { ADDON_CHANNELS } from '../addons/api'
import { ABOUT_CHANNELS, SPONSOR_URL } from '../shared/about'
import {
  type AddonGardenRequest,
  parseAddonGardenLink,
} from '../shared/addon-directory'
import {
  ADDON_HOTKEY_CHANNELS,
  type AddonHotkeyRegistration,
} from '../shared/addon-hotkeys'
import { ADDON_STORAGE_CHANNELS } from '../shared/addon-storage'
import { ADDON_TRUST_CHANNELS } from '../shared/addon-trust'
import { ADDON_WINDOW_CHANNELS } from '../shared/addon-windows'
import { ANALYSIS_CHANNELS } from '../shared/analysis'
import { BACKGROUND_CHANNELS, QUICK_NOTE_COMMAND } from '../shared/background'
import { APPEARANCE_CHANNEL } from '../shared/colorschemes'
import { DEPENDENCY_CHANNELS } from '../shared/dependencies'
import {
  APP_INFO_CHANNEL,
  type AppInfo,
  BOOTSTRAP_CHANNELS,
  DOCUMENT_CHANNELS,
  MAX_DOCUMENT_BYTES,
} from '../shared/desktop'
import {
  journalHead,
  parseJournalCheckpoint,
  verifyJournalCheckpoint,
} from '../shared/document-checkpoint'
import { createJournalReceiver } from '../shared/document-journal'
import { ASSOCIATION_CHANNELS } from '../shared/file-associations'
import type { AddonId, WorkspaceTarget } from '../shared/foundation-contracts'
import {
  GLOBAL_SHORTCUT_CHANNELS,
  type GlobalShortcutInvocation,
} from '../shared/global-shortcuts'
import { HISTORY_CHANNELS } from '../shared/history'
import { HOST_CREDENTIAL_CHANNELS } from '../shared/host-credentials'
import { HOST_NETWORK_CHANNELS } from '../shared/host-network'
import { HOST_SELECTED_IO_CHANNELS } from '../shared/host-selected-io'
import {
  type AppCommand,
  accelerator,
  actions,
  HOTKEY_CHANNELS,
  shortcutFromEvent,
} from '../shared/hotkeys'
import { IMPORT_CHANNELS } from '../shared/imports'
import { MEDIA_CHANNELS } from '../shared/media'
import { SELECTED_TEXT_CHANNELS } from '../shared/selected-text'
import { SIDELOAD_CHANNELS } from '../shared/sideload'
import { startupMark, startupSpan } from '../shared/startup'
import { TABLE_LAYOUT_CHANNELS } from '../shared/table-layout'
import { UI_CASE_CHANNEL } from '../shared/ui-case'
import { UPDATE_CHANNELS } from '../shared/updates'
import { WORKSPACE_CHANNELS } from '../shared/workspace'
import { WORKSPACE_SETTINGS_CHANNELS } from '../shared/workspace-settings'
import { AddonHotkeys } from './addon-hotkeys'
import { createAddonStorage } from './addon-storage'
import {
  getAddonTrustSettings,
  setAddonTrustSettings,
  startAddonRevocations,
} from './addon-trust'
import {
  addonWindowOwners,
  addonWindowSender,
  closeAddonWindow,
  closeAddonWindows,
  focusAddonWindow,
  onAddonWindowClosed,
  openAddonWindow,
  refreshAddonWindowColors,
  releaseAddonWindows,
  sendAddonWindowStates,
} from './addon-windows'
import {
  applyAddonRevocations,
  currentAddonOwner,
  enableAddon,
  getAddonActivationGeneration,
  getAddonManifests,
  getAddonStartupNotices,
  getAddonStates,
  installAddon,
  installAddonSelection,
  installDirectoryAddon,
  installedAddonResources,
  invalidateAddonActivations,
  invokeAddon,
  isAddonActivationCurrent,
  loadAddons,
  readAddonDocumentation,
  removeAddon,
  runNativeGlobalShortcut,
  setAddonDeactivationHandler,
  setAddonStatesHandler,
  setAddonWindowOwners,
  windowAddonName,
} from './addons'
import { analysisService } from './analysis'
import {
  appearanceColors,
  loadAppearance,
  saveAppearance,
  titleBarColors,
} from './appearance'
import { BackgroundMode } from './background'
import {
  autosaveDocument,
  closeDocumentTab,
  confirmDiscard,
  confirmDiscardAll,
  discardChanges,
  focusDocumentTab,
  getDocument,
  getDocumentPath,
  getDocumentPathForTab,
  getDocumentSource,
  getDocumentSourceFor,
  getOpenDocumentVersions,
  hasOpenDocumentPath,
  hasUnsavedDocuments,
  loadDocument,
  loadDocumentPreferences,
  moveDocumentTab,
  navigateDocument,
  newDocument,
  openDocument,
  renameDocument,
  restoreDocument,
  saveDocument,
  saveTargetDocument,
  selectDocumentTab,
  setTabsEnabled,
  updateDocument,
  updateDocumentEdited,
} from './document'
import { isDocumentName } from './document-types'
import { externalFileArguments } from './external-files'
import {
  fileOperationDialogOpened,
  fileOperationHasDialog,
  withinFileOperation,
} from './file-operation-dialog'
import { GlobalShortcuts } from './global-shortcuts'
import { listVersions, previewVersion } from './history'
import { HostCredentials } from './host-credentials'
import { HostNetwork } from './host-network'
import { HostSelectedIoService } from './host-selected-io'
import { hotkeys, loadHotkeys, saveHotkeys } from './hotkeys'
import { readDocumentImage } from './images'
import { cancelImport, runCancellableImport } from './import-cancellation'
import { listLicenses, readLicense } from './licenses'
import {
  openDocumentLink,
  openExternalDocumentLink,
  openRemoteDocument,
} from './links'
import { LocalDiagnostics } from './local-diagnostics/runtime'
import {
  attachMedia,
  documentMedia,
  openDroppedFile,
  readDocumentMedia,
  serveDocumentMedia,
} from './media'
import {
  getKnownWorkspaces,
  getRecentWorkspaces,
  observeKnownWorkspaces,
  setKnownWorkspace,
} from './recent-workspaces'
import {
  CONTENT_SECURITY_POLICY,
  isTrustedRendererUrl,
  resolveAssetPath,
} from './security'
import { SelectedTextService } from './selected-text'
import {
  cancelPackageInstall,
  installedAddons,
  installedAsset,
  openAddonsFolder,
} from './sideload'
import { getUiCase, loadUiCase, saveUiCase } from './ui-case'
import {
  cancelUpdateInstall,
  checkForUpdates,
  downloadUpdate,
  finishUpdateInstall,
  getUpdateState,
  installUpdate,
  loadUpdates,
  onUpdateInstallFailure,
  setUpdateChannel,
  setUpdateCheckFrequency,
  setUpdateStartupCheck,
  startUpdateChecks,
} from './updates'
import {
  cancelWorkspaceSelection,
  currentWorkspaceTarget,
  deleteKnownWorkspace,
  documentFileChanged,
  getWorkspace,
  getWorkspaceHeader,
  indexWorkspace,
  isCurrentWorkspaceTarget,
  listWorkspaceEntryPage,
  observeWorkspace,
  openRecentWorkspace,
  openWorkspace,
  openWorkspaceFile,
  readWorkspaceViewPage,
  refreshWorkspace,
  snapshotWorkspace,
  subscribeWorkspaceChanges,
  workspaceChangeSnapshot,
  workspaceRelativePath,
  workspaceRoot,
} from './workspace'
import { workspaceAction } from './workspace-actions'
import {
  createWorkspaceBinary,
  createWorkspaceText,
  readWorkspaceBinary,
  readWorkspaceText,
  renameWorkspaceFile,
  trashWorkspaceFile,
  updateWorkspaceText,
} from './workspace-files'
import {
  readTableLayout,
  renameWithTableLayout,
  writeTableLayout,
} from './workspace-layout'
import {
  getWorkspaceSettings,
  openStartupWorkspace,
  startupWorkspacePending,
  updateWorkspaceSettings,
} from './workspace-settings'

const localDiagnostics = new LocalDiagnostics()
startupMark('main-entry')
app.setName('hibi')
// Let held Vim motions repeat instead of opening macOS's accent picker.
if (process.platform === 'darwin')
  systemPreferences.setUserDefault('ApplePressAndHoldEnabled', 'boolean', false)
const iconName = `icon-${process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux'}.png`
const appIcon = app.isPackaged
  ? join(process.resourcesPath, 'icons', iconName)
  : join(app.getAppPath(), 'build', iconName)
app.enableSandbox()
const testing = !app.isPackaged && app.commandLine.hasSwitch('hibi-test')
const foundationsIpcBenchmark =
  testing && process.env.HIBI_FOUNDATIONS_IPC_BENCH === '1'
    ? (() => {
        const invokes = new Map<
          string,
          {
            calls: number
            requestBytesEstimate: number
            responseBytesEstimate: number
            failedCalls: number
            unavailableEstimates: number
          }
        >()
        const sends = new Map<
          string,
          {
            calls: number
            payloadBytesEstimate: number
            unavailableEstimates: number
          }
        >()
        const estimate = (value: unknown) => {
          try {
            return serialize(value).byteLength
          } catch {
            return null
          }
        }
        const invoke = (channel: string) => {
          let count = invokes.get(channel)
          if (!count) {
            count = {
              calls: 0,
              requestBytesEstimate: 0,
              responseBytesEstimate: 0,
              failedCalls: 0,
              unavailableEstimates: 0,
            }
            invokes.set(channel, count)
          }
          return count
        }
        const snapshot = () => ({
          invokes: Object.fromEntries(
            [...invokes].map(([channel, count]) => [channel, { ...count }]),
          ),
          sends: Object.fromEntries(
            [...sends].map(([channel, count]) => [channel, { ...count }]),
          ),
        })
        Object.assign(globalThis, {
          __hibiFoundationsIpcBenchmark: { snapshot },
        })
        return {
          request(channel: string, payload: unknown[]) {
            const count = invoke(channel)
            count.calls++
            const bytes = estimate(payload)
            if (bytes === null) count.unavailableEstimates++
            else count.requestBytesEstimate += bytes
          },
          response(channel: string, payload: unknown) {
            const count = invoke(channel)
            const bytes = estimate(payload)
            if (bytes === null) count.unavailableEstimates++
            else count.responseBytesEstimate += bytes
          },
          failed(channel: string) {
            invoke(channel).failedCalls++
          },
          send(channel: string, payload: unknown) {
            let count = sends.get(channel)
            if (!count) {
              count = {
                calls: 0,
                payloadBytesEstimate: 0,
                unavailableEstimates: 0,
              }
              sends.set(channel, count)
            }
            count.calls++
            const bytes = estimate([payload])
            if (bytes === null) count.unavailableEstimates++
            else count.payloadBytesEstimate += bytes
          },
        }
      })()
    : null
if (testing)
  app.on('web-contents-created', (_event, contents) =>
    contents.setAudioMuted(true),
  )
if (testing && process.platform === 'darwin')
  app.setActivationPolicy('accessory')
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'hibi-analysis',
    privileges: { standard: true, secure: true, corsEnabled: true },
  },
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
      codeCache: true,
    },
  },
])

// Keep development and test profiles separate from installed app data.
if (!app.isPackaged) {
  const testProfile = app.commandLine.getSwitchValue('user-data-dir')
  app.setPath(
    'userData',
    testProfile
      ? resolve(testProfile)
      : join(app.getPath('appData'), 'hibi-dev'),
  )
}

const devUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
const rendererUrl = devUrl ? new URL(devUrl).href : 'app://hibi/'
const rendererRoot = join(import.meta.dirname, '../renderer')
let mainWindow: BrowserWindow | null = null
let networkWindowKey: object = {}
const addonStorage = createAddonStorage(
  join(app.getPath('userData'), 'addon-storage'),
  isCurrentWorkspaceTarget,
  isAddonActivationCurrent,
)
const selectedText = new SelectedTextService(currentAddonOwner)
const selectedIo = new HostSelectedIoService(currentAddonOwner, {
  isOpenDocument: hasOpenDocumentPath,
})
async function askNetworkGrant(
  windowKey: object,
  signal: AbortSignal,
  message: string,
  detail: string,
) {
  const window = mainWindow
  if (
    !window ||
    window.isDestroyed() ||
    windowKey !== networkWindowKey ||
    signal.aborted
  )
    return false
  try {
    const { response } = await dialog.showMessageBox(window, {
      type: 'question',
      buttons: ['Cancel', 'Allow once'],
      defaultId: 0,
      cancelId: 0,
      message,
      detail,
    })
    return (
      response === 1 &&
      !signal.aborted &&
      windowKey === networkWindowKey &&
      !window.isDestroyed()
    )
  } catch {
    return false
  }
}
const hostNetwork = new HostNetwork({
  currentOwner: currentAddonOwner,
  declaredOrigins: (id) =>
    getAddonManifests().find((manifest) => manifest.id === id)?.network
      ?.origins ?? [],
  userAgent: `Hibi/${app.getVersion()} (https://github.com/schmayterling/hibi)`,
  isWindowLive: (key) =>
    key === networkWindowKey &&
    !!mainWindow &&
    !mainWindow.isDestroyed() &&
    !mainWindow.webContents.isDestroyed(),
  grantDestination: (grant, signal) =>
    askNetworkGrant(
      grant.windowKey,
      signal,
      grant.operation === 'post-utf8'
        ? `Allow ${grant.addonId} to upload data to this HTTPS URL?`
        : grant.credentialKey
          ? `Allow ${grant.addonId} to use a stored credential for this HTTPS URL?`
          : `Allow ${grant.addonId} to read this HTTPS URL?`,
      grant.operation === 'post-utf8'
        ? `${grant.url}\nUpload: ${grant.bodyBytes} UTF-8 bytes\nCredential: ${grant.credentialKey ? `${grant.credentialKey} (bearer token)` : 'None'}\n\nOnly this POST request is allowed. Redirects and retries are not allowed.`
        : grant.credentialKey
          ? `${grant.url}\nCredential: ${grant.credentialKey} (bearer token)\n\nOnly this GET request is allowed. Credentials are not sent to redirects.`
          : `${grant.url}\n\nOnly this GET request is allowed. Redirects ask again.`,
    ),
  grantPrivateAddress: (grant, signal) =>
    askNetworkGrant(
      grant.windowKey,
      signal,
      `Allow ${grant.addonId} to contact a local or private address?`,
      `${grant.url}\nAddress: ${grant.address}${grant.credentialKey ? `\nCredential: ${grant.credentialKey} (bearer token)` : ''}\n\nOnly this ${grant.operation === 'post-utf8' ? 'POST' : 'GET'} request is allowed.`,
    ),
  applyCredential: (owner, windowKey, key, apply) =>
    hostCredentials.applyForApprovedRequest(owner, windowKey, key, apply),
})
const hostCredentials = new HostCredentials({
  directory: join(app.getPath('userData'), 'addon-credentials'),
  storage: safeStorage,
  currentOwner: currentAddonOwner,
  isWindowLive: (key) =>
    key === networkWindowKey &&
    !!mainWindow &&
    !mainWindow.isDestroyed() &&
    !mainWindow.webContents.isDestroyed(),
})
setAddonDeactivationHandler(async (id, generation) => {
  const owner = {
    addonId: id as AddonId,
    activationGeneration: generation,
  }
  analysisService.cancel(id)
  hostNetwork.stopOwner(owner)
  hostCredentials.stopOwner(owner)
  selectedText.revokeAddon(id)
  selectedIo.revokeAddon(id)
  closeAddonWindows(id)
  await addonStorage.clearSession(id)
})
setAddonStatesHandler(sendAddonWindowStates)
setAddonWindowOwners(addonWindowOwners)
addonStorage.subscribe((change) => {
  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send(ADDON_STORAGE_CHANNELS.changed, change)
})
function resetAddonSessions(): void {
  invalidateAddonActivations()
  hostNetwork.stopWindow(networkWindowKey)
  hostCredentials.stopWindow(networkWindowKey)
  networkWindowKey = {}
  selectedText.clear()
  selectedIo.clear()
  void addonStorage.clearAllSessions().catch((error: unknown) => {
    console.error('Could not clear addon sessions:', error)
  })
}

let fileOperation: Promise<unknown> | null = null
const pendingFileOperations = new Set<Promise<void>>()
let closing = false
let quitting = false
let recordingHotkey = false
const globalShortcuts = new GlobalShortcuts(globalShortcut)
const addonHotkeys = new AddonHotkeys(
  join(app.getPath('userData'), 'addon-hotkeys.json'),
  process.platform,
  hotkeys,
)
let backgroundSettingsReady = false
let pendingBackgroundSettings = false
function deliverBackgroundSettings() {
  if (!backgroundSettingsReady || !pendingBackgroundSettings || !mainWindow)
    return
  pendingBackgroundSettings = false
  mainWindow.webContents.send(BACKGROUND_CHANNELS.settings)
}
const background = new BackgroundMode({
  open: showMainWindow,
  settings: () => {
    pendingBackgroundSettings = true
    showMainWindow()
    deliverBackgroundSettings()
  },
  hasQuickNote: () => !!addonHotkeys.command(QUICK_NOTE_COMMAND),
  quickNote: () => {
    const command = addonHotkeys.command(QUICK_NOTE_COMMAND)
    if (!command) return
    // Quick note opens its own capture window; the main window stays hidden.
    mainWindow?.webContents.send(ADDON_HOTKEY_CHANNELS.invoke, command)
  },
})
function syncAddonCommands(
  event: IpcMainInvokeEvent,
  bindingsChanged: boolean,
) {
  const bindings = addonHotkeys.bindings()
  if (bindingsChanged) {
    installMenu()
    event.sender.send(ADDON_HOTKEY_CHANNELS.changed, bindings)
  } else background.refresh()
  return bindings
}
let addonHotkeysLoading: Promise<void> | null = null
const loadAddonHotkeys = () => {
  if (!addonHotkeysLoading) {
    addonHotkeys.setCoreHotkeys(hotkeys)
    addonHotkeysLoading = addonHotkeys.load()
  }
  return addonHotkeysLoading
}
let pendingGlobalShortcut: { id: string; accelerator: string } | null = null
const externalFiles: string[] = []
const gardenRequests: AddonGardenRequest[] = []
function queueAddonLinks(values: readonly string[]) {
  for (const value of values) {
    const request = parseAddonGardenLink(value)
    if (!request) continue
    if (
      !gardenRequests.some(
        (pending) =>
          pending.id === request.id && pending.install === request.install,
      )
    ) {
      if (gardenRequests.length === 8) gardenRequests.shift()
      gardenRequests.push(request)
    }
    if (app.isReady()) {
      showMainWindow()
      mainWindow?.webContents.send(SIDELOAD_CHANNELS.gardenPending)
    }
  }
}
app.on('open-url', (event, value) => {
  event.preventDefault()
  queueAddonLinks([value])
})
function showMainWindow() {
  if (!mainWindow) createWindow()
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  if (testing) mainWindow.showInactive()
  else {
    mainWindow.show()
    mainWindow.focus()
  }
}
function queueExternalFiles(paths: string[]) {
  for (const path of paths) {
    if (!externalFiles.includes(path)) externalFiles.push(path)
  }
  if (!mainWindow) createWindow()
  mainWindow?.webContents.send(DOCUMENT_CHANNELS.externalPending)
  if (!testing && mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
}
// Finder can deliver these before app.whenReady(). Keep them until the renderer asks.
app.on('open-file', (event, path) => {
  event.preventDefault()
  queueExternalFiles([path])
})
app.on('before-quit', () => {
  quitting = true
  // With no main window to confirm, kept-alive addon windows must not block quitting.
  if (!mainWindow) releaseAddonWindows()
})
let devRestartRequested = false
function cancelDevRestart() {
  if (!devRestartRequested) return
  devRestartRequested = false
  process.send?.('hibi:dev-restart-cancelled')
}
if (process.env.NODE_ENV_ELECTRON_VITE === 'development')
  process.on('message', (message: unknown) => {
    if (message === 'hibi:dev-restart') {
      devRestartRequested = true
      process.send?.('hibi:dev-restart-accepted')
      app.quit()
    }
  })
app.on('will-quit', () => {
  globalShortcuts.clear()
  background.dispose()
})

const openOwnedAddonWindow = (addonId: string, options: unknown) =>
  openAddonWindow(addonId, windowAddonName(addonId), options)

function invokeGlobalShortcut(invocation: GlobalShortcutInvocation) {
  // Native handlers can open their own window, so the main window stays put.
  void runNativeGlobalShortcut(invocation.id, openOwnedAddonWindow).then(
    (handled) => {
      if (!handled) showGlobalShortcut(invocation)
    },
    (error: unknown) => console.error('global shortcut failed:', error),
  )
}

function showGlobalShortcut(invocation: GlobalShortcutInvocation) {
  const { id, token } = invocation
  const openingWindow = !mainWindow
  if (openingWindow) {
    const registration = globalShortcuts.get(id)
    if (registration?.token !== token) return
    pendingGlobalShortcut = { id, accelerator: registration.accelerator }
    createWindow()
  }
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  if (
    !openingWindow &&
    pendingGlobalShortcut?.id !== id &&
    !mainWindow.webContents.isLoadingMainFrame()
  )
    mainWindow.webContents.send(GLOBAL_SHORTCUT_CHANNELS.invoked, invocation)
}

function trustedWindow(
  event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
): BrowserWindow {
  if (
    !mainWindow ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== event.sender.mainFrame ||
    !isTrustedRendererUrl(event.senderFrame.url, rendererUrl)
  ) {
    throw new Error('untrusted ipc sender')
  }
  return mainWindow
}

const addonFileUnavailable = () =>
  ({
    ok: false,
    code: 'disposed',
    message: 'This addon is no longer active.',
  }) as const
function fileOwner(owner: unknown) {
  if (typeof owner !== 'string') return null
  const generation = getAddonActivationGeneration(owner)
  return generation === null ? null : { id: owner, generation }
}
function readAddonFile<T>(
  event: IpcMainInvokeEvent,
  owner: unknown,
  read: () => Promise<T>,
) {
  const activation = fileOwner(owner)
  if (!activation) return addonFileUnavailable()
  return readAfterFileOperation(event, async () => {
    const result = await read()
    return isAddonActivationCurrent(activation.id, activation.generation)
      ? result
      : addonFileUnavailable()
  })
}

function mutateAddonFile<T>(
  event: IpcMainInvokeEvent,
  owner: unknown,
  mutate: (isCurrent: () => boolean) => Promise<T>,
) {
  const activation = fileOwner(owner)
  if (!activation) return addonFileUnavailable()
  return runFileOperation(event, () =>
    mutate(() =>
      isAddonActivationCurrent(activation.id, activation.generation),
    ),
  )
}

function storageGeneration(request: unknown): number {
  if (!request || typeof request !== 'object' || Array.isArray(request))
    throw new Error('Invalid addon storage request.')
  const owner = (request as { owner?: unknown }).owner
  if (typeof owner !== 'string') throw new Error('Invalid addon storage owner.')
  const generation = getAddonActivationGeneration(owner)
  if (generation === null)
    throw new Error('Enable this addon in Settings → Addons first.')
  return generation
}

const fileOperationUnavailable = () =>
  new Error(
    'Another file operation is in progress. Wait for it to finish, then try again.',
  )

function runFileOperation<T>(
  event: IpcMainInvokeEvent,
  operation: (window: BrowserWindow) => Promise<T>,
) {
  if (closing) throw fileOperationUnavailable()
  return lockFileOperation(trustedWindow(event), () => {
    if (closing) throw fileOperationUnavailable()
    return operation(trustedWindow(event))
  })
}

let workspaceOpenIntent = 0
function runWorkspaceOpen(
  event: IpcMainInvokeEvent,
  operation: (
    window: BrowserWindow,
  ) => Promise<ReturnType<typeof getWorkspace>>,
  includeEntries = false,
) {
  trustedWindow(event)
  if (closing || fileOperationHasDialog()) throw fileOperationUnavailable()
  const intent = ++workspaceOpenIntent
  cancelWorkspaceSelection()
  return runFileOperation(event, (window) =>
    intent === workspaceOpenIntent
      ? operation(window)
      : Promise.resolve(getWorkspace(undefined, includeEntries)),
  )
}

async function lockFileOperation<T>(
  window: BrowserWindow,
  operation: (window: BrowserWindow) => Promise<T>,
) {
  let settle!: () => void
  const completed = new Promise<void>((resolve) => {
    settle = resolve
  })
  pendingFileOperations.add(completed)
  try {
    while (fileOperation) {
      if (fileOperationHasDialog()) throw fileOperationUnavailable()
      const running = fileOperation.catch(() => undefined)
      await Promise.race([running, fileOperationDialogOpened() ?? running])
    }
    const mediaPath = getDocumentPath()
    const pending = withinFileOperation(() => operation(window)).finally(() => {
      fileOperation = null
      if (mediaPath !== getDocumentPath())
        mainWindow?.webContents.send(
          MEDIA_CHANNELS.scopeChanged,
          getDocument().revision,
        )
    })
    fileOperation = pending
    return await pending
  } finally {
    pendingFileOperations.delete(completed)
    settle()
  }
}

async function readAfterFileOperation<T>(
  event: IpcMainInvokeEvent,
  read: (window: BrowserWindow) => Promise<T>,
  window = trustedWindow(event),
) {
  while (fileOperation) await fileOperation.catch(() => undefined)
  return read(window)
}

async function serveAsset(request: Request): Promise<Response> {
  if (request.method !== 'GET') return new Response(null, { status: 405 })
  try {
    const parsed = new URL(request.url)
    if (
      parsed.hostname === 'hibi' &&
      parsed.pathname.startsWith('/document-media/')
    )
      return await serveDocumentMedia(request)
    const isAddon = parsed.pathname.startsWith('/installed-addons/')
    const path = isAddon
      ? await installedAsset(request.url)
      : resolveAssetPath(request.url, rendererRoot)
    if (
      !path ||
      (isAddon &&
        getAddonActivationGeneration(parsed.pathname.split('/')[2] ?? '') ===
          null)
    )
      return new Response(null, { status: 403 })
    const response = await net.fetch(pathToFileURL(path).href)
    const headers = response.headers
    headers.set('Content-Security-Policy', CONTENT_SECURITY_POLICY)
    headers.set('X-Content-Type-Options', 'nosniff')
    if (isAddon) {
      headers.set(
        'Access-Control-Allow-Origin',
        devUrl ? new URL(devUrl).origin : 'app://hibi',
      )
      if (/\.m?js$/i.test(path))
        headers.set('Content-Type', 'text/javascript; charset=utf-8')
    }
    return response
  } catch {
    return new Response(null, { status: 404 })
  }
}

function showStartupError(window: BrowserWindow | null = mainWindow): void {
  if (quitting || closing || window?.isDestroyed()) return
  dialog.showErrorBox(
    'Hibi could not start',
    'Restart Hibi. If it still cannot start, reinstall it.',
  )
  app.quit()
}

let windowSetupReady = false
const appendDocumentChange = createJournalReceiver(getDocumentSourceFor)
function createWindow(): void {
  if (!windowSetupReady) return
  closing = false
  startupMark('window-start')
  const window = new BrowserWindow({
    width: 1000,
    height: 720,
    minWidth: 480,
    minHeight: 360,
    show: false,
    // Linux cannot change focusability after creation; CI shows test windows.
    focusable: !testing || process.platform === 'linux',
    title: 'Hibi',
    ...(process.platform === 'darwin' ? {} : { icon: appIcon }),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 12, y: 11 } }
      : { titleBarOverlay: titleBarColors(), autoHideMenuBar: true }),
    backgroundColor: appearanceColors().background,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
      backgroundThrottling: !testing,
    },
  })
  startupMark('window-created')
  mainWindow = window
  const stopRecording = () => {
    recordingHotkey = false
    if (!window.isDestroyed()) window.webContents.setIgnoreMenuShortcuts(false)
  }
  window.on('blur', stopRecording)
  window.webContents.on('did-start-loading', stopRecording)
  window.webContents.on('did-start-loading', () => {
    backgroundSettingsReady = false
    globalShortcuts.clear()
    addonHotkeys.clearRegistrations()
    installMenu()
  })
  window.webContents.on('did-start-loading', () => analysisService.cancel())
  window.webContents.on('render-process-gone', () => {
    backgroundSettingsReady = false
    stopRecording()
    globalShortcuts.clear()
    addonHotkeys.clearRegistrations()
    installMenu()
    pendingGlobalShortcut = null
    analysisService.cancel()
  })
  window.on('closed', () => {
    backgroundSettingsReady = false
    recordingHotkey = false
    addonHotkeys.clearRegistrations()
    installMenu()
    analysisService.cancel()
  })
  window.webContents.on('before-input-event', (event, input) => {
    if (recordingHotkey || input.type !== 'keyDown' || input.isComposing) return
    const shortcut = shortcutFromEvent({
      key: input.key,
      code: input.code,
      ctrlKey: input.control,
      metaKey: input.meta,
      altKey: input.alt,
      shiftKey: input.shift,
    })
    const action =
      shortcut && actions.find(({ id }) => hotkeys[id] === shortcut)
    if (action) {
      event.preventDefault()
      if (!input.isAutoRepeat)
        window.webContents.send(HOTKEY_CHANNELS.command, action.id)
      return
    }
    const addon = shortcut ? addonHotkeys.resolve(shortcut) : undefined
    if (addon) {
      event.preventDefault()
      if (!input.isAutoRepeat)
        window.webContents.send(ADDON_HOTKEY_CHANNELS.invoke, addon)
    }
  })
  let allowClose = false
  onUpdateInstallFailure(() => {
    allowClose = false
    quitting = false
  })
  let confirmingClose = false
  let rendererGone = false
  let navigationStarted = false
  let journalReady = false
  window.webContents.on(
    'did-start-navigation',
    (_event, _url, _inPlace, isMainFrame) => {
      if (isMainFrame) {
        journalReady = false
        // A Vite or recovery reload can replace a frame before its first finish.
        if (navigationStarted) resetAddonSessions()
        navigationStarted = true
      }
    },
  )
  let flushRequest:
    | { token: string; resolve: () => void; reject: (error: Error) => void }
    | undefined
  const flushed = (
    event: Electron.IpcMainEvent,
    token: unknown,
    error: unknown,
  ) => {
    if (
      event.sender !== window.webContents ||
      event.senderFrame !== event.sender.mainFrame ||
      !isTrustedRendererUrl(event.senderFrame.url, rendererUrl)
    )
      return
    if (token === 'ready' && error === null) {
      journalReady = true
      return
    }
    if (token !== flushRequest?.token) return
    if (error === null) flushRequest?.resolve()
    else
      flushRequest?.reject(
        new Error(
          'Could not confirm the latest edits. Keep this window open and try again.',
        ),
      )
  }
  ipcMain.on(DOCUMENT_CHANNELS.flushed, flushed)
  const flushRenderer = async () => {
    if (!journalReady || rendererGone || window.webContents.isDestroyed())
      return
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await new Promise<void>((resolve, reject) => {
        const token = randomUUID()
        flushRequest = { token, resolve, reject }
        timer = setTimeout(
          () =>
            reject(
              new Error(
                'The editor did not confirm its latest changes. Try closing again when it responds.',
              ),
            ),
          5000,
        )
        window.webContents.send(DOCUMENT_CHANNELS.flush, token)
      })
    } finally {
      clearTimeout(timer)
      flushRequest = undefined
    }
  }
  window.on('close', (event) => {
    if (allowClose) return
    cancelImport(window.id)
    event.preventDefault()
    if (confirmingClose) return
    if (background.enabled && !quitting) {
      window.hide()
      return
    }
    confirmingClose = true
    closing = true
    void (async () => {
      await flushRenderer()
      while (pendingFileOperations.size)
        await Promise.all(pendingFileOperations)
      if (
        quitting &&
        background.enabled &&
        !window.isVisible() &&
        hasUnsavedDocuments()
      )
        showMainWindow()
      if (await confirmDiscardAll(window)) {
        const installed = finishUpdateInstall()
        if (installed === false) {
          quitting = false
          return
        }
        discardChanges()
        allowClose = true
        if (quitting || installed) releaseAddonWindows()
        if (!installed) {
          if (quitting) app.quit()
          else window.close()
        }
      } else {
        cancelUpdateInstall()
        quitting = false
      }
    })()
      .catch((error: unknown) => {
        cancelUpdateInstall()
        quitting = false
        dialog.showErrorBox(
          'Could not save document',
          error instanceof Error ? error.message : 'Try saving again.',
        )
      })
      .finally(() => {
        confirmingClose = false
        if (!allowClose) closing = false
        if (!quitting) cancelDevRestart()
      })
  })
  window.once('ready-to-show', () => {
    startupMark('window-painted')
    if (testing) return
    if (!app.isPackaged && app.commandLine.hasSwitch('user-data-dir'))
      window.showInactive()
    else window.show()
  })
  window.on('closed', () => {
    resetAddonSessions()
    onUpdateInstallFailure()
    ipcMain.removeListener(DOCUMENT_CHANNELS.flushed, flushed)
    flushRequest?.reject(
      new Error('The editor closed before confirming its changes.'),
    )
    mainWindow = null
    if (process.platform !== 'darwin' || quitting) globalShortcuts.clear()
    // Hidden addon windows must not keep Hibi running where closing it quits.
    if (process.platform !== 'darwin') releaseAddonWindows(true)
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-frame-navigate', (event) => {
    // Recovery and Vite may reload the main frame's exact trusted entrypoint.
    if (!event.isMainFrame || !isTrustedRendererUrl(event.url, rendererUrl))
      event.preventDefault()
  })
  window.webContents.on('will-redirect', (event) => event.preventDefault())
  window.webContents.on('will-attach-webview', (event) =>
    event.preventDefault(),
  )
  window.webContents.on('render-process-gone', (_event, details) => {
    resetAddonSessions()
    rendererGone = true
    flushRequest?.resolve()
    console.error('renderer exited:', details.reason, details.exitCode)
    if (details.reason === 'clean-exit' || window.isDestroyed()) return
    if (background.enabled && !window.isVisible()) showMainWindow()
    void dialog
      .showMessageBox(window, {
        type: 'error',
        message: 'Hibi needs to reload.',
        detail: 'The window stopped responding. Unsaved changes may be lost.',
        buttons: ['Reload', 'Quit'],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 1) app.quit()
        else if (!window.isDestroyed()) window.reload()
      })
      .catch((error: unknown) => {
        console.error(error)
        app.quit()
      })
  })
  window.webContents.on('did-finish-load', () => {
    rendererGone = false
  })
  localDiagnostics.observeWindow(window)
  void window.loadURL(rendererUrl).catch((error: unknown) => {
    // Vite dependency optimization can replace the initial navigation with a reload.
    if (
      !app.isPackaged &&
      error instanceof Error &&
      'code' in error &&
      error.code === 'ERR_ABORTED'
    )
      return
    console.error('failed to load app:', error)
    showStartupError(window)
  })
}

function installMenu(): void {
  const command = (action: AppCommand) => () =>
    mainWindow?.webContents.send(HOTKEY_CHANNELS.command, action)
  const addonItems: MenuItemConstructorOptions[] = []
  let group: string | null = null
  for (const item of addonHotkeys.menuContributions()) {
    const nextGroup = item.menu.group ?? ''
    if (group !== null && group !== nextGroup)
      addonItems.push({ type: 'separator' })
    addonItems.push({
      label: item.label,
      click: () =>
        mainWindow?.webContents.send(ADDON_HOTKEY_CHANNELS.invoke, {
          id: item.id,
          token: item.token,
          source: 'menu',
        }),
    })
    group = nextGroup
  }
  const menu: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New',
          accelerator: accelerator(hotkeys.new),
          click: command('new'),
        },
        {
          label: 'Open…',
          accelerator: accelerator(hotkeys.open),
          click: command('open'),
        },
        {
          label: 'Open from URL…',
          click: () =>
            mainWindow?.webContents.send(DOCUMENT_CHANNELS.requestRemote),
        },
        { label: 'Import into workspace…', click: command('import') },
        {
          label: 'Save',
          accelerator: accelerator(hotkeys.save),
          click: command('save'),
        },
        {
          label: 'Save as…',
          accelerator: accelerator(hotkeys.saveAs),
          click: command('saveAs'),
        },
        { type: 'separator' },
        {
          label: 'Close tab',
          accelerator: accelerator(hotkeys['close-tab']),
          click: command('close-tab'),
        },
        {
          role: process.platform === 'darwin' ? 'close' : 'quit',
          ...(process.platform === 'darwin'
            ? { accelerator: 'CmdOrCtrl+Shift+W' }
            : process.platform === 'win32' && background.enabled
              ? { accelerator: 'CmdOrCtrl+Q' }
              : {}),
        },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        {
          label: 'Command palette',
          accelerator: accelerator(hotkeys.palette),
          click: command('palette'),
        },
        {
          label: 'Find in document',
          accelerator: accelerator(hotkeys.find),
          click: command('find'),
        },
        {
          label: 'Settings',
          accelerator: accelerator(hotkeys.settings),
          click: command('settings'),
        },
        {
          label: 'Back',
          accelerator: accelerator(hotkeys.back),
          click: command('back'),
        },
        {
          label: 'Forward',
          accelerator: accelerator(hotkeys.forward),
          click: command('forward'),
        },
        {
          label: 'Previous tab',
          accelerator: accelerator(hotkeys['previous-tab']),
          click: command('previous-tab'),
        },
        {
          label: 'Next tab',
          accelerator: accelerator(hotkeys['next-tab']),
          click: command('next-tab'),
        },
        { type: 'separator' },
        ...(!app.isPackaged
          ? [
              { role: 'reload' as const },
              { role: 'toggleDevTools' as const },
              { type: 'separator' as const },
            ]
          : []),
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    ...(addonItems.length ? [{ label: 'Addons', submenu: addonItems }] : []),
    { role: 'windowMenu' },
    { role: 'help', submenu: localDiagnostics.menuItems() },
  ]
  const built = Menu.buildFromTemplate(menu)
  if (getUiCase() === 'lowercase') {
    const lowercase = (items: Electron.MenuItem[]) => {
      for (const item of items) {
        item.label = item.label.toLocaleLowerCase()
        if (item.submenu) lowercase(item.submenu.items)
      }
    }
    lowercase(built.items)
  }
  Menu.setApplicationMenu(built)
  background.refresh()
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  localDiagnostics.start({
    userData: app.getPath('userData'),
    rendererUrl,
    trusted: (event) => {
      try {
        trustedWindow(event)
        return true
      } catch {
        return false
      }
    },
  })
  queueAddonLinks(process.argv)
  externalFiles.push(
    ...externalFileArguments(process.argv, process.cwd(), !app.isPackaged),
  )
  app.on('second-instance', (_event, argv, cwd) => {
    queueAddonLinks(argv)
    queueExternalFiles(externalFileArguments(argv, cwd, !app.isPackaged))
    showMainWindow()
  })
  app.on('activate', () => {
    if (!mainWindow) createWindow()
    else if (
      background.enabled &&
      BrowserWindow.getAllWindows().every((window) => !window.isVisible())
    )
      showMainWindow()
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  void app
    .whenReady()
    .then(async () => {
      startupMark('app-ready')
      // Installed macOS apps already carry their full-resolution bundle icon.
      // A dock-sized development icon avoids re-encoding 1024px images at launch.
      if (process.platform === 'darwin' && !app.isPackaged)
        app.dock?.setIcon(
          nativeImage
            .createFromPath(appIcon)
            .resize({ width: 256, height: 256 }),
        )
      const hotkeysReady = startupSpan('hotkeys', loadHotkeys)
      const addonsReady = startupSpan('addons', loadAddons)
      const documentReady = startupSpan(
        'document-preferences',
        loadDocumentPreferences,
      )
      const workspacePending = startupSpan(
        'workspace-preferences',
        startupWorkspacePending,
      )
      const updatesReady = loadUpdates()
      const preferences = Promise.all([
        hotkeysReady,
        addonsReady,
        startupSpan('ui-case', loadUiCase),
        background.load(),
        documentReady,
        workspacePending,
      ])
      // Handle rejection immediately while appearance and renderer loading overlap it.
      void preferences.catch(() => {})
      await startupSpan('appearance', loadAppearance)
      const handle = (
        channel: string,
        listener: Parameters<typeof ipcMain.handle>[1],
        ready: Promise<unknown> = preferences,
      ) =>
        ipcMain.handle(channel, async (...args) => {
          trustedWindow(args[0])
          if (!foundationsIpcBenchmark) {
            await ready
            return listener(...args)
          }
          foundationsIpcBenchmark.request(channel, args.slice(1))
          try {
            await ready
            const result = await listener(...args)
            foundationsIpcBenchmark.response(channel, result)
            return result
          } catch (error) {
            foundationsIpcBenchmark.failed(channel)
            throw error
          }
        })
      handle(BACKGROUND_CHANNELS.settingsReady, () => {
        backgroundSettingsReady = true
        deliverBackgroundSettings()
      })
      handle(BACKGROUND_CHANNELS.get, () => background.enabled)
      handle(BACKGROUND_CHANNELS.set, async (_event, value: unknown) => {
        const enabled = await background.save(value)
        installMenu()
        if (!enabled && mainWindow && !mainWindow.isVisible()) showMainWindow()
        return enabled
      })
      handle(UPDATE_CHANNELS.get, getUpdateState, updatesReady)
      handle(
        UPDATE_CHANNELS.channel,
        (_event, channel: unknown) => setUpdateChannel(channel),
        updatesReady,
      )
      handle(
        UPDATE_CHANNELS.startup,
        (_event, enabled: unknown) => setUpdateStartupCheck(enabled),
        updatesReady,
      )
      handle(
        UPDATE_CHANNELS.frequency,
        (_event, hours: unknown) => setUpdateCheckFrequency(hours),
        updatesReady,
      )
      handle(UPDATE_CHANNELS.check, checkForUpdates, updatesReady)
      handle(UPDATE_CHANNELS.download, downloadUpdate, updatesReady)
      handle(UPDATE_CHANNELS.install, installUpdate, updatesReady)
      protocol.handle('app', serveAsset)
      session.defaultSession.setPermissionCheckHandler(() => false)
      session.defaultSession.setPermissionRequestHandler(
        (_contents, _permission, callback) => callback(false),
      )
      session.defaultSession.on('will-download', (event) =>
        event.preventDefault(),
      )

      if (devUrl) {
        const websocketOrigin = new URL(devUrl).origin.replace(/^http/, 'ws')
        const devPolicy = CONTENT_SECURITY_POLICY.replace(
          "script-src 'self'",
          "script-src 'self' 'unsafe-inline'",
        ).replace("connect-src 'self'", `connect-src 'self' ${websocketOrigin}`)
        session.defaultSession.webRequest.onHeadersReceived(
          { urls: [`${new URL(devUrl).origin}/*`] },
          (details, callback) => {
            callback({
              responseHeaders: {
                ...details.responseHeaders,
                'Content-Security-Policy': [devPolicy],
              },
            })
          },
        )
      }

      const appInfo = (): AppInfo => ({
        version: app.getVersion(),
        electron: process.versions.electron,
        platform: process.platform,
      })
      handle(
        BOOTSTRAP_CHANNELS.document,
        async () => ({
          info: appInfo(),
          document: getDocument(),
          hotkeys,
          workspace: getWorkspace(undefined, false),
          externalPending: externalFiles.length > 0 || (await workspacePending),
          // Files named at launch come first; a restored workspace doesn't defer it.
          introduction:
            (app.isPackaged ||
              app.commandLine.hasSwitch('hibi-introduction')) &&
            externalFiles.length === 0,
        }),
        Promise.all([documentReady, hotkeysReady, workspacePending]),
      )
      handle(
        BOOTSTRAP_CHANNELS.addons,
        () => ({
          states: getAddonStates(),
          packages: installedAddons(),
          notices: getAddonStartupNotices(),
        }),
        addonsReady,
      )
      handle(
        APP_INFO_CHANNEL,
        (event): AppInfo => {
          trustedWindow(event)
          return appInfo()
        },
        Promise.resolve(),
      )
      handle(
        SIDELOAD_CHANNELS.documentation,
        (event, id: unknown, path: unknown) => {
          trustedWindow(event)
          return readAddonDocumentation(id, path)
        },
      )
      handle(SIDELOAD_CHANNELS.link, async (event, href: unknown) => {
        trustedWindow(event)
        await openExternalDocumentLink(href)
      })
      handle(ASSOCIATION_CHANNELS.get, async (event) => {
        trustedWindow(event)
        return (await import('./file-associations')).getFileAssociations()
      })
      handle(DEPENDENCY_CHANNELS.list, async (event, owner: unknown) => {
        trustedWindow(event)
        return (await import('./dependencies')).listDependencies(owner)
      })
      handle(DEPENDENCY_CHANNELS.check, async (event, target: unknown) => {
        trustedWindow(event)
        const dependencies = await import('./dependencies')
        return dependencies.checkDependency(
          dependencies.dependencyTarget(target),
        )
      })
      handle(DEPENDENCY_CHANNELS.install, async (event, target: unknown) => {
        const window = trustedWindow(event)
        const dependencies = await import('./dependencies')
        return dependencies.installDependency(
          window,
          dependencies.dependencyTarget(target),
        )
      })
      handle(
        DEPENDENCY_CHANNELS.path,
        async (event, key: unknown, action: unknown) => {
          const window = trustedWindow(event)
          return (await import('./dependencies')).configureDependency(
            window,
            key,
            action,
          )
        },
      )
      handle(DEPENDENCY_CHANNELS.guide, async (event, key: unknown) => {
        trustedWindow(event)
        return (await import('./dependencies')).openDependencyGuide(key)
      })
      handle(ASSOCIATION_CHANNELS.set, async (event, format: unknown) => {
        trustedWindow(event)
        await (await import('./file-associations')).setFileAssociation(format)
      })
      handle(UI_CASE_CHANNEL, async (event, value: unknown) => {
        trustedWindow(event)
        if (value === getUiCase()) return
        await saveUiCase(value)
        installMenu()
      })
      handle(APPEARANCE_CHANNEL, async (event, value: unknown) => {
        const window = trustedWindow(event)
        const saved = saveAppearance(value)
        window.setBackgroundColor(appearanceColors().background)
        if (process.platform !== 'darwin')
          window.setTitleBarOverlay(titleBarColors())
        refreshAddonWindowColors()
        await saved
      })
      handle(ABOUT_CHANNELS.licenses, (event) => {
        trustedWindow(event)
        return listLicenses()
      })
      handle(ABOUT_CHANNELS.license, (event, id: unknown) => {
        trustedWindow(event)
        return readLicense(id)
      })
      handle(ABOUT_CHANNELS.sponsor, (event) => {
        trustedWindow(event)
        return shell.openExternal(SPONSOR_URL)
      })
      if (import.meta.env.DEV)
        handle(
          'addons:development-manifest',
          async (event, value: unknown, contract: unknown, apply: unknown) => {
            trustedWindow(event)
            const { updateDevelopmentAddon } = await import(
              './addon-development'
            )
            return updateDevelopmentAddon(value, contract, apply)
          },
        )
      handle(ADDON_CHANNELS.states, (event) => {
        trustedWindow(event)
        return getAddonStates()
      })
      handle(
        ADDON_STORAGE_CHANNELS.read,
        (_event, request: unknown) =>
          addonStorage.read(request, storageGeneration(request)),
        addonsReady,
      )
      handle(
        ADDON_STORAGE_CHANNELS.write,
        (_event, request: unknown) =>
          addonStorage.write(request, storageGeneration(request)),
        addonsReady,
      )
      handle(
        SELECTED_TEXT_CHANNELS.select,
        (event, owner: unknown) =>
          runFileOperation(event, (window) =>
            selectedText.select(window, owner),
          ),
        addonsReady,
      )
      handle(
        SELECTED_TEXT_CHANNELS.read,
        (event, owner: unknown, handle: unknown) =>
          selectedText.read(trustedWindow(event), owner, handle),
        addonsReady,
      )
      handle(
        HOST_SELECTED_IO_CHANNELS.selectImport,
        (event, owner: unknown, choice: unknown) =>
          runFileOperation(event, (window) =>
            selectedIo.selectImport(window, owner, choice),
          ),
        addonsReady,
      )
      handle(
        HOST_SELECTED_IO_CHANNELS.readImport,
        (event, owner: unknown, handle: unknown) =>
          selectedIo.readImport(trustedWindow(event), owner, handle),
        addonsReady,
      )
      handle(
        HOST_SELECTED_IO_CHANNELS.selectExport,
        (event, owner: unknown, choice: unknown) =>
          runFileOperation(event, (window) =>
            selectedIo.selectExport(window, owner, choice),
          ),
        addonsReady,
      )
      handle(
        HOST_SELECTED_IO_CHANNELS.writeExport,
        (event, owner: unknown, handle: unknown, bytes: unknown) =>
          runFileOperation(event, (window) =>
            selectedIo.writeExport(window, owner, handle, bytes),
          ),
        addonsReady,
      )
      handle(
        HOST_SELECTED_IO_CHANNELS.cancel,
        (event, owner: unknown, handle: unknown) =>
          selectedIo.cancel(trustedWindow(event), owner, handle),
        addonsReady,
      )
      handle(
        HOST_NETWORK_CHANNELS.getText,
        (event, owner: unknown, request: unknown) => {
          trustedWindow(event)
          return typeof owner === 'string'
            ? hostNetwork.request(owner, networkWindowKey, request)
            : { ok: false, code: 'invalid-request' }
        },
        addonsReady,
      )
      handle(
        HOST_NETWORK_CHANNELS.requestText,
        (event, owner: unknown, request: unknown) => {
          trustedWindow(event)
          return typeof owner === 'string'
            ? hostNetwork.requestText(owner, networkWindowKey, request)
            : { ok: false, code: 'invalid-request' }
        },
        addonsReady,
      )
      handle(
        HOST_CREDENTIAL_CHANNELS.store,
        (event, owner: unknown, request: unknown) => {
          trustedWindow(event)
          return typeof owner === 'string'
            ? hostCredentials.store(owner, networkWindowKey, request)
            : { ok: false, code: 'invalid-request' }
        },
        addonsReady,
      )
      handle(
        HOST_CREDENTIAL_CHANNELS.remove,
        (event, owner: unknown, request: unknown) => {
          trustedWindow(event)
          return typeof owner === 'string'
            ? hostCredentials.remove(owner, networkWindowKey, request)
            : { ok: false, code: 'invalid-request' }
        },
        addonsReady,
      )
      handle(
        HOST_CREDENTIAL_CHANNELS.status,
        (event, owner: unknown, request: unknown) => {
          trustedWindow(event)
          return typeof owner === 'string'
            ? hostCredentials.status(owner, networkWindowKey, request)
            : { ok: false, code: 'invalid-request' }
        },
        addonsReady,
      )
      handle(
        ANALYSIS_CHANNELS.run,
        (event, owner: unknown, projection: unknown) =>
          analysisService.run(event.sender, owner, projection),
        addonsReady,
      )
      handle(
        ANALYSIS_CHANNELS.cancel,
        (_event, owner: unknown) => {
          if (typeof owner === 'string') analysisService.cancel(owner)
        },
        Promise.resolve(),
      )
      void addonsReady
        .then(() => startAddonRevocations(applyAddonRevocations))
        .catch(console.error)
      handle(
        ADDON_TRUST_CHANNELS.get,
        (event) => {
          trustedWindow(event)
          return getAddonTrustSettings()
        },
        addonsReady,
      )
      handle(
        ADDON_TRUST_CHANNELS.set,
        (event, value: unknown) => {
          trustedWindow(event)
          return setAddonTrustSettings(value)
        },
        addonsReady,
      )
      handle(SIDELOAD_CHANNELS.list, (event) => {
        trustedWindow(event)
        return installedAddons()
      })
      handle(SIDELOAD_CHANNELS.resources, (_event, id: unknown) =>
        installedAddonResources(id),
      )
      handle(
        SIDELOAD_CHANNELS.install,
        (event, url: unknown, openSettings: unknown) =>
          runFileOperation(event, (window) =>
            installAddon(window, url, openSettings),
          ),
      )
      handle(SIDELOAD_CHANNELS.directory, (event, refresh: unknown) => {
        trustedWindow(event)
        return import('./addon-directory').then(({ getAddonDirectory }) =>
          getAddonDirectory(refresh === true),
        )
      })
      handle(
        SIDELOAD_CHANNELS.directoryInstall,
        (event, id: unknown, openSettings: unknown) =>
          runFileOperation(event, (window) =>
            installDirectoryAddon(window, id, openSettings),
          ),
      )
      handle(SIDELOAD_CHANNELS.gardenRequests, (event) => {
        trustedWindow(event)
        return gardenRequests.splice(0)
      })
      handle(
        SIDELOAD_CHANNELS.selection,
        (event, id: unknown, keys: unknown, openSettings: unknown) =>
          runFileOperation(event, (window) =>
            installAddonSelection(window, id, keys, openSettings),
          ),
      )
      handle(SIDELOAD_CHANNELS.cancel, (event, id: unknown) =>
        cancelPackageInstall(trustedWindow(event), id),
      )
      handle(SIDELOAD_CHANNELS.folder, (event) => {
        trustedWindow(event)
        return openAddonsFolder()
      })
      handle(SIDELOAD_CHANNELS.garden, (event) => {
        trustedWindow(event)
        return shell.openExternal('https://hibi.garden/addons')
      })
      handle(SIDELOAD_CHANNELS.remove, (event, id: unknown) =>
        runFileOperation(event, async () => {
          await removeAddon(id)
        }),
      )
      handle(
        ADDON_CHANNELS.enable,
        (event, id: unknown, enabled: unknown, includeRequired: unknown) =>
          runFileOperation(event, () =>
            enableAddon(id, enabled, includeRequired),
          ),
      )
      handle(
        ADDON_CHANNELS.invoke,
        (event, id: unknown, method: unknown, input: unknown) => {
          const owner =
            typeof id === 'string' && typeof method === 'string'
              ? currentAddonOwner(id)
              : null
          if (!owner)
            throw new Error('Enable this addon in Settings → Addons first.')
          const { tabId, revision } = getDocumentSource().snapshot().document
          const workspace = currentWorkspaceTarget()
          return runFileOperation(event, async (window) => {
            const current = getDocumentSource().snapshot().document
            if (
              current.tabId !== tabId ||
              current.revision !== revision ||
              currentWorkspaceTarget() !== workspace
            )
              throw new Error(
                'The document or workspace changed. Try the action again.',
              )
            if (
              !isAddonActivationCurrent(
                owner.addonId,
                owner.activationGeneration,
              )
            )
              throw new Error(
                'This addon was disabled. Enable it in Settings → Addons to continue.',
              )
            return invokeAddon(window, id, method, input)
          })
        },
      )
      handle(
        ADDON_CHANNELS.query,
        (event, id: unknown, method: unknown, input: unknown) =>
          readAfterFileOperation(event, (window) =>
            invokeAddon(window, id, method, input, true),
          ),
      )
      handle(
        ADDON_WINDOW_CHANNELS.open,
        (_event, addonId: unknown, options: unknown) =>
          openAddonWindow(addonId as string, windowAddonName(addonId), options),
      )
      handle(ADDON_WINDOW_CHANNELS.focus, (_event, addonId: unknown, id) => {
        windowAddonName(addonId)
        focusAddonWindow(addonId as string, id)
      })
      handle(ADDON_WINDOW_CHANNELS.close, (_event, addonId: unknown, id) => {
        if (typeof addonId === 'string') closeAddonWindow(addonId, id)
      })
      handle(ADDON_WINDOW_CHANNELS.owners, addonWindowOwners)
      onAddonWindowClosed((addonId, id) =>
        mainWindow?.webContents.send(ADDON_WINDOW_CHANNELS.closed, addonId, id),
      )
      // Addon windows reach only their owner's native handlers.
      ipcMain.handle(ADDON_WINDOW_CHANNELS.context, (event) => {
        const { addonId, id, input, title, titleBar, platform } =
          addonWindowSender(event)
        return { addonId, id, input, title, titleBar, platform }
      })
      ipcMain.handle(ADDON_WINDOW_CHANNELS.states, (event) => {
        addonWindowSender(event)
        return getAddonStates()
      })
      ipcMain.handle(ADDON_WINDOW_CHANNELS.closeSelf, (event) => {
        addonWindowSender(event).window.close()
      })
      ipcMain.handle(
        ADDON_WINDOW_CHANNELS.query,
        (event, method: unknown, input: unknown) => {
          const { window, addonId } = addonWindowSender(event)
          return readAfterFileOperation(
            event,
            () => invokeAddon(window, addonId, method, input, true),
            window,
          )
        },
      )
      ipcMain.handle(
        ADDON_WINDOW_CHANNELS.invoke,
        (event, method: unknown, input: unknown) => {
          const { window, addonId } = addonWindowSender(event)
          return lockFileOperation(window, () => {
            addonWindowSender(event)
            return invokeAddon(window, addonId, method, input)
          })
        },
      )
      handle(HOTKEY_CHANNELS.get, (event) => {
        trustedWindow(event)
        return hotkeys
      })
      handle(ADDON_HOTKEY_CHANNELS.get, async () => {
        await loadAddonHotkeys()
        return addonHotkeys.bindings()
      })
      handle(ADDON_HOTKEY_CHANNELS.register, async (event, value: unknown) => {
        await loadAddonHotkeys()
        const previousBindings = addonHotkeys.bindings()
        addonHotkeys.register(value as AddonHotkeyRegistration)
        const registration = value as AddonHotkeyRegistration
        return syncAddonCommands(
          event,
          !registration.runnableOnly ||
            previousBindings.some(({ id }) => id === registration.id),
        )
      })
      handle(
        ADDON_HOTKEY_CHANNELS.unregister,
        (event, id: unknown, token: unknown) => {
          if (typeof id !== 'string' || typeof token !== 'string') return
          const hadBinding = addonHotkeys
            .bindings()
            .some((binding) => binding.id === id)
          if (!addonHotkeys.unregister(id, token)) return
          syncAddonCommands(event, hadBinding)
        },
      )
      handle(
        ADDON_HOTKEY_CHANNELS.save,
        async (event, id: unknown, shortcut: unknown) => {
          await loadAddonHotkeys()
          if (typeof id !== 'string' || typeof shortcut !== 'string')
            throw new Error('Choose a supported key combination.')
          const bindings = await addonHotkeys.setOverride(id, shortcut)
          event.sender.send(ADDON_HOTKEY_CHANNELS.changed, bindings)
          return bindings
        },
      )
      handle(ADDON_HOTKEY_CHANNELS.reset, async (event, id: unknown) => {
        await loadAddonHotkeys()
        if (typeof id !== 'string')
          throw new Error('This addon command is not available.')
        const bindings = await addonHotkeys.resetOverride(id)
        event.sender.send(ADDON_HOTKEY_CHANNELS.changed, bindings)
        return bindings
      })
      handle(
        GLOBAL_SHORTCUT_CHANNELS.register,
        (event, id: unknown, accelerator: unknown, token: unknown) => {
          globalShortcuts.register(id, accelerator, token, invokeGlobalShortcut)
          const pending = pendingGlobalShortcut
          if (
            pending &&
            pending.id === id &&
            pending.accelerator === accelerator
          ) {
            pendingGlobalShortcut = null
            event.sender.send(GLOBAL_SHORTCUT_CHANNELS.invoked, { id, token })
          }
        },
      )
      handle(
        GLOBAL_SHORTCUT_CHANNELS.unregister,
        (_event, id: unknown, token: unknown) => {
          globalShortcuts.unregister(id, token)
        },
      )
      handle(HOTKEY_CHANNELS.save, async (event, value: unknown) => {
        trustedWindow(event)
        const next = await saveHotkeys(value)
        addonHotkeys.setCoreHotkeys(next)
        installMenu()
        event.sender.send(
          ADDON_HOTKEY_CHANNELS.changed,
          addonHotkeys.bindings(),
        )
        return next
      })
      handle(HOTKEY_CHANNELS.record, (event, value: unknown) => {
        const window = trustedWindow(event)
        if (typeof value !== 'boolean')
          throw new Error('Could not record this shortcut. Try again.')
        recordingHotkey = value
        window.webContents.setIgnoreMenuShortcuts(value)
      })
      handle(DOCUMENT_CHANNELS.get, (event) => {
        trustedWindow(event)
        return getDocument()
      })
      handle(DOCUMENT_CHANNELS.selectTab, (event, id: unknown) =>
        runFileOperation(event, (window) => selectDocumentTab(window, id)),
      )
      handle(
        DOCUMENT_CHANNELS.focusTab,
        (event, id: unknown, expected: unknown) =>
          readAfterFileOperation(event, (window) =>
            focusDocumentTab(window, id, expected),
          ),
      )
      handle(DOCUMENT_CHANNELS.closeTab, (event, id: unknown) =>
        runFileOperation(event, (window) => closeDocumentTab(window, id)),
      )
      handle(
        DOCUMENT_CHANNELS.moveTab,
        (event, id: unknown, beforeId: unknown) =>
          runFileOperation(event, async () => moveDocumentTab(id, beforeId)),
      )
      handle(DOCUMENT_CHANNELS.tabsEnabled, (event, enabled: unknown) =>
        runFileOperation(event, (window) => setTabsEnabled(window, enabled)),
      )
      handle(HISTORY_CHANNELS.list, (event) =>
        readAfterFileOperation(event, () => listVersions(getDocumentPath())),
      )
      handle(HISTORY_CHANNELS.preview, (event, id: unknown) =>
        readAfterFileOperation(event, () =>
          previewVersion(getDocumentPath(), id),
        ),
      )
      handle(HISTORY_CHANNELS.restore, (event, id: unknown) =>
        runFileOperation(event, async (window) => {
          const content = await previewVersion(getDocumentPath(), id)
          if (!(await confirmDiscard(window))) return null
          return restoreDocument(window, content)
        }),
      )
      handle(
        DOCUMENT_CHANNELS.image,
        async (event, source: unknown, revision: unknown) => {
          trustedWindow(event)
          if (typeof source !== 'string' || revision !== getDocument().revision)
            return null
          const path = getDocumentPath()
          const image = await readDocumentImage(source, path, workspaceRoot())
          return revision === getDocument().revision &&
            path === getDocumentPath()
            ? image
            : null
        },
      )
      let legacyWorkspaceListeners = false
      handle(WORKSPACE_CHANNELS.legacySubscribe, (event, enabled: unknown) => {
        trustedWindow(event)
        legacyWorkspaceListeners = enabled === true
      })
      handle(WORKSPACE_CHANNELS.get, (event) => {
        trustedWindow(event)
        return getWorkspace(undefined, true)
      })
      handle(WORKSPACE_CHANNELS.header, (event) => {
        trustedWindow(event)
        return getWorkspaceHeader()
      })
      handle(WORKSPACE_CHANNELS.viewPage, (event, request: unknown) =>
        readAfterFileOperation(event, async () =>
          readWorkspaceViewPage(
            request as import('../shared/workspace-view').WorkspaceViewPageRequest,
          ),
        ),
      )
      handle(
        MEDIA_CHANNELS.attach,
        (event, files: unknown, revision: unknown) =>
          runFileOperation(event, (window) =>
            attachMedia(window, files, revision),
          ),
      )
      handle(
        MEDIA_CHANNELS.open,
        (event, path: unknown, includeEntries: unknown) =>
          runFileOperation(event, (window) =>
            openDroppedFile(window, path, includeEntries !== false),
          ),
      )
      handle(
        MEDIA_CHANNELS.read,
        (event, source: unknown, revision: unknown) => {
          trustedWindow(event)
          if (typeof source !== 'string' || typeof revision !== 'number')
            return null
          return readDocumentMedia(source, revision)
        },
      )
      handle(
        MEDIA_CHANNELS.resolve,
        (event, source: unknown, revision: unknown, request: unknown) => {
          trustedWindow(event)
          if (
            typeof source !== 'string' ||
            typeof revision !== 'number' ||
            typeof request !== 'string' ||
            !request ||
            request.length > 128
          )
            return null
          return documentMedia.resolve(source, revision, request)
        },
      )
      handle(MEDIA_CHANNELS.cancel, (event, request: unknown) => {
        trustedWindow(event)
        if (typeof request === 'string' && request.length <= 128)
          documentMedia.cancel(request)
      })
      handle(WORKSPACE_CHANNELS.snapshot, (event) =>
        readAfterFileOperation(event, snapshotWorkspace),
      )
      handle(WORKSPACE_CHANNELS.changeSnapshot, (event) =>
        readAfterFileOperation(event, async () => workspaceChangeSnapshot()),
      )
      handle(
        WORKSPACE_CHANNELS.listPage,
        (event, owner: unknown, request: unknown) => {
          const activation = fileOwner(owner)
          if (!activation) return addonFileUnavailable()
          return readAfterFileOperation(event, async () => {
            const result = listWorkspaceEntryPage(
              request as import('../shared/workspace').WorkspaceEntryPageRequest,
            )
            return isAddonActivationCurrent(
              activation.id,
              activation.generation,
            )
              ? result
              : addonFileUnavailable()
          })
        },
      )
      handle(
        WORKSPACE_CHANNELS.readText,
        (event, owner: unknown, target: unknown, path: unknown) =>
          readAddonFile(event, owner, () =>
            readWorkspaceText(target as WorkspaceTarget, path),
          ),
      )
      handle(
        WORKSPACE_CHANNELS.readBinary,
        (event, owner: unknown, target: unknown, path: unknown) =>
          readAddonFile(event, owner, () =>
            readWorkspaceBinary(target as WorkspaceTarget, path),
          ),
      )
      handle(
        WORKSPACE_CHANNELS.createText,
        (
          event,
          owner: unknown,
          target: unknown,
          path: unknown,
          markdown: unknown,
        ) =>
          mutateAddonFile(event, owner, (isCurrent) =>
            createWorkspaceText(
              target as WorkspaceTarget,
              path,
              markdown,
              isCurrent,
            ),
          ),
      )
      handle(
        WORKSPACE_CHANNELS.createBinary,
        (
          event,
          owner: unknown,
          target: unknown,
          path: unknown,
          bytes: unknown,
        ) =>
          mutateAddonFile(event, owner, (isCurrent) =>
            createWorkspaceBinary(
              target as WorkspaceTarget,
              path,
              bytes,
              isCurrent,
            ),
          ),
      )
      handle(
        WORKSPACE_CHANNELS.updateText,
        (
          event,
          owner: unknown,
          target: unknown,
          path: unknown,
          expectedVersion: unknown,
          markdown: unknown,
          options: unknown,
        ) =>
          mutateAddonFile(event, owner, (isCurrent) =>
            updateWorkspaceText(
              target as WorkspaceTarget,
              path,
              expectedVersion,
              markdown,
              options,
              isCurrent,
            ),
          ),
      )
      handle(
        WORKSPACE_CHANNELS.renameFile,
        (
          event,
          owner: unknown,
          target: unknown,
          sourcePath: unknown,
          destinationPath: unknown,
          expectedVersion: unknown,
        ) =>
          mutateAddonFile(event, owner, (isCurrent) =>
            renameWorkspaceFile(
              target as WorkspaceTarget,
              sourcePath,
              destinationPath,
              expectedVersion,
              isCurrent,
            ),
          ),
      )
      handle(
        WORKSPACE_CHANNELS.trashFile,
        (
          event,
          owner: unknown,
          target: unknown,
          path: unknown,
          expectedVersion: unknown,
        ) =>
          mutateAddonFile(event, owner, (isCurrent) =>
            trashWorkspaceFile(
              target as WorkspaceTarget,
              path,
              expectedVersion,
              (file) => shell.trashItem(file),
              isCurrent,
            ),
          ),
      )
      handle(WORKSPACE_CHANNELS.index, (event, verifyAll: unknown) =>
        readAfterFileOperation(event, () => indexWorkspace(verifyAll === true)),
      )
      handle(WORKSPACE_CHANNELS.queryReferences, (event, request: unknown) =>
        readAfterFileOperation(event, () =>
          import('./workspace-metadata-query').then((module) =>
            module.queryWorkspaceReferences(
              request,
              getOpenDocumentVersions,
              String(event.sender.id),
            ),
          ),
        ),
      )
      const tableLayoutTarget = (tabId: unknown) => {
        if (typeof tabId !== 'string' || !tabId || tabId.length > 128)
          throw new Error('Invalid document identity.')
        const root = workspaceRoot()
        const path = workspaceRelativePath(getDocumentPathForTab(tabId))
        return root && path ? { root, path } : null
      }
      handle(TABLE_LAYOUT_CHANNELS.read, (event, tabId: unknown) =>
        readAfterFileOperation(event, async () => {
          const target = tableLayoutTarget(tabId)
          return target ? readTableLayout(target.root, target.path) : null
        }),
      )
      handle(
        TABLE_LAYOUT_CHANNELS.write,
        (event, tabId: unknown, tables: unknown) =>
          readAfterFileOperation(event, async () => {
            const target = tableLayoutTarget(tabId)
            if (target) await writeTableLayout(target.root, target.path, tables)
          }),
      )
      handle(
        WORKSPACE_CHANNELS.action,
        (event, input: unknown, includeEntries: unknown) =>
          runFileOperation(event, (window) =>
            workspaceAction(window, input, includeEntries !== false),
          ),
      )
      handle(WORKSPACE_CHANNELS.open, (event, includeEntries: unknown) =>
        runWorkspaceOpen(
          event,
          (window) => openWorkspace(window, includeEntries !== false),
          includeEntries !== false,
        ),
      )
      handle(IMPORT_CHANNELS.list, (event) => {
        trustedWindow(event)
        return import('./imports').then((module) => module.listImporters())
      })
      handle(IMPORT_CHANNELS.cancel, (event) => {
        cancelImport(trustedWindow(event).id)
      })
      handle(IMPORT_CHANNELS.run, (event, request: unknown) =>
        runCancellableImport(trustedWindow(event).id, (signal) =>
          runFileOperation(event, (window) =>
            import('./imports').then((module) =>
              module.importIntoWorkspace(window, request, signal),
            ),
          ),
        ),
      )
      handle(WORKSPACE_SETTINGS_CHANNELS.get, (event) =>
        readAfterFileOperation(event, getWorkspaceSettings),
      )
      handle(WORKSPACE_SETTINGS_CHANNELS.update, (event, input: unknown) =>
        runFileOperation(event, (window) =>
          updateWorkspaceSettings(window, input),
        ),
      )
      handle(
        WORKSPACE_CHANNELS.recent,
        (event) => {
          trustedWindow(event)
          return getRecentWorkspaces()
        },
        Promise.resolve(),
      )
      handle(
        WORKSPACE_CHANNELS.openRecent,
        (event, id: unknown, includeEntries: unknown) =>
          runWorkspaceOpen(
            event,
            () => openRecentWorkspace(id, includeEntries !== false),
            includeEntries !== false,
          ),
      )
      handle(WORKSPACE_CHANNELS.known, (event) => {
        trustedWindow(event)
        return getKnownWorkspaces()
      })
      handle(
        WORKSPACE_CHANNELS.setKnown,
        (event, id: unknown, action: unknown) => {
          trustedWindow(event)
          return setKnownWorkspace(id, action)
        },
      )
      handle(WORKSPACE_CHANNELS.deleteKnown, (event, id: unknown) =>
        runFileOperation(event, (window) => deleteKnownWorkspace(window, id)),
      )
      handle(WORKSPACE_CHANNELS.refresh, (event, includeEntries: unknown) => {
        trustedWindow(event)
        return refreshWorkspace(null, includeEntries !== false)
      })
      handle(
        WORKSPACE_CHANNELS.openFile,
        (event, path: unknown, target: unknown) =>
          runFileOperation(event, (window) =>
            openWorkspaceFile(window, path, target),
          ),
      )
      observeWorkspace((change) => {
        documentMedia.invalidate(change)
        mainWindow?.webContents.send(WORKSPACE_CHANNELS.headerChanged, change)
        if (legacyWorkspaceListeners)
          mainWindow?.webContents.send(
            WORKSPACE_CHANNELS.changed,
            getWorkspace(undefined, true),
            change,
          )
      })
      subscribeWorkspaceChanges((change) => {
        const contents = mainWindow?.webContents
        if (!contents) return
        contents.send(WORKSPACE_CHANNELS.changedV2, change)
        foundationsIpcBenchmark?.send(WORKSPACE_CHANNELS.changedV2, change)
      }, false)
      observeKnownWorkspaces((known) =>
        mainWindow?.webContents.send(WORKSPACE_CHANNELS.listChanged, known),
      )
      handle(DOCUMENT_CHANNELS.update, (event, value: unknown) => {
        const window = trustedWindow(event)
        updateDocument(value)
        updateDocumentEdited(window)
      })
      handle(DOCUMENT_CHANNELS.append, (event, change: unknown) => {
        const window = trustedWindow(event)
        const ack = appendDocumentChange(change)
        updateDocumentEdited(window)
        return ack
      })
      handle(DOCUMENT_CHANNELS.recoveryHead, (event, tabId: unknown) => {
        trustedWindow(event)
        if (typeof tabId !== 'string' || !tabId || tabId.length > 128)
          throw new Error('Invalid document recovery identity.')
        return journalHead(getDocumentSourceFor(tabId))
      })
      handle(
        DOCUMENT_CHANNELS.verifyCheckpoint,
        (event, checkpoint: unknown) => {
          trustedWindow(event)
          const parsed = parseJournalCheckpoint(checkpoint, MAX_DOCUMENT_BYTES)
          return verifyJournalCheckpoint(
            () => getDocumentSourceFor(parsed.tabId),
            parsed,
            MAX_DOCUMENT_BYTES,
          )
        },
      )
      handle(DOCUMENT_CHANNELS.open, (event) =>
        runFileOperation(event, openDocument),
      )
      handle(DOCUMENT_CHANNELS.external, (event) =>
        runFileOperation(event, async (window) => {
          let document = null
          const errors: string[] = []
          try {
            const hadWorkspace = Boolean(workspaceRoot())
            await openStartupWorkspace(window, externalFiles.length > 0)
            if (!hadWorkspace && workspaceRoot()) document = getDocument()
          } catch (error) {
            errors.push(
              error instanceof Error
                ? error.message
                : 'Could not open the startup workspace.',
            )
          }
          for (const path of externalFiles.splice(0)) {
            try {
              if (!isDocumentName(path))
                throw new Error('Unsupported document format.')
              const opened = await loadDocument(window, path)
              if (!opened) break
              document = opened
            } catch (error) {
              errors.push(
                `${basename(path)}: ${error instanceof Error ? error.message : 'Could not open file.'}`,
              )
            }
          }
          return { document, errors }
        }),
      )
      handle(DOCUMENT_CHANNELS.navigate, (event, direction: unknown) =>
        runFileOperation(event, (window) =>
          navigateDocument(window, direction),
        ),
      )
      handle(
        DOCUMENT_CHANNELS.link,
        (event, href: unknown, revision: unknown) =>
          runFileOperation(event, (window) =>
            openDocumentLink(window, href, revision),
          ),
      )
      handle(DOCUMENT_CHANNELS.remote, (event, url: unknown) =>
        runFileOperation(event, (window) => openRemoteDocument(window, url)),
      )
      handle(DOCUMENT_CHANNELS.new, (event) =>
        runFileOperation(event, newDocument),
      )
      handle(DOCUMENT_CHANNELS.save, (event, saveAs: unknown) => {
        if (typeof saveAs !== 'boolean')
          throw new Error('Could not read the save request. Try saving again.')
        return runFileOperation(event, async (window) => {
          const previous = getDocumentPath()
          const pending = getDocument().ephemeral
          const saved = await saveDocument(
            window,
            saveAs,
            join(workspaceRoot() ?? '', getDocument().name),
          )
          if (saved)
            await documentFileChanged(
              previous,
              getDocumentPath(),
              pending || previous !== getDocumentPath(),
            )
          return saved
        })
      })
      handle(
        DOCUMENT_CHANNELS.saveTarget,
        (
          event,
          owner: unknown,
          tabId: unknown,
          revision: unknown,
          contentVersion: unknown,
        ) => {
          const activation = fileOwner(owner)
          if (!activation) return { status: 'stale', document: null }
          return runFileOperation(event, async (window) => {
            const path =
              typeof tabId === 'string' ? getDocumentPathForTab(tabId) : null
            const result = await saveTargetDocument(
              window,
              tabId,
              revision,
              contentVersion,
              () =>
                isAddonActivationCurrent(activation.id, activation.generation),
            )
            if (result.status === 'saved' && path)
              await documentFileChanged(path, path, false)
            return result
          })
        },
      )
      handle(
        DOCUMENT_CHANNELS.autosave,
        (event, tabId: unknown, revision: unknown) => {
          trustedWindow(event)
          if (fileOperation) return { status: 'skipped', document: null }
          return runFileOperation(event, async (window) => {
            const target =
              typeof tabId === 'string' ? getDocumentPathForTab(tabId) : null
            const result = await autosaveDocument(window, tabId, revision)
            if (result.status === 'saved')
              await documentFileChanged(target, target, false)
            return result
          })
        },
      )
      handle(DOCUMENT_CHANNELS.rename, (event, name: unknown) =>
        runFileOperation(event, async () => {
          const previous = getDocumentPath()
          const pending = getDocument().ephemeral
          const root = workspaceRoot()
          const renamed = await renameWithTableLayout(
            () => renameDocument(name),
            () =>
              pending || previous === getDocumentPath()
                ? null
                : [
                    root,
                    workspaceRelativePath(previous),
                    workspaceRelativePath(getDocumentPath()),
                  ],
          )
          if (previous !== getDocumentPath())
            await documentFileChanged(previous, getDocumentPath(), !pending)
          return renamed
        }),
      )
      nativeTheme.on('updated', () => {
        mainWindow?.setBackgroundColor(appearanceColors().background)
        if (process.platform !== 'darwin')
          mainWindow?.setTitleBarOverlay(titleBarColors())
        refreshAddonWindowColors()
      })
      windowSetupReady = true
      createWindow()
      await preferences
      installMenu()
      await updatesReady
      startUpdateChecks()
    })
    .catch((error: unknown) => {
      console.error('startup failed:', error)
      showStartupError()
    })
}
