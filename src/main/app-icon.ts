import { mkdtemp, open, readFile, rm, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  type NativeImage,
  nativeImage,
  nativeTheme,
  systemPreferences,
} from 'electron'
import {
  type AppIconMode,
  type AppIconState,
  appIconFormats,
  appIconModes,
  appIconPreference,
  darkAppIcon,
  isAppIconMode,
  MAX_APP_ICON_BYTES,
  MIN_APP_ICON_SIDE,
  readAppIcon,
} from '../shared/app-icon'
import { runFileDialog } from './file-operation-dialog'
import { writeText } from './files'

const platform =
  process.platform === 'darwin'
    ? 'mac'
    : process.platform === 'win32'
      ? 'win'
      : 'linux'

let mode: AppIconMode = 'app'
let custom: NativeImage | null = null
let customRead: Promise<void> | undefined
let customRevision = 0
let writing: Promise<unknown> = Promise.resolve()
const preferencePath = () => join(app.getPath('userData'), 'app-icon.json')
const customPath = () => join(app.getPath('userData'), 'app-icon.png')

/** The custom image is decoded at launch only when it is the icon shown. */
function readCustom() {
  customRead ??= readFile(customPath()).then(
    (bytes) => {
      const image = nativeImage.createFromBuffer(bytes)
      if (image.isEmpty()) console.error('Could not read the custom app icon.')
      else custom = image
    },
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT')
        console.error('Could not load the custom app icon:', error)
    },
  )
  return customRead
}

/** Reads the app icon choice before the first window opens. */
export async function loadAppIcon() {
  try {
    mode = appIconPreference(
      JSON.parse(await readFile(preferencePath(), 'utf8')),
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      console.error('Could not load the app icon preference:', error)
  }
  if (!appIconModes(process.platform).includes(mode)) mode = 'app'
  if (mode !== 'custom') return
  await readCustom()
  if (!custom) mode = 'app'
}

export async function appIconState(): Promise<AppIconState> {
  await readCustom()
  return {
    mode,
    custom: custom?.resize({ width: 128, quality: 'best' }).toDataURL() ?? null,
  }
}

/** The appearance macOS and Windows use, even while Hibi sets its own. */
const systemDark = () =>
  process.platform === 'darwin'
    ? systemPreferences.getUserDefault('AppleInterfaceStyle', 'string') ===
      'Dark'
    : nativeTheme.shouldUseDarkColorsForSystemIntegratedUI

function shownIcon() {
  if (mode === 'custom' && custom)
    return { key: `custom-${customRevision}`, icon: custom }
  const dark = darkAppIcon(
    mode === 'custom' ? 'app' : mode,
    nativeTheme.shouldUseDarkColors,
    systemDark(),
  )
  const name = `icon-${platform}${dark ? '-dark' : ''}.png`
  return {
    key: dark ? 'dark' : 'light',
    icon: app.isPackaged
      ? join(process.resourcesPath, 'icons', name)
      : join(app.getAppPath(), 'build', name),
  }
}

/** The window icon for Windows and Linux (the taskbar and window switcher). */
export const appIcon = () => shownIcon().icon

let shown: string | undefined
/**
 * Show the chosen icon: the Dock icon on macOS, each window's icon elsewhere.
 * Installed macOS apps start with their light bundle icon, so nothing is
 * re-encoded at launch for it; development builds always replace Electron's.
 * The app bundle itself is never changed, so its signature stays intact.
 */
export function applyAppIcon() {
  const { key, icon } = shownIcon()
  if (key === shown) return
  const first = shown === undefined
  shown = key
  if (process.platform === 'darwin') {
    if (first && app.isPackaged && key === 'light') return
    app.dock?.setIcon(
      typeof icon === 'string'
        ? nativeImage.createFromPath(icon).resize({ width: 256, height: 256 })
        : icon,
    )
  } else
    for (const window of BrowserWindow.getAllWindows()) window.setIcon(icon)
}

/** `image` replaces the custom image; `null` removes it. */
function save(next: AppIconMode | 'kept', image?: NativeImage | null) {
  const run = writing
    .catch(() => {})
    .then(async () => {
      await readCustom()
      const target = next === 'kept' ? (mode === 'custom' ? 'app' : mode) : next
      if (target === 'custom' && !custom && !image)
        throw new Error('Choose an image for the app icon first.')
      if (image) await writeText(customPath(), image.toPNG())
      else if (image === null)
        await unlink(customPath()).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error
        })
      if (image !== undefined) {
        custom = image
        customRevision++
      }
      try {
        await writeText(preferencePath(), JSON.stringify({ mode: target }))
      } catch (error) {
        console.error('Could not save the app icon preference:', error)
        throw new Error('Could not save your app icon. Try again.', {
          cause: error,
        })
      }
      mode = target
      applyAppIcon()
      return appIconState()
    })
  writing = run
  return run
}

