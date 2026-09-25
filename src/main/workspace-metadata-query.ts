import type {
  OperationResult,
  WorkspaceTarget,
} from '../shared/foundation-contracts'
import type { NoteHeading, PropertyScalar } from '../shared/note-metadata.ts'
import {
  indexWorkspace,
  isCurrentWorkspaceTarget,
  subscribeWorkspaceChanges,
  workspaceChangeCursor,
  workspaceIndexRevision,
} from './workspace'
import { WorkspaceReferenceIndex } from './workspace-reference-index'

type QueryFailure = 'stale' | 'not-found' | 'limit-exceeded' | 'unsupported'

interface QueryBase {
  readonly target: WorkspaceTarget
  /** This slice interprets standard GFM, independent of optional addon flavors. */
  readonly syntax: 'gfm'
  readonly sequence: number
  readonly stale: boolean
  readonly complete: boolean
  readonly capReached: boolean
}

export type WorkspaceReferenceQueryResult = QueryBase &
  (
    | {
        readonly kind: 'links' | 'backlinks'
        readonly path: string
        readonly items: readonly string[]
        readonly hasMore: boolean
        readonly nextOffset: number
      }
    | {
        readonly kind: 'tag' | 'search-paths' | 'property'
        readonly items: readonly string[]
        readonly hasMore: boolean
        readonly nextOffset: number
        readonly metadataComplete?: boolean
      }
    | {
        readonly kind: 'headings'
        readonly path: string
        readonly items: readonly NoteHeading[]
        readonly hasMore: boolean
        readonly nextOffset: number
      }
    | {
        readonly kind: 'resolve'
        readonly from: string
        readonly resolved: string | null
      }
  )

const references = new WorkspaceReferenceIndex()
let indexedTarget: WorkspaceTarget | null = null
let indexedSequence = -1
let indexedRevision = -1
let indexedSourceVersions = ''

function clearCache(): void {
  references.clear()
  indexedTarget = null
  indexedSequence = -1
  indexedRevision = -1
  indexedSourceVersions = ''
}

const subscription = subscribeWorkspaceChanges((event) => {
  if (event.kind === 'resync') clearCache()
})

export function disposeWorkspaceReferenceQueries(): void {
  subscription.dispose()
  clearCache()
}

export interface OpenDocumentVersion {
  readonly file: string
  readonly tabId: string
  readonly contentVersion: number
}

function versionKey(versions: readonly OpenDocumentVersion[]): string {
  return JSON.stringify(
    versions
      .map(({ file, tabId, contentVersion }) => [file, tabId, contentVersion])
      .sort(
        ([leftPath, leftTab], [rightPath, rightTab]) =>
          String(leftPath).localeCompare(String(rightPath)) ||
          String(leftTab).localeCompare(String(rightTab)),
      ),
  )
}

const failure = (
  code: QueryFailure,
  message: string,
): OperationResult<never, QueryFailure> => ({ ok: false, code, message })

