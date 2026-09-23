import { createHash } from 'node:crypto'
import { type FSWatcher, watch } from 'node:fs'
import { lstat, readdir, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, parse, relative, sep } from 'node:path'
import { app, type BrowserWindow, dialog, shell } from 'electron'
import type {
  WorkspaceEntry,
  WorkspaceIndex,
  WorkspaceSnapshot,
  WorkspaceState,
} from '../shared/workspace'
import type { WorkspaceManifest } from '../shared/workspace-settings'
import {
  closeDeletedDocuments,
  confirmDiscardAll,
  getDocument,
  getDocumentPath,
  getOpenDocuments,
  loadDocument,
  selectDocumentTab,
} from './document'
import { readMarkdown } from './files'
import {
  forgetWorkspace,
  getKnownWorkspaces,
  rememberWorkspace,
} from './recent-workspaces'
import { workspaceIgnore, workspaceMetadata } from './workspace-metadata'

let root: string | null = null
let entries: WorkspaceEntry[] = []
let manifest: WorkspaceManifest | null = null
let watcher: FSWatcher | undefined
let refreshTimer: ReturnType<typeof setTimeout> | undefined
let onChanged: () => void = () => {}

export function workspaceRoot(): string | null {
  return root
}
export function workspaceId(): string | null {
  return root ? createHash('sha256').update(root).digest('hex') : null
}

function relativePath(base: string, path: string): string | null {
  const value = relative(base, path)
  return value &&
    !value.startsWith(`..${sep}`) &&
    value !== '..' &&
    !isAbsolute(value)
    ? value.split(sep).join('/')
    : null
}

export async function scanWorkspace(base: string): Promise<WorkspaceEntry[]> {
  const ignored = await workspaceIgnore(base)
  let count = 0
  async function walk(directory: string): Promise<WorkspaceEntry[]> {
    const result: WorkspaceEntry[] = []
    const children = await readdir(directory, { withFileTypes: true })
    for (const child of children) {
      if (
        child.name.startsWith('.') ||
        child.name === 'node_modules' ||
        child.isSymbolicLink()
      )
        continue
      if (++count > 20000)
        throw new Error(
          'This folder has more than 20,000 items. Open a smaller folder.',
        )
      const full = join(directory, child.name)
      const path = relative(base, full).split(sep).join('/')
      if (ignored.ignores(path + (child.isDirectory() ? '/' : ''))) continue
      if (child.isDirectory()) {
        const nested = await walk(full)
        result.push({
          path,
          name: child.name,
          kind: 'folder',
          children: nested,
        })
      } else if (child.isFile() && isDocumentName(child.name, true)) {
        result.push({ path, name: child.name, kind: 'file' })
      }
    }
    return result.sort(
      (a, b) =>
        Number(b.kind === 'folder') - Number(a.kind === 'folder') ||
        a.name.localeCompare(b.name, undefined, { numeric: true }),
    )
  }
  return walk(base)
}

export function getWorkspace(): WorkspaceState | null {
  if (!root) return null
  const path = getDocumentPath()
  const activePath = path ? relativePath(root, path) : null
  let visible = entries
  const open = getOpenDocuments()
  for (const draft of open) {
    const draftPath = draft.pendingPath && relativePath(root, draft.pendingPath)
    if (!draftPath) continue
    const parts = draftPath.split('/')
    const addDraft = (
      items: WorkspaceEntry[],
      depth: number,
    ): WorkspaceEntry[] => {
      const name = parts[depth]
      if (!name) return items
      if (depth === parts.length - 1)
        return [
          ...items.filter((item) => item.path !== draftPath),
          { path: draftPath, name, kind: 'file' },
        ]
      return items.map((item) =>
        item.name === name && item.children
          ? { ...item, children: addDraft(item.children, depth + 1) }
          : item,
      )
    }
    visible = addDraft(visible, 0)
  }
  const dirty = new Set(
    open
      .filter((draft) => draft.dirty && draft.file)
      .map((draft) => relativePath(root!, draft.file!)),
  )
  const decorate = (items: WorkspaceEntry[]): WorkspaceEntry[] =>
    items.map((item) => ({
      ...item,
      dirty: dirty.has(item.path),
      ...(item.children ? { children: decorate(item.children) } : {}),
    }))
  return {
    id: workspaceId()!,
    name: manifest?.name ?? basename(root),
    manifest,
    entries: decorate(visible),
    activePath,
  }
}

