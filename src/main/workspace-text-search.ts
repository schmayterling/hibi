import { createHash, randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { app } from 'electron'
import type {
  OperationResult,
  WorkspaceTarget,
} from '../shared/foundation-contracts'
import type { SourceSnapshot } from '../shared/source-buffer.ts'
import {
  type QueryFailure,
  WORKSPACE_TEXT_QUERY_BYTES,
  type WorkspaceReferenceQueryRequest,
  type WorkspaceReferenceQueryResult,
  type WorkspaceTextMatch,
} from '../shared/workspace-query.ts'
import { getDocumentSourceFor, getDocumentTabs } from './document'
import { documentExtensions } from './document-types'
import {
  observeKnownWorkspaces,
  workspaceIndexCacheReady,
} from './recent-workspaces'
import {
  isCurrentWorkspaceTarget,
  listenWorkspaceChanges,
  workspaceChangeCursor,
  workspaceIndexRevision,
  workspaceRelativePath,
  workspaceRoot,
} from './workspace'
import type { OpenDocumentVersion } from './workspace-metadata-query'
import { showAllWorkspaceFiles } from './workspace-settings'
import { workspaceSyntax } from './workspace-syntax'
import type { WorkspaceTextPage } from './workspace-text-index'

type TextRequest = Extract<
  WorkspaceReferenceQueryRequest,
  { kind: 'search-text' }
>
type TextResult = Extract<
  WorkspaceReferenceQueryResult,
  { kind: 'search-text' }
> & {
  matches: readonly WorkspaceTextMatch[]
}
type Draft = { snapshot: SourceSnapshot; tabId: string }
type Session = {
  id: string
  owner: string
  group: string | null
  target: WorkspaceTarget
  sequence: number
  revision: number
  versions: string
  query: string
  includePaths: boolean
  cancel: Int32Array
  drafts: Map<string, Draft>
  client: SearchWorker
  used: number
}
const sessions = new Map<string, Session>()
const cursors = new Map<string, Session>()
const staleCursors = new Map<string, { scope: string; used: number }>()
const mcpCursorMs = 15 * 60_000
const cursorScope = (owner: string, query: string, target: WorkspaceTarget) =>
  createHash('sha256')
    .update(
      JSON.stringify([
        owner,
        query,
        target.workspaceId,
        target.workspaceGeneration,
      ]),
    )
    .digest('hex')
const groups = new Map<string, Session>()
const latestGroups = new Map<string, number>()
let requestGeneration = 0
let client: SearchWorker | null = null
let root = ''
let extensions = ''
let stopping: Promise<unknown> = Promise.resolve()

const changed = () => new Error('This search changed. Start again.')

class SearchWorker {
  private readonly worker: Worker
  private readonly ready: Promise<void>
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
    }
  >()
  private request = 0
  private termination: Promise<unknown> | null = null
  private readonly database: string
  private corrupt = false
  failed = false

  constructor(
    selected: string,
    workspaceId: string,
    showAllFiles: boolean,
    supported: string[],
  ) {
    this.database = join(
      app.getPath('userData'),
      'workspace-index-cache',
      workspaceId,
      'text-v1.sqlite',
    )
    this.worker = new Worker(
      join(app.getAppPath(), 'out/main/workspace-text-worker.js'),
      {
        workerData: {
          root: selected,
          database: this.database,
          extensions: supported,
          showAllFiles,
        },
        resourceLimits: { maxOldGenerationSizeMb: 128 },
      },
    )
    let resolveReady: () => void
    let rejectReady: (error: Error) => void
    this.ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    const fail = () => {
      this.failed = true
      rejectReady(changed())
      for (const request of this.pending.values()) request.reject(changed())
      this.pending.clear()
    }
    this.worker.on('error', fail)
    this.worker.on('exit', fail)
    this.worker.on('message', (message) => {
      if (message.type === 'ready') {
        resolveReady()
        if (!this.pending.size) this.worker.unref()
      } else if (message.type === 'draft') {
        if (this.failed) return
        let text: string | null = null
        let failed = true
        try {
          const session = sessions.get(message.query)
          const draft = session?.drafts.get(message.path)
          const current =
            draft &&
            (session?.includePaths
              ? draft.snapshot
              : getDocumentSourceFor(draft.tabId).snapshot())
          if (
            draft &&
            session &&
            current &&
            !Atomics.load(session.cancel, 0) &&
            isCurrentWorkspaceTarget(session.target) &&
            workspaceChangeCursor().sequence === session.sequence &&
            current.document.revision === draft.snapshot.document.revision &&
            current.version === draft.snapshot.version &&
            Number.isSafeInteger(message.offset) &&
            message.offset >= 0 &&
            message.offset <= draft.snapshot.utf16Length
          ) {
            text =
              message.offset === draft.snapshot.utf16Length
                ? null
                : draft.snapshot.sliceRaw(
                    message.offset,
                    Math.min(
                      draft.snapshot.utf16Length,
                      message.offset + 64 * 1024,
                    ),
                  )
            failed = false
          }
        } catch {}
        this.worker.postMessage({ type: 'draft', id: message.id, text, failed })
      } else if (message.type === 'reply') {
        const request = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.fatal) {
          this.corrupt = message.corrupt === true
          void this.stop()
        }
        if (message.failed) request?.reject(changed())
        else request?.resolve(message.value)
        if (!this.pending.size) this.worker.unref()
      }
    })
  }

  async call<T>(type: string, value: Record<string, unknown> = {}): Promise<T> {
    await this.ready
    if (this.failed) throw changed()
    this.worker.ref()
    const id = ++this.request
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject })
      this.worker.postMessage({ type, id, ...value })
    })
  }

  stop() {
    this.failed = true
    for (const pending of this.pending.values()) pending.reject(changed())
    this.pending.clear()
    this.termination ??= this.worker.terminate().then(async () => {
      if (this.corrupt)
        for (const suffix of ['', '-wal', '-shm'])
          await rm(this.database + suffix, { force: true }).catch(() => {})
    })
    return this.termination
  }
}

