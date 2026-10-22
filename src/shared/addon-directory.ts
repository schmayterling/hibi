import type { AddonAuthor, AddonManifest } from '../addons/api'
import { validId } from './addon-manifest.ts'
import {
  addonPackageUrl,
  MAX_ADDON_BYTES,
  validAddonPath,
} from './addon-package.ts'

export const ADDON_DIRECTORY_URL =
  'https://raw.githubusercontent.com/hibigarden/addons-repository/main/catalog.json'
export const ADDON_DIRECTORY_REPOSITORY =
  'https://github.com/hibigarden/addons-repository'
export const MAX_DIRECTORY_BYTES = 1024 * 1024

export type AddonDirectoryEntry = Pick<
  AddonManifest,
  'id' | 'name' | 'description' | 'version' | 'apiVersion' | 'authors'
> & {
  kind: 'extension' | 'theme'
  license: string
  homepage?: string
} & (
    | { path: string; repository?: never; download?: never }
    | {
        repository: { url: string; commit: string; path?: string }
        path?: never
        download?: never
      }
    | {
        download: { url: string; size: number; sha256: string }
        path?: never
        repository?: never
      }
  )

export type AddonDirectory = {
  entries: AddonDirectoryEntry[]
  fetchedAt: string | null
  error?: string
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, limit: number): value is string =>
  typeof value === 'string' && !!value.trim() && value.length <= limit
const folder = (value: unknown): value is string =>
  validAddonPath(value) && !value.endsWith('/')
const author = (value: unknown): value is AddonAuthor =>
  object(value) &&
  text(value.displayName, 128) &&
  (value.github === undefined ||
    (typeof value.github === 'string' &&
      /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(value.github))) &&
  (value.discordId === undefined ||
    (typeof value.discordId === 'string' &&
      /^\d{1,24}$/.test(value.discordId))) &&
  (value.role === undefined || text(value.role, 128))

/** Discovery metadata never grants trust or permission to execute a package. */
export function parseAddonDirectory(value: unknown): AddonDirectoryEntry[] {
  if (!Array.isArray(value) || value.length > 500)
    throw new Error('The addon directory is invalid.')
  const ids = new Set<string>()
  return value.map((entry: unknown) => {
    if (
      !object(entry) ||
      Object.keys(entry).some(
        (key) =>
          ![
            'id',
            'name',
            'description',
            'version',
            'apiVersion',
            'kind',
            'authors',
            'license',
            'homepage',
            'path',
            'repository',
            'download',
          ].includes(key),
      ) ||
      !validId(entry.id) ||
      ids.has(entry.id) ||
      !text(entry.name, 128) ||
      !text(entry.description, 2048) ||
      !text(entry.version, 64) ||
      ![1, 2].includes(entry.apiVersion as number) ||
      !['extension', 'theme'].includes(entry.kind as string) ||
      !text(entry.license, 128) ||
      !Array.isArray(entry.authors) ||
      !entry.authors.length ||
      entry.authors.length > 32 ||
      !entry.authors.every(author) ||
      ['path', 'repository', 'download'].filter(
        (key) => entry[key] !== undefined,
      ).length !== 1
    )
      throw new Error('The addon directory contains an invalid entry.')
    ids.add(entry.id)
    if (entry.homepage !== undefined) addonPackageUrl(entry.homepage)
    if (entry.path !== undefined && !folder(entry.path))
      throw new Error('The addon directory contains an invalid folder.')
    if (entry.repository !== undefined) {
      const source = entry.repository
      if (
        !object(source) ||
        typeof source.url !== 'string' ||
        !/^https:\/\/github\.com\/[A-Za-z\d_.-]+\/[A-Za-z\d_.-]+\/?$/.test(
          source.url,
        ) ||
        typeof source.commit !== 'string' ||
        !/^[a-f\d]{40}$/.test(source.commit) ||
        source.url
          .split('/')
          .slice(3)
          .some((part) => part === '.' || part === '..') ||
        Object.keys(source).some(
          (key) => !['url', 'commit', 'path'].includes(key),
        ) ||
        (source.path !== undefined && !folder(source.path))
      )
        throw new Error('The addon directory contains an invalid repository.')
    }
    if (entry.download !== undefined) {
      const source = entry.download
      if (
        !object(source) ||
        typeof source.url !== 'string' ||
        !Number.isSafeInteger(source.size) ||
        (source.size as number) <= 0 ||
        (source.size as number) > MAX_ADDON_BYTES ||
        typeof source.sha256 !== 'string' ||
        !/^[a-f\d]{64}$/.test(source.sha256) ||
        Object.keys(source).some(
          (key) => !['url', 'size', 'sha256'].includes(key),
        )
      )
        throw new Error('The addon directory contains an invalid download.')
      addonPackageUrl(source.url)
    }
    return entry as AddonDirectoryEntry
  })
}

export function directoryInstallUrl(entry: AddonDirectoryEntry): string {
  if (entry.download) return entry.download.url
  const source = entry.repository
  const path = source?.path ?? entry.path
  return `${(source?.url ?? ADDON_DIRECTORY_REPOSITORY).replace(/\/$/, '')}/tree/${source?.commit ?? 'main'}${path ? `/${path.split('/').map(encodeURIComponent).join('/')}` : ''}`
}

export function addonGardenLink(id: string, install = true): string {
  return `hibi://addons/${install ? 'install' : 'open'}?id=${encodeURIComponent(id)}`
}

export type AddonGardenRequest = { id: string; install: boolean }

export function parseAddonGardenLink(value: string): AddonGardenRequest | null {
  if (value.length > 512) return null
  try {
    const url = new URL(value)
    const id = url.searchParams.get('id')
    if (
      url.protocol === 'hibi:' &&
      url.hostname === 'addons' &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.hash &&
      ['/install', '/open'].includes(url.pathname) &&
      [...url.searchParams].length === 1 &&
      validId(id)
    )
      return { id, install: url.pathname === '/install' }
  } catch {
    /* Other operating-system URLs do not belong to this handler. */
  }
  return null
}

export function directoryManifestMatches(
  entry: AddonDirectoryEntry,
  manifest: AddonManifest,
): boolean {
  return (
    ['id', 'name', 'description', 'version', 'apiVersion', 'kind'].every(
      (key) =>
        entry[key as keyof AddonDirectoryEntry] ===
        manifest[key as keyof AddonManifest],
    ) &&
    JSON.stringify(
      entry.authors?.map(({ displayName, github, discordId, role }) => [
        displayName,
        github,
        discordId,
        role,
      ]),
    ) ===
      JSON.stringify(
        manifest.authors?.map(({ displayName, github, discordId, role }) => [
          displayName,
          github,
          discordId,
          role,
        ]),
      )
  )
}
