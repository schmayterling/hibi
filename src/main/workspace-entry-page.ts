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

type Frame = { entries: readonly WorkspaceEntry[]; index: number }

function cursorFor(
  target: WorkspaceTarget,
  sequence: number,
  stack: readonly Frame[],
): string {
  return JSON.stringify([
    target.workspaceId,
    target.workspaceGeneration,
    sequence,
    stack.map((frame) => frame.index),
  ])
}

function cursorStack(
  value: string,
  target: WorkspaceTarget,
  sequence: number,
  entries: readonly WorkspaceEntry[],
): Frame[] | null {
  if (value.length > MAX_WORKSPACE_PAGE_BYTES) return null
  try {
    const cursor: unknown = JSON.parse(value)
    if (
      !Array.isArray(cursor) ||
      cursor.length !== 4 ||
      cursor[0] !== target.workspaceId ||
      cursor[1] !== target.workspaceGeneration ||
      cursor[2] !== sequence ||
      !Array.isArray(cursor[3]) ||
      !cursor[3].length
    )
      return null
    const stack: Frame[] = []
    let siblings = entries
    for (const index of cursor[3]) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= siblings.length)
        return null
      stack.push({ entries: siblings, index })
      const entry = siblings[index]
      if (!entry) return null
      siblings = entry.children ?? []
    }
    return stack
  } catch {
    return null
  }
}

function advance(stack: Frame[], entry: WorkspaceEntry) {
  if (entry.children?.length) {
    stack.push({ entries: entry.children, index: 0 })
    return
  }
  while (stack.length) {
    const frame = stack[stack.length - 1] as Frame
    if (++frame.index < frame.entries.length) return
    stack.pop()
  }
}

/** Resume at a tree position; a complete crawl never replays earlier siblings. */
export function pageWorkspaceEntries(
  entries: readonly WorkspaceEntry[],
  snapshot: WorkspaceStreamCursor,
  request: WorkspaceEntryPageRequest,
  select: (entry: WorkspaceEntry) => WorkspaceListedEntry = (entry) => ({
    path: entry.path,
    name: entry.name,
    kind: entry.kind,
  }),
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
  const stack =
    request.cursor === undefined
      ? entries.length
        ? [{ entries, index: 0 }]
        : []
      : typeof request.cursor === 'string'
        ? cursorStack(request.cursor, target, snapshot.sequence, entries)
        : null
  if (!stack) return resync()

  const result: WorkspaceListedEntry[] = []
  const header = {
    target,
    sequence: snapshot.sequence,
    stale: snapshot.stale,
    complete: snapshot.complete,
    capReached: snapshot.capReached,
  }
  const headerBytes = Buffer.byteLength(
    JSON.stringify({ ...header, entries: [], nextCursor: '' }),
  )
  let bytes = headerBytes
  while (stack.length) {
    const cursor = cursorFor(target, snapshot.sequence, stack)
    if (result.length === limit)
      return {
        ok: true,
        value: { ...header, entries: result, nextCursor: cursor },
      }
    const frame = stack[stack.length - 1] as Frame
    const source = frame.entries[frame.index] as WorkspaceEntry
    const entry = select(source)
    const nextBytes =
      bytes +
      Buffer.byteLength(JSON.stringify(entry)) +
      Number(result.length > 0)
    // Reserve the escaped continuation, including one possible child level or index carry.
    if (
      nextBytes + Buffer.byteLength(JSON.stringify(cursor)) + 32 >
      MAX_WORKSPACE_PAGE_BYTES
    ) {
      if (!result.length)
        return limitExceeded('This path exceeds the 64 KiB page limit.')
      return {
        ok: true,
        value: { ...header, entries: result, nextCursor: cursor },
      }
    }
    result.push(entry)
    bytes = nextBytes
    advance(stack, source)
  }
  return { ok: true, value: { ...header, entries: result, nextCursor: null } }
}
