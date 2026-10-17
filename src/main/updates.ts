import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, net } from 'electron'
import type { AppUpdater } from 'electron-updater'
import { HISTORY_CHANNELS } from '../shared/history'
import {
  newerUpdate,
  UPDATE_CHANNELS,
  UPDATE_URL,
  type UpdateRelease,
  type UpdateState,
  updateChannel,
  updateCheckFrequency,
  updateRelease,
} from '../shared/updates'
import { retryRename } from './atomic-rename'

let state: UpdateState = {
  channel: 'nightly-green',
  checkOnStartup: true,
  checkFrequency: 6,
  status: 'idle',
  supported: false,
  message: 'Updates are available in installed builds.',
}
let release: UpdateRelease | undefined
let updater: AppUpdater | undefined
let installRequested = false
let installing = false
let installFailure: (() => void) | undefined
let busy = false
let periodicCheck: ReturnType<typeof setInterval> | undefined
const unsupportedMessage =
  'Updates require an installed macOS or Windows build, or a running Linux AppImage.'
const preferencePath = () =>
  join(app.getPath('userData'), 'update-channel.json')
const startupPreferencePath = () =>
  join(app.getPath('userData'), 'update-startup-check.json')
const frequencyPreferencePath = () =>
  join(app.getPath('userData'), 'update-check-frequency.json')
export const getUpdateState = () => ({ ...state })
export function onUpdateInstallFailure(callback?: () => void) {
  installFailure = callback
}

function failInstall() {
  installRequested = false
  installing = false
  installFailure?.()
  publish({
    status: 'error',
    message: 'Could not install the update. Download it again and retry.',
  })
}

function publish(patch: Partial<UpdateState>) {
  state = { ...state, ...patch }
  for (const window of BrowserWindow.getAllWindows())
    window.webContents.send(UPDATE_CHANNELS.changed, getUpdateState())
}

async function run(action: () => Promise<void>) {
  if (busy || installRequested || installing)
    throw new Error('Wait for the current update action to finish.')
  busy = true
  try {
    await action()
  } catch (error) {
    publish({
      status: 'error',
      message:
        error instanceof Error
          ? error.message
          : 'The update failed. Try again.',
    })
  } finally {
    busy = false
  }
  return getUpdateState()
}

export async function loadUpdates() {
  try {
    state.channel = updateChannel(
      JSON.parse(await readFile(preferencePath(), 'utf8')),
    )
  } catch {
    /* Missing or old preferences use the recommended channel. */
  }
  try {
    const saved = JSON.parse(await readFile(startupPreferencePath(), 'utf8'))
    if (typeof saved === 'boolean') state.checkOnStartup = saved
  } catch {
    /* Missing preferences check on startup. */
  }
  try {
    state.checkFrequency = updateCheckFrequency(
      JSON.parse(await readFile(frequencyPreferencePath(), 'utf8')),
    )
  } catch {
    /* Missing or old preferences use six hours. */
  }
  state.supported =
    app.isPackaged &&
    ((process.platform === 'darwin' &&
      ['arm64', 'x64'].includes(process.arch)) ||
      (process.platform === 'win32' && process.arch === 'x64') ||
      (process.platform === 'linux' &&
        process.arch === 'x64' &&
        !!process.env.APPIMAGE))
  state.message = state.supported
    ? 'Hibi checks for updates automatically. You choose when to download and install.'
    : unsupportedMessage
}

function schedulePeriodicChecks() {
  if (periodicCheck) clearInterval(periodicCheck)
  periodicCheck = setInterval(
    checkAutomatically,
    state.checkFrequency * 60 * 60 * 1000,
  )
  periodicCheck.unref()
}

function checkAutomatically() {
  if (
    !busy &&
    !installRequested &&
    !installing &&
    ['idle', 'error'].includes(state.status)
  )
    void checkForUpdates().catch(() => {})
}

export function startUpdateChecks() {
  if (!state.supported) return
  setTimeout(() => {
    if (state.checkOnStartup) checkAutomatically()
  }, 15_000).unref()
  schedulePeriodicChecks()
}

export function setUpdateStartupCheck(input: unknown) {
  if (typeof input !== 'boolean')
    throw new Error('Choose whether to check for updates on startup.')
  return run(async () => {
    await writeFile(`${startupPreferencePath()}.tmp`, JSON.stringify(input), {
      mode: 0o600,
    })
    await retryRename(() =>
      rename(`${startupPreferencePath()}.tmp`, startupPreferencePath()),
    )
    publish({ checkOnStartup: input })
  })
}

export function setUpdateCheckFrequency(input: unknown) {
  const hours = updateCheckFrequency(input)
  return run(async () => {
    await writeFile(`${frequencyPreferencePath()}.tmp`, JSON.stringify(hours), {
      mode: 0o600,
    })
    await retryRename(() =>
      rename(`${frequencyPreferencePath()}.tmp`, frequencyPreferencePath()),
    )
    publish({ checkFrequency: hours })
    if (periodicCheck) schedulePeriodicChecks()
  })
}