/** Main-process queries reuse indexWorkspace's pages and dirty document overlay. */
export async function queryWorkspaceReferences(
  input: unknown,
  getOpenDocumentVersions: () => readonly OpenDocumentVersion[],
): Promise<OperationResult<WorkspaceReferenceQueryResult, QueryFailure>> {
  if (!input || typeof input !== 'object')
    return failure('unsupported', 'Choose a workspace query.')
  const request = input as Record<string, unknown>
  const target = request.target
  if (!isCurrentWorkspaceTarget(target))
    return failure('stale', 'This workspace is no longer open.')
  const kind = request.kind
  if (
    kind !== 'links' &&
    kind !== 'backlinks' &&
    kind !== 'resolve' &&
    kind !== 'tag' &&
    kind !== 'property' &&
    kind !== 'headings' &&
    kind !== 'search-paths'
  )
    return failure('unsupported', 'This workspace query is not supported.')
  const path = request.path
  const pathRequired =
    kind === 'links' ||
    kind === 'backlinks' ||
    kind === 'resolve' ||
    kind === 'headings'
  if (pathRequired && (typeof path !== 'string' || !path || path.length > 4096))
    return failure('unsupported', 'Choose a document in this workspace.')
  if (
    kind === 'tag' &&
    (typeof request.tag !== 'string' ||
      request.tag.length > 128 ||
      !/^[\p{L}\p{N}_-]+(?:\/[\p{L}\p{N}_-]+)*$/u.test(request.tag) ||
      !/[\p{L}_]/u.test(request.tag))
  )
    return failure('unsupported', 'Choose a valid tag.')
  if (
    kind === 'property' &&
    (typeof request.key !== 'string' ||
      !request.key ||
      request.key.length > 128 ||
      !(
        request.value === null ||
        typeof request.value === 'boolean' ||
        (typeof request.value === 'number' && Number.isFinite(request.value)) ||
        (typeof request.value === 'string' &&
          Buffer.byteLength(request.value) <= 4096)
      ))
  )
    return failure('unsupported', 'Choose a bounded property predicate.')
  if (
    kind === 'search-paths' &&
    (typeof request.query !== 'string' ||
      !request.query.trim() ||
      request.query.length > 256)
  )
    return failure(
      'unsupported',
      'Choose a path search of 1 to 256 characters.',
    )
  let offset = 0
  let limit = 50
  if (kind === 'resolve') {
    if (
      typeof request.href !== 'string' ||
      !request.href ||
      request.href.length > 4096 ||
      (request.syntax !== 'markdown' && request.syntax !== 'wiki')
    )
      return failure('unsupported', 'Choose a valid link target.')
  } else {
    if (request.offset !== undefined) {
      if (typeof request.offset !== 'number')
        return failure('unsupported', 'Choose a numeric query offset.')
      offset = request.offset
    }
    if (request.limit !== undefined) {
      if (typeof request.limit !== 'number')
        return failure('unsupported', 'Choose a numeric query limit.')
      limit = request.limit
    }
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > 2000 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      return failure('limit-exceeded', 'Use a page of 1 to 100 results.')
  }
  const before = workspaceChangeCursor()
  const revision = workspaceIndexRevision()
  const sourceVersions = versionKey(getOpenDocumentVersions())
  if (
    before.target?.workspaceId !== target.workspaceId ||
    before.target.workspaceGeneration !== target.workspaceGeneration
  )
    return failure('stale', 'This workspace changed. Try again.')
  const refresh =
    indexedTarget?.workspaceId !== target.workspaceId ||
    indexedTarget.workspaceGeneration !== target.workspaceGeneration ||
    indexedSequence !== before.sequence ||
    indexedRevision !== revision ||
    indexedSourceVersions !== sourceVersions
  let index: Awaited<ReturnType<typeof indexWorkspace>> = null
  if (refresh)
    try {
      index = await indexWorkspace()
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes('index up to 2,000 documents')
      )
        return failure('limit-exceeded', error.message)
      throw error
    }
  const after = workspaceChangeCursor()
  if (
    !isCurrentWorkspaceTarget(target) ||
    after.target?.workspaceId !== target.workspaceId ||
    after.target.workspaceGeneration !== target.workspaceGeneration ||
    before.sequence !== after.sequence ||
    revision !== workspaceIndexRevision() ||
    sourceVersions !== versionKey(getOpenDocumentVersions()) ||
    (refresh && index?.workspace.id !== target.workspaceId)
  )
    return failure('stale', 'This workspace changed. Try again.')
  if (index) {
    references.apply(target, index.pages)
    indexedTarget = target
    indexedSequence = after.sequence
    indexedRevision = revision
    indexedSourceVersions = sourceVersions
  }
  if (pathRequired && !references.has(path as string))
    return failure('not-found', 'This document is not in the workspace index.')
  const base: QueryBase = {
    target,
    syntax: 'gfm',
    sequence: after.sequence,
    stale: after.stale,
    complete: after.complete,
    capReached: after.capReached,
  }
  if (kind === 'resolve')
    return {
      ok: true,
      value: {
        ...base,
        kind,
        from: path as string,
        resolved: references.resolve(
          path as string,
          request.href as string,
          request.syntax as 'markdown' | 'wiki',
        ),
      },
    }
  if (kind === 'tag')
    return {
      ok: true,
      value: {
        ...base,
        kind,
        ...references.tagged(
          (request.tag as string).normalize('NFC').toLowerCase(),
          offset,
          limit,
        ),
      },
    }
  if (kind === 'property') {
    const result = references.property(
      request.key as string,
      request.value as PropertyScalar,
      offset,
      limit,
    )
    return {
      ok: true,
      value: {
        ...base,
        kind,
        items: result.items,
        hasMore: result.hasMore,
        nextOffset: result.nextOffset,
        complete: base.complete && result.complete,
        metadataComplete: result.complete,
      },
    }
  }
  if (kind === 'search-paths')
    return {
      ok: true,
      value: {
        ...base,
        kind,
        ...references.searchPaths(request.query as string, offset, limit),
      },
    }
  if (kind === 'headings') {
    const result = references.headings(path as string, offset, limit)
    return {
      ok: true,
      value: {
        ...base,
        kind,
        path: path as string,
        items: result.items,
        hasMore: result.hasMore,
        nextOffset: result.nextOffset,
        complete: base.complete && result.complete,
      },
    }
  }
  return {
    ok: true,
    value: {
      ...base,
      kind,
      path: path as string,
      ...(kind === 'links'
        ? references.links(path as string, offset, limit)
        : references.backlinks(path as string, offset, limit)),
    },
  }
}
