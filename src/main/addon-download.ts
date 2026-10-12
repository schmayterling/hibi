import { addonPackageUrl, MAX_ADDON_BYTES } from '../shared/addon-package.ts'
import {
  addonCandidatePaths,
  copyAddonPackage,
  inventoryAddonArchive,
} from './addon-inventory.ts'
import { download } from './download.ts'

/** No cookies, credentials, or code execution; redirects must remain HTTPS. */
export async function downloadAddon(
  value: unknown,
  signal?: AbortSignal,
): Promise<{ zip: Buffer; host: string }> {
  const parts: Uint8Array[] = []
  const timeout = AbortSignal.timeout(20000)
  const result = await download(addonPackageUrl(value).href, {
    maxBytes: MAX_ADDON_BYTES,
    parseUrl: addonPackageUrl,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    accept: 'application/zip',
    write: (chunk) => {
      parts.push(chunk)
    },
  })
  return { zip: Buffer.concat(parts), host: new URL(result.url).host }
}

/** Compatibility path for archives containing one prepared package. */
export async function unpackAddon(
  zip: Buffer,
  destination: string,
): Promise<string> {
  const inventory = await inventoryAddonArchive(zip)
  const candidates = addonCandidatePaths(inventory)
  if (candidates.length !== 1)
    throw new Error('The ZIP file needs exactly one hibi-addon.json.')
  await copyAddonPackage(inventory, candidates[0] ?? '', destination)
  return destination
}