export function saveAppIconMode(value: unknown) {
  if (!isAppIconMode(value) || !appIconModes(process.platform).includes(value))
    throw new Error('Invalid app icon setting.')
  return save(value)
}

/** Removes the custom image; its mode falls back to following Hibi. */
export const resetAppIcon = () => save('kept', null)

async function readImage(path: string) {
  const file = await open(path, 'r')
  try {
    const { size } = await file.stat()
    // One byte past the limit is enough for the size check to refuse it.
    const bytes = Buffer.alloc(Math.min(size, MAX_APP_ICON_BYTES) + 1)
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
    return bytes.subarray(0, bytesRead)
  } finally {
    await file.close()
  }
}

/** Draws a checked SVG with Quick Look (macOS), from a private copy. */
async function drawSvg(bytes: Buffer) {
  const folder = await mkdtemp(join(app.getPath('temp'), 'hibi-app-icon-'))
  try {
    const path = join(folder, 'icon.svg')
    await writeText(path, bytes)
    const image = await nativeImage.createThumbnailFromPath(path, {
      width: 512,
      height: 512,
    })
    // One representation: with a Retina one kept too, the size checks below
    // would see 512 pixels and save the 1024-pixel drawing.
    return nativeImage.createFromBuffer(image.toPNG())
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
}

/** Opens the system file dialog; Hibi keeps a PNG of at most 512 pixels. */
export async function chooseAppIcon(window: BrowserWindow) {
  const result = await runFileDialog(() =>
    dialog.showOpenDialog(window, {
      title: 'Choose app icon',
      properties: ['openFile'],
      filters: [
        { name: 'Images', extensions: appIconFormats(process.platform) },
      ],
    }),
  )
  const path = result.filePaths[0]
  if (result.canceled || !path) return null
  const unreadable = (cause: unknown) =>
    new Error('Could not read this image. Choose another one.', { cause })
  const bytes = await readImage(path).catch((cause) => {
    throw unreadable(cause)
  })
  const { format, png } = readAppIcon(bytes)
  if (!appIconFormats(process.platform).includes(format))
    throw new Error(
      `${format.toUpperCase()} images can't be the app icon on this system. Choose a PNG.`,
    )
  // ICNS and ICO arrive here as the PNG embedded in them.
  const image = png
    ? nativeImage.createFromBuffer(Buffer.from(png))
    : await drawSvg(bytes).catch((cause) => {
        throw unreadable(cause)
      })
  if (image.isEmpty()) throw unreadable(null)
  const { width, height } = image.getSize()
  if (Math.min(width, height) < MIN_APP_ICON_SIDE)
    throw new Error(
      `Choose an image at least ${MIN_APP_ICON_SIDE} by ${MIN_APP_ICON_SIDE} pixels.`,
    )
  return save(
    'custom',
    width <= 512 && height <= 512
      ? image
      : image.resize({
          ...(width >= height ? { width: 512 } : { height: 512 }),
          quality: 'best',
        }),
  )
}
