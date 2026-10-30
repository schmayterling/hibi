import { createHash } from 'node:crypto'
import { type BigIntStats, type FSWatcher, watch } from 'node:fs'
import { lstat, readFile, realpath, rm, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, parse, relative, sep } from 'node:path'
import { app, type BrowserWindow, dialog, shell } from 'electron'
import ignore from 'ignore'
import type {
  WorkspaceChangeEvent,
  WorkspaceTarget,
} from '../shared/foundation-contracts'
import { wikiTarget } from '../shared/note-links'
import type { SourceSnapshot } from '../shared/source-buffer'
import type {
  WorkspaceChange,
  WorkspaceEntry,
  WorkspaceEntryPageRequest,
  WorkspaceEntryPageResult,
  WorkspaceIndex,
  WorkspaceSnapshot,
  WorkspaceState,
  WorkspaceStreamSnapshot,
} from '../shared/workspace'
import type { WorkspaceManifest } from '../shared/workspace-settings'
import type {
  WorkspaceHeader,
  WorkspaceViewEntry,
  WorkspaceViewPageRequest,
  WorkspaceViewPageResult,
} from '../shared/workspace-view'
import {
  closeDeletedDocuments,
  confirmDiscardAll,
  getDocument,
  getDocumentPath,
  getDocumentSourceFor,
  getDocumentTabs,
  getOpenDocumentMetadata,
  getOpenDocuments,
  getOpenDocumentVersions,
  loadDocument,
  selectDocumentTab,
} from './document'
import { runFileDialog } from './file-operation-dialog'
import { readMarkdown, readMarkdownChunks } from './files'
import {
  forgetWorkspace,
  getKnownWorkspaces,
  rememberWorkspace,
} from './recent-workspaces'
import {
  WorkspaceChangeStream,
  type WorkspaceStreamCursor,
  type WorkspaceStreamStatus,
} from './workspace-change-stream'
import { pageWorkspaceEntries } from './workspace-entry-page'
import {
  type CachedIndexPage,
  diskIndexVersion,
  needsIndexVerification,
} from './workspace-index-cache'
import { LatestIndexJob } from './workspace-index-job'
import type { WorkspaceMetadataPage } from './workspace-index-metadata'
import {
  checkLegacyIndexBytes,
  LegacyWorkspaceIndex,
} from './workspace-legacy-index'
import { workspaceIgnore, workspaceMetadata } from './workspace-metadata'
import {
  incompleteMetadataPage,
  WorkspaceMetadataParser,
} from './workspace-metadata-parser'
import { resolveWorkspaceEntry } from './workspace-paths'
import { createScanCoordinator, watchNeedsScan } from './workspace-refresh'
import { scanWorkspaceTree } from './workspace-scan'
import { showAllWorkspaceFiles } from './workspace-settings'
import type { WorkspaceSyntax } from './workspace-syntax'

type ScanResult = {
  entries: WorkspaceEntry[]
  manifest: WorkspaceManifest | null
  showAllFiles: boolean
  ignored: ReturnType<typeof ignore>
}

let root: string | null = null
let workspaceGeneration = 0
let workspaceTarget: WorkspaceTarget | null = null
const workspaceStream = new WorkspaceChangeStream()
let entries: WorkspaceEntry[] = []
let treeRevision = 0
let manifest: WorkspaceManifest | null = null
let obsidian: WorkspaceState['obsidian']
let showingAllFiles = false
let ignoredPaths: ReturnType<typeof ignore> | null = null
let watcher: FSWatcher | undefined
let refreshTimer: ReturnType<typeof setTimeout> | undefined
let refreshQueuedAt = 0
let scanCoordinator:
  | ReturnType<typeof createScanCoordinator<ScanResult>>
  | undefined
let pendingTreePaths: Set<string> | null = new Set()
let watcherEvents = new Map<string, 'change' | 'rename'>()
let unknownWatcherEvent = false
let workspaceScansInFlight = 0
let watcherFlushesInFlight = 0
let workspaceScanFailed = false
let loadGeneration = 0
let loadController: AbortController | undefined
let selectionController: AbortController | undefined
const acknowledgedPaths = new Map<
  string,
  { fingerprint: string | null; expires: number }
>()
let onChanged: (change: WorkspaceChange) => void = () => {}
let indexRevision = 0
let cachedRoot: string | null = null
let cachedPages = new Map<string, CachedIndexPage<WorkspaceMetadataPage>>()
const metadataParser = new WorkspaceMetadataParser(() => ({
  entry: join(app.getAppPath(), 'out/main/workspace-metadata-worker.js'),
  cacheDirectory: join(
    app.getPath('userData'),
    'workspace-index-cache',
    workspaceId() ?? '',
  ),
  appVersion: app.getVersion(),
}))
let dirtyIndexPaths: Set<string> | null = null
let cachedMetadataTree: readonly WorkspaceEntry[] | null = null
let cachedSyntaxFingerprint = ''
let cachedDraftPaths = new Set<string>()
const legacyIndex = new LegacyWorkspaceIndex()
let legacyCachedRoot: string | null = null
type IndexDraft = {
  file: string
  tabId: string
  contentVersion: number
  pending: boolean
  source: SourceSnapshot
}
type IndexRequest = {
  key: string
  selected: string
  workspace: Omit<WorkspaceState, 'entries'>
  drafts: Map<string, IndexDraft>
  documents: ReturnType<typeof getOpenDocumentMetadata>
  tree: readonly WorkspaceEntry[]
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
  return getOpenDocumentMetadata().some(
    (draft) =>
      draft.pendingPath && relativePath(selected, draft.pendingPath) === path,
  )
}

function publishWorkspaceChange(change: WorkspaceChange) {
  if (
    change.kind === 'tree' ||
    change.paths === null ||
    (cachedRoot !== root && legacyCachedRoot !== root) ||
    change.paths.some(indexedContentPath)
  ) {
    if (change.paths === null) dirtyIndexPaths = null
    else if (dirtyIndexPaths)
      for (const path of change.paths) dirtyIndexPaths.add(path)
    indexRevision++
    indexJob.invalidate()
  }
  workspaceStream.publish(
    change.paths === null ? 'resync' : change.kind,
    change.paths,
  )
  onChanged(change)
}

