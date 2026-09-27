import type { DocumentState } from './desktop'
import {
  type JournalCheckpoint,
  type JournalHead,
  parseJournalCheckpoint,
  parseJournalHead,
} from './document-checkpoint.ts'
import type { SourceStore } from './source-buffer'
import {
  parseSourceOperation,
  type SourceOperation,
} from './source-operations.ts'
import { ownSourceText } from './source-text.ts'

/** One ordered UTF-16 replacement. The next content version is its sequence number. */
export type DocumentChange = {
  tabId: string
  revision: number
  baseVersion: number
  contentVersion: number
  from: number
  to: number
  insert: string
}
export type DocumentAcknowledgment = Pick<
  DocumentState,
  'tabId' | 'revision' | 'contentVersion'
> & { operationId?: string }
export type JournalMessage = DocumentChange | SourceOperation

export function sourceChange(before: string, after: string) {
  if (before === after) return null
  let from = 0,
    endBefore = before.length,
    endAfter = after.length
  while (
    from < endBefore &&
    from < endAfter &&
    before.charCodeAt(from) === after.charCodeAt(from)
  )
    from++
  while (
    endBefore > from &&
    endAfter > from &&
    before.charCodeAt(endBefore - 1) === after.charCodeAt(endAfter - 1)
  ) {
    endBefore--
    endAfter--
  }
  if (splitsSurrogate(before, from) || splitsSurrogate(after, from)) from--
  if (splitsSurrogate(before, endBefore) || splitsSurrogate(after, endAfter)) {
    endBefore++
    endAfter++
  }
  return { from, to: endBefore, insert: after.slice(from, endAfter) }
}
function splitsSurrogate(source: string, position: number) {
  return (
    /[\uD800-\uDBFF]/.test(source.charAt(position - 1)) &&
    /[\uDC00-\uDFFF]/.test(source.charAt(position))
  )
}
const parsedChanges = new WeakSet<DocumentChange>()
export function parseDocumentChange(value: unknown): DocumentChange {
  if (!value || typeof value !== 'object')
    throw new Error('Invalid document change.')
  if (parsedChanges.has(value as DocumentChange)) return value as DocumentChange
  const change = value as DocumentChange
  if (
    typeof change.tabId !== 'string' ||
    !change.tabId ||
    change.tabId.length > 128 ||
    ![
      change.revision,
      change.baseVersion,
      change.contentVersion,
      change.from,
      change.to,
    ].every((value) => Number.isSafeInteger(value) && value >= 0) ||
    change.contentVersion !== change.baseVersion + 1 ||
    change.to < change.from ||
    typeof change.insert !== 'string' ||
    change.insert.length > 2 * 1024 * 1024 ||
    /[\uD800-\uDFFF]/u.test(change.insert)
  )
    throw new Error('Invalid document change.')
  const parsed = Object.freeze({
    tabId: ownSourceText(change.tabId),
    revision: change.revision,
    baseVersion: change.baseVersion,
    contentVersion: change.contentVersion,
    from: change.from,
    to: change.to,
    insert: ownSourceText(change.insert),
  })
  parsedChanges.add(parsed)
  return parsed
}
const parseMessage = (value: unknown): JournalMessage =>
  value && typeof value === 'object' && 'document' in value
    ? parseSourceOperation(value)
    : parseDocumentChange(value)
const identity = (change: JournalMessage) =>
  'document' in change ? change.document : change
const key = (change: JournalMessage) => {
  const document = identity(change)
  return `${document.tabId}:${document.revision}:${change.contentVersion}`
}
const samePayload = (a: JournalMessage, b: JournalMessage) =>
  JSON.stringify(a) === JSON.stringify(b)

/** Retained UTF-16 payload estimate, not Electron wire bytes or measured heap. */
export const journalMessageBytes = (change: JournalMessage) => {
  const document = identity(change)
  return (
    128 +
    document.tabId.length * 2 +
    ('document' in change
      ? (change.operationId.length + change.historyGroup.length) * 2 +
        change.changes.reduce(
          (bytes, range) => bytes + 48 + range.insert.length * 2,
          0,
        )
      : 48 + change.insert.length * 2)
  )
}

