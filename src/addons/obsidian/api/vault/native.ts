import { randomUUID } from 'node:crypto'
import { lstat, mkdir, opendir, readdir } from 'node:fs/promises'
import { basename, join, relative, sep } from 'node:path'
import { BrowserWindow } from 'electron'
import {
  getDocumentPath,
  getOpenDocumentVersions,
} from '../../../../main/document'
import {
  currentWorkspaceTarget,
  isCurrentWorkspaceTarget,
  refreshWorkspace,
  workspaceChangeCursor,
} from '../../../../main/workspace'
import { workspaceAction } from '../../../../main/workspace-actions'
import { updateWorkspaceText } from '../../../../main/workspace-files'
import {
  obsidianConfiguration,
  obsidianSettings,
} from '../../../../main/workspace-obsidian'
import {
  isPathInside,
  resolveWorkspaceEntry,
} from '../../../../main/workspace-paths'
import type { NativeAddonContext } from '../../../api'
import { vaultPath } from './paths'
import type { VaultEntry, VaultInfo, VaultPage } from './types'

type Listing = {
  root: string
  folder: string
  recursive: boolean
  sequence: number
  iterator: AsyncGenerator<VaultEntry>
  timer: ReturnType<typeof setTimeout>
  check: () => void
  reading: boolean
}
const listings = new Map<string, Listing>()
async function closeListing(id: string) {
  const listing = listings.get(id)
  if (!listing) return
  listings.delete(id)
  clearTimeout(listing.timer)
  await listing.iterator.return(undefined)
}
export async function closeVaultLists() {
  await Promise.all([...listings.keys()].map(closeListing))
}