/** Retained immutable scan tree for native readers; no document text or decoration. */
export function workspaceEntries(): readonly WorkspaceEntry[] {
  return entries
}

export function workspaceRoot(): string | null {
  return root
}

export function workspaceName(): string | null {
  return root ? (manifest?.name ?? basename(root)) : null
}
export function workspaceId(): string | null {
  return root ? createHash('sha256').update(root).digest('hex') : null
}

export function currentWorkspaceTarget(): WorkspaceTarget | null {
  return workspaceTarget
}

export function isCurrentWorkspaceTarget(
  target: unknown,
): target is WorkspaceTarget {
  if (!workspaceTarget || typeof target !== 'object' || target === null)
    return false
  const candidate = target as WorkspaceTarget
  return (
    workspaceTarget.workspaceId === candidate.workspaceId &&
    workspaceTarget.workspaceGeneration === candidate.workspaceGeneration
  )
}

function workspaceStreamStatus(): WorkspaceStreamStatus {
  return {
    stale:
      !watcher ||
      workspaceScansInFlight > 0 ||
      watcherFlushesInFlight > 0 ||
      watcherEvents.size > 0 ||
      unknownWatcherEvent ||
      workspaceScanFailed,
    complete: !workspaceScanFailed,
    capReached: false,
  }
}

export function workspaceChangeSnapshot(): WorkspaceStreamSnapshot {
  return workspaceStream.snapshot(entries, workspaceStreamStatus())
}

export function workspaceChangeCursor(): WorkspaceStreamCursor {
  return workspaceStream.cursor(workspaceStreamStatus())
}

export function listWorkspaceEntryPage(
  request: WorkspaceEntryPageRequest,
): WorkspaceEntryPageResult {
  return pageWorkspaceEntries(entries, workspaceChangeCursor(), request)
}

let viewDrafts: WorkspaceViewEntry[] = []
let viewDraftKey = ''
let viewDraftRevision = 0
type ViewSnapshot = {
  revision: number
  entries: readonly WorkspaceEntry[]
  status: WorkspaceStreamCursor
}
// Each private stream retains its immutable tree until that traversal finishes.
let viewSnapshots: { tree?: ViewSnapshot; drafts?: ViewSnapshot } = {}

export function getWorkspaceHeader(): WorkspaceHeader | null {
  const state = workspaceHeaderFields()
  if (!state || !root) return null
  const drafts: WorkspaceViewEntry[] = []
  for (const document of getOpenDocumentMetadata()) {
    if (!document.dirty && !document.pendingPath) continue
    const nativePath = document.pendingPath ?? document.file
    if (!nativePath) continue
    const path = relativePath(root, nativePath)
    if (path)
      drafts.push({
        path,
        name: basename(path),
        kind: 'file',
        dirty: document.dirty,
        ...(document.pendingPath ? { pending: true } : {}),
      })
  }
  const key = JSON.stringify([workspaceTarget, drafts])
  if (key !== viewDraftKey) {
    viewDraftKey = key
    viewDrafts = drafts
    viewDraftRevision++
  }
  return {
    ...state,
    ...workspaceChangeCursor(),
    treeRevision,
    draftRevision: viewDraftRevision,
  }
}

export function readWorkspaceViewPage(
  request: WorkspaceViewPageRequest,
): WorkspaceViewPageResult {
  if (!isCurrentWorkspaceTarget(request?.target))
    return pageWorkspaceEntries([], workspaceChangeCursor(), request)
  const kind = request.drafts ? 'drafts' : 'tree'
  const revision = request.drafts ? request.draftRevision : request.treeRevision
  let snapshot = viewSnapshots[kind]
  if (
    !snapshot ||
    snapshot.revision !== revision ||
    snapshot.status.target?.workspaceId !== request.target.workspaceId ||
    snapshot.status.target.workspaceGeneration !==
      request.target.workspaceGeneration
  ) {
    if (
      request.cursor !== undefined ||
      revision !== (request.drafts ? viewDraftRevision : treeRevision)
    )
      return {
        ok: false,
        code: 'resync-needed',
        message:
          'The workspace changed. Start listing again from the first page.',
      }
    snapshot = {
      revision,
      entries: request.drafts ? viewDrafts : entries,
      status: workspaceChangeCursor(),
    }
    viewSnapshots[kind] = snapshot
  }
  const result = pageWorkspaceEntries(
    snapshot.entries,
    { ...snapshot.status, sequence: revision },
    { ...request, sequence: revision },
    request.drafts
      ? (entry) => {
          const draft = entry as WorkspaceViewEntry
          return {
            path: draft.path,
            name: draft.name,
            kind: draft.kind,
            dirty: draft.dirty,
            ...(draft.pending ? { pending: true } : {}),
          }
        }
      : undefined,
  )
  if (result.ok && result.value.nextCursor === null) delete viewSnapshots[kind]
  return result
}

export function workspaceIndexRevision(): number {
  return indexRevision
}

export function listenWorkspaceChanges(
  listener: (event: WorkspaceChangeEvent) => void,
): () => void {
  return workspaceStream.listen(listener)
}

export function subscribeWorkspaceChanges(
  listener: (event: WorkspaceChangeEvent) => void,
  includeEntries = false,
): { snapshot: WorkspaceStreamSnapshot; dispose: () => void } {
  return workspaceStream.subscribe(
    listener,
    includeEntries ? entries : [],
    workspaceStreamStatus(),
  )
}

async function obsidianVault(
  base: string,
): Promise<WorkspaceState['obsidian']> {
  const settings = join(base, '.obsidian')
  const folder = await lstat(settings).catch(() => null)
  if (!folder?.isDirectory() || folder.isSymbolicLink()) return undefined
  const plugins = join(settings, 'community-plugins.json')
  const file = await lstat(plugins).catch(() => null)
  if (!file?.isFile() || file.isSymbolicLink()) return { externalAddons: false }
  if (file.size > 65536) return { externalAddons: true }
  try {
    const enabled = JSON.parse(await readFile(plugins, 'utf8'))
    return { externalAddons: Array.isArray(enabled) && enabled.length > 0 }
  } catch {
    return { externalAddons: false }
  }
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
  signal?: AbortSignal,
  previous?: WorkspaceEntry[],
): Promise<WorkspaceEntry[]> {
  signal?.throwIfAborted()
  const ignored = await workspaceIgnore(base)
  signal?.throwIfAborted()
  return scanWorkspaceTree(
    base,
    showAllFiles,
    ignored,
    (name) => isDocumentName(name, true),
    signal,
    previous,
  )
}

