import { lstat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { BrowserWindow } from 'electron'
import { readMarkdown, writeMarkdown } from '../../main/files'
import {
  refreshWorkspace,
  resolveWorkspaceFile,
  scanWorkspace,
} from '../../main/workspace'
import {
  validateWorkspaceName,
  workspaceAction,
} from '../../main/workspace-actions'
import type { NativeAddonContext } from '../api'

function workspace(context: NativeAddonContext, input: unknown) {
  const base = context.workspace.directory()
  if (!base) throw new Error('Open a workspace before using this plugin.')
  if (
    request(input).workspaceId !== context.workspace.id() ||
    typeof context.workspace.id() !== 'string'
  )
    throw new Error(
      'The workspace changed. Reload this plugin before using it.',
    )
  return base
}

function notePath(input: unknown) {
  if (typeof input !== 'string' || !/\.md$/i.test(input))
    throw new Error('Obsidian plugins can access Markdown notes only.')
  return input
}

function request(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Invalid Obsidian vault request.')
  return input as Record<string, unknown>
}

async function existing(
  context: NativeAddonContext,
  input: unknown,
  path: unknown,
) {
  return resolveWorkspaceFile(workspace(context, input), notePath(path))
}

export async function vaultList(input: unknown, context: NativeAddonContext) {
  const root = workspace(context, input)
  const entries = await scanWorkspace(root)
  const files: {
    path: string
    stat: { ctime: number; mtime: number; size: number }
  }[] = []
  async function visit(items: typeof entries) {
    for (const item of items) {
      if (item.children) await visit(item.children)
      else if (/\.md$/i.test(item.path)) {
        const stat = await lstat(await existing(context, input, item.path))
        files.push({
          path: item.path,
          stat: { ctime: stat.ctimeMs, mtime: stat.mtimeMs, size: stat.size },
        })
      }
    }
  }
  await visit(entries)
  return files
}

export async function vaultRead(input: unknown, context: NativeAddonContext) {
  const path = await existing(context, input, request(input).path)
  if (path === (await context.document.path()))
    return context.document.get().markdown
  return readMarkdown(path)
}

export async function vaultCreate(input: unknown, context: NativeAddonContext) {
  const data = request(input)
  const path = notePath(data.path)
  if (
    typeof data.content !== 'string' ||
    isAbsolute(path) ||
    path.length > 4096
  )
    throw new Error('Choose a Markdown note inside this workspace.')
  const parts = path.split('/')
  for (const part of parts) validateWorkspaceName(part)
  const name = parts.at(-1)
  if (!name) throw new Error('Choose a Markdown note inside this workspace.')
  let parent = workspace(context, input)
  for (const part of parts.slice(0, -1)) {
    parent = join(parent, part)
    const stat = await lstat(parent)
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('This note folder is unavailable.')
  }
  await writeMarkdown(join(parent, name), data.content, true)
  await refreshWorkspace()
  const stat = await lstat(join(parent, name))
  return {
    path,
    stat: { ctime: stat.ctimeMs, mtime: stat.mtimeMs, size: stat.size },
  }
}

export async function vaultModify(input: unknown, context: NativeAddonContext) {
  const data = request(input)
  if (typeof data.content !== 'string')
    throw new Error('The plugin must provide Markdown text.')
  const path = await existing(context, input, data.path)
  if (context.workspace.hasUnsavedChanges())
    throw new Error(
      'Save or discard your changes before a plugin writes notes.',
    )
  const before = await readMarkdown(path)
  if (data.expected !== undefined && data.expected !== before)
    throw new Error('This note changed since the plugin read it. Try again.')
  await writeMarkdown(path, data.content)
  await context.workspace.reload()
  const stat = await lstat(path)
  return { ctime: stat.ctimeMs, mtime: stat.mtimeMs, size: stat.size }
}

function currentWindow() {
  const window =
    BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (!window) throw new Error('The Hibi window is unavailable.')
  return window
}

export async function vaultRename(input: unknown, context: NativeAddonContext) {
  const data = request(input)
  await existing(context, input, data.path)
  const next = notePath(data.destination)
  if (isAbsolute(next) || next.length > 4096)
    throw new Error('Choose a Markdown note inside this workspace.')
  for (const part of next.split('/')) validateWorkspaceName(part)
  const source = data.path as string
  const result = await workspaceAction(currentWindow(), {
    action:
      source.split('/').slice(0, -1).join('/') ===
      next.split('/').slice(0, -1).join('/')
        ? 'rename'
        : 'move',
    path: source,
    destination:
      source.split('/').slice(0, -1).join('/') ===
      next.split('/').slice(0, -1).join('/')
        ? next.split('/').at(-1)
        : next,
  })
  if (!result) throw new Error('The note rename was cancelled.')
  return result.path
}

export async function vaultTrash(input: unknown, context: NativeAddonContext) {
  const path = notePath(request(input).path)
  await existing(context, input, path)
  const result = await workspaceAction(currentWindow(), {
    action: 'delete',
    path,
  })
  if (!result) throw new Error('The note deletion was cancelled.')
}
