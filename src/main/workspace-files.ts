import { relative, sep } from 'node:path'
import type {
  OperationResult,
  WorkspaceTarget,
} from '../shared/foundation-contracts'
import { getOpenDocuments } from './document'
import { isDocumentName } from './document-types'
import { readMarkdown, validateMarkdown } from './files'
import {
  isCurrentWorkspaceTarget,
  notifyWorkspaceContent,
  refreshWorkspace,
  workspaceRoot,
} from './workspace'
import { createExclusiveText } from './workspace-exclusive-create'
import { resolveWorkspaceEntry } from './workspace-paths'

export interface WorkspaceTextRead {
  readonly target: WorkspaceTarget
  readonly path: string
  readonly markdown: string
  /** This reads persisted bytes. Open unsaved document content is separate. */
  readonly source: 'disk'
}

export interface WorkspaceTextCreation {
  readonly target: WorkspaceTarget
  readonly path: string
  /** The file was committed even if workspace changed before indexing finished. */
  readonly persisted: true
  readonly indexed: boolean
  readonly directorySynced: boolean
  readonly atomicVisibility: boolean
}

type FileResult<T> = OperationResult<
  T,
  | 'stale'
  | 'not-found'
  | 'conflict'
  | 'permission-denied'
  | 'limit-exceeded'
  | 'unsupported'
>

const stale = (): FileResult<never> => ({
  ok: false,
  code: 'stale',
  message: 'This workspace is no longer open.',
})

function knownFailure(error: unknown): FileResult<never> | null {
  const code =
    typeof error === 'object' && error !== null
      ? (error as NodeJS.ErrnoException).code
      : undefined
  if (code === 'ENOENT')
    return {
      ok: false,
      code: 'not-found',
      message: 'This file or folder is missing.',
    }
  if (code === 'EEXIST')
    return {
      ok: false,
      code: 'conflict',
      message: 'A file already exists at that path.',
    }
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS')
    return {
      ok: false,
      code: 'permission-denied',
      message: 'This file cannot be accessed.',
    }
  if (!(error instanceof Error)) return null
  if (error.message.includes('2 MiB'))
    return { ok: false, code: 'limit-exceeded', message: error.message }
  if (
    error.message.includes('Choose a file or folder') ||
    error.message.includes('path is missing or contains a symbolic link')
  )
    return { ok: false, code: 'permission-denied', message: error.message }
  if (
    error.message.includes('text file') ||
    error.message.includes('UTF-8') ||
    /not valid for encoding utf-8/i.test(error.message)
  )
    return {
      ok: false,
      code: 'unsupported',
      message: 'Choose a UTF-8 text document.',
    }
  return null
}

/** Explicit disk read: never follows current tab or active editor focus. */
export async function readWorkspaceText(
  target: WorkspaceTarget,
  path: unknown,
): Promise<FileResult<WorkspaceTextRead>> {
  const root = workspaceRoot()
  if (!root || !isCurrentWorkspaceTarget(target)) return stale()
  try {
    const file = await resolveWorkspaceEntry(root, path)
    if (!isCurrentWorkspaceTarget(target)) return stale()
    const markdown = await readMarkdown(file)
    if (!isCurrentWorkspaceTarget(target)) return stale()
    return {
      ok: true,
      value: {
        target,
        path: relative(root, file).split(sep).join('/'),
        markdown,
        source: 'disk',
      },
    }
  } catch (error) {
    if (!isCurrentWorkspaceTarget(target)) return stale()
    const failure = knownFailure(error)
    if (failure) return failure
    throw error
  }
}

/** Exclusive create with the existing document size limit and path rules. */
export async function createWorkspaceText(
  target: WorkspaceTarget,
  path: unknown,
  markdown: unknown,
): Promise<FileResult<WorkspaceTextCreation>> {
  const root = workspaceRoot()
  if (!root || !isCurrentWorkspaceTarget(target)) return stale()
  if (typeof markdown !== 'string')
    return { ok: false, code: 'unsupported', message: 'Use UTF-8 text.' }
  try {
    validateMarkdown(markdown)
    const file = await resolveWorkspaceEntry(root, path, true)
    if (!isCurrentWorkspaceTarget(target)) return stale()
    if (!isDocumentName(file, true))
      return {
        ok: false,
        code: 'unsupported',
        message: 'Use a supported document extension.',
      }
    if (getOpenDocuments().some((draft) => draft.file === file))
      return {
        ok: false,
        code: 'conflict',
        message: 'A document is already open at that path.',
      }
    // The scope is rechecked after staging and immediately before commit.
    let openDocumentConflict = false
    const commit = await createExclusiveText(file, markdown, () => {
      if (!isCurrentWorkspaceTarget(target)) return false
      openDocumentConflict = getOpenDocuments().some(
        (draft) => draft.file === file,
      )
      return !openDocumentConflict
    })
    if (!commit)
      return openDocumentConflict && isCurrentWorkspaceTarget(target)
        ? {
            ok: false,
            code: 'conflict',
            message: 'A document is already open at that path.',
          }
        : stale()
    const changedPath = relative(root, file).split(sep).join('/')
    let indexed = false
    if (isCurrentWorkspaceTarget(target)) {
      try {
        indexed = (await refreshWorkspace([changedPath])) !== null
      } catch (error) {
        console.error('workspace refresh after create failed:', error)
        if (isCurrentWorkspaceTarget(target))
          await notifyWorkspaceContent(null).catch((notifyError: unknown) =>
            console.error('workspace resync notification failed:', notifyError),
          )
      }
    }
    return {
      ok: true,
      value: { target, path: changedPath, persisted: true, indexed, ...commit },
    }
  } catch (error) {
    if (!isCurrentWorkspaceTarget(target)) return stale()
    const failure = knownFailure(error)
    if (failure) return failure
    throw error
  }
}
