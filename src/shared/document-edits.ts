import type { DocumentState } from './desktop'
import type { VersionedDocumentTarget } from './foundation-contracts'
import { exceedsUtf8Limit } from './text-size.ts'

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
  name: string
  dirty: boolean
  ephemeral: boolean
  canAutosave: boolean
}>
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

/** Validate exact ranges before an editor transaction is created. */
export function editedSource(
  source: string,
  changes: readonly SourceEdit[],
  maximumBytes: number,
) {
  const splitsSurrogate = (position: number) =>
    /[\uD800-\uDBFF]/.test(source.charAt(position - 1)) &&
    /[\uDC00-\uDFFF]/.test(source.charAt(position))
  let previous: SourceEdit | undefined
  const parts: string[] = []
  let end = 0
  for (const change of changes) {
    if (
      change.to > source.length ||
      splitsSurrogate(change.from) ||
      splitsSurrogate(change.to)
    )
      throw new Error(
        'The edit range is outside the text or splits a Unicode character.',
      )
    if (
      previous &&
      (change.from < previous.to ||
        (change.from === previous.to &&
          (change.from === change.to || previous.from === previous.to)))
    )
      throw new Error('Edit ranges overlap or share an insertion boundary.')
    if (source.slice(change.from, change.to) !== change.expectedText)
      throw new Error('The text at the edit range has changed.')
    parts.push(source.slice(end, change.from), change.insert)
    end = change.to
    previous = change
  }
  parts.push(source.slice(end))
  const result = parts.join('')
  if (exceedsUtf8Limit(result, maximumBytes))
    throw new Error('The edited document exceeds its size limit.')
  return result
}
