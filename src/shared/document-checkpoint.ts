import type { SourceStore } from './source-buffer.ts'

export type JournalHead = Readonly<{
  tabId: string
  revision: number
  contentVersion: number
}>
export type JournalCheckpoint = JournalHead &
  (
    | Readonly<{ source: string }>
    | Readonly<{ streamId: string; length: number }>
  )

export function parseJournalHead(value: unknown): JournalHead {
  if (!value || typeof value !== 'object')
    throw new Error('Invalid document recovery identity.')
  const head = value as JournalHead
  if (
    typeof head.tabId !== 'string' ||
    !head.tabId ||
    head.tabId.length > 128 ||
    ![head.revision, head.contentVersion].every(
      (number) => Number.isSafeInteger(number) && number >= 0,
    )
  )
    throw new Error('Invalid document recovery identity.')
  return {
    tabId: head.tabId,
    revision: head.revision,
    contentVersion: head.contentVersion,
  }
}

export function parseJournalCheckpoint(
  value: unknown,
  maximumUnits: number,
): JournalCheckpoint {
  const head = parseJournalHead(value)
  if ('streamId' in (value as JournalCheckpoint)) {
    const { streamId, length } = value as JournalHead & {
      streamId: string
      length: number
    }
    if (
      typeof streamId !== 'string' ||
      !/^[\w.:-]{1,128}$/.test(streamId) ||
      !Number.isSafeInteger(length) ||
      length < 0
    )
      throw new Error('Invalid document recovery checkpoint.')
    return { ...head, streamId, length }
  }
  const source = (value as { source?: unknown }).source
  if (typeof source !== 'string' || source.length > maximumUnits)
    throw new Error('Invalid document recovery checkpoint.')
  return { ...head, source }
}

export function journalHead(store: SourceStore): JournalHead {
  const source = store.snapshot()
  return {
    tabId: source.document.tabId,
    revision: source.document.revision,
    contentVersion: source.version,
  }
}

/** Read-only verification; receipt loss never authorizes overwriting native text. */
export async function verifyJournalCheckpoint(
  read: () => SourceStore,
  value: unknown,
  maximumUnits: number,
): Promise<JournalHead> {
  const checkpoint = parseJournalCheckpoint(value, maximumUnits)
  if (!('source' in checkpoint))
    throw new Error('Invalid document recovery checkpoint.')
  const snapshot = read().snapshot()
  if (
    snapshot.document.tabId !== checkpoint.tabId ||
    snapshot.document.revision !== checkpoint.revision ||
    snapshot.version !== checkpoint.contentVersion ||
    snapshot.utf16Length !== checkpoint.source.length
  )
    throw new Error('The document recovery checkpoint is stale.')
  let offset = 0,
    started = performance.now()
  for (const chunk of snapshot.chunks()) {
    if (!checkpoint.source.startsWith(chunk, offset))
      throw new Error('The document recovery checkpoint does not match.')
    offset += chunk.length
    if (performance.now() - started >= 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      if (!read().ownsCurrentSnapshot(snapshot))
        throw new Error('The document changed during recovery verification.')
      started = performance.now()
    }
  }
  if (!read().ownsCurrentSnapshot(snapshot))
    throw new Error('The document changed during recovery verification.')
  return parseJournalHead(checkpoint)
}
