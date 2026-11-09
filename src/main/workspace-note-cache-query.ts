import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type {
  OperationResult,
  WorkspaceTarget,
} from '../shared/foundation-contracts'
import { resolveHeadingSubpath } from '../shared/heading-anchor'
import { DetailReader } from '../shared/metadata-stream'
import type { NoteCacheEntry } from '../shared/note-cache'
import type {
  QueryFailure,
  WorkspaceNoteSubpath,
  WorkspaceReferenceQueryBase,
  WorkspaceReferenceQueryResult,
} from '../shared/workspace-query'
import {
  isCurrentWorkspaceTarget,
  listenWorkspaceChanges,
  workspaceChangeCursor,
  workspaceIndexRevision,
  workspaceMetadataDetails,
  workspaceRoot,
} from './workspace'
import type { OpenDocumentVersion } from './workspace-metadata-query'
import { workspaceSyntax } from './workspace-syntax'

type Cursor = {
  owner: string
  path: string
  workspaceId: string
  generation: number
  sequence: number
  revision: number
  syntax: string
  versions: string
  offset: number
  source: string
  version: string
}
const cursors = new Map<string, Cursor>()
listenWorkspaceChanges((event) => {
  if (event.kind === 'resync') cursors.clear()
})
const failure = (
  code: QueryFailure,
  message: string,
): OperationResult<never, QueryFailure> => ({ ok: false, code, message })
const validPath = (path: unknown): path is string =>
  typeof path === 'string' &&
  path.length > 0 &&
  path.length <= 4096 &&
  !/[\\\p{Cc}]/u.test(path) &&
  !/^[a-z]:/i.test(path) &&
  path.split('/').every((part) => part && !part.startsWith('.'))

