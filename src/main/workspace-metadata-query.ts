import type {
  OperationResult,
  WorkspaceTarget,
} from '../shared/foundation-contracts'
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
  const path = request.path
  if (typeof path !== 'string' || !path || path.length > 4096)
    return failure('unsupported', 'Choose a document in this workspace.')
  const kind = request.kind
  if (kind !== 'links' && kind !== 'backlinks' && kind !== 'resolve')
    return failure('unsupported', 'This workspace query is not supported.')
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
  if (!references.has(path))
    return failure('not-found', 'This document is not in the workspace index.')
  const base: QueryBase = {
    target,
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
        from: path,
        resolved: references.resolve(
          path,
          request.href as string,
          request.syntax as 'markdown' | 'wiki',
        ),
      },
    }
  return {
    ok: true,
    value: {
      ...base,
      kind,
      path,
      ...(kind === 'links'
        ? references.links(path, offset, limit)
        : references.backlinks(path, offset, limit)),
    },
  }
}
