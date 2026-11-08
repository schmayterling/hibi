import { lstat, mkdir, readdir } from 'node:fs/promises'
import { basename, relative, sep } from 'node:path'
import { BrowserWindow } from 'electron'
import {
  getDocumentPath,
  getOpenDocumentVersions,
} from '../../../../main/document'
import {
  currentWorkspaceTarget,
  isCurrentWorkspaceTarget,
  listWorkspaceEntryPage,
  refreshWorkspace,
  workspaceChangeCursor,
} from '../../../../main/workspace'
import { workspaceAction } from '../../../../main/workspace-actions'
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
    if (
      !root ||
      !target ||
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
    const file = await resolveWorkspaceEntry(root, path, false, path === '')
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
        const result = listWorkspaceEntryPage({
          target: place.target,
          sequence: place.data.sequence as number,
          ...(place.data.cursor === undefined
            ? {}
            : { cursor: place.data.cursor as string }),
          limit: 100,
        })
        if (!result.ok) throw new Error(result.message)
        const entries: VaultEntry[] = []
        for (const item of result.value.entries) {
          const path = place.path(item.path)
          try {
            entries.push(await entry(place.root, path))
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
          place.check()
        }
        return {
          entries,
          sequence: result.value.sequence,
          nextCursor: result.value.nextCursor,
        }
      },
    },
    methods: {
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
