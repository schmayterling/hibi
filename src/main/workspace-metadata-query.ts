import { randomUUID } from 'node:crypto'
import type {
  OperationResult,
  WorkspaceTarget,
} from '../shared/foundation-contracts'
import type { PropertyScalar } from '../shared/note-metadata.ts'
import type {
  QueryFailure,
  WorkspaceReferenceQueryBase,
  WorkspaceReferenceQueryResult,
} from '../shared/workspace-query.ts'
import {
  indexWorkspace,
  isCurrentWorkspaceTarget,
  subscribeWorkspaceChanges,
  workspaceChangeCursor,
  workspaceIndexRevision,
} from './workspace'
import {
  type GraphPosition,
  type TextSearchPosition,
  WorkspaceReferenceIndex,
} from './workspace-reference-index'
import { workspaceSyntax } from './workspace-syntax'

const references = new WorkspaceReferenceIndex()
type SearchCursorState = {
  target: WorkspaceTarget
  sequence: number
  revision: number
  sourceVersions: string
  query: string
  position: TextSearchPosition
}
const searchCursors = new Map<string, SearchCursorState>()
type GraphCursorState = Omit<SearchCursorState, 'query' | 'position'> & {
  syntaxFingerprint: string
  position: GraphPosition
}
const graphCursors = new Map<string, GraphCursorState>()
let indexedTarget: WorkspaceTarget | null = null
let indexedSequence = -1
let indexedRevision = -1
let indexedSourceVersions = ''
let indexedSyntaxFingerprint = ''
let requestedSyntaxFingerprint = ''

function hasIndexedSnapshot(
  target: WorkspaceTarget,
  sequence: number,
  revision: number,
  sourceVersions: string,
  syntaxFingerprint: string,
): boolean {
  return (
    indexedTarget?.workspaceId === target.workspaceId &&
    indexedTarget.workspaceGeneration === target.workspaceGeneration &&
    indexedSequence === sequence &&
    indexedRevision === revision &&
    indexedSourceVersions === sourceVersions &&
    indexedSyntaxFingerprint === syntaxFingerprint
  )
}

