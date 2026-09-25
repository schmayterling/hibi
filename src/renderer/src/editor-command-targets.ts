import type { EditorInteractionRequest } from '../../shared/editor-interactions'
import { sameInteraction } from '../../shared/editor-interactions'
import type { CommandExecutionContext } from '../../shared/foundation-contracts'

type Target = {
  context: CommandExecutionContext
  request: EditorInteractionRequest
  current: () => EditorInteractionRequest | null
}

const targets = new Map<string, Target>()
const selectionCaptures = new Set<{
  capture: () => EditorInteractionRequest | null
  current: (position: number) => EditorInteractionRequest | null
}>()

export function registerEditorSelectionCapture(
  capture: () => EditorInteractionRequest | null,
  current: (position: number) => EditorInteractionRequest | null,
) {
  const entry = { capture, current }
  selectionCaptures.add(entry)
  return () => selectionCaptures.delete(entry)
}

export function captureEditorSelectionCommandTarget(
  base: CommandExecutionContext,
) {
  if (!base.view) return null
  for (const entry of selectionCaptures) {
    const request = entry.capture()
    if (
      !request ||
      request.view.viewId !== base.view.viewId ||
      request.view.viewGeneration !== base.view.viewGeneration
    )
      continue
    return captureEditorCommandTarget(base, request, () =>
      entry.current(request.position),
    )
  }
  return null
}

export function captureEditorCommandTarget(
  base: CommandExecutionContext,
  request: EditorInteractionRequest,
  current: () => EditorInteractionRequest | null,
) {
  const targetId = crypto.randomUUID()
  const context: CommandExecutionContext = {
    ...base,
    document: {
      documentId: request.view.documentId,
      documentGeneration: request.view.documentGeneration,
    },
    view: { ...request.view },
    selection: {
      targetId,
      editor: request.editor,
      contentVersion: request.contentVersion,
      position: request.position,
      anchor: request.selection.anchor,
      head: request.selection.head,
      selectedText: request.selectedText.slice(0, 256),
    },
  }
  targets.set(targetId, {
    context: structuredClone(context),
    request: {
      ...request,
      view: { ...request.view },
      selection: { ...request.selection },
      before: '',
      after: '',
      selectedText: '',
    },
    current,
  })
  return {
    context,
    release: () => targets.delete(targetId),
  }
}

export function isEditorCommandTargetCurrent(context: CommandExecutionContext) {
  const selection = context.selection
  if (!selection) return false
  const target = targets.get(selection.targetId)
  if (!target) return false
  const captured = target.context
  if (
    context.source !== captured.source ||
    context.workspace?.workspaceId !== captured.workspace?.workspaceId ||
    context.workspace?.workspaceGeneration !==
      captured.workspace?.workspaceGeneration ||
    context.document?.documentId !== captured.document?.documentId ||
    context.document?.documentGeneration !==
      captured.document?.documentGeneration ||
    context.view?.viewId !== captured.view?.viewId ||
    context.view?.viewGeneration !== captured.view?.viewGeneration ||
    context.selection?.editor !== captured.selection?.editor ||
    context.selection?.contentVersion !== captured.selection?.contentVersion ||
    context.selection?.position !== captured.selection?.position ||
    context.selection?.anchor !== captured.selection?.anchor ||
    context.selection?.head !== captured.selection?.head ||
    context.selection?.selectedText !== captured.selection?.selectedText
  )
    return false
  try {
    return sameInteraction(target.request, target.current())
  } catch {
    return false
  }
}