/** Per-note demand reads use the worker directly, without building a whole-workspace graph. */
export async function queryWorkspaceNoteMetadata(
  input: unknown,
  versions: () => readonly OpenDocumentVersion[],
  owner: string,
): Promise<OperationResult<WorkspaceReferenceQueryResult, QueryFailure>> {
  if (!input || typeof input !== 'object')
    return failure('unsupported', 'Choose a note metadata query.')
  const request = input as Record<string, unknown>
  const target = request.target
  if (!isCurrentWorkspaceTarget(target))
    return failure('stale', 'This workspace is no longer open.')
  if (!validPath(request.path))
    return failure('unsupported', 'Choose a document in this workspace.')
  const kind = request.kind
  if (kind !== 'metadata' && kind !== 'resolve-subpath')
    return failure('unsupported', 'Choose a note metadata query.')
  if (
    request.cursor !== undefined &&
    (kind !== 'metadata' ||
      typeof request.cursor !== 'string' ||
      request.cursor.length > 64)
  )
    return failure('unsupported', 'Use a valid metadata cursor.')
  if (
    kind === 'resolve-subpath' &&
    (typeof request.subpath !== 'string' ||
      !request.subpath ||
      request.subpath.length > 4096)
  )
    return failure('unsupported', 'Choose a heading or block reference.')
  const syntax = workspaceSyntax(request.syntaxSnapshot)
  if (!syntax)
    return failure('unsupported', 'Use a bounded Markdown syntax snapshot.')
  const path = request.path
  const captured = target as WorkspaceTarget
  const before = workspaceChangeCursor()
  const revision = workspaceIndexRevision()
  const nativePath = join(workspaceRoot() ?? '', path)
  const versionKey = () =>
    JSON.stringify(versions().filter(({ file }) => file === nativePath))
  const sourceVersions = versionKey()
  const current = () =>
    isCurrentWorkspaceTarget(captured) &&
    workspaceChangeCursor().sequence === before.sequence &&
    workspaceIndexRevision() === revision &&
    versionKey() === sourceVersions
  let old: Cursor | undefined
  if (typeof request.cursor === 'string') {
    old = cursors.get(request.cursor)
    if (
      !old ||
      old.owner !== owner ||
      old.path !== path ||
      old.workspaceId !== captured.workspaceId ||
      old.generation !== captured.workspaceGeneration ||
      old.sequence !== before.sequence ||
      old.revision !== revision ||
      old.syntax !== syntax.fingerprint ||
      old.versions !== sourceVersions
    )
      return failure('stale', 'This note metadata changed. Start again.')
  }
  let offset = old?.offset ?? 0
  let identity = old?.source
  let version = old?.version
  const reader = kind === 'resolve-subpath' ? new DetailReader() : null
  const headings: Extract<NoteCacheEntry, { kind: 'heading' }>['value'][] = []
  let resolved: WorkspaceNoteSubpath | null = null
  let subpath = ''
  if (kind === 'resolve-subpath') {
    try {
      subpath = decodeURIComponent(
        (request.subpath as string).replace(/^#/, ''),
      )
    } catch {
      return failure('unsupported', 'Use a valid heading or block reference.')
    }
  }
  while (current()) {
    const page = await workspaceMetadataDetails(path, syntax, offset, current)
    if (!current())
      return failure('stale', 'This note metadata changed. Start again.')
    if (!page)
      return failure('not-found', 'This document has no indexed metadata.')
    const source = JSON.stringify(page.source)
    if (
      identity !== undefined &&
      (identity !== source || version !== page.version)
    )
      return failure('stale', 'This note metadata changed. Start again.')
    identity = source
    version = page.version
    const base: WorkspaceReferenceQueryBase = {
      target: captured,
      syntax: 'gfm+wikilinks+hashtags',
      flavorAware: syntax.flavorAware,
      unsupportedSyntax: !page.complete,
      sequence: before.sequence,
      stale: before.stale,
      complete: page.complete && syntax.flavorAware && !before.stale,
      capReached: false,
    }
    if (kind === 'metadata') {
      if (typeof request.cursor === 'string') cursors.delete(request.cursor)
      let nextCursor: string | null = null
      if (page.hasMore) {
        if (page.nextCursor <= offset)
          return failure('stale', 'This note metadata changed. Start again.')
        nextCursor = randomUUID()
        if (cursors.size >= 32)
          cursors.delete(cursors.keys().next().value as string)
        cursors.set(nextCursor, {
          owner,
          path,
          workspaceId: captured.workspaceId,
          generation: captured.workspaceGeneration,
          sequence: before.sequence,
          revision,
          syntax: syntax.fingerprint,
          versions: sourceVersions,
          offset: page.nextCursor,
          source,
          version: page.version,
        })
      }
      return {
        ok: true,
        value: {
          ...base,
          kind,
          path,
          version: page.version,
          tokens: page.tokens,
          nextCursor,
          hasMore: page.hasMore,
        },
      }
    }
    for (const entry of reader!.write(page.tokens)) {
      if (entry.kind === 'block' && subpath === '^' + entry.value.id)
        resolved ??= {
          type: 'block',
          id: entry.value.id,
          position: entry.value.position,
        }
      if (entry.kind === 'heading' && !subpath.startsWith('^'))
        headings.push(entry.value)
    }
    if (resolved)
      return {
        ok: true,
        value: { ...base, kind, path, version: page.version, resolved },
      }
    if (!page.hasMore) {
      reader!.finish()
      if (!subpath.startsWith('^')) {
        const heading = resolveHeadingSubpath(headings, subpath)
        if (heading)
          resolved = {
            type: 'heading',
            id: heading.anchor,
            position: headings[heading.index]!.position,
          }
      }
      return {
        ok: true,
        value: { ...base, kind, path, version: page.version, resolved },
      }
    }
    if (page.nextCursor <= offset)
      return failure('stale', 'This note metadata changed. Start again.')
    offset = page.nextCursor
  }
  return failure('stale', 'This note metadata changed. Start again.')
}
