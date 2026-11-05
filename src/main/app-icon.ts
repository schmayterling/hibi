import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  app,
  BrowserWindow,
  nativeImage,
  nativeTheme,
  systemPreferences,
} from 'electron'
import {
  type AppIconMode,
  darkAppIcon,
  isAppIconMode,
} from '../shared/app-icon'
import { writeText } from './files'
import { setMacAppIcon } from './mac-app-icon'

const platform =
  process.platform === 'darwin'
    ? 'mac'
    : process.platform === 'win32'
      ? 'win'
      : 'linux'

let mode: AppIconMode = 'app'
let configured = false
let persistence: Promise<void> = Promise.resolve()
let persisted: string | undefined
export async function flushAppIcon() {
  await writing
  await persistence
}
let writing: Promise<void> = Promise.resolve()
const preferencePath = () => join(app.getPath('userData'), 'app-icon.json')
export const getAppIconMode = () => mode

export async function loadAppIconMode() {
  if (process.platform !== 'darwin') return
  try {
    const value: unknown = JSON.parse(await readFile(preferencePath(), 'utf8'))
    if (!isAppIconMode(value)) throw new Error('Invalid app icon appearance.')
    mode = value
    configured = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      console.error('Could not load app icon appearance:', error)
  }
}

export function saveAppIconMode(value: unknown) {
  if (process.platform !== 'darwin' || !isAppIconMode(value))
    throw new Error('Invalid app icon appearance.')
  writing = writing
    .catch(() => {})
    .then(async () => {
      await writeText(preferencePath(), JSON.stringify(value))
      mode = value
      configured = true
      await applyAppIcon()
    })
  return writing
}

function isDarkIcon() {
  return darkAppIcon(
    mode,
    nativeTheme.shouldUseDarkColors,
    process.platform === 'darwin'
      ? systemPreferences.getUserDefault('AppleInterfaceStyle', 'string') ===
          'Dark'
      : nativeTheme.shouldUseDarkColors,
  )
}

/** The app icon for the light or dark appearance (`npm run icons` renders both). */
export function appIconPath(dark = isDarkIcon()) {
  const name = `icon-${platform}${dark ? '-dark' : ''}.png`
  return app.isPackaged
    ? join(process.resourcesPath, 'icons', name)
    : join(app.getAppPath(), 'build', name)
}

let shown: boolean | undefined
/** Update runtime icons and, after an explicit choice, the installed macOS icon. */
export function applyAppIcon(): Promise<void> {
  const dark = isDarkIcon()
  if (dark !== shown) {
    const first = shown === undefined
    shown = dark
    if (process.platform === 'darwin') {
      // Adaptive installed icons can be dark even when Hibi uses a light theme.
      if (!(first && app.isPackaged && mode === 'system'))
        app.dock?.setIcon(
          nativeImage
            .createFromPath(appIconPath(dark))
            .resize({ width: 256, height: 256 }),
        )
    } else
      for (const window of BrowserWindow.getAllWindows())
        window.setIcon(appIconPath(dark))
  }
  // Never customize the developer/test Electron bundle or an unconfigured install.
  if (process.platform !== 'darwin' || !app.isPackaged || !configured)
    return Promise.resolve()
  const desired = mode === 'system' ? 'system' : dark ? 'dark' : 'light'
  const bundle = dirname(dirname(dirname(process.execPath)))
  const icon = mode === 'system' ? null : appIconPath(dark)
  persistence = persistence
    .catch(() => {})
    .then(async () => {
      if (persisted === desired) return
      try {
        await setMacAppIcon(bundle, icon)
        persisted = desired
      } catch (cause) {
        throw new Error(
          'Your preference was saved, but the installed app icon could not be updated. Move Hibi to a writable Applications folder and choose the icon again.',
          { cause },
        )
      }
    })
  return persistence
}
