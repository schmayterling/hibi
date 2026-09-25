import { createHash } from 'node:crypto'
import { type BigIntStats, constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, sep } from 'node:path'
import { MAX_DOCUMENT_BYTES } from '../shared/desktop'
import type { WorkspaceTarget } from '../shared/foundation-contracts'
import type {
  WorkspaceFileResult,
  WorkspaceTextCreation,
  WorkspaceTextRead,
  WorkspaceTextUpdate,
} from '../shared/workspace'
import { hasOpenDocumentPath } from './document'
import { isDocumentName } from './document-types'
import { validateMarkdown } from './files'
import {
  isCurrentWorkspaceTarget,
  notifyWorkspaceContent,
  refreshWorkspace,
  workspaceRoot,
} from './workspace'
import { replaceExistingText } from './workspace-atomic-update'
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

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.nlink === right.nlink
  )
}

function diskVersion(info: BigIntStats, bytes: Uint8Array): string {
  return createHash('sha256')
    .update(
      `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.mode}:${info.uid}:${info.gid}:${info.nlink}\0`,
    )
    .update(bytes)
    .digest('hex')
}

type ScopedText = {
  markdown: string
  version: string
  contentHash: string
  canonical: string
  links: bigint
}

async function readScopedText(root: string, file: string): Promise<ScopedText> {
  const parent = await parentIdentity(root, file)
  const handle = await open(
    file,
    constants.O_RDONLY |
      (constants.O_NONBLOCK ?? 0) |
      (constants.O_NOFOLLOW ?? 0),
  )
  try {
    const info = await handle.stat({ bigint: true })
    if (!info.isFile())
      throw new Error('Choose a text file, not a folder or device.')
    if (info.size > BigInt(MAX_DOCUMENT_BYTES))
      throw new Error(
        'This document exceeds the 2 MiB limit. Open a smaller file.',
      )
    const canonical = await realpath(file)
    const opened = await lstat(file, { bigint: true })
    if (
      !inside(root, canonical) ||
      opened.isSymbolicLink() ||
      !sameFile(opened, info)
    )
      throw Object.assign(new Error('The workspace file changed. Try again.'), {
        code: 'ESTALE',
      })
    await verifyParent(root, file, parent)
    const bytes = Buffer.alloc(Number(info.size) + 1)
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
    if (bytesRead !== Number(info.size))
      throw Object.assign(new Error('The workspace file changed. Try again.'), {
        code: 'ESTALE',
      })
    await verifyParent(root, file, parent)
    const afterHandle = await handle.stat({ bigint: true })
    const after = await lstat(file, { bigint: true })
    if (
      !sameFile(afterHandle, info) ||
      !sameFile(after, info) ||
      (await realpath(file)) !== canonical
    )
      throw Object.assign(new Error('The workspace file changed. Try again.'), {
        code: 'ESTALE',
      })
    const content = bytes.subarray(0, bytesRead)
    return {
      markdown: new TextDecoder('utf-8', {
        fatal: true,
        ignoreBOM: true,
      }).decode(content),
      version: diskVersion(info, content),
      contentHash: createHash('sha256').update(content).digest('hex'),
      canonical,
      links: info.nlink,
    }
  } finally {
    await handle.close()
  }
}

