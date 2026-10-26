import type { SourceStore } from './source-buffer.ts'

export type JournalHead = Readonly<{
  tabId: string
  revision: number
  contentVersion: number
}>
export type JournalCheckpoint = JournalHead &
  Readonly<{ streamId: string; length: number }>

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

export function parseJournalCheckpoint(value: unknown): JournalCheckpoint {
  const head = parseJournalHead(value),
    { streamId, length } = value as JournalCheckpoint
  if (
    typeof streamId !== 'string' ||
    !/^[\w.:-]{1,128}$/.test(streamId) ||
    !Number.isSafeInteger(length) ||
    length < 0
  )
    throw new Error('Invalid document recovery checkpoint.')
  return { ...head, streamId, length }
}

export function journalHead(store: SourceStore): JournalHead {
  const source = store.snapshot()
  return {
    tabId: source.document.tabId,
    revision: source.document.revision,
    contentVersion: source.version,
  }
}
