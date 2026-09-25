import type { WorkspaceTarget } from '../shared/foundation-contracts'
import type {
  WorkspaceEntry,
  WorkspaceEntryPageRequest,
  WorkspaceEntryPageResult,
  WorkspaceListedEntry,
} from '../shared/workspace'
import type { WorkspaceStreamCursor } from './workspace-change-stream'

export const MAX_WORKSPACE_PAGE_ENTRIES = 200
export const MAX_WORKSPACE_PAGE_BYTES = 64 * 1024

const stale = (): WorkspaceEntryPageResult => ({
  ok: false,
  code: 'stale',
  message: 'This workspace is no longer open.',
})

const resync = (): WorkspaceEntryPageResult => ({
  ok: false,
  code: 'resync-needed',
  message: 'The workspace changed. Start listing again from the first page.',
})

const limitExceeded = (message: string): WorkspaceEntryPageResult => ({
  ok: false,
  code: 'limit-exceeded',
  message,
})

function cursorFor(
  target: WorkspaceTarget,
  sequence: number,
  offset: number,
): string {
  return JSON.stringify([
    target.workspaceId,
    target.workspaceGeneration,
    sequence,
    offset,
  ])
}

function cursorOffset(
  value: string,
  target: WorkspaceTarget,
  sequence: number,
): number | null {
  if (value.length > 256) return null
  try {
    const cursor: unknown = JSON.parse(value)
    if (
      !Array.isArray(cursor) ||
      cursor.length !== 4 ||
      cursor[0] !== target.workspaceId ||
      cursor[1] !== target.workspaceGeneration ||
      cursor[2] !== sequence ||
      !Number.isSafeInteger(cursor[3]) ||
      cursor[3] < 0
    )
      return null
    return cursor[3]
  } catch {
    return null
  }
}

function* flatEntries(
  entries: readonly WorkspaceEntry[],
): Generator<WorkspaceListedEntry> {
  for (const entry of entries) {
    yield { path: entry.path, name: entry.name, kind: entry.kind }
    if (entry.children) yield* flatEntries(entry.children)
  }
}

/** Page the retained tree at one stream sequence; never clone or send the full tree. */
export function pageWorkspaceEntries(
  entries: readonly WorkspaceEntry[],
  snapshot: WorkspaceStreamCursor,
  request: WorkspaceEntryPageRequest,
): WorkspaceEntryPageResult {
  const target = snapshot.target
  if (
    !target ||
    !request?.target ||
    request.target.workspaceId !== target.workspaceId ||
    request.target.workspaceGeneration !== target.workspaceGeneration
  )
    return stale()

  const limit = request.limit ?? 100
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_WORKSPACE_PAGE_ENTRIES
  )
    return limitExceeded('Choose a page size from 1 to 200 entries.')
  if (request.sequence !== undefined && request.sequence !== snapshot.sequence)
    return resync()
  const offset =
    request.cursor === undefined
      ? 0
      : typeof request.cursor === 'string'
        ? cursorOffset(request.cursor, target, snapshot.sequence)
        : null
  if (offset === null) return resync()

  const result: WorkspaceListedEntry[] = []
  const header = {
    target,
    sequence: snapshot.sequence,
    stale: snapshot.stale,
    complete: snapshot.complete,
    capReached: snapshot.capReached,
  }
  const headerBytes = Buffer.byteLength(
    JSON.stringify({
      ...header,
      entries: [],
      nextCursor: cursorFor(target, snapshot.sequence, Number.MAX_SAFE_INTEGER),
    }),
  )
  let bytes = headerBytes
  let index = 0
  for (const entry of flatEntries(entries)) {
    if (index++ < offset) continue
    if (result.length === limit) {
      return {
        ok: true,
        value: {
          ...header,
          entries: result,
          nextCursor: cursorFor(target, snapshot.sequence, index - 1),
        },
      }
    }
    const nextBytes =
      bytes +
      Buffer.byteLength(JSON.stringify(entry)) +
      Number(result.length > 0)
    if (nextBytes > MAX_WORKSPACE_PAGE_BYTES) {
      if (!result.length)
        return limitExceeded('This path exceeds the 64 KiB page limit.')
      return {
        ok: true,
        value: {
          ...header,
          entries: result,
          nextCursor: cursorFor(target, snapshot.sequence, index - 1),
        },
      }
    }
    result.push(entry)
    bytes = nextBytes
  }
  if (offset > index) return resync()
  return { ok: true, value: { ...header, entries: result, nextCursor: null } }
}
