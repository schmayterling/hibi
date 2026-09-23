import { lstat, realpath } from 'node:fs/promises'
import { basename, join, relative, sep } from 'node:path'
import { dialog } from 'electron'
import { writeMarkdown } from '../../main/files'
import {
  getRecentWorkspaces,
  rememberWorkspace,
} from '../../main/recent-workspaces'
import { refreshWorkspace, scanWorkspace } from '../../main/workspace'
import { validateWorkspaceName } from '../../main/workspace-actions'
import type { WorkspaceEntry } from '../../shared/workspace'
import type { NativeAddon, NativeAddonContext } from '../api'
import manifest from './manifest'

async function target(id: unknown, context: NativeAddonContext) {
  if (typeof id !== 'string') throw new Error('Choose a workspace.')
  const path = id
    ? (await getRecentWorkspaces()).find((item) => item.id === id)?.path
    : context.workspace.directory()
  if (!path) throw new Error('Open a workspace or choose a recent one.')
  const root = await realpath(path)
  if (!(await lstat(root)).isDirectory())
    throw new Error('This workspace is no longer a folder.')
  return root
}

async function folderPath(root: string, value: unknown) {
  if (typeof value !== 'string' || value.length > 4096)
    throw new Error('Choose a folder inside the workspace.')
  let path = root
  if (value) {
    for (const part of value.split('/')) {
      validateWorkspaceName(part)
      path = join(path, part)
      const info = await lstat(path)
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error('Choose an ordinary folder inside the workspace.')
    }
  }
  const resolved = await realpath(path)
  const inside = relative(root, resolved)
  if (inside === '..' || inside.startsWith(`..${sep}`))
    throw new Error('Choose a folder inside the workspace.')
  return resolved
}

function folders(entries: WorkspaceEntry[], found: string[] = []): string[] {
  for (const entry of entries) {
    if (entry.kind !== 'folder') continue
    found.push(entry.path)
    folders(entry.children ?? [], found)
  }
  return found
}

export default {
  id: manifest.id,
  queries: {
    async targets() {
      return getRecentWorkspaces()
    },
    async folders(input, context) {
      const root = await target(input, context)
      return folders(await scanWorkspace(root))
    },
  },
  methods: {
    async chooseWorkspace() {
      const result = await dialog.showOpenDialog({
        title: 'Choose quick note workspace',
        properties: ['openDirectory'],
      })
      const chosen = result.filePaths[0]
      if (result.canceled || !chosen) return null
      const path = await realpath(chosen)
      if (!(await lstat(path)).isDirectory())
        throw new Error('Choose a workspace folder.')
      await rememberWorkspace(path)
      return (await getRecentWorkspaces()).find((entry) => entry.path === path)
    },
    async save(input, context) {
      if (!input || typeof input !== 'object')
        throw new Error('Could not read this note. Try again.')
      const request = input as Record<string, unknown>
      const root = await target(request.workspaceId, context)
      const directory = await folderPath(root, request.folder)
      if (typeof request.title !== 'string')
        throw new Error('Enter a note title.')
      const stem = request.title.trim().replace(/\.md$/i, '')
      validateWorkspaceName(stem)
      if (typeof request.markdown !== 'string' || !request.markdown.trim())
        throw new Error('Write a note before saving.')
      for (let number = 1; number <= 10000; number++) {
        const name = `${stem}${number === 1 ? '' : ` ${number}`}.md`
        validateWorkspaceName(name)
        const path = join(directory, name)
        try {
          await writeMarkdown(path, request.markdown, true)
          if (context.workspace.directory() === root)
            await refreshWorkspace().catch((error) =>
              console.error('could not refresh quick note workspace:', error),
            )
          return { path, name: basename(path) }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
      }
      throw new Error('This folder has too many notes with that title.')
    },
  },
} satisfies NativeAddon