function knownFailure(error: unknown): WorkspaceFileResult<never> | null {
  const code =
    typeof error === 'object' && error !== null
      ? (error as NodeJS.ErrnoException).code
      : undefined
  if (code === 'EWORKSPACE') return stale()
  if (code === 'EOWNER') return disposed()
  if (code === 'EOPEN')
    return {
      ok: false,
      code: 'conflict',
      message: 'Close this document before updating its disk file.',
    }
  if (code === 'EVERSION')
    return {
      ok: false,
      code: 'conflict',
      message: 'This file changed on disk. Read it again before updating.',
    }
  if (code === 'EHARDLINK')
    return {
      ok: false,
      code: 'unsupported',
      message: 'Files with hard links cannot be replaced this way.',
    }
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
    const read = await readScopedText(root, file)
    if (!isCurrentWorkspaceTarget(target)) return stale()
    return {
      ok: true,
      value: {
        target,
        path: relative(root, read.canonical).split(sep).join('/'),
        markdown: read.markdown,
        version: read.version,
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

const pendingUpdates = new Map<string, Promise<void>>()

async function serializeUpdate<T>(
  file: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = pendingUpdates.get(file) ?? Promise.resolve()
  let release: () => void = () => {}
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  pendingUpdates.set(file, current)
  try {
    await previous
    return await work()
  } finally {
    release()
    if (pendingUpdates.get(file) === current) pendingUpdates.delete(file)
  }
}

function mutationError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/** A closed-file replacement requires the exact disk version returned by read. */
export async function updateWorkspaceText(
  target: WorkspaceTarget,
  path: unknown,
  expectedVersion: unknown,
  markdown: unknown,
  options?: unknown,
  isCurrentOwner?: () => boolean,
): Promise<WorkspaceFileResult<WorkspaceTextUpdate>> {
  const ownerActive = () => isCurrentOwner?.() ?? true
  const root = workspaceRoot()
  if (!root || !isCurrentWorkspaceTarget(target)) return stale()
  if (!ownerActive()) return disposed()
  if (process.platform === 'win32')
    return {
      ok: false,
      code: 'unsupported',
      message: 'Private workspace replacements are not available on Windows.',
    }
  if (
    !options ||
    typeof options !== 'object' ||
    (options as { allowMetadataReset?: unknown }).allowMetadataReset !== true
  )
    return {
      ok: false,
      code: 'unsupported',
      message:
        'Replacing a disk file resets its metadata. Allow that reset explicitly.',
    }
  if (
    typeof expectedVersion !== 'string' ||
    !/^[a-f0-9]{64}$/.test(expectedVersion)
  )
    return {
      ok: false,
      code: 'unsupported',
      message: 'Read this file before updating it.',
    }
  if (typeof markdown !== 'string')
    return { ok: false, code: 'unsupported', message: 'Use UTF-8 text.' }
  try {
    validateMarkdown(markdown)
    const file = await resolveWorkspaceEntry(root, path)
    if (!isCurrentWorkspaceTarget(target)) return stale()
    if (!ownerActive()) return disposed()
    if (!isDocumentName(file, true))
      return {
        ok: false,
        code: 'unsupported',
        message: 'Use a supported document extension.',
      }
    const canonical = await realpath(file)
    if (!inside(root, canonical))
      throw mutationError('EACCES', 'This path is outside the workspace.')
    return await serializeUpdate(canonical, async () => {
      const ensureActive = () => {
        if (!isCurrentWorkspaceTarget(target))
          throw mutationError('EWORKSPACE', 'This workspace is no longer open.')
        if (!ownerActive())
          throw mutationError('EOWNER', 'This addon is no longer active.')
      }
      const ensureClosed = (current: ScopedText) => {
        if (hasOpenDocumentPath(file) || hasOpenDocumentPath(current.canonical))
          throw mutationError('EOPEN', 'This document is open.')
      }
      ensureActive()
      const original = await readScopedText(root, file)
      ensureActive()
      ensureClosed(original)
      if (original.links > 1n)
        throw mutationError('EHARDLINK', 'This file has hard links.')
      if (original.version !== expectedVersion)
        throw mutationError('EVERSION', 'This file changed on disk.')
      const parent = await parentIdentity(root, file)
      ensureActive()
      const commit = await replaceExistingText(
        file,
        markdown,
        0o600,
        async () => {
          ensureActive()
          await verifyParent(root, file, parent)
          const latest = await readScopedText(root, file)
          ensureActive()
          ensureClosed(latest)
          if (latest.links > 1n)
            throw mutationError('EHARDLINK', 'This file has hard links.')
          if (latest.version !== expectedVersion)
            throw mutationError('EVERSION', 'This file changed on disk.')
          await verifyParent(root, file, parent)
          ensureActive()
          ensureClosed(latest)
        },
      )
      const changedPath = relative(root, original.canonical)
        .split(sep)
        .join('/')
      let scopeVerifiedAfterCommit = false
      let version: string | null = null
      let indexed = false
      let ownerActiveAfterCommit = false
      try {
        await verifyParent(root, file, parent)
        const updated = await readScopedText(root, file)
        scopeVerifiedAfterCommit = updated.canonical === original.canonical
        if (
          scopeVerifiedAfterCommit &&
          updated.contentHash ===
            createHash('sha256').update(markdown, 'utf8').digest('hex')
        )
          version = updated.version
      } catch (error) {
        console.error('workspace file changed after update:', error)
      }
      if (scopeVerifiedAfterCommit && isCurrentWorkspaceTarget(target)) {
        try {
          indexed = (await notifyWorkspaceContent([changedPath])) !== null
        } catch (error) {
          console.error('workspace content refresh after update failed:', error)
        }
      }
      try {
        ownerActiveAfterCommit = ownerActive()
      } catch (error) {
        console.error('workspace owner check after update failed:', error)
      }
      return {
        ok: true,
        value: {
          target,
          path: changedPath,
          previousVersion: expectedVersion,
          version,
          persisted: true,
          indexed,
          scopeVerifiedAfterCommit,
          ownerActiveAfterCommit,
          metadataPreserved: false,
          ...commit,
        },
      }
    })
  } catch (error) {
    if (!isCurrentWorkspaceTarget(target)) return stale()
    if (!ownerActive()) return disposed()
    const failure = knownFailure(error)
    if (failure) return failure
    throw error
  }
}
