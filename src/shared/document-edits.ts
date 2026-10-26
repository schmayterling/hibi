import type { DocumentState } from './desktop'
import type {
  DocumentTarget,
  VersionedDocumentTarget,
} from './foundation-contracts'
import type { SourceSnapshot } from './source-buffer.ts'
import { highSurrogate, lowSurrogate } from './source-metrics.ts'

/** UTF-16 offsets in the complete, unprojected document source. */
export type SourceEdit = {
  from: number
  to: number
  insert: string
  expectedText: string
}
export type SourceEditRequest = {
  requestId: string
  tabId: string
  revision: number
  contentVersion: number
  /** Optional exact analysis/schema identity returned by getTextProjection(). */
  projectionId?: string
  changes: readonly SourceEdit[]
}
export type SourceEditResult =
  | { status: 'applied'; contentVersion: number }
  | {
      status:
        | 'stale'
        | 'invalid'
        | 'unsupported-view'
        | 'composing'
        | 'busy'
        | 'disposed'
      message: string
    }

export type OpenDocumentMetadata = Readonly<{
  target: VersionedDocumentTarget
  /** Window-local tab identity, stable across save and rename. */
  tabId: string
  name: string
  dirty: boolean
  ephemeral: boolean
  canAutosave: boolean
}>
export type DocumentMetadataResult =
  | { status: 'read'; metadata: OpenDocumentMetadata }
  | { status: 'invalid' | 'stale' | 'disposed'; message: string }
export type DocumentLifecycleEvent =
  | { kind: 'opened' | 'changed'; metadata: OpenDocumentMetadata }
  | { kind: 'closed'; target: DocumentTarget }
export type DocumentSaveResult = {
  status: 'saved' | 'clean' | 'stale' | 'conflict' | 'unsupported'
  document: import('./desktop.ts').DocumentSaveReply | null
}
export type TargetDocumentSaveResult =
  | { status: 'saved' | 'clean'; savedVersion: number }
  | {
      status:
        | 'invalid'
        | 'stale'
        | 'conflict'
        | 'unsupported'
        | 'busy'
        | 'failed'
        | 'disposed'
      message: string
    }
export type DocumentSourceReadResult =
  | { status: 'read'; target: VersionedDocumentTarget; source: string }
  | { status: 'invalid' | 'stale' | 'disposed'; message: string }
export type TargetSourceEditRequest = Readonly<{
  /** Unique within one addon activation; retries with different edits fail. */
  requestId: string
  target: VersionedDocumentTarget
  /** Optional proof returned by the active editor's text projection. */
  projectionId?: string
  /** Exact expected text at UTF-16 offsets in the canonical source. */
  changes: readonly SourceEdit[]
}>
export type TargetSourceEditResult =
  | SourceEditResult
  | { status: 'conflict'; message: string }

export function parseSourceEditRequest(value: unknown): SourceEditRequest {
  if (!value || typeof value !== 'object')
    throw new Error('Invalid edit request.')
  const input = value as Partial<SourceEditRequest>
  if (
    typeof input.requestId !== 'string' ||
    !/^[\w.:-]{1,128}$/.test(input.requestId) ||
    typeof input.tabId !== 'string' ||
    input.tabId.length > 128 ||
    !Number.isSafeInteger(input.revision) ||
    input.revision! < 0 ||
    !Number.isSafeInteger(input.contentVersion) ||
    input.contentVersion! < 0 ||
    (input.projectionId !== undefined &&
      (typeof input.projectionId !== 'string' ||
        input.projectionId.length > 256)) ||
    !Array.isArray(input.changes) ||
    !input.changes.length ||
    input.changes.length > 256
  )
    throw new Error('Invalid edit identity or change count.')
  let size = 0
  const changes = input.changes
    .map((change) => {
      if (
        !change ||
        !Number.isSafeInteger(change.from) ||
        !Number.isSafeInteger(change.to) ||
        change.from < 0 ||
        change.to < change.from ||
        typeof change.insert !== 'string' ||
        typeof change.expectedText !== 'string' ||
        /[\uD800-\uDFFF]/u.test(change.insert)
      )
        throw new Error('Invalid edit range or text.')
      size += change.insert.length + change.expectedText.length
      if (size > 4 * 1024 * 1024)
        throw new Error('The edit request is too large.')
      return {
        from: change.from,
        to: change.to,
        insert: change.insert,
        expectedText: change.expectedText,
      }
    })
    .sort((a, b) => a.from - b.from || a.to - b.to)
  return {
    requestId: input.requestId,
    tabId: input.tabId,
    revision: input.revision!,
    contentVersion: input.contentVersion!,
    ...(input.projectionId === undefined
      ? {}
      : { projectionId: input.projectionId }),
    changes,
  }
}

