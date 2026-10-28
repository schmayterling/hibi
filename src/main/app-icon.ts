import { join } from 'node:path'
import { app, BrowserWindow, nativeImage, nativeTheme } from 'electron'

const platform =
  process.platform === 'darwin'
    ? 'mac'
    : process.platform === 'win32'
      ? 'win'
      : 'linux'

/** The app icon for the light or dark appearance (`npm run icons` renders both). */
export function appIconPath(dark = nativeTheme.shouldUseDarkColors) {
  const name = `icon-${platform}${dark ? '-dark' : ''}.png`
  return app.isPackaged
    ? join(process.resourcesPath, 'icons', name)
    : join(app.getAppPath(), 'build', name)
}

let shown: boolean | undefined
/**
 * Show the icon that matches the current appearance: the Dock icon on macOS,
 * each window's icon elsewhere. Installed macOS apps start with their light
 * bundle icon, so nothing is re-encoded at launch unless the appearance is
 * dark; development builds always replace Electron's icon.
 */
export function applyAppIcon() {
  const dark = nativeTheme.shouldUseDarkColors
  if (dark === shown) return
  const first = shown === undefined
  shown = dark
  if (process.platform === 'darwin') {
    if (first && app.isPackaged && !dark) return
    app.dock?.setIcon(
      nativeImage
        .createFromPath(appIconPath(dark))
        .resize({ width: 256, height: 256 }),
    )
  } else
    for (const window of BrowserWindow.getAllWindows())
      window.setIcon(appIconPath(dark))
}
