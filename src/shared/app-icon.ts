export const APP_ICON_CHANNELS = {
  get: 'app-icon:get',
  set: 'app-icon:set',
  choose: 'app-icon:choose',
  reset: 'app-icon:reset',
} as const

export const APP_ICON_MODES = [
  'system',
  'app',
  'light',
  'dark',
  'custom',
] as const
export type AppIconMode = (typeof APP_ICON_MODES)[number]
/** The chosen mode, and a small PNG data URL of the custom image if one is kept. */
export type AppIconState = { mode: AppIconMode; custom: string | null }

export const isAppIconMode = (value: unknown): value is AppIconMode =>
  APP_ICON_MODES.some((mode) => mode === value)

/** Reads app-icon.json; anything else than `{ mode }` with a known mode is rejected. */
export function appIconPreference(value: unknown): AppIconMode {
  if (
    value !== null &&
    typeof value === 'object' &&
    Object.keys(value).length === 1 &&
    'mode' in value &&
    isAppIconMode(value.mode)
  )
    return value.mode
  throw new TypeError('Expected an app icon preference.')
}

export function darkAppIcon(
  mode: Exclude<AppIconMode, 'custom'>,
  appDark: boolean,
  systemDark: boolean,
) {
  if (mode === 'app') return appDark
  if (mode === 'system') return systemDark
  return mode === 'dark'
}

export const MAX_APP_ICON_BYTES = 8 * 1024 * 1024
export const MAX_APP_ICON_SIDE = 4096
export const MIN_APP_ICON_SIDE = 16
export type AppIconFormat = 'png' | 'icns' | 'ico' | 'svg'

const tooLarge = () =>
  new Error(
    `Choose an image up to ${MAX_APP_ICON_SIDE} by ${MAX_APP_ICON_SIDE} pixels.`,
  )
const unreadable = () =>
  new Error('Choose a PNG, ICNS, ICO or SVG image for the app icon.')
// Only fragment links and embedded raster images; no files, no network.
const local = String.raw`(?!["']?\s*(?:#|data:image\/(?:png|jpeg|gif|webp)[;,]))`
const outside = new RegExp(
  String.raw`<script|<foreignObject|@import|\b(?:href|src)\s*=\s*${local}|url\(\s*${local}`,
  'i',
)

/**
 * The image format, from the file's bytes rather than its name. PNG sizes are
 * read from the header so a huge image is refused before it is decoded.
 */
export function appIconFormat(bytes: Uint8Array): AppIconFormat {
  if (!bytes.length) throw unreadable()
  if (bytes.length > MAX_APP_ICON_BYTES)
    throw new Error('Choose an image smaller than 8 MB.')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const ascii = (start: number, end: number) =>
    String.fromCharCode(...bytes.subarray(start, end))
  if (
    bytes.length >= 24 &&
    ascii(0, 8) === '\x89PNG\r\n\x1a\n' &&
    ascii(12, 16) === 'IHDR'
  ) {
    const width = view.getUint32(16)
    const height = view.getUint32(20)
    if (!width || !height) throw unreadable()
    if (width > MAX_APP_ICON_SIDE || height > MAX_APP_ICON_SIDE)
      throw tooLarge()
    return 'png'
  }
  if (
    bytes.length >= 8 &&
    ascii(0, 4) === 'icns' &&
    view.getUint32(4) === bytes.length
  )
    return 'icns'
  if (
    bytes.length >= 22 &&
    view.getUint16(0, true) === 0 &&
    view.getUint16(2, true) === 1 &&
    view.getUint16(4, true) > 0
  )
    return 'ico'
  // The decoder drops a leading byte order mark.
  const text = new TextDecoder().decode(bytes)
  if (/^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/.test(text)) {
    if (outside.test(text))
      throw new Error(
        'This SVG loads other files or runs scripts. Choose a self-contained image.',
      )
    return 'svg'
  }
  throw unreadable()
}

/** Formats each platform's image decoders read. */
export function appIconFormats(platform: string): AppIconFormat[] {
  if (platform === 'darwin') return ['png', 'icns', 'ico', 'svg']
  if (platform === 'win32') return ['png', 'ico']
  return ['png']
}
