import type { OperationResult, WorkspaceTarget } from './foundation-contracts'
import { DetailReader } from './metadata-stream.ts'
import type { NoteCacheEntry } from './note-cache'
import type {
  QueryFailure,
  WorkspaceReferenceQueryRequest,
  WorkspaceReferenceQueryResult,
  WorkspaceSyntaxSnapshot,
} from './workspace-query'

export type NoteMetadataRequest = {
  readonly target: WorkspaceTarget
  readonly path: string
  readonly syntaxSnapshot?: WorkspaceSyntaxSnapshot
}
type Query = (
  request: WorkspaceReferenceQueryRequest,
) => Promise<OperationResult<WorkspaceReferenceQueryResult, QueryFailure>>

/** Yield one requested note's metadata, releasing each completed entry before the next page. */
export async function* iterateNoteMetadata(
  query: Query,
  request: NoteMetadataRequest,
): AsyncGenerator<NoteCacheEntry> {
  const reader = new DetailReader()
  let cursor: string | undefined
  let sequence: number | undefined
  let version: string | undefined
  const seen = new Set<string>()
  do {
    const result = await query({
      ...request,
      kind: 'metadata',
      ...(cursor ? { cursor } : {}),
    })
    if (!result.ok)
      throw Object.assign(new Error(result.message), { code: result.code })
    const page = result.value
    if (
      page.kind !== 'metadata' ||
      page.path !== request.path ||
      page.stale ||
      page.target.workspaceId !== request.target.workspaceId ||
      page.target.workspaceGeneration !== request.target.workspaceGeneration ||
      (sequence !== undefined && page.sequence !== sequence) ||
      (version !== undefined && page.version !== version)
    )
      throw new Error('This note metadata changed. Start again.')
    sequence = page.sequence
    version = page.version
    yield* reader.write(page.tokens)
    if (!page.hasMore) {
      if (page.nextCursor !== null) throw new Error('Invalid metadata cursor.')
      reader.finish()
      return
    }
    if (!page.nextCursor || seen.has(page.nextCursor))
      throw new Error('Invalid metadata cursor.')
    cursor = page.nextCursor
    seen.add(cursor)
  } while (cursor)
}
