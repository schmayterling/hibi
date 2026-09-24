import { createHash } from 'node:crypto'
import { type FSWatcher, type Stats, watch } from 'node:fs'
import { lstat, readdir, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, parse, relative, sep } from 'node:path'
import { app, type BrowserWindow, dialog, shell } from 'electron'
import ignore from 'ignore'
import type {
  WorkspaceChange,
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
import {
  type CachedIndexPage,
  diskIndexVersion,
  needsIndexVerification,
  readIndexPage,
} from './workspace-index-cache'
import { LatestIndexJob } from './workspace-index-job'
import { workspaceIgnore, workspaceMetadata } from './workspace-metadata'
import { createScanCoordinator, watchNeedsScan } from './workspace-refresh'
import { showAllWorkspaceFiles } from './workspace-settings'

type ScanResult = {
  entries: WorkspaceEntry[]
  manifest: WorkspaceManifest | null
  showAllFiles: boolean
  ignored: ReturnType<typeof ignore>
}

let root: string | null = null
let entries: WorkspaceEntry[] = []
let manifest: WorkspaceManifest | null = null
let showingAllFiles = false
let ignoredPaths: ReturnType<typeof ignore> | null = null
let watcher: FSWatcher | undefined
let refreshTimer: ReturnType<typeof setTimeout> | undefined
let scanCoordinator:
  | ReturnType<typeof createScanCoordinator<ScanResult>>
  | undefined
let pendingTreePaths: Set<string> | null = new Set()
let watcherEvents = new Map<string, 'change' | 'rename'>()
let unknownWatcherEvent = false
let loadGeneration = 0
const acknowledgedPaths = new Map<
  string,
  { fingerprint: string | null; expires: number }
>()
let onChanged: (change: WorkspaceChange) => void = () => {}
let indexRevision = 0
let cachedRoot: string | null = null
let cachedPages = new Map<string, CachedIndexPage>()
let dirtyIndexPaths: Set<string> | null = null
let cachedIndexKey: string | null = null
let cachedIndexPages: WorkspaceIndex['pages'] | null = null
type IndexDraft = ReturnType<typeof getOpenDocuments>[number]
type IndexRequest = {
  key: string
  selected: string
  workspace: WorkspaceState
  drafts: Map<string, IndexDraft>
  revision: number
}
const indexJob = new LatestIndexJob(captureIndexRequest, runIndexRequest)

function indexedContentPath(path: string): boolean {
  if (cachedPages.has(path)) return true
  if (!isDocumentName(basename(path), true)) return false
  if (cachedEntry(path)?.kind === 'file') return true
  const selected = root
  if (
    !selected ||
    !relevantWatchPath(path) ||
    path.split('/').includes('node_modules') ||
    ignoredPaths?.ignores(path)
  )
    return false
  return getOpenDocuments().some(
    (draft) =>
      draft.pendingPath && relativePath(selected, draft.pendingPath) === path,
  )
}

function publishWorkspaceChange(change: WorkspaceChange) {
  if (
    change.kind === 'tree' ||
    change.paths === null ||
    cachedRoot !== root ||
    change.paths.some(indexedContentPath)
  ) {
    if (change.paths === null) dirtyIndexPaths = null
    else if (dirtyIndexPaths)
      for (const path of change.paths) dirtyIndexPaths.add(path)
    indexRevision++
    indexJob.invalidate()
  }
  onChanged(change)
}

export function workspaceRoot(): string | null {
  return root
}
export function workspaceId(): string | null {
  return root ? createHash('sha256').update(root).digest('hex') : null
}

export function workspaceRelativePath(path: string | null): string | null {
  return root && path ? relativePath(root, path) : null
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

export async function scanWorkspace(
  base: string,
  showAllFiles = false,
): Promise<WorkspaceEntry[]> {
  const ignored = await workspaceIgnore(base)
  let count = 0
  async function walk(directory: string): Promise<WorkspaceEntry[]> {
    const result: WorkspaceEntry[] = []
    const children = await readdir(directory, { withFileTypes: true })
    for (const child of children) {
      if (
        (child.name.startsWith('.') &&
          (child.isDirectory() || !showAllFiles)) ||
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
      } else if (
        child.isFile() &&
        (showAllFiles || isDocumentName(child.name, true))
      ) {
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

export function getWorkspace(
  open?: ReturnType<typeof getOpenDocuments>,
): WorkspaceState | null {
  if (!root) return null
  const documents = open ?? getOpenDocuments()
  const path = getDocumentPath()
  const activePath = path ? relativePath(root, path) : null
  let visible = entries
  for (const draft of documents) {
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
    documents
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

function addTreePaths(paths: string[] | null) {
  if (paths === null) pendingTreePaths = null
  else if (pendingTreePaths)
    for (const path of paths) pendingTreePaths.add(path)
}

function takeTreePaths(): string[] | null {
  const paths = pendingTreePaths ? [...pendingTreePaths] : null
  pendingTreePaths = new Set()
  return paths
}

async function fileStatus(base: string, path: string): Promise<Stats | null> {
  try {
    return await lstat(join(base, path))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function fingerprint(info: Stats | null): string | null {
  return info
    ? [
        info.dev,
        info.ino,
        info.mode,
        info.size,
        info.mtimeMs,
        info.ctimeMs,
      ].join(':')
    : null
}

async function acknowledgePaths(base: string, paths: string[]) {
  const now = Date.now()
  for (const [path, acknowledged] of acknowledgedPaths)
    if (acknowledged.expires < now) acknowledgedPaths.delete(path)
  const affected = new Set(paths)
  for (const path of paths) {
    const parts = path.split('/')
    for (let length = 1; length < parts.length; length++)
      affected.add(parts.slice(0, length).join('/'))
  }
  await Promise.all(
    [...affected].map(async (path) => {
      const current = fingerprint(await fileStatus(base, path))
      if (root === base)
        acknowledgedPaths.set(path, {
          fingerprint: current,
          expires: Date.now() + 1500,
        })
    }),
  )
}

async function requestWorkspaceScan(
  paths: string[] | null,
  acknowledge = false,
): Promise<WorkspaceState | null> {
  const selected = root
  if (!selected || !scanCoordinator) return getWorkspace()
  if (acknowledge && paths) await acknowledgePaths(selected, paths)
  if (root !== selected) return getWorkspace()
  addTreePaths(paths)
  await scanCoordinator.request()
  return getWorkspace()
}

export function refreshWorkspace(
  paths: string[] | null = null,
): Promise<WorkspaceState | null> {
  return requestWorkspaceScan(paths, paths !== null)
}

export async function notifyWorkspaceContent(
  paths: string[] | null,
): Promise<WorkspaceState | null> {
  const selected = root
  if (!selected) return null
  if (paths) await acknowledgePaths(selected, paths)
  if (root === selected) publishWorkspaceChange({ kind: 'content', paths })
  return getWorkspace()
}

export async function documentFileChanged(
  previous: string | null,
  next: string | null,
  treeChanged: boolean,
): Promise<void> {
  const paths = [
    ...new Set(
      [workspaceRelativePath(previous), workspaceRelativePath(next)].filter(
        (path): path is string => path !== null,
      ),
    ),
  ]
  if (!paths.length) return
  if (treeChanged) await refreshWorkspace(paths)
  else await notifyWorkspaceContent(paths)
}

function cachedEntry(path: string): WorkspaceEntry | undefined {
  let level = entries
  let found: WorkspaceEntry | undefined
  for (const part of path.split('/')) {
    found = level.find((item) => item.name === part)
    if (!found) return undefined
    level = found.children ?? []
  }
  return found
}

function metadataPath(path: string): boolean {
  return (
    path === '.hibi' ||
    path === '.hibi/workspace.json' ||
    path === '.hibi/ignore' ||
    path === '.hibi.json' ||
    path === '.hibiignore'
  )
}

function gitMetadataPath(path: string): boolean {
  return path === '.git' || path.startsWith('.git/')
}

function relevantWatchPath(path: string): boolean {
  if (metadataPath(path) || gitMetadataPath(path)) return true
  const parts = path.split('/')
  return !parts.some(
    (part, index) =>
      part.startsWith('.') && (index < parts.length - 1 || !showingAllFiles),
  )
}

async function flushWatcherEvents(selected: string) {
  const events = watcherEvents
  const unknown = unknownWatcherEvent
  watcherEvents = new Map()
  unknownWatcherEvent = false
  if (root !== selected) return
  if (unknown) {
    await requestWorkspaceScan(null)
    return
  }
  const ignored = await workspaceIgnore(selected)
  if (root !== selected) return
  const treePaths: string[] = []
  const contentPaths: string[] = []
  for (const [path] of events) {
    if (!relevantWatchPath(path)) continue
    const stat = await fileStatus(selected, path)
    const current = fingerprint(stat)
    const acknowledged = acknowledgedPaths.get(path)
    if (acknowledged) {
      if (Date.now() > acknowledged.expires) acknowledgedPaths.delete(path)
      else if (acknowledged.fingerprint === current) continue
    }
    if (metadataPath(path)) {
      treePaths.push(path)
      continue
    }
    if (gitMetadataPath(path)) {
      contentPaths.push(path)
      continue
    }
    if (
      path.split('/').includes('node_modules') ||
      ignored.ignores(path) ||
      ignored.ignores(`${path}/`)
    ) {
      contentPaths.push(path)
      continue
    }
    const visibleKind = stat?.isDirectory()
      ? 'folder'
      : stat?.isFile() &&
          (showingAllFiles || isDocumentName(basename(path), true))
        ? 'file'
        : null
    if (watchNeedsScan(cachedEntry(path)?.kind ?? null, visibleKind))
      treePaths.push(path)
    else contentPaths.push(path)
  }
  if (root !== selected) return
  if (treePaths.length)
    await requestWorkspaceScan([...treePaths, ...contentPaths])
  else if (contentPaths.length)
    publishWorkspaceChange({ kind: 'content', paths: contentPaths })
}

function atomicTempTarget(path: string): string | null {
  const parts = path.split('/')
  const name = parts.pop()
  const match =
    /^\.(.+)\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i.exec(
      name ?? '',
    )
  return match ? [...parts, match[1]].join('/') : null
}

function queueWatcherEvent(
  selected: string,
  eventType: string,
  filename: string | Buffer | null,
) {
  if (root !== selected) return
  const path =
    filename && relativePath(selected, join(selected, filename.toString()))
  const target = path && atomicTempTarget(path)
  const changedPath = target || path
  const acknowledged = changedPath && acknowledgedPaths.get(changedPath)
  if (
    !changedPath ||
    (relevantWatchPath(changedPath) &&
      !gitMetadataPath(changedPath) &&
      (metadataPath(changedPath) ||
        (!changedPath.split('/').includes('node_modules') &&
          !ignoredPaths?.ignores(changedPath) &&
          !ignoredPaths?.ignores(`${changedPath}/`))) &&
      (!acknowledged || acknowledged.expires < Date.now()))
  )
    scanCoordinator?.invalidate()
  if (target) watcherEvents.set(target, 'rename')
  else if (path)
    watcherEvents.set(
      path,
      eventType === 'rename' || watcherEvents.get(path) === 'rename'
        ? 'rename'
        : 'change',
    )
  else unknownWatcherEvent = true
  clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => {
    void flushWatcherEvents(selected).catch((error: unknown) =>
      console.error('workspace refresh failed:', error),
    )
  }, 200)
}

export function observeWorkspace(
  callback: (change: WorkspaceChange) => void,
): void {
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
  const loading = ++loadGeneration
  const nextRoot = await realpath(selected)
  if (loading !== loadGeneration) return getWorkspace()
  if (nextRoot === root) {
    await refreshWorkspace()
    if (loading !== loadGeneration) return getWorkspace()
    await rememberWorkspace(nextRoot)
    return getWorkspace()
  }
  const showAllFiles = await showAllWorkspaceFiles()
  const [nextEntries, metadata] = await Promise.all([
    scanWorkspace(nextRoot, showAllFiles),
    workspaceMetadata(nextRoot),
  ])
  if (loading !== loadGeneration) return getWorkspace()
  watcher?.close()
  clearTimeout(refreshTimer)
  indexJob.reset()
  scanCoordinator?.close()
  watcherEvents.clear()
  unknownWatcherEvent = false
  acknowledgedPaths.clear()
  pendingTreePaths = new Set()
  cachedRoot = null
  cachedPages.clear()
  dirtyIndexPaths = null
  cachedIndexKey = null
  cachedIndexPages = null
  root = nextRoot
  entries = nextEntries
  manifest = metadata.manifest
  showingAllFiles = showAllFiles
  ignoredPaths = ignore().add(metadata.ignore)
  scanCoordinator = createScanCoordinator(
    async () => {
      const showAllFiles = await showAllWorkspaceFiles()
      const [next, metadata] = await Promise.all([
        scanWorkspace(nextRoot, showAllFiles),
        workspaceMetadata(nextRoot),
      ])
      return {
        entries: next,
        manifest: metadata.manifest,
        showAllFiles,
        ignored: ignore().add(metadata.ignore),
      }
    },
    (next) => {
      if (root !== nextRoot) return
      entries = next.entries
      manifest = next.manifest
      showingAllFiles = next.showAllFiles
      ignoredPaths = next.ignored
      publishWorkspaceChange({ kind: 'tree', paths: takeTreePaths() })
    },
  )
  try {
    watcher = watch(
      root,
      { recursive: true, persistent: false },
      (eventType, filename) => queueWatcherEvent(nextRoot, eventType, filename),
    )
    watcher.on('error', (error) =>
      console.error('workspace watcher failed:', error),
    )
  } catch (error) {
    console.error('workspace watcher unavailable:', error)
  }
  await rememberWorkspace(nextRoot).catch((error: unknown) =>
    console.error('could not remember workspace:', error),
  )
  publishWorkspaceChange({ kind: 'tree', paths: null })
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
    loadGeneration += 1
    watcher?.close()
    clearTimeout(refreshTimer)
    indexJob.reset()
    scanCoordinator?.close()
    scanCoordinator = undefined
    watcher = undefined
    watcherEvents.clear()
    unknownWatcherEvent = false
    acknowledgedPaths.clear()
    pendingTreePaths = new Set()
    root = null
    entries = []
    manifest = null
    ignoredPaths = null
    cachedRoot = null
    cachedPages.clear()
    dirtyIndexPaths = null
    cachedIndexKey = null
    cachedIndexPages = null
  }
  await forgetWorkspace(item.path)
  publishWorkspaceChange({ kind: 'tree', paths: null })
  return true
}

export async function resolveWorkspaceFile(
  base: string,
  value: unknown,
  allowUnsupported = false,
): Promise<string> {
  if (
    typeof value !== 'string' ||
    value.length > 4096 ||
    isAbsolute(value) ||
    value.includes('\\') ||
    value.split('/').some((part) => !part || part === '.' || part === '..') ||
    (!allowUnsupported && !isDocumentName(value, true))
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
  return loadDocument(
    window,
    await resolveWorkspaceFile(root, path, await showAllWorkspaceFiles()),
  )
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

function captureIndexRequest(): { key: string; request: IndexRequest } | null {
  const selected = root
  if (!selected) return null
  const open = getOpenDocuments()
  const workspace = getWorkspace(open)
  if (!workspace) return null
  const drafts = new Map(
    open.flatMap((draft) => {
      const path = draft.file && relativePath(selected, draft.file)
      return path && draft.dirty ? [[path, draft] as const] : []
    }),
  )
  const revision = indexRevision
  const key = JSON.stringify([
    selected,
    revision,
    [...drafts]
      .map(([path, draft]) => [path, draft.tabId, draft.contentVersion])
      .sort(([a], [b]) => String(a).localeCompare(String(b))),
  ])
  return { key, request: { key, selected, workspace, drafts, revision } }
}

async function runIndexRequest(
  request: IndexRequest,
  current: () => boolean,
): Promise<WorkspaceIndex> {
  const { selected, workspace, drafts, revision } = request
  const pages = await collectIndexPages(
    selected,
    workspace.entries,
    drafts,
    () => current() && root === selected && indexRevision === revision,
  )
  const path = getDocumentPath()
  const activePath = path ? relativePath(selected, path) : null
  if (current()) {
    cachedIndexKey = request.key
    cachedIndexPages = pages
  }
  return { workspace: { ...workspace, activePath }, pages }
}

export function indexWorkspace(
  verifyAll = false,
): Promise<WorkspaceIndex | null> {
  if (verifyAll && root) {
    dirtyIndexPaths = null
    indexRevision++
    indexJob.invalidate()
  }
  const captured = captureIndexRequest()
  if (!captured) return Promise.resolve(null)
  if (
    !indexJob.running &&
    cachedIndexKey === captured.key &&
    cachedIndexPages &&
    dirtyIndexPaths?.size === 0
  )
    return Promise.resolve({
      workspace: captured.request.workspace,
      pages: cachedIndexPages,
    })
  return indexJob.request(captured)
}

async function collectIndexPages(
  selected: string,
  entries: readonly WorkspaceEntry[],
  drafts: Map<string, IndexDraft>,
  current: () => boolean,
): Promise<WorkspaceIndex['pages']> {
  const previous = cachedRoot === selected ? cachedPages : new Map()
  const next = new Map<string, CachedIndexPage>()
  const pages: WorkspaceIndex['pages'] = []
  let bytes = 0
  async function collect(items: readonly WorkspaceEntry[]) {
    for (const item of items) {
      if (!current()) return
      if (item.children) {
        await collect(item.children)
        continue
      }
      if (item.kind !== 'file') continue
      if (!isDocumentName(item.name, true)) continue
      try {
        const draft = drafts.get(item.path)
        const existing = previous.get(item.path)
        let cached: CachedIndexPage
        if (
          !draft &&
          existing?.version.startsWith('disk:') &&
          !needsIndexVerification(dirtyIndexPaths, item.path)
        ) {
          cached = existing
        } else {
          const path =
            draft?.file ?? (await resolveWorkspaceFile(selected, item.path))
          let version: string
          if (draft) {
            version = `draft:${draft.tabId}:${draft.contentVersion}`
          } else {
            const file = await stat(path, { bigint: true })
            version = diskIndexVersion(file)
          }
          cached = await readIndexPage(
            existing,
            version,
            existing?.page.id ??
              createHash('sha256').update(path).digest('hex'),
            item.path,
            () => draft?.markdown ?? readMarkdown(path),
          )
        }
        bytes += cached.bytes
        if (pages.length >= 2000 || bytes > 20 * 1024 * 1024)
          throw new Error(
            'Hibi can index up to 2,000 documents and 20 MiB of text. Open a smaller workspace.',
          )
        next.set(item.path, cached)
        pages.push(cached.page)
      } catch (error) {
        // A concurrent rename/delete can remove a cached entry; the watcher refreshes it.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }
  await collect(entries)
  if (current()) {
    cachedRoot = selected
    cachedPages = next
    dirtyIndexPaths = new Set()
  }
  return pages
}

import { isMarkdownDocument } from '../shared/document-types'
import { isDocumentName } from './document-types'
import { imageSources } from './images'
import { exportDocumentMedia } from './media'