function release(session: Session) {
  Atomics.store(session.cancel, 0, 1)
  sessions.delete(session.id)
  if (session.group && groups.get(session.group) === session) {
    groups.delete(session.group)
    latestGroups.delete(session.group)
  }
  for (const [cursor, current] of cursors)
    if (current === session) {
      cursors.delete(cursor)
      if (session.includePaths)
        staleCursors.set(cursor, {
          scope: cursorScope(session.owner, session.query, session.target),
          used: session.used,
        })
    }
  if (session.id)
    void session.client.call('cancel', { queryId: session.id }).catch(() => {})
  session.drafts.clear()
}

function stop() {
  for (const session of groups.values()) release(session)
  for (const session of sessions.values()) release(session)
  cursors.clear()
  latestGroups.clear()
  if (client) stopping = Promise.all([stopping, client.stop()])
  client = null
  root = ''
  extensions = ''
}
app.on('before-quit', stop)
observeKnownWorkspaces((known) => {
  if (client && !known.some((item) => item.path === root)) stop()
  return stopping.then(() => {})
})
listenWorkspaceChanges((event) => {
  if (
    event.kind === 'resync' ||
    event.paths === null ||
    event.paths?.some(
      (path) => path === '.hibi/ignore' || path === '.hibiignore',
    )
  ) {
    stop()
    return
  }
  if (!client) return
  for (const session of sessions.values()) release(session)
  const current = client
  void current.call('invalidate', { paths: event.paths }).catch(() => {
    if (client === current) stop()
  })
})
const expiry = setInterval(() => {
  for (const session of sessions.values())
    if (
      Date.now() - session.used >
      (session.includePaths ? mcpCursorMs : 60_000)
    )
      release(session)
  for (const [cursor, old] of staleCursors)
    if (Date.now() - old.used > mcpCursorMs) staleCursors.delete(cursor)
}, 30_000)
expiry.unref()

