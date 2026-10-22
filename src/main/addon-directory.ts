import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import {
  ADDON_DIRECTORY_URL,
  type AddonDirectory,
  type AddonDirectoryEntry,
  MAX_DIRECTORY_BYTES,
  parseAddonDirectory,
} from '../shared/addon-directory'
import { validId } from '../shared/addon-manifest'
import { retryRename } from './atomic-rename'
import { download } from './download'

const HOUR = 60 * 60 * 1000
let cached: AddonDirectory | undefined
let loaded = false
let pending: Promise<AddonDirectory> | undefined
let lastAttempt = 0
const cachePath = () => join(app.getPath('userData'), 'addon-directory.json')

/** Fetch only when the user opens the directory; startup remains offline. */
export async function getAddonDirectory(
  refresh = false,
): Promise<AddonDirectory> {
  if (pending) return pending
  pending = loadDirectory(refresh).finally(() => {
    pending = undefined
  })
  return pending
}

async function loadDirectory(refresh: boolean): Promise<AddonDirectory> {
  if (!loaded) {
    loaded = true
    try {
      const saved: unknown = JSON.parse(await readFile(cachePath(), 'utf8'))
      if (
        saved &&
        typeof saved === 'object' &&
        'entries' in saved &&
        'fetchedAt' in saved &&
        typeof saved.fetchedAt === 'string' &&
        Number.isFinite(Date.parse(saved.fetchedAt))
      )
        cached = {
          entries: parseAddonDirectory(saved.entries),
          fetchedAt: saved.fetchedAt,
        }
    } catch {
      /* A missing or invalid cache is replaced by the next successful fetch. */
    }
  }
  if (
    !refresh &&
    cached &&
    Date.now() -
      Math.max(lastAttempt, Date.parse(cached.fetchedAt ?? '') || 0) <
      HOUR
  )
    return cached
  lastAttempt = Date.now()
  return refreshDirectory()
}

async function refreshDirectory(): Promise<AddonDirectory> {
  try {
    const testing = !app.isPackaged && app.commandLine.hasSwitch('hibi-test')
    const override = testing
      ? process.env.HIBI_TEST_ADDON_DIRECTORY_URL
      : undefined
    const source = override ?? ADDON_DIRECTORY_URL
    const parts: Uint8Array[] = []
    const { net } = await import('electron')
    await download(source, {
      maxBytes: MAX_DIRECTORY_BYTES,
      signal: AbortSignal.timeout(15_000),
      stallTimeoutMs: 5000,
      accept: 'application/json',
      allowedOrigins: [new URL(source).origin],
      ...(override
        ? {
            parseUrl: (value: string) => {
              const url = new URL(value)
              if (url.href !== source)
                throw new Error('The test directory redirected.')
              return url
            },
          }
        : {}),
      fetch: (input, init) => net.fetch(input as string | Request, init),
      write: (chunk) => {
        parts.push(chunk)
      },
    })
    const entries = parseAddonDirectory(
      JSON.parse(Buffer.concat(parts).toString('utf8')),
    )
    const next: AddonDirectory = {
      entries,
      fetchedAt: new Date().toISOString(),
    }
    const path = cachePath()
    await writeFile(`${path}.tmp`, JSON.stringify(next), { mode: 0o600 })
    await retryRename(() => rename(`${path}.tmp`, path))
    cached = next
    return next
  } catch (error) {
    cached = {
      entries: cached?.entries ?? [],
      fetchedAt: cached?.fetchedAt ?? null,
      error:
        error instanceof Error
          ? error.message
          : 'Could not refresh Hibi garden. Try again.',
    }
    return cached
  }
}

export async function directoryAddon(
  id: unknown,
): Promise<AddonDirectoryEntry> {
  if (!validId(id)) throw new Error('Choose an addon from Hibi garden.')
  const directory = await getAddonDirectory()
  const entry = directory.entries.find((entry) => entry.id === id)
  if (!entry)
    throw new Error(
      directory.error ??
        'This addon is not in Hibi garden. Refresh the directory and try again.',
    )
  return entry
}