/** Both legacy replacements and atomic batches commit to one persistent recovery replica. */
export function createJournalReceiver(read: (tabId: string) => SourceStore) {
  const receipts = new Map<
    string,
    { change: JournalMessage; ack: DocumentAcknowledgment; bytes: number }
  >()
  let receiptSize = 0
  return (value: unknown): DocumentAcknowledgment => {
    const change = parseMessage(value)
    const previous = receipts.get(key(change))
    if (previous) {
      if (!samePayload(previous.change, change))
        throw new Error(
          'This change sequence was already used for different content.',
        )
      return previous.ack
    }
    const document = identity(change),
      store = read(document.tabId),
      current = store.snapshot()
    if (
      current.document.tabId !== document.tabId ||
      current.document.revision !== document.revision ||
      current.version !== change.baseVersion
    )
      throw new Error(
        'The document changed before these edits could be kept. Copy your unsaved text before reloading.',
      )
    let operation: SourceOperation
    if ('document' in change) operation = change
    else {
      // The legacy protocol allowed raw CRLF boundaries. Preserve that meaning
      // while giving the exact-operation kernel complete line-ending ownership.
      let { from, to, insert } = change
      if (
        from > 0 &&
        current.sliceRaw(from - 1, Math.min(current.utf16Length, from + 1)) ===
          '\r\n'
      ) {
        from--
        insert = `\r${insert}`
      }
      if (
        to > 0 &&
        to < current.utf16Length &&
        current.sliceRaw(to - 1, to + 1) === '\r\n'
      ) {
        to++
        insert += '\n'
      }
      operation = {
        document: { tabId: change.tabId, revision: change.revision },
        operationId: `legacy:${change.contentVersion}`,
        baseVersion: change.baseVersion,
        contentVersion: change.contentVersion,
        origin: 'source',
        historyGroup: 'legacy',
        changes: [{ from, to, insert }],
      }
    }
    store.commit(store.prepare(operation))
    const ack = {
      tabId: document.tabId,
      revision: document.revision,
      contentVersion: change.contentVersion,
      ...('document' in change ? { operationId: change.operationId } : {}),
    }
    const bytes = journalMessageBytes(change)
    receipts.set(key(change), { change, ack, bytes })
    receiptSize += bytes
    while (receipts.size > 128 || receiptSize > 8 * 1024 * 1024) {
      const first = receipts.keys().next().value!
      receiptSize -= receipts.get(first)!.bytes
      receipts.delete(first)
    }
    return ack
  }
}

type JournalOptions = {
  maximumBytes?: number
  /** One separately bounded bulk operation can enter an empty queue. */
  maximumBulkBytes?: number
  timeoutMs?: number
  retryDelays?: readonly number[]
  checkpoint?: (tabId: string) => JournalCheckpoint | Promise<JournalCheckpoint>
  head?: (tabId: string) => Promise<JournalHead>
  verify?: (checkpoint: JournalCheckpoint) => Promise<JournalHead>
  maximumCheckpointUnits?: number
}