export function sourceEditMatches(
  request: SourceEditRequest,
  document: Pick<DocumentState, 'tabId' | 'revision' | 'contentVersion'>,
) {
  return (
    request.tabId === document.tabId &&
    request.revision === document.revision &&
    request.contentVersion === document.contentVersion
  )
}

/** Admit exact raw ranges without constructing the edited document. */
export function validateSourceEdits(
  snapshot: SourceSnapshot,
  changes: readonly SourceEdit[],
  maximumBytes = Infinity,
):
  | { status: 'valid'; changed: boolean }
  | {
      status: 'invalid' | 'conflict'
      message: string
    } {
  let previous: SourceEdit | undefined,
    changed = false
  for (const change of changes) {
    if (
      change.to < change.from ||
      !snapshot.isEditBoundary(change.from) ||
      !snapshot.isEditBoundary(change.to) ||
      (previous &&
        (change.from < previous.to ||
          (change.from === previous.to &&
            (change.from === change.to || previous.from === previous.to))))
    )
      return {
        status: 'invalid',
        message: 'Edit ranges overlap or split a character or line ending.',
      }
    const actual = snapshot.sliceRaw(change.from, change.to)
    if (actual !== change.expectedText)
      return {
        status: 'conflict',
        message: 'The text at the edit range has changed.',
      }
    if (actual !== change.insert) changed = true
    previous = change
  }
  if (maximumBytes !== Infinity) {
    let bytes = 0,
      last = -1,
      end = 0
    const append = (size: number, first: number, final: number) => {
      bytes += size - (highSurrogate(last) && lowSurrogate(first) ? 2 : 0)
      last = final
    }
    const retain = (from: number, to: number) => {
      if (from === to) return
      append(
        snapshot.rawToByte(to)! - snapshot.rawToByte(from)!,
        snapshot.sliceRaw(from, from + 1).charCodeAt(0),
        snapshot.sliceRaw(to - 1, to).charCodeAt(0),
      )
    }
    const encoder = new TextEncoder()
    for (const change of changes) {
      retain(end, change.from)
      if (change.insert.length)
        append(
          encoder.encode(change.insert).length,
          change.insert.charCodeAt(0),
          change.insert.charCodeAt(change.insert.length - 1),
        )
      end = change.to
    }
    retain(end, snapshot.utf16Length)
    if (bytes > maximumBytes)
      return {
        status: 'invalid',
        message: 'The edited document exceeds its size limit.',
      }
  }
  return { status: 'valid', changed }
}

/** Rich projection proofs still need the complete proposed source. */
export function editedSource(
  snapshot: SourceSnapshot,
  changes: readonly SourceEdit[],
  maximumBytes = Infinity,
) {
  const validation = validateSourceEdits(snapshot, changes, maximumBytes)
  if (validation.status !== 'valid') throw new Error(validation.message)
  const parts: string[] = []
  let end = 0
  for (const change of changes) {
    parts.push(snapshot.sliceRaw(end, change.from), change.insert)
    end = change.to
  }
  parts.push(snapshot.sliceRaw(end, snapshot.utf16Length))
  return parts.join('')
}
