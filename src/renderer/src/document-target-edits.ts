import type { DocumentsApi } from '../../addons/api'
import {
  type OpenDocumentMetadata,
  parseSourceEditRequest,
  type SourceEditRequest,
  type SourceEditResult,
  type TargetSourceEditRequest,
  type TargetSourceEditResult,
} from '../../shared/document-edits.ts'
import type {
  DocumentId,
  DocumentTarget,
  VersionedDocumentTarget,
} from '../../shared/foundation-contracts'
import type { DocumentRuntime } from './document-runtime'

const unavailable = {
  status: 'stale' as const,
  message: 'This document session is no longer available. Read it again.',
}
const invalid = (message: string) => ({ status: 'invalid' as const, message })

function parseTarget(value: unknown): DocumentTarget | null {
  if (!value || typeof value !== 'object') return null
  const target = value as Record<string, unknown>
  if (
    typeof target.documentId !== 'string' ||
    !target.documentId ||
    target.documentId.length > 128 ||
    typeof target.documentGeneration !== 'number' ||
    !Number.isSafeInteger(target.documentGeneration) ||
    target.documentGeneration < 1
  )
    return null
  return Object.freeze({
    documentId: target.documentId as DocumentId,
    documentGeneration: target.documentGeneration,
  })
}

function parseVersionedTarget(value: unknown): VersionedDocumentTarget | null {
  const target = parseTarget(value)
  if (!target) return null
  const version = (value as Record<string, unknown>).contentVersion
  if (
    typeof version !== 'number' ||
    !Number.isSafeInteger(version) ||
    version < 0
  )
    return null
  return Object.freeze({ ...target, contentVersion: version })
}