type WorkspaceMetadata = Omit<WorkspaceState, 'entries'>
export type WorkspaceReply<IncludeEntries extends boolean = false> =
  IncludeEntries extends true ? WorkspaceState : WorkspaceMetadata

function workspaceHeaderFields(): WorkspaceMetadata | null {
  if (!root) return null
  const path = getDocumentPath()
  return {
    id: workspaceId()!,
    ...(workspaceTarget
      ? { workspaceGeneration: workspaceTarget.workspaceGeneration }
      : {}),
    name: manifest?.name ?? basename(root),
    manifest,
    ...(obsidian ? { obsidian } : {}),
    activePath: path ? relativePath(root, path) : null,
  }
}

export function getWorkspace<IncludeEntries extends boolean = false>(
  open?: ReturnType<typeof getOpenDocumentMetadata>,
  includeEntries?: IncludeEntries,
): WorkspaceReply<IncludeEntries> | null
export function getWorkspace(
  open?: ReturnType<typeof getOpenDocumentMetadata>,
  includeEntries: boolean = false,
): WorkspaceReply<boolean> | null {
  const header = workspaceHeaderFields()
  if (!header || !root) return null
  if (!includeEntries) return { ...header, entries: [] }
  const documents = open ?? getOpenDocumentMetadata()
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
    documents.flatMap((draft) => {
      const file = draft.pendingPath ?? draft.file
      const path = draft.dirty && file ? relativePath(root!, file) : null
      return path ? [path] : []
    }),
  )
  const decorate = (items: WorkspaceEntry[]): WorkspaceEntry[] =>
    items.map((item) => ({
      ...item,
      dirty: dirty.has(item.path),
      ...(item.children ? { children: decorate(item.children) } : {}),
    }))
  return {
    ...header,
    entries: decorate(visible),
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

async function fileStatus(
  base: string,
  path: string,
): Promise<BigIntStats | null> {
  try {
    return await lstat(join(base, path), { bigint: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function fingerprint(info: BigIntStats | null): string | null {
  return info
    ? [
        info.dev,
        info.ino,
        info.mode,
        info.size,
        info.mtimeNs,
        info.ctimeNs,
      ].join(':')
    : null
}

async function acknowledgePaths(
  base: string,
  target: WorkspaceTarget,
  paths: string[],
) {
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
      if (isCurrentWorkspaceTarget(target))
        acknowledgedPaths.set(path, {
          fingerprint: current,
          expires: Date.now() + 1500,
        })
    }),
  )
}

function requestWorkspaceScan<IncludeEntries extends boolean = false>(
  paths: string[] | null,
  acknowledge?: boolean,
  includeEntries?: IncludeEntries,
): Promise<WorkspaceReply<IncludeEntries> | null>
async function requestWorkspaceScan(
  paths: string[] | null,
  acknowledge = false,
  includeEntries = false,
): Promise<WorkspaceReply<boolean> | null> {
  const selected = root
  const target = workspaceTarget
  if (!selected || !target || !scanCoordinator)
    return getWorkspace(undefined, includeEntries)
  workspaceScansInFlight++
  try {
    if (acknowledge && paths) await acknowledgePaths(selected, target, paths)
    if (!isCurrentWorkspaceTarget(target)) return null
    addTreePaths(paths)
    await scanCoordinator.request()
    if (!isCurrentWorkspaceTarget(target)) return null
    workspaceScanFailed = false
    return getWorkspace(undefined, includeEntries)
  } catch (error) {
    if (isCurrentWorkspaceTarget(target)) {
      workspaceScanFailed = true
      workspaceStream.publish('resync', null)
    }
    throw error
  } finally {
    if (isCurrentWorkspaceTarget(target)) workspaceScansInFlight--
  }
}

export function refreshWorkspace<IncludeEntries extends boolean = false>(
  paths?: string[] | null,
  includeEntries?: IncludeEntries,
): Promise<WorkspaceReply<IncludeEntries> | null>
export function refreshWorkspace(
  paths: string[] | null = null,
  includeEntries = false,
): Promise<WorkspaceReply<boolean> | null> {
  return requestWorkspaceScan(paths, paths !== null, includeEntries)
}

export function notifyWorkspaceContent<IncludeEntries extends boolean = false>(
  paths: string[] | null,
  includeEntries?: IncludeEntries,
): Promise<WorkspaceReply<IncludeEntries> | null>
export async function notifyWorkspaceContent(
  paths: string[] | null,
  includeEntries = false,
): Promise<WorkspaceReply<boolean> | null> {
  const selected = root
  const target = workspaceTarget
  if (!selected || !target) return null
  if (paths) await acknowledgePaths(selected, target, paths)
  if (!isCurrentWorkspaceTarget(target)) return null
  publishWorkspaceChange({ kind: 'content', paths })
  return getWorkspace(undefined, includeEntries)
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
  if (treeChanged) await refreshWorkspace(paths, false)
  else await notifyWorkspaceContent(paths, false)
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

async function flushWatcherEvents(selected: string, target: WorkspaceTarget) {
  if (!isCurrentWorkspaceTarget(target)) return
  watcherFlushesInFlight++
  try {
    await reconcileWatcherEvents(selected, target)
  } catch (error) {
    if (isCurrentWorkspaceTarget(target)) {
      unknownWatcherEvent = true
      if (!workspaceScanFailed) {
        workspaceScanFailed = true
        workspaceStream.publish('resync', null)
      }
    }
    throw error
  } finally {
    if (isCurrentWorkspaceTarget(target)) watcherFlushesInFlight--
  }
}

async function reconcileWatcherEvents(
  selected: string,
  target: WorkspaceTarget,
) {
  if (!isCurrentWorkspaceTarget(target)) return
  const events = watcherEvents
  const unknown = unknownWatcherEvent
  watcherEvents = new Map()
  unknownWatcherEvent = false
  if (unknown) {
    await requestWorkspaceScan(null)
    return
  }
  const ignored = await workspaceIgnore(selected)
  if (!isCurrentWorkspaceTarget(target)) return
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
  if (!isCurrentWorkspaceTarget(target)) return
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
  scopeTarget: WorkspaceTarget,
  eventType: string,
  filename: string | Buffer | null,
) {
  if (!isCurrentWorkspaceTarget(scopeTarget)) return
  const path =
    filename && relativePath(selected, join(selected, filename.toString()))
  const target = path && atomicTempTarget(path)
  if (target) watcherEvents.set(target, 'rename')
  else if (path)
    watcherEvents.set(
      path,
      eventType === 'rename' || watcherEvents.get(path) === 'rename'
        ? 'rename'
        : 'change',
    )
  else unknownWatcherEvent = true
  const now = performance.now()
  if (refreshTimer === undefined) refreshQueuedAt = now
  clearTimeout(refreshTimer)
  refreshTimer = setTimeout(
    () => {
      refreshTimer = undefined
      void flushWatcherEvents(selected, scopeTarget).catch((error: unknown) =>
        console.error('workspace refresh failed:', error),
      )
    },
    Math.max(0, Math.min(200, 1000 - (now - refreshQueuedAt))),
  )
}

export function observeWorkspace(
  callback: (change: WorkspaceChange) => void,
): void {
  onChanged = callback
}

export function openWorkspace<IncludeEntries extends boolean = false>(
  window: BrowserWindow,
  includeEntries?: IncludeEntries,
): Promise<WorkspaceReply<IncludeEntries> | null>
export async function openWorkspace(
  window: BrowserWindow,
  includeEntries = false,
): Promise<WorkspaceReply<boolean> | null> {
  const result = await runFileDialog(() =>
    dialog.showOpenDialog(window, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Open workspace',
    }),
  )
  const selected = result.filePaths[0]
  if (result.canceled || !selected) return null
  return loadWorkspace(selected, true, includeEntries)
}

export function cancelWorkspaceSelection(): void {
  selectionController?.abort()
  selectionController = undefined
}

function cancelWorkspaceLoad(): void {
  selectionController = undefined
  loadGeneration++
  loadController?.abort()
  loadController = undefined
}

export function loadWorkspace<IncludeEntries extends boolean = false>(
  selected: string,
  selection?: boolean,
  includeEntries?: IncludeEntries,
): Promise<WorkspaceReply<IncludeEntries> | null>
export async function loadWorkspace(
  selected: string,
  selection = false,
  includeEntries = false,
): Promise<WorkspaceReply<boolean> | null> {
  cancelWorkspaceLoad()
  const loading = loadGeneration
  const controller = new AbortController()
  loadController = controller
  if (selection) selectionController = controller
  const signal = controller.signal
  const detach = () => {
    if (loadController === controller) loadController = undefined
    if (selectionController === controller) selectionController = undefined
  }
  const nextRoot = await realpath(selected)
  if (loading !== loadGeneration || signal.aborted)
    return getWorkspace(undefined, includeEntries)
  if (nextRoot === root) {
    detach()
    const vault = await obsidianVault(nextRoot)
    if (loading !== loadGeneration || signal.aborted)
      return getWorkspace(undefined, includeEntries)
    obsidian = vault
    await refreshWorkspace(null, includeEntries)
    if (loading !== loadGeneration || signal.aborted)
      return getWorkspace(undefined, includeEntries)
    await rememberWorkspace(nextRoot)
    return getWorkspace(undefined, includeEntries)
  }
  const showAllFiles = await showAllWorkspaceFiles()
  if (loading !== loadGeneration || signal.aborted)
    return getWorkspace(undefined, includeEntries)
  let candidateWatcher: FSWatcher | undefined
  let candidateTarget: WorkspaceTarget | null = null
  let changedDuringScan = false
  try {
    const prepared = watch(
      nextRoot,
      { recursive: true, persistent: false },
      (eventType, filename) => {
        if (candidateTarget)
          queueWatcherEvent(nextRoot, candidateTarget, eventType, filename)
        else changedDuringScan = true
      },
    )
    candidateWatcher = prepared
    prepared.on('error', (error) => {
      console.error('workspace watcher failed:', error)
      prepared.close()
      if (watcher === prepared) {
        watcher = undefined
        workspaceStream.publish('resync', null)
      } else {
        if (candidateWatcher === prepared) candidateWatcher = undefined
        changedDuringScan = true
      }
    })
  } catch (error) {
    console.error('workspace watcher unavailable:', error)
  }
  const cancelCandidate = () => candidateWatcher?.close()
  signal.addEventListener('abort', cancelCandidate, { once: true })
  let nextEntries: WorkspaceEntry[]
  let metadata: Awaited<ReturnType<typeof workspaceMetadata>>
  let vault: WorkspaceState['obsidian']
  try {
    ;[nextEntries, metadata, vault] = await Promise.all([
      scanWorkspace(nextRoot, showAllFiles, signal),
      workspaceMetadata(nextRoot),
      obsidianVault(nextRoot),
    ])
  } catch (error) {
    candidateWatcher?.close()
    if (signal.aborted) return getWorkspace(undefined, includeEntries)
    throw error
  } finally {
    signal.removeEventListener('abort', cancelCandidate)
  }
  if (loading !== loadGeneration || signal.aborted) {
    candidateWatcher?.close()
    return getWorkspace(undefined, includeEntries)
  }
  watcher?.close()
  watcher = undefined
  clearTimeout(refreshTimer)
  refreshTimer = undefined
  indexJob.reset()
  scanCoordinator?.close()
  scanCoordinator = undefined
  watcherEvents.clear()
  unknownWatcherEvent = false
  workspaceScansInFlight = 0
  watcherFlushesInFlight = 0
  workspaceScanFailed = false
  acknowledgedPaths.clear()
  pendingTreePaths = new Set()
  cachedRoot = null
  cachedPages.clear()
  dirtyIndexPaths = null
  metadataParser.close()
  legacyIndex.clear()
  legacyCachedRoot = null
  cachedMetadataTree = null
  cachedSyntaxFingerprint = ''
  cachedDraftPaths.clear()
  root = nextRoot
  workspaceTarget = Object.freeze({
    workspaceId: workspaceId() as WorkspaceTarget['workspaceId'],
    workspaceGeneration: ++workspaceGeneration,
  })
  const selectedTarget = workspaceTarget
  entries = nextEntries
  treeRevision++
  viewSnapshots = {}
  manifest = metadata.manifest
  obsidian = vault
  showingAllFiles = showAllFiles
  ignoredPaths = ignore().add(metadata.ignore)
  workspaceStream.replace(workspaceTarget)
  detach()
  scanCoordinator = createScanCoordinator(
    async (signal) => {
      const showAllFiles = await showAllWorkspaceFiles()
      const [next, metadata] = await Promise.all([
        scanWorkspace(nextRoot, showAllFiles, signal, entries),
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
      if (!isCurrentWorkspaceTarget(selectedTarget)) return
      const treeChanged = entries !== next.entries
      const metadataChanged =
        JSON.stringify(manifest) !== JSON.stringify(next.manifest) ||
        showingAllFiles !== next.showAllFiles
      const paths = takeTreePaths()
      entries = next.entries
      manifest = next.manifest
      showingAllFiles = next.showAllFiles
      ignoredPaths = next.ignored
      if (treeChanged) treeRevision++
      if (treeChanged || metadataChanged || paths?.some(metadataPath)) {
        publishWorkspaceChange({ kind: 'tree', paths })
      } else if (paths === null || paths.length) {
        publishWorkspaceChange({ kind: 'content', paths })
      }
    },
  )
  watcher = candidateWatcher
  candidateTarget = selectedTarget
  let startupReconciled = false
  let startupScanFailed = false
  if (changedDuringScan)
    startupReconciled =
      (await requestWorkspaceScan(null, false, includeEntries).catch(
        (error: unknown) => {
          console.error('workspace startup rescan failed:', error)
          startupScanFailed = true
          return null
        },
      )) !== null
  if (loading !== loadGeneration || !isCurrentWorkspaceTarget(selectedTarget))
    return getWorkspace(undefined, includeEntries)
  await rememberWorkspace(nextRoot).catch((error: unknown) =>
    console.error('could not remember workspace:', error),
  )
  if (loading !== loadGeneration || !isCurrentWorkspaceTarget(selectedTarget))
    return getWorkspace(undefined, includeEntries)
  if (!startupReconciled && !startupScanFailed)
    publishWorkspaceChange({ kind: 'tree', paths: null })
  return getWorkspace(undefined, includeEntries)
}

export function openRecentWorkspace<IncludeEntries extends boolean = false>(
  id: unknown,
  includeEntries?: IncludeEntries,
): Promise<WorkspaceReply<IncludeEntries> | null>
export async function openRecentWorkspace(
  id: unknown,
  includeEntries = false,
): Promise<WorkspaceReply<boolean> | null> {
  const recent = (await getKnownWorkspaces()).find(
    (item) => !item.hidden && item.id === id,
  )
  if (!recent)
    throw new Error(
      'This workspace is no longer in the recent list. Open it from its folder.',
    )
  return loadWorkspace(recent.path, true, includeEntries)
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
  const removedCaches = new Set([item.id])
  let stopping: Promise<void> | undefined
  if (root === item.path || root?.startsWith(`${item.path}${sep}`)) {
    const currentId = workspaceId()
    if (currentId) removedCaches.add(currentId)
  }
  await shell.trashItem(item.path)
  closeDeletedDocuments(window, item.path)
  if (root === item.path || root?.startsWith(`${item.path}${sep}`)) {
    cancelWorkspaceLoad()
    watcher?.close()
    clearTimeout(refreshTimer)
    refreshTimer = undefined
    indexJob.reset()
    scanCoordinator?.close()
    scanCoordinator = undefined
    watcher = undefined
    watcherEvents.clear()
    unknownWatcherEvent = false
    workspaceScansInFlight = 0
    watcherFlushesInFlight = 0
    workspaceScanFailed = false
    acknowledgedPaths.clear()
    pendingTreePaths = new Set()
    root = null
    workspaceTarget = null
    workspaceGeneration++
    entries = []
    treeRevision++
    viewSnapshots = {}
    manifest = null
    obsidian = undefined
    ignoredPaths = null
    cachedRoot = null
    cachedPages.clear()
    dirtyIndexPaths = null
    stopping = metadataParser.close()
    legacyIndex.clear()
    legacyCachedRoot = null
    cachedMetadataTree = null
    cachedSyntaxFingerprint = ''
    cachedDraftPaths.clear()
    workspaceStream.replace(null)
  }
  await stopping
  await Promise.all(
    [...removedCaches].map((id) =>
      rm(join(app.getPath('userData'), 'workspace-index-cache', id), {
        recursive: true,
        force: true,
      }).catch(() => {}),
    ),
  )
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

export async function resolveWikiDocument(from: string | null, target: string) {
  if (!root || !from) return null
  const source = relativePath(root, from)
  if (!source) return null
  const paths = new Set<string>()
  const collect = (items: readonly WorkspaceEntry[]) => {
    for (const item of items) {
      if (item.children) collect(item.children)
      else if (item.kind === 'file') paths.add(item.path)
    }
  }
  collect(entries)
  const path = wikiTarget(source, target, paths)
  return path ? resolveWorkspaceFile(root, path) : null
}

export async function openWorkspaceFile(
  window: BrowserWindow,
  path: unknown,
  target?: unknown,
) {
  if (!root) throw new Error('Open a workspace first.')
  if (target !== undefined && !isCurrentWorkspaceTarget(target))
    throw new Error('The workspace changed, so this file did not open.')
  if (
    typeof path === 'string' &&
    getWorkspace(undefined, false)?.activePath === path
  )
    return getDocument()
  const draft =
    typeof path === 'string' &&
    getOpenDocuments().find(
      (draft) =>
        draft.pendingPath && relativePath(root!, draft.pendingPath) === path,
    )
  // Once another app creates a draft's planned file, it opens like the file.
  const planned = draft ? draft.pendingPath : null
  if (draft && !(planned && (await lstat(planned).catch(() => null))))
    return selectDocumentTab(window, draft.tabId)
  return loadDocument(
    window,
    await resolveWorkspaceFile(root, path, await showAllWorkspaceFiles()),
  )
}

export async function readWorkspaceExportSource(
  relative: string,
  target: WorkspaceTarget,
) {
  if (!isCurrentWorkspaceTarget(target) || !root)
    throw new Error('The workspace changed during export. Export again.')
  const selected = root
  const draft = getOpenDocuments().find(
    (draft) => draft.file && relativePath(selected, draft.file) === relative,
  )
  const path =
    draft?.pendingPath ?? (await resolveWorkspaceFile(selected, relative))
  // New drafts have no disk file; their parent still belongs to the workspace.
  if (draft?.pendingPath) {
    await resolveWorkspaceEntry(selected, relative, true)
  }
  // Export owns one page at a time and has no per-note content ceiling.
  const chunks: string[] = []
  if (!draft?.dirty)
    for await (const chunk of readMarkdownChunks(path)) chunks.push(chunk)
  const markdown = draft?.dirty ? draft.markdown : chunks.join('')
  if (!isCurrentWorkspaceTarget(target))
    throw new Error('The workspace changed during export. Export again.')
  return {
    page: {
      id: createHash('sha256').update(path).digest('hex'),
      path: relative,
      markdown,
    },
    note: path,
    workspace: selected,
  }
}

export async function readWorkspaceExportPage(
  relative: string,
  target: WorkspaceTarget,
  media: boolean | readonly string[] = true,
): Promise<WorkspaceSnapshot['pages'][number]> {
  const source = await readWorkspaceExportSource(relative, target)
  const images: Record<string, string> = Object.create(null)
  if (media && isMarkdownDocument(relative))
    for (const href of typeof media === 'boolean'
      ? imageSources(source.page.markdown)
      : media) {
      const image = await exportDocumentMedia(
        href,
        source.note,
        source.workspace,
      )
      if (image) images[href] = image
    }
  if (!isCurrentWorkspaceTarget(target))
    throw new Error('The workspace changed during export. Export again.')
  return { ...source.page, ...(media ? { images } : {}) }
}

export function exportPaths(
  entries: readonly WorkspaceEntry[],
): { path: string }[] {
  return entries.flatMap((entry) =>
    entry.children
      ? exportPaths(entry.children)
      : entry.kind === 'file' &&
          !entry.name.startsWith('.') &&
          isDocumentName(entry.name, true)
        ? [{ path: entry.path }]
        : [],
  )
}

export async function snapshotWorkspace(): Promise<WorkspaceSnapshot> {
  const target = currentWorkspaceTarget()
  if (!target) throw new Error('Open a workspace first.')
  await refreshWorkspace()
  if (!isCurrentWorkspaceTarget(target))
    throw new Error('The workspace changed during export. Export again.')
  const workspace = getWorkspace(undefined, true)
  if (!workspace) throw new Error('Open a workspace first.')
  const pages: WorkspaceSnapshot['pages'] = []
  for (const { path } of exportPaths(workspace.entries))
    pages.push(await readWorkspaceExportPage(path, target))
  if (!pages.length)
    throw new Error('This workspace has no supported documents to export.')
  return { name: workspace.name, pages }
}

function captureIndexRequest(): { key: string; request: IndexRequest } | null {
  const selected = root
  if (!selected) return null
  const documents = getOpenDocumentMetadata()
  const workspace = getWorkspace(documents, false)
  if (!workspace) return null
  const drafts = metadataDrafts(selected)
  const revision = indexRevision
  const key = JSON.stringify([
    selected,
    workspaceTarget?.workspaceGeneration,
    revision,
    [...drafts]
      .map(([path, draft]) => [path, draft.tabId, draft.contentVersion])
      .sort(([a], [b]) => String(a).localeCompare(String(b))),
    documents.map(({ file, pendingPath, dirty }) => [file, pendingPath, dirty]),
  ])
  return {
    key,
    request: {
      key,
      selected,
      workspace,
      drafts,
      documents,
      tree: entries,
      revision,
    },
  }
}

async function runIndexRequest(
  request: IndexRequest,
  current: () => boolean,
): Promise<WorkspaceIndex | null> {
  const { selected, workspace, drafts, documents, tree, revision } = request
  const active = () =>
    current() && root === selected && indexRevision === revision
  const source = (draft: IndexDraft) => ({
    id: createHash('sha256').update(draft.file).digest('hex'),
    version: `draft:${draft.tabId}:${draft.contentVersion}`,
    read: (maximumBytes: number) => {
      checkLegacyIndexBytes(draft.source.utf16Length, maximumBytes)
      return draft.source.materialize()
    },
  })
  const result = await legacyIndex.read({
    key: request.key,
    workspace,
    entries: tree,
    documents: documents.flatMap((document) => {
      const file = document.pendingPath ?? document.file
      const path = file && relativePath(selected, file)
      return path
        ? [{ path, dirty: document.dirty, pending: !!document.pendingPath }]
        : []
    }),
    drafts: new Map([...drafts].map(([path, draft]) => [path, source(draft)])),
    resolve: async (path) => {
      const file = await resolveWorkspaceFile(selected, path)
      if (!active())
        throw new DOMException('Workspace index canceled.', 'AbortError')
      const info = await stat(file, { bigint: true })
      return {
        id: createHash('sha256').update(file).digest('hex'),
        version: diskIndexVersion(info),
        read: (maximumBytes: number) => {
          checkLegacyIndexBytes(Number(info.size), maximumBytes)
          return readMarkdown(file, maximumBytes)
        },
      }
    },
    isDocument: (name) => isDocumentName(name, true),
    current: active,
  })
  if (result && active()) legacyCachedRoot = selected
  return result
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
  return indexJob.request(captured)
}

function metadataDrafts(selected: string): Map<string, IndexDraft> {
  const dirty = new Set(
    getDocumentTabs()
      .filter((tab) => tab.dirty)
      .map((tab) => tab.id),
  )
  const pending = new Set(
    getOpenDocumentMetadata().flatMap((document) =>
      document.pendingPath ? [document.pendingPath] : [],
    ),
  )
  const drafts = new Map<string, IndexDraft>()
  for (const version of getOpenDocumentVersions()) {
    const path = relativePath(selected, version.file)
    if (
      !dirty.has(version.tabId) ||
      !path ||
      !isDocumentName(basename(path), true) ||
      !relevantWatchPath(path) ||
      path.split('/').includes('node_modules') ||
      ignoredPaths?.ignores(path)
    )
      continue
    drafts.set(path, {
      ...version,
      pending: pending.has(version.file),
      source: getDocumentSourceFor(version.tabId).snapshot(),
    })
  }
  return drafts
}

/** Heading text stays on disk; only this requested page crosses the worker boundary. */
export async function workspaceMetadataHeadings(
  path: string,
  syntax: WorkspaceSyntax,
  offset: number,
  limit: number,
  current: () => boolean,
) {
  const selected = root
  if (!selected) return null
  const revision = indexRevision
  const active = () =>
    current() && root === selected && indexRevision === revision
  const draft = metadataDrafts(selected).get(path)
  try {
    const file = draft?.file ?? (await resolveWorkspaceFile(selected, path))
    if (!active()) return null
    const version = draft
      ? `draft:${draft.tabId}:${draft.contentVersion}`
      : diskIndexVersion(await stat(file, { bigint: true }))
    if (!active()) return null
    const id = createHash('sha256').update(file).digest('hex')
    const cached = {
      kind: 'cached' as const,
      id,
      path,
      version,
      fingerprint: syntax.fingerprint,
    }
    const page = await metadataParser.readHeadings(
      cached,
      offset,
      limit,
      active,
    )
    if (!active()) return null
    if (page) return page
    const input = {
      id,
      path,
      version,
      fingerprint: syntax.fingerprint,
      syntax: syntax.page({ id, path, markdown: '' }),
    }
    const parsed = draft
      ? await metadataParser.parseSource(input, draft.source, active)
      : await metadataParser.parseFile(
          { ...input, nativePath: file, expectedVersion: version },
          active,
        )
    if (!parsed || !active()) return null
    return await metadataParser.readHeadings(cached, offset, limit, active)
  } catch (error) {
    if (!active() || (error as NodeJS.ErrnoException).code === 'ENOENT')
      return null
    throw error
  }
}

type PreparedMetadata =
  | {
      kind: 'retained'
      path: string
      cached: CachedIndexPage<WorkspaceMetadataPage>
    }
  | {
      kind: 'source'
      path: string
      file: string
      id: string
      version: string
      key: string
      existing: CachedIndexPage<WorkspaceMetadataPage> | undefined
      draft: IndexDraft | undefined
    }

async function readMetadataBatch(
  paths: readonly string[],
  selected: string,
  syntax: WorkspaceSyntax,
  drafts: ReadonlyMap<string, IndexDraft>,
  previous: ReadonlyMap<string, CachedIndexPage<WorkspaceMetadataPage>>,
  current: () => boolean,
  begin?: () => Promise<boolean>,
): Promise<[string, CachedIndexPage<WorkspaceMetadataPage>][]> {
  const prepared: (PreparedMetadata | null)[] = paths.map(() => null)
  let offset = 0
  await Promise.all(
    Array.from({ length: Math.min(4, paths.length) }, async () => {
      while (current() && offset < paths.length) {
        const index = offset++
        const path = paths[index]
        if (!path) continue
        const draft = drafts.get(path)
        const existing = previous.get(path)
        try {
          if (
            !draft &&
            existing?.page.version.startsWith('disk:') &&
            existing.version ===
              `${existing.page.version}:${syntax.fingerprint}` &&
            !needsIndexVerification(dirtyIndexPaths, path)
          ) {
            prepared[index] = { kind: 'retained', path, cached: existing }
            continue
          }
          const file =
            draft?.file ?? (await resolveWorkspaceFile(selected, path))
          if (!current()) return
          const version = draft
            ? `draft:${draft.tabId}:${draft.contentVersion}`
            : diskIndexVersion(await stat(file, { bigint: true }))
          if (!current()) return
          const key = `${version}:${syntax.fingerprint}`
          prepared[index] =
            existing?.version === key
              ? { kind: 'retained', path, cached: existing }
              : {
                  kind: 'source',
                  path,
                  file,
                  id: createHash('sha256').update(file).digest('hex'),
                  version,
                  key,
                  existing,
                  draft,
                }
        } catch (error) {
          if (!current()) return
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
    }),
  )
  if (!current() || (begin && !(await begin()))) return []
  const sources = prepared.filter(
    (item): item is Extract<PreparedMetadata, { kind: 'source' }> =>
      item?.kind === 'source' && !item.draft,
  )
  const hits = sources.length
    ? await metadataParser.cachedBatch(
        sources.map((item) => ({
          kind: 'cached' as const,
          id: item.id,
          path: item.path,
          version: item.version,
          fingerprint: syntax.fingerprint,
        })),
        current,
      )
    : []
  if (!current()) return []
  const cachedHits = new Map(
    sources.map((item, index) => [item.path, hits[index]]),
  )
  const result: [string, CachedIndexPage<WorkspaceMetadataPage>][] = []
  let started = performance.now()
  for (const item of prepared) {
    if (!current()) return []
    if (!item) continue
    if (item.kind === 'retained') result.push([item.path, item.cached])
    else {
      try {
        const hit = cachedHits.get(item.path)
        let cached: CachedIndexPage<WorkspaceMetadataPage>
        if (hit) cached = { version: item.key, page: hit, bytes: 0 }
        else {
          const input = {
            id: item.id,
            path: item.path,
            version: item.version,
            fingerprint: syntax.fingerprint,
            syntax: syntax.page({ id: item.id, path: item.path, markdown: '' }),
          }
          const parsed = item.draft
            ? await metadataParser.parseSource(
                input,
                item.draft.source,
                current,
              )
            : await metadataParser.parseFile(
                {
                  ...input,
                  nativePath: item.file,
                  expectedVersion: item.version,
                },
                current,
              )
          if (!current()) return []
          cached = {
            version: item.key,
            page: parsed ?? incompleteMetadataPage(input),
            bytes: 0,
          }
        }
        if (!current()) return []
        result.push([item.path, cached])
      } catch (error) {
        if (!current()) return []
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    if (performance.now() - started >= 4) {
      await new Promise<void>((resolve) => setImmediate(resolve))
      started = performance.now()
    }
  }
  if (begin && result.length)
    await metadataParser.markSeen(
      result.flatMap(([, cached]) => (cached.page.id ? [cached.page.id] : [])),
      current,
    )
  return current() ? result : []
}

type WorkspaceMetadataRead<Pages> = {
  pages: Pages
  commit: () => boolean
}

/** One bounded descriptor batch; publish its cache only with the applied index. */
export function workspaceMetadataPages(
  syntax: WorkspaceSyntax,
  current: () => boolean,
): WorkspaceMetadataRead<AsyncIterable<WorkspaceMetadataPage>> {
  let publish: (() => boolean) | undefined
  async function* read(): AsyncGenerator<WorkspaceMetadataPage> {
    const selected = root
    if (!selected) return
    const revision = indexRevision
    const tree = entries
    const drafts = metadataDrafts(selected)
    const active = () =>
      current() && root === selected && indexRevision === revision
    const previous =
      cachedRoot === selected
        ? cachedPages
        : new Map<string, CachedIndexPage<WorkspaceMetadataPage>>()
    const next = new Map<string, CachedIndexPage<WorkspaceMetadataPage>>()
    const seen = new Set<string>()
    let building = false
    const begin = async () => {
      if (!building) building = await metadataParser.beginBuild(active)
      return building && active()
    }
    let started = performance.now()
    async function* paths(
      items: readonly WorkspaceEntry[],
    ): AsyncGenerator<string> {
      for (const item of items) {
        if (!active()) return
        if (item.children) yield* paths(item.children)
        else if (item.kind === 'file' && isDocumentName(item.name, true)) {
          seen.add(item.path)
          yield item.path
        }
        if (performance.now() - started >= 4) {
          await new Promise<void>((resolve) => setImmediate(resolve))
          started = performance.now()
        }
      }
    }
    async function* allPaths() {
      yield* paths(tree)
      for (const [path, draft] of drafts)
        if (draft.pending && !seen.has(path)) yield path
    }
    let batch: string[] = []
    for await (const path of allPaths()) {
      batch.push(path)
      if (batch.length < 64) continue
      const pages = await readMetadataBatch(
        batch,
        selected,
        syntax,
        drafts,
        previous,
        active,
        begin,
      )
      if (!active()) return
      for (const [path, cached] of pages) {
        next.set(path, cached)
        yield cached.page
      }
      batch = []
    }
    if (batch.length) {
      const pages = await readMetadataBatch(
        batch,
        selected,
        syntax,
        drafts,
        previous,
        active,
        begin,
      )
      if (!active()) return
      for (const [path, cached] of pages) {
        next.set(path, cached)
        yield cached.page
      }
    }
    if (!active()) return
    if (building) await metadataParser.finishBuild(active)
    else {
      await metadataParser.close()
      if (!active()) return
      const id = createHash('sha256').update(selected).digest('hex')
      await rm(join(app.getPath('userData'), 'workspace-index-cache', id), {
        recursive: true,
        force: true,
      }).catch(() => {})
    }
    if (!active()) return
    publish = () => {
      if (!active()) return false
      cachedRoot = selected
      cachedPages = next
      cachedMetadataTree = tree
      cachedSyntaxFingerprint = syntax.fingerprint
      cachedDraftPaths = new Set(
        [...drafts.keys()].filter((path) => next.has(path)),
      )
      dirtyIndexPaths = new Set()
      return true
    }
  }
  return {
    pages: read(),
    commit() {
      const commit = publish
      publish = undefined
      return commit?.() ?? false
    },
  }
}

/** Apply dirty buffers and known content changes without traversing the retained tree. */
export async function workspaceMetadataDelta(
  syntax: WorkspaceSyntax,
  current: () => boolean,
): Promise<WorkspaceMetadataRead<readonly WorkspaceMetadataPage[]> | null> {
  const selected = root
  if (
    !selected ||
    cachedRoot !== selected ||
    cachedMetadataTree !== entries ||
    cachedSyntaxFingerprint !== syntax.fingerprint ||
    !dirtyIndexPaths
  )
    return null
  const revision = indexRevision
  const active = () =>
    current() && root === selected && indexRevision === revision
  const drafts = metadataDrafts(selected)
  const changed = new Set([...dirtyIndexPaths, ...cachedDraftPaths])
  for (const [path, draft] of drafts)
    if (draft.pending || cachedPages.has(path)) changed.add(path)
  for (const path of changed) if (!cachedPages.has(path)) return null
  const updates: [string, CachedIndexPage<WorkspaceMetadataPage>][] = []
  let batch: string[] = []
  for (const path of changed) {
    batch.push(path)
    if (batch.length < 64) continue
    updates.push(
      ...(await readMetadataBatch(
        batch,
        selected,
        syntax,
        drafts,
        cachedPages,
        active,
      )),
    )
    batch = []
  }
  if (batch.length)
    updates.push(
      ...(await readMetadataBatch(
        batch,
        selected,
        syntax,
        drafts,
        cachedPages,
        active,
      )),
    )
  if (!active() || updates.length !== changed.size) return null
  return {
    pages: updates.map(([, cached]) => cached.page),
    commit() {
      if (!active()) return false
      for (const [path, cached] of updates) cachedPages.set(path, cached)
      cachedDraftPaths = new Set(
        [...drafts.keys()].filter((path) => cachedPages.has(path)),
      )
      dirtyIndexPaths = new Set()
      return true
    },
  }
}

import { isMarkdownDocument } from '../shared/document-types'
import { isDocumentName } from './document-types'
import { imageSources } from './images'
import { exportDocumentMedia } from './media'