function failure(
  code: QueryFailure,
  message: string,
): OperationResult<never, QueryFailure> {
  return { ok: false, code, message }
}

export async function queryWorkspaceText(
  input: unknown,
  getVersions: () => readonly OpenDocumentVersion[],
  owner = 'legacy',
  includePaths = false,
): Promise<OperationResult<TextResult, QueryFailure>> {
  if (!input || typeof input !== 'object')
    return failure('unsupported', 'Choose a workspace query.')
  const request = input as TextRequest
  if (!isCurrentWorkspaceTarget(request.target))
    return failure('stale', 'This workspace is no longer open.')
  if (
    typeof request.query !== 'string' ||
    !request.query.trim() ||
    request.query.length > WORKSPACE_TEXT_QUERY_BYTES ||
    Buffer.byteLength(request.query) > WORKSPACE_TEXT_QUERY_BYTES
  )
    return failure('unsupported', 'Use a search query of up to 256 KiB.')
  if (!workspaceSyntax(request.syntaxSnapshot))
    return failure('unsupported', 'Use a bounded Markdown syntax snapshot.')
  if (
    request.cursor !== undefined &&
    (typeof request.cursor !== 'string' || request.cursor.length > 64)
  )
    return failure('unsupported', 'Use a valid search cursor.')
  if ((input as Record<string, unknown>).offset !== undefined)
    return failure('unsupported', 'Use a valid search cursor.')
  if (
    request.searchId !== undefined &&
    (typeof request.searchId !== 'string' ||
      !request.searchId ||
      request.searchId.length > 128 ||
      request.searchId.includes('\0'))
  )
    return failure('unsupported', 'Use a valid search cursor.')
  if (request.cancel !== undefined && typeof request.cancel !== 'boolean')
    return failure('unsupported', 'Use a valid search cursor.')
  const limit = request.limit ?? 50
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    return failure('limit-exceeded', 'Use a page of 1 to 100 results.')
  const before = workspaceChangeCursor()
  const revision = workspaceIndexRevision()
  const selected = workspaceRoot()
  if (!selected || !isCurrentWorkspaceTarget(request.target))
    return failure('stale', 'This workspace changed. Try again.')
  const base = {
    target: request.target,
    syntax: 'gfm+wikilinks+hashtags' as const,
    flavorAware: true,
    unsupportedSyntax: false,
    sequence: before.sequence,
    stale: before.stale,
    capReached: false,
  }
  const group = request.searchId ? `${owner}:${request.searchId}` : null
  if (request.cancel) {
    if (!group) return failure('unsupported', 'Use a valid search cursor.')
    const old = groups.get(group)
    if (old) release(old)
    latestGroups.delete(group)
    return {
      ok: true,
      value: {
        ...base,
        kind: 'search-text',
        complete: true,
        items: [],
        matches: [],
        hasMore: false,
        nextCursor: null,
      },
    }
  }
  const versions = JSON.stringify(getVersions())
  const supported = documentExtensions()
  let session: Session | undefined
  if (request.cursor !== undefined) {
    session = cursors.get(request.cursor)
    if (!session && includePaths) {
      const old = staleCursors.get(request.cursor)
      if (
        old &&
        Date.now() - old.used <= mcpCursorMs &&
        old.scope === cursorScope(owner, request.query, request.target)
      )
        return failure('stale', 'This search changed. Start again.')
    }
    if (
      includePaths &&
      (!session ||
        session.owner !== owner ||
        session.query !== request.query ||
        session.includePaths !== includePaths ||
        session.target.workspaceId !== request.target.workspaceId ||
        session.target.workspaceGeneration !==
          request.target.workspaceGeneration)
    )
      return failure('unsupported', 'Use a valid search cursor.')
    if (
      !session ||
      session.owner !== owner ||
      session.query !== request.query ||
      session.includePaths !== includePaths ||
      session.target.workspaceId !== request.target.workspaceId ||
      session.target.workspaceGeneration !==
        request.target.workspaceGeneration ||
      session.sequence !== before.sequence ||
      session.revision !== revision ||
      (!includePaths && session.versions !== versions) ||
      Date.now() - session.used > (session.includePaths ? mcpCursorMs : 60_000)
    ) {
      if (session?.owner === owner) release(session)
      return failure('stale', 'This search changed. Start again.')
    }
    cursors.delete(request.cursor)
  }
  try {
    if (!session) {
      if (group) {
        const old = groups.get(group)
        if (old) release(old)
      }
      const generation = ++requestGeneration
      if (group) latestGroups.set(group, generation)
      const showAllFiles = await showAllWorkspaceFiles()
      const key = JSON.stringify([supported, showAllFiles])
      if (group && latestGroups.get(group) !== generation) throw changed()
      if (
        client &&
        (root !== selected || extensions !== key || client.failed)
      ) {
        stop()
        if (group) latestGroups.set(group, generation)
      }
      if (!client) {
        await stopping
        await workspaceIndexCacheReady()
        const current = client as SearchWorker | null
        if (
          !isCurrentWorkspaceTarget(request.target) ||
          workspaceChangeCursor().sequence !== before.sequence ||
          workspaceIndexRevision() !== revision ||
          (group && latestGroups.get(group) !== generation) ||
          (current &&
            (root !== selected || extensions !== key || current.failed))
        )
          throw changed()
        if (!client) {
          root = selected
          extensions = key
          client = new SearchWorker(
            selected,
            request.target.workspaceId,
            showAllFiles,
            supported,
          )
        }
      }
      const dirty = new Set(
        getDocumentTabs()
          .filter((tab) => tab.dirty)
          .map((tab) => tab.id),
      )
      const drafts = new Map<string, Draft>()
      for (const version of getVersions()) {
        const path = workspaceRelativePath(version.file)
        if (path && dirty.has(version.tabId))
          drafts.set(path, {
            tabId: version.tabId,
            snapshot: getDocumentSourceFor(version.tabId).snapshot(),
          })
      }
      session = {
        id: '',
        owner,
        group,
        target: request.target,
        sequence: before.sequence,
        revision,
        versions,
        query: request.query,
        includePaths,
        cancel: new Int32Array(new SharedArrayBuffer(4)),
        drafts,
        client,
        used: Date.now(),
      }
      if (group) groups.set(group, session)
      session.id = await client.call<string>('begin', {
        query: request.query,
        drafts: [...drafts.keys()],
        includePaths,
        cancel: session.cancel.buffer,
      })
      sessions.set(session.id, session)
    }
    const result = await session.client.call<WorkspaceTextPage>('page', {
      queryId: session.id,
      limit,
    })
    if (
      Atomics.load(session.cancel, 0) ||
      !isCurrentWorkspaceTarget(request.target) ||
      workspaceChangeCursor().sequence !== before.sequence ||
      workspaceIndexRevision() !== revision ||
      (!includePaths && JSON.stringify(getVersions()) !== versions)
    )
      throw changed()
    session.used = Date.now()
    let nextCursor: string | null = null
    if (result.hasMore) {
      nextCursor = randomUUID()
      cursors.set(nextCursor, session)
    } else release(session)
    return {
      ok: true,
      value: {
        ...base,
        kind: 'search-text',
        items: result.matches.map((match) => match.path),
        matches: result.matches,
        hasMore: result.hasMore,
        nextCursor,
        complete: result.complete && before.complete && !before.stale,
      },
    }
  } catch {
    if (session) release(session)
    return failure('stale', 'This search changed. Start again.')
  }
}