/** These handlers are composed into the trusted host, never loaded from a vault. */
export function createVaultNative(
  context: NativeAddonContext,
  checkHost: () => void = () => {},
) {
  async function captured(input: unknown) {
    if (!input || typeof input !== 'object')
      throw new Error('Invalid vault request.')
    const data = input as Record<string, unknown>
    const root = context.workspace.directory()
    const target = currentWorkspaceTarget()
    if (!root || !target) throw new Error('Open a folder first.')
    if (
      data.vaultId !== context.workspace.id() ||
      !isCurrentWorkspaceTarget(data.target)
    )
      throw new Error('This vault is no longer open.')
    const check = () => {
      checkHost()
      if (
        !context.isCurrent() ||
        context.workspace.directory() !== root ||
        !isCurrentWorkspaceTarget(target)
      )
        throw new Error('This vault or plugin host changed.')
    }
    check()
    const config = await obsidianConfiguration(root)
    check()
    const path = (value: unknown, allowRoot = false) => {
      const result = vaultPath(
        value,
        config?.directory ?? '.obsidian',
        allowRoot,
      )
      for (const folder of config?.folders ?? [])
        vaultPath(result, folder, allowRoot)
      return result
    }
    return { data, root, target, check, path }
  }
  const entry = async (root: string, path: string): Promise<VaultEntry> => {
    // Listing names come from the filesystem, independent of Hibi's UI/name filters.
    let file = root
    const parts = path ? path.split('/') : []
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index]!
      if (!part || part === '.' || part === '..')
        throw new Error('Choose a path inside this vault.')
      file = join(file, part)
      const parent = await lstat(file)
      if (
        parent.isSymbolicLink() ||
        (index < parts.length - 1 && !parent.isDirectory())
      )
        throw new Error(
          'This path contains a symbolic link or is not a folder.',
        )
    }
    const stat = await lstat(file)
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
      throw new Error('Choose a regular vault file or folder.')
    return {
      path,
      kind: stat.isDirectory() ? 'folder' : 'file',
      identity: `${stat.dev}:${stat.ino}`,
      stat: {
        ctime: stat.birthtimeMs || stat.ctimeMs,
        mtime: stat.mtimeMs,
        size: stat.size,
      },
    }
  }
  return {
    queries: {
      async vaultInfo(input: unknown): Promise<VaultInfo> {
        const place = await captured(input)
        const settings = await obsidianSettings(place.root)
        place.check()
        const relativePath = (file: string | null) => {
          if (!file || !isPathInside(place.root, file)) return null
          const path = relative(place.root, file).split(sep).join('/')
          try {
            return place.path(path)
          } catch {
            return null
          }
        }
        return {
          target: place.target,
          sequence: workspaceChangeCursor().sequence,
          name: basename(place.root),
          configDir: settings?.directory ?? '.obsidian',
          settings,
          activePath: relativePath(getDocumentPath()),
          documents: getOpenDocumentVersions().flatMap((item) => {
            const path = relativePath(item.file)
            return path === null ? [] : [{ tabId: item.tabId, path }]
          }),
        }
      },
      async vaultStat(input: unknown): Promise<VaultEntry | null> {
        const place = await captured(input)
        const path = place.path(place.data.path, true)
        try {
          const result = await entry(place.root, path)
          place.check()
          return result
        } catch (error) {
          place.check()
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
          throw error
        }
      },
      async vaultList(input: unknown): Promise<VaultPage> {
        const place = await captured(input)
        const sequence = workspaceChangeCursor().sequence
        const folder = place.path(place.data.path ?? '', true)
        const recursive = place.data.recursive !== false
        if (place.data.sequence !== sequence)
          throw new Error('This vault listing is stale. Refresh it.')
        let id: string
        let listing: Listing
        if (place.data.cursor !== undefined) {
          if (typeof place.data.cursor !== 'string')
            throw new Error('Invalid vault listing cursor.')
          id = place.data.cursor
          const saved = listings.get(id)
          if (
            !saved ||
            saved.root !== place.root ||
            saved.folder !== folder ||
            saved.recursive !== recursive ||
            saved.sequence !== sequence
          )
            throw new Error('This vault listing is stale. Refresh it.')
          listing = saved
        } else {
          const walk = async function* (
            path: string,
          ): AsyncGenerator<VaultEntry> {
            const directory = await entry(place.root, path)
            if (directory.kind !== 'folder')
              throw new Error('Choose a vault folder.')
            for await (const child of await opendir(join(place.root, path))) {
              place.check()
              if (
                child.name.startsWith('.') ||
                child.isSymbolicLink() ||
                (!child.isDirectory() && !child.isFile())
              )
                continue
              const relative = path ? `${path}/${child.name}` : child.name
              let item: VaultEntry
              try {
                item = await entry(place.root, relative)
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
                throw error
              }
              yield item
              if (recursive && item.kind === 'folder') yield* walk(relative)
            }
          }
          id = randomUUID()
          const timer = setTimeout(() => {
            const current = listings.get(id)
            if (current?.reading) {
              current.timer.refresh()
              return
            }
            void closeListing(id).catch((error) =>
              console.error('Could not close vault listing:', error),
            )
          }, 60000)
          timer.unref()
          listing = {
            root: place.root,
            folder,
            recursive,
            sequence,
            iterator: walk(folder),
            timer,
            check: place.check,
            reading: false,
          }
          listings.set(id, listing)
        }
        if (listing.reading)
          throw new Error('This vault listing is already being read.')
        listing.reading = true
        try {
          listing.check()
          const entries: VaultEntry[] = []
          let done = false
          while (entries.length < 100) {
            const next = await listing.iterator.next()
            listing.check()
            if (workspaceChangeCursor().sequence !== sequence)
              throw new Error('This vault listing is stale. Refresh it.')
            if (next.done) {
              done = true
              break
            }
            entries.push(next.value)
          }
          listing.timer.refresh()
          if (done) await closeListing(id)
          return { entries, sequence, nextCursor: done ? null : id }
        } catch (error) {
          await closeListing(id)
          throw error
        } finally {
          listing.reading = false
        }
      },
    },
    methods: {
      async vaultUpdateText(input: unknown) {
        const place = await captured(input)
        const path = place.path(place.data.path)
        await resolveWorkspaceEntry(place.root, path)
        place.check()
        return updateWorkspaceText(
          place.target,
          path,
          place.data.expectedVersion,
          place.data.markdown,
          { allowMetadataReset: true },
          () => {
            place.check()
            return true
          },
          true,
        )
      },
      async vaultCreateFolder(input: unknown) {
        const place = await captured(input)
        const path = place.path(place.data.path)
        const file = await resolveWorkspaceEntry(place.root, path, true)
        place.check()
        await mkdir(file)
        place.check()
        await refreshWorkspace([path])
        return entry(place.root, path)
      },
      async vaultAction(input: unknown) {
        const place = await captured(input)
        const path = place.path(place.data.path)
        const action = place.data.action
        if (action !== 'rename' && action !== 'copy' && action !== 'delete')
          throw new Error('Unsupported vault action.')
        async function inspect(path: string): Promise<void> {
          const file = await resolveWorkspaceEntry(place.root, place.path(path))
          const stat = await lstat(file)
          place.check()
          if (stat.isDirectory())
            for (const name of await readdir(file))
              await inspect(`${path}/${name}`)
          else if (!stat.isFile() || stat.isSymbolicLink())
            throw new Error('Choose regular vault files.')
        }
        await inspect(path)
        const destination =
          action === 'delete' ? undefined : place.path(place.data.destination)
        if (destination)
          await resolveWorkspaceEntry(place.root, destination, true)
        place.check()
        const windows = BrowserWindow.getAllWindows().filter((window) => {
          if (window.isDestroyed()) return false
          const url = new URL(window.webContents.getURL())
          return url.pathname === '/' || url.pathname.endsWith('/index.html')
        })
        const window = windows[0]
        if (windows.length !== 1 || !window)
          throw new Error('The Hibi workspace window is unavailable.')
        // Move accepts an exact relative destination; shared actions own link/trash policy.
        const sameParent =
          destination !== undefined &&
          path.split('/').slice(0, -1).join('/') ===
            destination.split('/').slice(0, -1).join('/')
        const result = await workspaceAction(window, {
          target: place.target,
          action:
            action === 'rename' ? (sameParent ? 'rename' : 'move') : action,
          path,
          ...(destination === undefined
            ? {}
            : {
                destination:
                  action === 'rename' && sameParent
                    ? (destination.split('/').at(-1) ?? destination)
                    : destination,
              }),
        })
        if (!result) throw new Error('The vault operation was cancelled.')
        place.check()
        return result.path
      },
    },
  }
}
