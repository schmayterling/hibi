import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, sep } from 'node:path'
import { MAX_DOCUMENT_BYTES } from '../shared/desktop'
import type { WorkspaceTarget } from '../shared/foundation-contracts'
import type {
  WorkspaceFileResult,
  WorkspaceTextCreation,
  WorkspaceTextRead,
} from '../shared/workspace'
import { hasOpenDocumentPath } from './document'
import { isDocumentName } from './document-types'
import { validateMarkdown } from './files'
import {
  isCurrentWorkspaceTarget,
  refreshWorkspace,
  workspaceRoot,
} from './workspace'
import { createExclusiveText } from './workspace-exclusive-create'
import { resolveWorkspaceEntry } from './workspace-paths'

const stale = (): WorkspaceFileResult<never> => ({
  ok: false,
  code: 'stale',
  message: 'This workspace is no longer open.',
})

const disposed = (): WorkspaceFileResult<never> => ({
  ok: false,
  code: 'disposed',
  message: 'This addon is no longer active.',
})

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`)
}

type ParentIdentity = { canonical: string; dev: number; ino: number }

// ponytail: path checks cannot defeat a same-user swap-back race without
// directory-handle-relative IO; use native openat-style IO if required.
async function parentIdentity(
  root: string,
  file: string,
): Promise<ParentIdentity> {
  const parent = dirname(file)
  const [canonical, info] = await Promise.all([realpath(parent), lstat(parent)])
  if (!inside(root, canonical) || info.isSymbolicLink() || !info.isDirectory())
    throw Object.assign(new Error('This path is outside the workspace.'), {
      code: 'EACCES',
    })
  return { canonical, dev: info.dev, ino: info.ino }
}

async function verifyParent(
  root: string,
  file: string,
  expected: ParentIdentity,
): Promise<void> {
  const current = await parentIdentity(root, file)
  if (
    current.canonical !== expected.canonical ||
    current.dev !== expected.dev ||
    current.ino !== expected.ino
  )
    throw Object.assign(new Error('The workspace folder changed. Try again.'), {
      code: 'ESTALE',
    })
}

async function readScopedText(root: string, file: string): Promise<string> {
  const parent = await parentIdentity(root, file)
  const handle = await open(
    file,
    constants.O_RDONLY |
      (constants.O_NONBLOCK ?? 0) |
      (constants.O_NOFOLLOW ?? 0),
  )
  try {
    const info = await handle.stat()
    if (!info.isFile())
      throw new Error('Choose a text file, not a folder or device.')
    if (info.size > MAX_DOCUMENT_BYTES)
      throw new Error(
        'This document exceeds the 2 MiB limit. Open a smaller file.',
      )
    const canonical = await realpath(file)
    const opened = await lstat(file)
    if (
      !inside(root, canonical) ||
      opened.isSymbolicLink() ||
      opened.dev !== info.dev ||
      opened.ino !== info.ino
    )
      throw Object.assign(new Error('The workspace file changed. Try again.'), {
        code: 'ESTALE',
      })
    await verifyParent(root, file, parent)
    const bytes = Buffer.alloc(info.size + 1)
    let bytesRead = 0
    while (bytesRead < bytes.length) {
      const chunk = await handle.read(
        bytes,
        bytesRead,
        bytes.length - bytesRead,
        bytesRead,
      )
      if (!chunk.bytesRead) break
      bytesRead += chunk.bytesRead
    }
    if (bytesRead !== info.size)
      throw Object.assign(new Error('The workspace file changed. Try again.'), {
        code: 'ESTALE',
      })
    await verifyParent(root, file, parent)
    const after = await lstat(file)
    if (
      after.dev !== info.dev ||
      after.ino !== info.ino ||
      (await realpath(file)) !== canonical
    )
      throw Object.assign(new Error('The workspace file changed. Try again.'), {
        code: 'ESTALE',
      })
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes.subarray(0, bytesRead),
    )
  } finally {
    await handle.close()
  }
}

function knownFailure(error: unknown): WorkspaceFileResult<never> | null {
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
  if (code === 'ESTALE')
    return {
      ok: false,
      code: 'conflict',
      message: 'The workspace path changed. Try again.',
    }
  if (code === 'ENAMETOOLONG')
    return {
      ok: false,
      code: 'limit-exceeded',
      message: 'Choose a shorter file name.',
    }
  if (
    code === 'EACCES' ||
    code === 'EPERM' ||
    code === 'EROFS' ||
    code === 'ELOOP'
  )
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
): Promise<WorkspaceFileResult<WorkspaceTextRead>> {
  const root = workspaceRoot()
  if (!root || !isCurrentWorkspaceTarget(target)) return stale()
  try {
    const file = await resolveWorkspaceEntry(root, path)
    if (!isCurrentWorkspaceTarget(target)) return stale()
    const markdown = await readScopedText(root, file)
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
  isCurrentOwner?: () => boolean,
): Promise<WorkspaceFileResult<WorkspaceTextCreation>> {
  const ownerActive = () => isCurrentOwner?.() ?? true
  const root = workspaceRoot()
  if (!root || !isCurrentWorkspaceTarget(target)) return stale()
  if (!ownerActive()) return disposed()
  if (typeof markdown !== 'string')
    return { ok: false, code: 'unsupported', message: 'Use UTF-8 text.' }
  try {
    validateMarkdown(markdown)
    const file = await resolveWorkspaceEntry(root, path, true)
    if (!isCurrentWorkspaceTarget(target)) return stale()
    if (!ownerActive()) return disposed()
    if (!isDocumentName(file, true))
      return {
        ok: false,
        code: 'unsupported',
        message: 'Use a supported document extension.',
      }
    const parent = await parentIdentity(root, file)
    if (!isCurrentWorkspaceTarget(target)) return stale()
    if (!ownerActive()) return disposed()
    if (hasOpenDocumentPath(file))
      return {
        ok: false,
        code: 'conflict',
        message: 'A document is already open at that path.',
      }
    // The scope is rechecked after staging and immediately before commit.
    let openDocumentConflict = false
    const commit = await createExclusiveText(file, markdown, async () => {
      if (!isCurrentWorkspaceTarget(target) || !ownerActive()) return false
      await verifyParent(root, file, parent)
      if (!isCurrentWorkspaceTarget(target) || !ownerActive()) return false
      openDocumentConflict = hasOpenDocumentPath(file)
      return !openDocumentConflict
    })
    if (!commit) {
      if (!isCurrentWorkspaceTarget(target)) return stale()
      if (!ownerActive()) return disposed()
      return openDocumentConflict
        ? {
            ok: false,
            code: 'conflict',
            message: 'A document is already open at that path.',
          }
        : stale()
    }
    const changedPath = relative(root, file).split(sep).join('/')
    let indexed = false
    let scopeVerifiedAfterCommit = false
    try {
      await verifyParent(root, file, parent)
      scopeVerifiedAfterCommit = true
    } catch (error) {
      console.error('workspace parent changed after create:', error)
    }
    if (scopeVerifiedAfterCommit && isCurrentWorkspaceTarget(target)) {
      try {
        indexed = (await refreshWorkspace([changedPath])) !== null
      } catch (error) {
        console.error('workspace refresh after create failed:', error)
      }
    }
    return {
      ok: true,
      value: {
        target,
        path: changedPath,
        persisted: true,
        indexed,
        scopeVerifiedAfterCommit,
        ownerActiveAfterCommit: ownerActive(),
        ...commit,
      },
    }
  } catch (error) {
    if (!isCurrentWorkspaceTarget(target)) return stale()
    if (!ownerActive()) return disposed()
    const failure = knownFailure(error)
    if (failure) return failure
    throw error
  }
}
