export const MAX_ADDON_MANIFEST_BYTES = 64 * 1024
export const MAX_ADDON_BYTES = 25 * 1024 * 1024
export const MAX_ADDON_FILE_BYTES = 5 * 1024 * 1024
export const MAX_ADDON_ENTRIES = 1000

/** Portable repository names, including names excluded from installation. */
export function validAddonInventoryPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length < 2048 &&
    value
      .split('/')
      .every(
        (part) =>
          !!part &&
          part !== '.' &&
          part !== '..' &&
          !/[\\:?<>"|*]|\p{Cc}/u.test(part) &&
          !/[. ]$/.test(part) &&
          !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part),
      )
  )
}

export function excludedAddonPath(path: string): boolean {
  return path.split('/').some((part) => {
    const name = part.toLowerCase()
    return (
      name.startsWith('.') || name === 'node_modules' || name === '__macosx'
    )
  })
}

export function validAddonPath(value: unknown): value is string {
  return (
    validAddonInventoryPath(value) &&
    !/[%#]/.test(value) &&
    value.split('/').every((part) => !part.startsWith('.'))
  )
}

export function addonPackageUrl(value: unknown): URL {
  if (typeof value !== 'string' || value.length > 8192)
    throw new Error(
      'Enter an HTTPS URL for an addon ZIP file or Git repository.',
    )
  return downloadUrl(value)
}

export function downloadUrl(value: unknown): URL {
  if (typeof value !== 'string' || value.length > 8192)
    throw new Error('Enter an HTTPS URL for the download.')
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password)
    throw new Error('Use an HTTPS URL without a username or password.')
  url.hash = ''
  return url
}
