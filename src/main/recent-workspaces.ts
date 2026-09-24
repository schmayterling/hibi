import { createHash } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { app } from 'electron'
import {
  type KnownWorkspace,
  type RecentWorkspace,
  toRecentWorkspaces,
} from '../shared/workspace'

type SavedWorkspace = { path: string; pinned: boolean; hidden: boolean }

let writing: Promise<void> = Promise.resolve()
const listeners = new Set<(known: KnownWorkspace[]) => void>()
const location = () => join(app.getPath('userData'), 'recent-workspaces.json')
const idFor = (path: string) => createHash('sha256').update(path).digest('hex')
const asKnown = (saved: SavedWorkspace[]): KnownWorkspace[] =>
  saved.map((item) => ({ ...item, id: idFor(item.path) }))

export function observeKnownWorkspaces(
  listener: (known: KnownWorkspace[]) => void,
) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const validPath = (path: unknown): path is string =>
  typeof path === 'string' &&
  path.length <= 4096 &&
  !path.includes('\0') &&
  isAbsolute(path)

async function readWorkspaces(): Promise<SavedWorkspace[]> {
  try {
    const saved: unknown = JSON.parse(await readFile(location(), 'utf8'))
    if (!Array.isArray(saved)) return []
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
    return []
  }
}

function writeWorkspaces(
  update: (saved: SavedWorkspace[]) => SavedWorkspace[],
) {
  const next = writing
    .catch(() => {})
    .then(async () => {
      const file = location()
      const saved = update(await readWorkspaces())
      await writeFile(`${file}.tmp`, JSON.stringify(saved), { mode: 0o600 })
      await rename(`${file}.tmp`, file)
      const known = asKnown(saved)
      for (const listener of listeners) listener(known)
      return known
    })
  writing = next.then(() => {})
  return next
}

export async function getKnownWorkspaces(): Promise<KnownWorkspace[]> {
  await writing.catch(() => {})
  return asKnown(await readWorkspaces())
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