export function setUpdateChannel(input: unknown) {
  const channel = updateChannel(input)
  return run(async () => {
    await writeFile(`${preferencePath()}.tmp`, JSON.stringify(channel), {
      mode: 0o600,
    })
    await retryRename(() => rename(`${preferencePath()}.tmp`, preferencePath()))
    release = undefined
    publish({
      channel,
      status: 'idle',
      version: undefined,
      broken: undefined,
      progress: undefined,
      message: state.supported
        ? 'Update channel saved. Check for updates to see the latest build.'
        : unsupportedMessage,
    })
  })
}

export function checkForUpdates() {
  return run(async () => {
    if (!state.supported)
      throw new Error(
        'Updates are available only in supported installed builds.',
      )
    release = undefined
    publish({
      status: 'checking',
      version: undefined,
      broken: undefined,
      progress: undefined,
      message: 'Checking for updates…',
    })
    const response = await net.fetch(
      `${UPDATE_URL}${state.channel}/update.json`,
      {
        cache: 'no-store',
        signal: AbortSignal.timeout(30_000),
      },
    )
    if (response.status === 404)
      throw new Error(
        'No build is available on this channel yet. Try again later.',
      )
    if (!response.ok)
      throw new Error(
        `Could not check for updates (HTTP ${response.status}). Try again.`,
      )
    const candidate = updateRelease(await response.json(), state.channel)
    if (!candidate.assets[`${process.platform}-${process.arch}`])
      throw new Error('This update has no download for your system.')
    if (!newerUpdate(candidate.version, app.getVersion())) {
      publish({
        status: 'idle',
        message: 'No newer build is available on this channel.',
      })
      return
    }
    release = candidate
    publish({
      status: 'available',
      version: candidate.version,
      broken: candidate.status === 'nightly-broken',
      message: `An update is available: ${candidate.version}`,
    })
    for (const window of BrowserWindow.getAllWindows())
      window.webContents.send(
        HISTORY_CHANNELS.notice,
        'A Hibi update is available.',
        'updates',
      )
  })
}

async function desktopUpdater() {
  if (!updater) {
    const module = await import('electron-updater')
    updater = module.default.autoUpdater
    updater.autoDownload = false
    updater.autoInstallOnAppQuit = false
    updater.allowPrerelease = true
    updater.disableDifferentialDownload = true
    updater.on('error', () => {
      if (installRequested || installing) failInstall()
    })
    updater.on('download-progress', ({ percent }) =>
      publish({ progress: Math.floor(percent) }),
    )
  }
  return updater
}

export function downloadUpdate() {
  return run(async () => {
    if (!release || !['available', 'error'].includes(state.status))
      throw new Error('Check for updates before downloading.')
    publish({
      status: 'downloading',
      progress: 0,
      message: `An update is available: ${release.version}`,
    })
    const base = `${UPDATE_URL}${release.tag}/`
    const client = await desktopUpdater()
    client.setFeedURL({
      provider: 'generic',
      url: base,
      channel: 'latest',
      useMultipleRangeRequest: false,
    })
    // Our run-number comparison already rejected older builds. Semver sorts Git hashes incorrectly.
    client.allowDowngrade = true
    const result = await client.checkForUpdates()
    const asset = release.assets[`${process.platform}-${process.arch}`]
    const expected =
      process.platform === 'darwin'
        ? [
            release.assets['darwin-arm64']?.zip,
            release.assets['darwin-x64']?.zip,
          ]
        : [asset]
    const files = result?.updateInfo.files
    if (
      !result?.isUpdateAvailable ||
      result.updateInfo.version !== release.version ||
      !asset ||
      expected.some((file) => !file) ||
      files?.length !== expected.length ||
      !expected.every((file) =>
        files.some(
          (actual) =>
            actual.url === file?.name &&
            actual.sha512 === file.sha512 &&
            actual.size === file.size,
        ),
      )
    )
      throw new Error('The update metadata changed. Check for updates again.')
    await client.downloadUpdate()
    publish({
      status: 'downloaded',
      progress: 100,
      message: `An update is available: ${release.version}`,
    })
  })
}

export async function installUpdate() {
  if (busy || installRequested || installing || state.status !== 'downloaded')
    throw new Error('Download an update before installing.')
  installRequested = true
  app.quit()
}

export function cancelUpdateInstall() {
  installRequested = false
}
export function finishUpdateInstall() {
  if (installing) return true
  if (!installRequested || !updater) return undefined
  installRequested = false
  installing = true
  try {
    updater.quitAndInstall(false, true)
  } catch {
    if (installing) failInstall()
  }
  return state.status !== 'error'
}
