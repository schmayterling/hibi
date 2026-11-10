import { checkSvgIcon } from './svg-icon.ts'

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
const noPng = (format: string) =>
  new Error(
    `This ${format} has no PNG image inside that Hibi can read. Choose a PNG.`,
  )
const ascii = (bytes: Uint8Array, start: number, end: number) =>
  String.fromCharCode(...bytes.subarray(start, end))

/** A PNG's width, read from its header, or null if `bytes` is not a PNG. */
function pngWidth(bytes: Uint8Array) {
  if (
    bytes.length < 33 ||
    ascii(bytes, 0, 8) !== '\x89PNG\r\n\x1a\n' ||
    ascii(bytes, 12, 16) !== 'IHDR'
  )
    return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  if (!width || !height) throw unreadable()
  if (width > MAX_APP_ICON_SIDE || height > MAX_APP_ICON_SIDE) throw tooLarge()
  return width
}

/** The widest PNG among an icon file's images. */
function widest(images: Uint8Array[], format: string) {
  let best: Uint8Array | null = null
  let bestWidth = 0
  for (const image of images) {
    const width = pngWidth(image)
    if (width && width > bestWidth) [best, bestWidth] = [image, width]
  }
  if (!best) throw noPng(format)
  return best
}

/**
 * The image format, from the file's bytes rather than its name, and the PNG
 * to decode for it. ICNS and ICO files are read here, so only an embedded PNG
 * reaches the decoder; an SVG must pass `checkSvgIcon`. PNG sizes come from
 * the header so a huge image is refused before it is decoded.
 */
export function readAppIcon(bytes: Uint8Array): {
  format: AppIconFormat
  png: Uint8Array | null
} {
  if (!bytes.length) throw unreadable()
  if (bytes.length > MAX_APP_ICON_BYTES)
    throw new Error('Choose an image smaller than 8 MB.')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (pngWidth(bytes)) return { format: 'png', png: bytes }
  if (
    bytes.length >= 8 &&
    ascii(bytes, 0, 4) === 'icns' &&
    view.getUint32(4) === bytes.length
  ) {
    const images = []
    for (let at = 8; at < bytes.length; ) {
      const length = at + 8 <= bytes.length ? view.getUint32(at + 4) : 0
      if (length < 8 || at + length > bytes.length) throw noPng('ICNS')
      images.push(bytes.subarray(at + 8, at + length))
      at += length
    }
    return { format: 'icns', png: widest(images, 'ICNS') }
  }
  if (
    bytes.length >= 6 &&
    view.getUint16(0, true) === 0 &&
    view.getUint16(2, true) === 1 &&
    view.getUint16(4, true) > 0
  ) {
    const count = view.getUint16(4, true)
    if (6 + count * 16 > bytes.length) throw noPng('ICO')
    const images = []
    for (let entry = 6; entry < 6 + count * 16; entry += 16) {
      const size = view.getUint32(entry + 8, true)
      const offset = view.getUint32(entry + 12, true)
      if (offset + size > bytes.length) throw noPng('ICO')
      // ponytail: bitmap entries are skipped; old bitmap-only ICOs need a BMP reader.
      images.push(bytes.subarray(offset, offset + size))
    }
    return { format: 'ico', png: widest(images, 'ICO') }
  }
  const text = new TextDecoder().decode(bytes.subarray(0, 1024))
  if (/^\s*</.test(text) || bytes[0] === 0xfe || bytes[0] === 0xff) {
    checkSvgIcon(bytes)
    return { format: 'svg', png: null }
  }
  throw unreadable()
}

/** Formats each platform reads: SVG needs macOS's Quick Look to draw it. */
export function appIconFormats(platform: string): AppIconFormat[] {
  return platform === 'darwin'
    ? ['png', 'icns', 'ico', 'svg']
    : ['png', 'icns', 'ico']
}

/**
 * Linux reports only the appearance Hibi itself sets, so Follow system would
 * silently follow Hibi there; it is not offered.
 */
export function appIconModes(platform: string): AppIconMode[] {
  return APP_ICON_MODES.filter(
    (mode) => platform !== 'linux' || mode !== 'system',
  )
}