function clearCache(): void {
  references.clear()
  searchCursors.clear()
  graphCursors.clear()
  indexedTarget = null
  indexedSequence = -1
  indexedRevision = -1
  indexedSourceVersions = ''
  indexedSyntaxFingerprint = ''
  requestedSyntaxFingerprint = ''
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
    kind !== 'tags' &&
    kind !== 'search-tags' &&
    kind !== 'graph' &&
    kind !== 'property' &&
    kind !== 'headings' &&
    kind !== 'search-paths' &&
    kind !== 'search-text'
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
    kind === 'search-tags' &&
    (typeof request.query !== 'string' || request.query.length > 128)
  )
    return failure(
      'unsupported',
      'Choose a tag search of up to 128 characters.',
    )
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
    (kind === 'search-paths' || kind === 'search-text') &&
    (typeof request.query !== 'string' ||
      !request.query.trim() ||
      request.query.length > (kind === 'search-text' ? 128 : 256))
  )
    return failure(
      'unsupported',
      `Choose a search of 1 to ${kind === 'search-text' ? 128 : 256} characters.`,
    )
  if (
    kind === 'search-text' &&
    (request.offset !== undefined ||
      (request.cursor !== undefined &&
        (typeof request.cursor !== 'string' || request.cursor.length > 64)))
  )
    return failure('unsupported', 'Use a valid search cursor.')
  if (
    kind === 'graph' &&
    (request.offset !== undefined ||
      (request.cursor !== undefined &&
        (typeof request.cursor !== 'string' || request.cursor.length > 64)))
  )
    return failure('unsupported', 'Use a valid graph cursor.')
  const syntax = workspaceSyntax(request.syntaxSnapshot)
  if (!syntax)
    return failure('unsupported', 'Use a bounded Markdown syntax snapshot.')
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
    if (
      kind !== 'search-text' &&
      kind !== 'graph' &&
      request.offset !== undefined
    ) {
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
  requestedSyntaxFingerprint = syntax.fingerprint
  const refresh = !hasIndexedSnapshot(
    target,
    before.sequence,
    revision,
    sourceVersions,
    syntax.fingerprint,
  )
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
    requestedSyntaxFingerprint !== syntax.fingerprint ||
    (refresh && index?.workspace.id !== target.workspaceId)
  )
    return failure('stale', 'This workspace changed. Try again.')
  if (
    index &&
    !hasIndexedSnapshot(
      target,
      after.sequence,
      revision,
      sourceVersions,
      syntax.fingerprint,
    )
  ) {
    const sourceChanged =
      indexedTarget?.workspaceId !== target.workspaceId ||
      indexedTarget.workspaceGeneration !== target.workspaceGeneration ||
      indexedSequence !== after.sequence ||
      indexedRevision !== revision ||
      indexedSourceVersions !== sourceVersions
    references.apply(target, index.pages, syntax.page)
    if (sourceChanged) searchCursors.clear()
    graphCursors.clear()
    indexedTarget = target
    indexedSequence = after.sequence
    indexedRevision = revision
    indexedSourceVersions = sourceVersions
    indexedSyntaxFingerprint = syntax.fingerprint
  }
  if (pathRequired && !references.has(path as string))
    return failure('not-found', 'This document is not in the workspace index.')
  const base: WorkspaceReferenceQueryBase = {
    target,
    syntax: 'gfm+wikilinks+hashtags',
    flavorAware: syntax.flavorAware,
    unsupportedSyntax: references.hasUnsupportedSyntax(),
    sequence: after.sequence,
    stale: after.stale,
    complete: after.complete && references.isComplete(),
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
  if (kind === 'tags' || kind === 'search-tags') {
    const result = references.tags(
      offset,
      limit,
      kind === 'search-tags'
        ? (request.query as string).normalize('NFC').toLowerCase()
        : undefined,
    )
    return {
      ok: true,
      value: {
        ...base,
        kind,
        items: result.items,
        hasMore: result.hasMore,
        nextOffset: result.nextOffset,
        complete: base.complete && !result.capReached,
        capReached: base.capReached || result.capReached,
      },
    }
  }
  if (kind === 'graph') {
    let position: GraphPosition = {
      pathIndex: 0,
      targetIndex: 0,
      nodeEmitted: false,
      emitted: 0,
    }
    if (request.cursor !== undefined) {
      const old = graphCursors.get(request.cursor as string)
      if (
        !old ||
        old.target.workspaceId !== target.workspaceId ||
        old.target.workspaceGeneration !== target.workspaceGeneration ||
        old.sequence !== after.sequence ||
        old.revision !== revision ||
        old.sourceVersions !== sourceVersions ||
        old.syntaxFingerprint !== syntax.fingerprint
      )
        return failure('stale', 'This graph changed. Start again.')
      graphCursors.delete(request.cursor as string)
      position = old.position
    }
    const result = references.graph(position, limit)
    let nextCursor: string | null = null
    if (result.hasMore) {
      nextCursor = randomUUID()
      if (graphCursors.size >= 16)
        graphCursors.delete(graphCursors.keys().next().value as string)
      graphCursors.set(nextCursor, {
        target,
        sequence: after.sequence,
        revision,
        sourceVersions,
        syntaxFingerprint: syntax.fingerprint,
        position: result.position,
      })
    }
    return {
      ok: true,
      value: {
        ...base,
        kind,
        items: result.items,
        hasMore: result.hasMore,
        nextCursor,
        complete: base.complete && !result.hasMore && !result.capReached,
        capReached: base.capReached || result.capReached,
      },
    }
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
        complete: after.complete,
        unsupportedSyntax: false,
        kind,
        ...references.searchPaths(request.query as string, offset, limit),
      },
    }
  if (kind === 'search-text') {
    let position: TextSearchPosition = { pathIndex: 0, sourceOffset: 0 }
    if (request.cursor !== undefined) {
      const old = searchCursors.get(request.cursor as string)
      if (
        !old ||
        old.target.workspaceId !== target.workspaceId ||
        old.target.workspaceGeneration !== target.workspaceGeneration ||
        old.sequence !== after.sequence ||
        old.revision !== revision ||
        old.sourceVersions !== sourceVersions ||
        old.query !== request.query
      )
        return failure('stale', 'This search changed. Start again.')
      searchCursors.delete(request.cursor as string)
      position = old.position
    }
    const result = references.searchText(
      request.query as string,
      position,
      limit,
    )
    let nextCursor: string | null = null
    if (result.hasMore) {
      nextCursor = randomUUID()
      if (searchCursors.size >= 16)
        searchCursors.delete(searchCursors.keys().next().value as string)
      searchCursors.set(nextCursor, {
        target,
        sequence: after.sequence,
        revision,
        sourceVersions,
        query: request.query as string,
        position: result.position,
      })
    }
    return {
      ok: true,
      value: {
        ...base,
        unsupportedSyntax: false,
        kind,
        items: result.items,
        hasMore: result.hasMore,
        nextCursor,
        complete: after.complete && !result.hasMore,
      },
    }
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
