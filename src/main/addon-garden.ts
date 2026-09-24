import { compatibleAddonManifest } from '../addons/api.ts'
import type { GardenAddon } from '../shared/sideload'

export const GARDEN_REPOSITORY =
  'https://github.com/hibigarden/addons-repository'
const CATALOG_URL =
  'https://raw.githubusercontent.com/hibigarden/addons-repository/main/catalog.json'
const MAX_CATALOG_BYTES = 256 * 1024

export async function getGardenAddons(request = fetch): Promise<GardenAddon[]> {
  const response = await request(CATALOG_URL, {
    signal: AbortSignal.timeout(8000),
  })
  if (!response.ok || !response.body)
    throw new Error('Could not load garden addons. Try again later.')
  const chunks: Uint8Array[] = []
  let bytes = 0
  for await (const chunk of response.body) {
    bytes += chunk.length
    if (bytes > MAX_CATALOG_BYTES)
      throw new Error('The garden addon catalog is too large.')
    chunks.push(chunk)
  }
  const entries: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!Array.isArray(entries) || entries.length > 200)
    throw new Error('The garden addon catalog is invalid.')
  const ids = new Set<string>()
  for (const entry of entries) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof entry.id !== 'string' ||
      !/^[a-z][a-z0-9-]*$/.test(entry.id) ||
      ids.has(entry.id) ||
      entry.path !== `addons/${entry.id}` ||
      ![entry.name, entry.description, entry.version].every(
        (value) => typeof value === 'string' && !!value.trim(),
      ) ||
      !compatibleAddonManifest(entry) ||
      !['extension', 'theme'].includes(entry.kind) ||
      !Array.isArray(entry.authors) ||
      !entry.authors.length ||
      entry.authors.some(
        (author: unknown) =>
          !author ||
          typeof author !== 'object' ||
          typeof (author as { displayName?: unknown }).displayName !== 'string',
      )
    )
      throw new Error('The garden addon catalog is invalid.')
    ids.add(entry.id)
  }
  return entries as GardenAddon[]
}