/** Per-addon activation scope; no receipt survives disable, eviction or process exit. */
export function createDocumentTargetEditScope(
  runtime: DocumentRuntime,
  activeApply: (request: SourceEditRequest) => SourceEditResult,
  isBusy: () => boolean,
): DocumentsApi & { dispose: () => void } {
  const receipts = new Map<
    string,
    { fingerprint: string; result: TargetSourceEditResult | null }
  >()
  let receiptBytes = 0,
    disposed = false,
    applying = false
  const claim = (requestId: string, fingerprint: string) => {
    receipts.set(requestId, { fingerprint, result: null })
    receiptBytes += fingerprint.length
    while (receipts.size > 128 || receiptBytes > 8 * 1024 * 1024) {
      const oldest = receipts.entries().next().value
      if (!oldest) break
      receiptBytes -= oldest[1].fingerprint.length
      receipts.delete(oldest[0])
    }
  }
  const remember = (
    requestId: string,
    fingerprint: string,
    result: TargetSourceEditResult,
  ) => {
    if (!receipts.has(requestId)) claim(requestId, fingerprint)
    if (
      result.status !== 'busy' &&
      result.status !== 'composing' &&
      result.status !== 'unsupported-view'
    ) {
      const receipt = receipts.get(requestId)
      if (receipt) receipt.result = result
    }
    return result
  }
  return {
    dispose() {
      disposed = true
      receipts.clear()
      receiptBytes = 0
    },
    listOpen() {
      if (disposed) return []
      const open: OpenDocumentMetadata[] = []
      for (const document of runtime.documents()) {
        if (!document.tabs.length) continue
        const identity = runtime.captureDocument(document.tabId)
        if (!identity) continue
        open.push(
          Object.freeze({
            target: Object.freeze({
              ...identity,
              contentVersion: document.contentVersion,
            }),
            name: document.name,
            dirty: document.dirty,
            ephemeral: document.ephemeral,
            canAutosave: document.canAutosave,
          }),
        )
      }
      return Object.freeze(open)
    },
    readSource(value) {
      if (disposed)
        return { status: 'disposed', message: 'This addon has stopped.' }
      let target: DocumentTarget | null
      try {
        target = parseTarget(value)
      } catch {
        return invalid('Invalid document target.')
      }
      if (!target) return invalid('Invalid document target.')
      const session = runtime.resolveDocument(target)
      if (!session) return unavailable
      const snapshot = session.snapshot()
      return {
        status: 'read',
        target: Object.freeze({
          ...target,
          contentVersion: snapshot.version,
        }),
        source: snapshot.materialize(),
      }
    },
    applyEdits(value: TargetSourceEditRequest): TargetSourceEditResult {
      if (disposed)
        return { status: 'disposed', message: 'This addon has stopped.' }
      if (!value || typeof value !== 'object')
        return invalid('Invalid edit request.')
      let target: VersionedDocumentTarget | null
      try {
        target = parseVersionedTarget(value.target)
      } catch {
        return invalid('Invalid document target or version.')
      }
      if (!target) return invalid('Invalid document target or version.')
      let parsed: SourceEditRequest
      try {
        parsed = parseSourceEditRequest({
          requestId: value.requestId,
          tabId: 'target',
          revision: 0,
          contentVersion: target.contentVersion,
          projectionId: value.projectionId,
          changes: value.changes,
        })
      } catch (error) {
        return invalid(String(error))
      }
      const fingerprint = JSON.stringify({
        target,
        projectionId: parsed.projectionId ?? null,
        changes: parsed.changes,
      })
      if (fingerprint.length > 8 * 1024 * 1024)
        return invalid('The edit request is too large.')
      const previous = receipts.get(parsed.requestId)
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          return invalid(
            'This request ID was already used for different edits.',
          )
        if (previous.result) return previous.result
      } else claim(parsed.requestId, fingerprint)
      if (applying || isBusy())
        return remember(parsed.requestId, fingerprint, {
          status: 'busy',
          message: 'The document is busy. Try again in a moment.',
        })
      const session = runtime.resolveDocument(target)
      if (!session) return remember(parsed.requestId, fingerprint, unavailable)
      const snapshot = session.snapshot()
      if (snapshot.version !== target.contentVersion)
        return remember(parsed.requestId, fingerprint, {
          status: 'stale',
          message: 'The document changed. Read it again before editing.',
        })
      let prior: (typeof parsed.changes)[number] | undefined,
        changed = false
      for (const edit of parsed.changes) {
        if (
          !snapshot.isEditBoundary(edit.from) ||
          !snapshot.isEditBoundary(edit.to) ||
          (prior &&
            (edit.from < prior.to ||
              (edit.from === prior.to &&
                (edit.from === edit.to || prior.from === prior.to))))
        )
          return remember(
            parsed.requestId,
            fingerprint,
            invalid('Edit ranges overlap or split a character or line ending.'),
          )
        const actual = snapshot.sliceRaw(edit.from, edit.to)
        if (actual !== edit.expectedText)
          return remember(parsed.requestId, fingerprint, {
            status: 'conflict',
            message: 'The text at the edit range has changed.',
          })
        if (actual !== edit.insert) changed = true
        prior = edit
      }
      if (!changed && parsed.projectionId === undefined)
        return remember(parsed.requestId, fingerprint, {
          status: 'applied',
          contentVersion: snapshot.version,
        })
      applying = true
      try {
        let result: TargetSourceEditResult
        if (runtime.hasMountedView(target)) {
          const active = runtime.captureActiveView()
          // ponytail: background mounted views need a target-aware proof adapter.
          result =
            active?.documentId === target.documentId &&
            active.documentGeneration === target.documentGeneration &&
            runtime.get()?.tabId === snapshot.document.tabId
              ? activeApply({
                  ...parsed,
                  requestId: crypto.randomUUID(),
                  tabId: snapshot.document.tabId,
                  revision: snapshot.document.revision,
                })
              : {
                  status: 'unsupported-view',
                  message:
                    'This mounted editor cannot apply the edit without changing focus.',
                }
          const after = session.snapshot()
          if (result.status === 'applied')
            result =
              changed && after.version === snapshot.version
                ? {
                    status: 'busy',
                    message: 'The editor did not accept this edit. Try again.',
                  }
                : { status: 'applied', contentVersion: after.version }
          else if (after.version !== snapshot.version)
            result = {
              status: 'busy',
              message:
                'The document changed while applying this edit. Read it before retrying.',
            }
        } else if (parsed.projectionId !== undefined)
          result = {
            status: 'unsupported-view',
            message: 'A projection-bound edit needs its mounted editor.',
          }
        else {
          const operation = session.edit(
            parsed.changes.map(({ from, to, insert }) => ({
              from,
              to,
              insert,
            })),
            'addon',
            crypto.randomUUID(),
          )
          result = {
            status: 'applied',
            contentVersion: operation.after.version,
          }
        }
        return remember(parsed.requestId, fingerprint, result)
      } catch (error) {
        if (session.snapshot().version !== snapshot.version)
          return remember(parsed.requestId, fingerprint, {
            status: 'applied',
            contentVersion: session.snapshot().version,
          })
        const message = error instanceof Error ? error.message : String(error)
        const result = /busy|dispatching|recovery is full/i.test(message)
          ? { status: 'busy' as const, message }
          : /stale|disposed/i.test(message)
            ? { status: 'stale' as const, message }
            : invalid(message)
        return remember(parsed.requestId, fingerprint, result)
      } finally {
        applying = false
      }
    },
  }
}