/** One lossless queue for legacy and atomic edits; failed delivery never forgets an edit. */
export function createDocumentJournal(
  send: (change: JournalMessage) => Promise<DocumentAcknowledgment>,
  options: JournalOptions = {},
) {
  type PendingChange = {
    change: JournalMessage
    promise: Promise<DocumentAcknowledgment>
    resolve: (ack: DocumentAcknowledgment) => void
    reject: (error: unknown) => void
    started: boolean
    failed: boolean
    bytes: number
  }
  const pending = new Map<string, PendingChange>()
  const inFlight = new Map<
    string,
    { change: JournalMessage; promise: Promise<DocumentAcknowledgment> }
  >()
  let pendingBytes = 0
  let inFlightBytes = 0
  let paused = false
  let flushing: Promise<void> | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let retryAttempt = 0
  let lastMemoryAck: DocumentAcknowledgment | null = null
  let lastError: string | null = null
  let controlPending = false
  const withinDeadline = <T>(work: () => Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const result = new Promise<T>((resolve, reject) => {
      if (options.timeoutMs)
        timer = setTimeout(
          () =>
            reject(
              new Error(
                'Document recovery timed out. Your pending edits are kept; retry saving.',
              ),
            ),
          options.timeoutMs,
        )
      try {
        Promise.resolve(work()).then(resolve, reject)
      } catch (error) {
        reject(error)
      }
    })
    return result.finally(() => clearTimeout(timer))
  }
  const forget = (id: string, entry: PendingChange) => {
    if (pending.get(id) !== entry) return
    pending.delete(id)
    pendingBytes -= entry.bytes
    if (!pending.size) {
      clearTimeout(retryTimer)
      retryTimer = undefined
      retryAttempt = 0
      lastError = null
    }
  }
  const assertCapacity = (value: JournalMessage) => {
    const change = parseMessage(value),
      bytes = journalMessageBytes(change)
    const existing = pending.get(key(change))
    if (existing) {
      if (!samePayload(existing.change, change))
        throw new Error('Conflicting document change sequence.')
      return
    }
    const outstanding = inFlight.get(key(change))
    if (outstanding && !samePayload(outstanding.change, change))
      throw new Error('Conflicting document change sequence.')
    const maximum =
      pending.size || inFlight.size
        ? (options.maximumBytes ?? 8 * 1024 * 1024)
        : (options.maximumBulkBytes ?? 40 * 1024 * 1024)
    if (pendingBytes + inFlightBytes + bytes > maximum)
      throw new Error(
        'Document recovery is full. Your accepted edits are kept; retry saving before editing again.',
      )
  }
  const scheduleRetry = () => {
    const delay = options.retryDelays?.[retryAttempt]
    if (retryTimer || flushing || !pending.size || delay === undefined) return
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      retryAttempt++
      void flush().catch(() => {})
    }, delay)
  }
  const deliver = (entry: PendingChange) => {
    const change = entry.change,
      document = identity(change)
    entry.started = true
    entry.failed = false
    const id = key(change)
    let transport = inFlight.get(id)?.promise
    if (!transport) {
      inFlightBytes += entry.bytes
      // A deadline cannot cancel an Electron invoke. Reuse its outstanding
      // promise instead of retaining another payload on every retry.
      transport = new Promise<DocumentAcknowledgment>((resolve, reject) => {
        try {
          Promise.resolve(send(change)).then(resolve, reject)
        } catch (error) {
          reject(error)
        }
      }).finally(() => {
        inFlight.delete(id)
        inFlightBytes -= entry.bytes
      })
      inFlight.set(id, { change, promise: transport })
    }
    const delivery = transport
    entry.promise = withinDeadline(() => delivery)
      .then((ack) => {
        if (
          ack.tabId !== document.tabId ||
          ack.revision !== document.revision ||
          ack.contentVersion !== change.contentVersion ||
          ('document' in change && ack.operationId !== change.operationId)
        )
          throw new Error('Could not confirm the latest document changes.')
        if (
          !lastMemoryAck ||
          lastMemoryAck.tabId !== ack.tabId ||
          lastMemoryAck.revision !== ack.revision ||
          lastMemoryAck.contentVersion < ack.contentVersion
        )
          lastMemoryAck = ack
        forget(key(change), entry)
        return ack
      })
      .catch((error) => {
        entry.failed = true
        lastError = error instanceof Error ? error.message : String(error)
        scheduleRetry()
        throw error
      })
    void entry.promise.then(entry.resolve, entry.reject)
    return entry.promise
  }
  const append = (value: JournalMessage): Promise<DocumentAcknowledgment> => {
    try {
      const change = parseMessage(value),
        existing = pending.get(key(change))
      if (existing) {
        if (!samePayload(existing.change, change))
          throw new Error('Conflicting document change sequence.')
        return existing.promise
      }
      assertCapacity(change)
      let resolve!: PendingChange['resolve'], reject!: PendingChange['reject']
      const promise = new Promise<DocumentAcknowledgment>((yes, no) => {
        resolve = yes
        reject = no
      })
      const entry: PendingChange = {
        change,
        promise,
        resolve,
        reject,
        started: false,
        failed: false,
        bytes: journalMessageBytes(change),
      }
      pending.set(key(change), entry)
      pendingBytes += entry.bytes
      void promise.catch(() => {})
      if (!paused) deliver(entry)
      return promise
    } catch (error) {
      return Promise.reject(error)
    }
  }
  const control = <T>(work: () => Promise<T>): Promise<T> => {
    if (controlPending)
      return Promise.reject(
        new Error(
          'A document recovery request is still pending. Retry when the app responds.',
        ),
      )
    controlPending = true
    const request = Promise.resolve()
      .then(work)
      .finally(() => {
        controlPending = false
      })
    return withinDeadline(() => request)
  }
  const reconcile = async () => {
    const { checkpoint: checkpointFor, head: headFor, verify } = options
    if (!checkpointFor || !headFor || !verify)
      throw new Error('Document recovery checkpoint is unavailable.')
    paused = true
    try {
      await Promise.allSettled(
        [...pending.values()]
          .filter((entry) => entry.started)
          .map((entry) => entry.promise),
      )
      const groups = new Map<
        string,
        { document: ReturnType<typeof identity>; entries: PendingChange[] }
      >()
      for (const entry of pending.values()) {
        const document = identity(entry.change)
        const id = JSON.stringify([document.tabId, document.revision])
        const group = groups.get(id)
        if (group) group.entries.push(entry)
        else groups.set(id, { document, entries: [entry] })
      }
      for (const { document, entries } of groups.values()) {
        const checkpoint = parseJournalCheckpoint(
          await control(async () => checkpointFor(document.tabId)),
          options.maximumCheckpointUnits ?? 16 * 1024 * 1024,
        )
        if (
          document.tabId !== checkpoint.tabId ||
          document.revision !== checkpoint.revision
        )
          throw new Error(
            'Pending edits belong to another document. Recovery stopped.',
          )
        const head = parseJournalHead(
          await control(() => headFor(document.tabId)),
        )
        if (
          head.tabId !== checkpoint.tabId ||
          head.revision !== checkpoint.revision ||
          head.contentVersion > checkpoint.contentVersion
        )
          throw new Error(
            'The native document changed before recovery could be verified.',
          )
        let version = head.contentVersion
        for (const entry of entries.sort(
          (a, b) => a.change.contentVersion - b.change.contentVersion,
        )) {
          const change = entry.change
          if (change.contentVersion > checkpoint.contentVersion) continue
          if (change.contentVersion <= version) {
            if (!entry.started)
              throw new Error(
                'Native recovery contains an unsent change. Recovery stopped.',
              )
            continue
          }
          if (change.baseVersion !== version)
            throw new Error(
              'Document recovery is missing an operation. Your pending edits are kept.',
            )
          await deliver(entry)
          version = change.contentVersion
        }
        if (version !== checkpoint.contentVersion)
          throw new Error(
            'Document recovery is missing an operation. Your pending edits are kept.',
          )
        const verified = parseJournalHead(
          await control(() => verify(checkpoint)),
        )
        if (
          verified.tabId !== checkpoint.tabId ||
          verified.revision !== checkpoint.revision ||
          verified.contentVersion !== checkpoint.contentVersion
        )
          throw new Error('Could not verify the document recovery checkpoint.')
        lastMemoryAck = verified
        for (const entry of entries)
          if (entry.change.contentVersion <= checkpoint.contentVersion)
            forget(key(entry.change), entry)
      }
    } finally {
      paused = false
      for (const entry of pending.values()) if (!entry.started) deliver(entry)
    }
  }
  const drain = async () => {
    while (pending.size) {
      await Promise.allSettled(
        [...pending.values()].map((entry) => entry.promise),
      )
      for (const entry of pending.values())
        if (entry.failed) await deliver(entry)
    }
  }
  function flush() {
    const barrier = (flushing ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        try {
          await drain()
        } catch (error) {
          if (!options.checkpoint || !options.head || !options.verify)
            throw error
          await reconcile()
          await drain()
        }
      })
      .finally(() => {
        if (flushing === barrier) {
          flushing = undefined
          scheduleRetry()
        }
      })
    flushing = barrier
    return barrier
  }
  return {
    append,
    appendOperation: (operation: SourceOperation) => append(operation),
    assertCapacity,
    hasPending: () => pending.size > 0,
    pendingBytes: () => pendingBytes,
    state: () => ({
      pendingCount: pending.size,
      pendingBytes,
      inFlightCount: inFlight.size,
      inFlightBytes,
      lastMemoryAck,
      status: !pending.size
        ? 'idle'
        : flushing
          ? 'retrying'
          : lastError
            ? 'failed'
            : 'pending',
      error: lastError,
    }),
    flush,
  }
}
