import { createHash } from 'node:crypto'
import { lstat, opendir, readFile, rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { app } from 'electron'
import {
  type KnownWorkspace,
  type RecentWorkspace,
  toRecentWorkspaces,
} from '../shared/workspace'
import { writeText } from './files'

type SavedWorkspace = { path: string; pinned: boolean; hidden: boolean }

let writing: Promise<void> = Promise.resolve()
const listeners = new Set<(known: KnownWorkspace[]) => void | Promise<void>>()
let checkedCaches = false
const location = () => join(app.getPath('userData'), 'recent-workspaces.json')
const idFor = (path: string) => createHash('sha256').update(path).digest('hex')
const asKnown = (saved: SavedWorkspace[]): KnownWorkspace[] =>
  saved.map((item) => ({ ...item, id: idFor(item.path) }))

export function observeKnownWorkspaces(
  listener: (known: KnownWorkspace[]) => void | Promise<void>,
) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const validPath = (path: unknown): path is string =>
  typeof path === 'string' &&
  path.length <= 4096 &&
  !path.includes('\0') &&
  isAbsolute(path)

async function readWorkspaces(): Promise<SavedWorkspace[] | null> {
  try {
    const saved: unknown = JSON.parse(await readFile(location(), 'utf8'))
    if (!Array.isArray(saved)) return null
    const seen = new Set<string>()
    return saved.flatMap((item: unknown) => {
      const path =
        typeof item === 'string'
          ? item
          : item && typeof item === 'object' && 'path' in item
            ? item.path
            : null
      if (!validPath(path) || seen.has(path)) return []
      seen.add(path)
      return [
        {
          path,
          pinned:
            typeof item === 'object' &&
            item !== null &&
            'pinned' in item &&
            item.pinned === true,
          hidden:
            typeof item === 'object' &&
            item !== null &&
            'hidden' in item &&
            item.hidden === true,
        },
      ]
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      console.error('could not read workspaces:', error)
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null
  }
}

function writeWorkspaces(
  update: (saved: SavedWorkspace[]) => SavedWorkspace[],
) {
  const next = writing
    .catch(() => {})
    .then(async () => {
      const file = location()
      const previous = await readWorkspaces()
      const current = previous ?? []
      const before = JSON.stringify(current)
      const saved = update(current)
      const text = JSON.stringify(saved)
      if (text !== before) await writeText(file, text)
      const known = asKnown(saved)
      if (previous !== null || text !== before) {
        for (const listener of listeners) await listener(known)
        await pruneIndexCaches(known)
      }
      return known
    })
  writing = next.then(
    () => {},
    () => {},
  )
  return next
}

/** New search workers wait until forgotten caches have closed and been removed. */
export const workspaceIndexCacheReady = () => writing

async function pruneIndexCaches(known: readonly KnownWorkspace[]) {
  const cache = join(app.getPath('userData'), 'workspace-index-cache')
  try {
    const info = await lstat(cache)
    if (!info.isDirectory() || info.isSymbolicLink()) return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const ids = new Set(known.map((item) => item.id))
  for await (const entry of await opendir(cache)) {
    if (
      entry.isDirectory() &&
      /^[a-f0-9]{64}$/.test(entry.name) &&
      !ids.has(entry.name)
    )
      await rm(join(cache, entry.name), { recursive: true, force: true })
  }
}

export async function getKnownWorkspaces(): Promise<KnownWorkspace[]> {
  if (!checkedCaches) {
    checkedCaches = true
    await writeWorkspaces((saved) => saved)
  }
  await writing
  return asKnown((await readWorkspaces()) ?? [])
}

export async function getRecentWorkspaces(): Promise<RecentWorkspace[]> {
  return toRecentWorkspaces(await getKnownWorkspaces())
}

export async function rememberWorkspace(path: string): Promise<void> {
  await writeWorkspaces((saved) => [
    {
      path,
      pinned: saved.find((item) => item.path === path)?.pinned ?? false,
      hidden: false,
    },
    ...saved.filter((item) => item.path !== path),
  ])
}

export async function setKnownWorkspace(
  id: unknown,
  action: unknown,
): Promise<KnownWorkspace[]> {
  if (
    typeof id !== 'string' ||
    typeof action !== 'string' ||
    !['pin', 'unpin', 'hide'].includes(action)
  )
    throw new Error('Choose a workspace action from the menu.')
  return writeWorkspaces((saved) => {
    if (!saved.some((item) => idFor(item.path) === id))
      throw new Error('This workspace is no longer in the list.')
    return saved.map((item) =>
      idFor(item.path) === id
        ? {
            ...item,
            pinned:
              action === 'pin'
                ? true
                : action === 'unpin'
                  ? false
                  : item.pinned,
            hidden: action === 'hide' ? true : item.hidden,
          }
        : item,
    )
  })
}

export async function forgetWorkspace(path: string): Promise<void> {
  await writeWorkspaces((saved) => saved.filter((item) => item.path !== path))
}