export async function refreshWorkspace(): Promise<WorkspaceState | null> {
  const selected = root
  if (selected) {
    const [next, metadata] = await Promise.all([
      scanWorkspace(selected),
      workspaceMetadata(selected),
    ])
    if (root === selected) {
      entries = next
      manifest = metadata.manifest
    }
  }
  return getWorkspace()
}

export function observeWorkspace(callback: () => void): void {
  onChanged = callback
}

export async function openWorkspace(
  window: BrowserWindow,
): Promise<WorkspaceState | null> {
  const result = await dialog.showOpenDialog(window, {
    properties: ['openDirectory'],
    title: 'Open workspace',
  })
  const selected = result.filePaths[0]
  if (result.canceled || !selected) return null
  return loadWorkspace(selected)
}

export async function loadWorkspace(
  selected: string,
): Promise<WorkspaceState | null> {
  const nextRoot = await realpath(selected)
  const nextEntries = await scanWorkspace(nextRoot)
  const metadata = await workspaceMetadata(nextRoot)
  watcher?.close()
  clearTimeout(refreshTimer)
  root = nextRoot
  entries = nextEntries
  manifest = metadata.manifest
  try {
    watcher = watch(root, { recursive: true, persistent: false }, () => {
      clearTimeout(refreshTimer)
      refreshTimer = setTimeout(() => {
        void refreshWorkspace()
          .then(onChanged)
          .catch((error: unknown) =>
            console.error('workspace refresh failed:', error),
          )
      }, 200)
    })
    watcher.on('error', (error) =>
      console.error('workspace watcher failed:', error),
    )
  } catch (error) {
    console.error('workspace watcher unavailable:', error)
  }
  await rememberWorkspace(nextRoot).catch((error: unknown) =>
    console.error('could not remember workspace:', error),
  )
  onChanged()
  return getWorkspace()
}

export async function openRecentWorkspace(id: unknown) {
  const recent = (await getKnownWorkspaces()).find(
    (item) => !item.hidden && item.id === id,
  )
  if (!recent)
    throw new Error(
      'This workspace is no longer in the recent list. Open it from its folder.',
    )
  return loadWorkspace(recent.path)
}

export async function deleteKnownWorkspace(
  window: BrowserWindow,
  id: unknown,
): Promise<boolean> {
  const item = (await getKnownWorkspaces()).find((entry) => entry.id === id)
  if (!item || item.hidden)
    throw new Error('This workspace is no longer in the list.')
  const stat = await lstat(item.path)
  const containsAppPath = [app.getPath('userData'), app.getAppPath()].some(
    (path) => path === item.path || path.startsWith(`${item.path}${sep}`),
  )
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (await realpath(item.path)) !== item.path ||
    item.path === parse(item.path).root ||
    item.path === app.getPath('home') ||
    containsAppPath
  )
    throw new Error('This folder cannot be moved to Trash from Hibi.')
  if (!(await confirmDiscardAll(window, item.path))) return false
  await shell.trashItem(item.path)
  closeDeletedDocuments(window, item.path)
  if (root === item.path || root?.startsWith(`${item.path}${sep}`)) {
    watcher?.close()
    clearTimeout(refreshTimer)
    watcher = undefined
    root = null
    entries = []
    manifest = null
  }
  await forgetWorkspace(item.path)
  onChanged()
  return true
}

export async function resolveWorkspaceFile(
  base: string,
  value: unknown,
): Promise<string> {
  if (
    typeof value !== 'string' ||
    value.length > 4096 ||
    isAbsolute(value) ||
    value.includes('\\') ||
    value.split('/').some((part) => !part || part === '.' || part === '..') ||
    !isDocumentName(value, true)
  )
    throw new Error('Choose a supported document inside this workspace.')
  const candidate = join(base, value)
  if ((await lstat(candidate)).isSymbolicLink())
    throw new Error(
      'Symbolic links cannot be opened from a workspace. Open the original file instead.',
    )
  const chosen = await realpath(candidate)
  if (!relativePath(base, chosen))
    throw new Error(
      'This file is outside the workspace. Open its folder first.',
    )
  return chosen
}

export async function openWorkspaceFile(window: BrowserWindow, path: unknown) {
  if (!root) throw new Error('Open a workspace first.')
  if (typeof path === 'string' && getWorkspace()?.activePath === path)
    return getDocument()
  const draft =
    typeof path === 'string' &&
    getOpenDocuments().find(
      (draft) =>
        draft.pendingPath && relativePath(root!, draft.pendingPath) === path,
    )
  if (draft) return selectDocumentTab(window, draft.tabId)
  return loadDocument(window, await resolveWorkspaceFile(root, path))
}

export async function snapshotWorkspace(): Promise<WorkspaceSnapshot> {
  const selected = root
  if (!selected) throw new Error('Open a workspace first.')
  const tree = await scanWorkspace(selected)
  const pages: WorkspaceSnapshot['pages'] = []
  const drafts = new Map(
    getOpenDocuments()
      .filter((draft) => draft.dirty && draft.file)
      .map((draft) => [draft.file, draft.markdown]),
  )
  let bytes = 0
  async function collect(items: WorkspaceEntry[]) {
    for (const item of items) {
      if (item.kind === 'folder') await collect(item.children ?? [])
      else {
        const path = await resolveWorkspaceFile(selected as string, item.path)
        const markdown = drafts.get(path) ?? (await readMarkdown(path))
        bytes += Buffer.byteLength(markdown)
        if (pages.length >= 2000 || bytes > 20 * 1024 * 1024)
          throw new Error(
            'Export supports up to 2,000 documents and 20 MiB of text and images. Choose a smaller folder.',
          )
        const images: Record<string, string> = Object.create(null)
        for (const source of isMarkdownDocument(item.path)
          ? imageSources(markdown)
          : []) {
          const image = await exportDocumentMedia(source, path, selected)
          if (!image) continue
          bytes += Buffer.byteLength(image)
          if (bytes > 20 * 1024 * 1024)
            throw new Error(
              'Export supports up to 20 MiB of text and images. Choose a smaller folder.',
            )
          images[source] = image
        }
        pages.push({
          id: createHash('sha256').update(path).digest('hex'),
          path: item.path,
          markdown,
          images,
        })
      }
    }
  }
  await collect(tree)
  if (!pages.length)
    throw new Error('This workspace has no supported documents to export.')
  return {
    name:
      (await workspaceMetadata(selected)).manifest?.name ?? basename(selected),
    pages,
  }
}

export async function indexWorkspace(): Promise<WorkspaceIndex | null> {
  const selected = root
  const workspace = getWorkspace()
  if (!selected || !workspace) return null
  const drafts = new Map(
    getOpenDocuments().flatMap((draft) => {
      const path = draft.file && relativePath(selected, draft.file)
      return path && draft.dirty ? [[path, draft] as const] : []
    }),
  )
  const pages: WorkspaceIndex['pages'] = []
  let bytes = 0
  async function collect(items: readonly WorkspaceEntry[]) {
    for (const item of items) {
      if (item.children) {
        await collect(item.children)
        continue
      }
      if (item.kind !== 'file') continue
      try {
        const draft = drafts.get(item.path)
        const path =
          draft?.file ?? (await resolveWorkspaceFile(selected!, item.path))
        const markdown = draft?.markdown ?? (await readMarkdown(path))
        bytes += Buffer.byteLength(markdown)
        if (pages.length >= 2000 || bytes > 20 * 1024 * 1024)
          throw new Error(
            'Hibi can index up to 2,000 documents and 20 MiB of text. Open a smaller workspace.',
          )
        pages.push({
          id: createHash('sha256').update(path).digest('hex'),
          path: item.path,
          markdown,
        })
      } catch (error) {
        // A concurrent rename/delete can remove a cached entry; the watcher refreshes it.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }
  await collect(workspace.entries)
  return root === selected ? { workspace, pages } : null
}

import { isMarkdownDocument } from '../shared/document-types'
import { isDocumentName } from './document-types'
import { imageSources } from './images'
import { exportDocumentMedia } from './media'
