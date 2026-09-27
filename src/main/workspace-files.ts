import { createHash } from 'node:crypto'
import { type BigIntStats, constants } from 'node:fs'
import { link, lstat, open, realpath, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, relative, sep } from 'node:path'
import { MAX_DOCUMENT_BYTES } from '../shared/desktop'
import type { WorkspaceTarget } from '../shared/foundation-contracts'
import type {
  WorkspaceBinaryCreation,
  WorkspaceBinaryRead,
  WorkspaceFileRename,
  WorkspaceFileResult,
  WorkspaceFileTrash,
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
import {
  createExclusiveBytes,
  createExclusiveText,
} from './workspace-exclusive-create'
import { resolveWorkspaceEntry } from './workspace-paths'

const MAX_BINARY_BYTES = 16 * 1024 * 1024

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

type ScopedBytes = {
  bytes: Uint8Array
  version: string
  canonical: string
  links: bigint
  info: BigIntStats
}

async function readScopedBytes(
  root: string,
  file: string,
  limit: number,
): Promise<ScopedBytes> {
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
      throw new Error('Choose a file, not a folder or device.')
    if (info.size > BigInt(limit))
      throw new Error(
        `This file exceeds the ${limit / (1024 * 1024)} MiB limit. Choose a smaller file.`,
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
      bytes: content,
      version: diskVersion(info, content),
      canonical,
      links: info.nlink,
      info,
    }
  } finally {
    await handle.close()
  }
}

type ScopedText = ScopedBytes & {
  markdown: string
  contentHash: string
}

async function readScopedText(root: string, file: string): Promise<ScopedText> {
  const read = await readScopedBytes(root, file, MAX_DOCUMENT_BYTES)
  return {
    ...read,
    markdown: new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true,
    }).decode(read.bytes),
    contentHash: createHash('sha256').update(read.bytes).digest('hex'),
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
    code === 'EXDEV' ||
    code === 'ENOTSUP' ||
    code === 'EOPNOTSUPP' ||
    code === 'ENOSYS'
  )
    return {
      ok: false,
      code: 'unsupported',
      message: 'This filesystem cannot move this file safely.',
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
  if (/\b(?:2|16) MiB\b/.test(error.message))
    return { ok: false, code: 'limit-exceeded', message: error.message }
  if (
    error.message.includes('Choose a file or folder') ||
    error.message.includes('path is missing or contains a symbolic link')
  )
    return { ok: false, code: 'permission-denied', message: error.message }
  if (
    error.message.includes('Choose a file') ||
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

/** Explicit, bounded binary read; no buffer or active-tab state is consulted. */
export async function readWorkspaceBinary(
  target: WorkspaceTarget,
  path: unknown,
): Promise<WorkspaceFileResult<WorkspaceBinaryRead>> {
  const root = workspaceRoot()
  if (!root || !isCurrentWorkspaceTarget(target)) return stale()
  try {
    const file = await resolveWorkspaceEntry(root, path)
    if (!isCurrentWorkspaceTarget(target)) return stale()
    const read = await readScopedBytes(root, file, MAX_BINARY_BYTES)
    if (!isCurrentWorkspaceTarget(target)) return stale()
    return {
      ok: true,
      value: {
        target,
        path: relative(root, read.canonical).split(sep).join('/'),
        bytes: read.bytes,
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

/** Exclusive create under a captured workspace and addon activation. */
async function createWorkspaceFile(
  target: WorkspaceTarget,
  path: unknown,
  contents: string | Uint8Array,
  kind: 'text' | 'binary',
  isCurrentOwner?: () => boolean,
): Promise<WorkspaceFileResult<WorkspaceTextCreation>> {
  const ownerActive = () => isCurrentOwner?.() ?? true
  const root = workspaceRoot()
  if (!root || !isCurrentWorkspaceTarget(target)) return stale()
  if (!ownerActive()) return disposed()
  try {
    const file = await resolveWorkspaceEntry(root, path, true)
    if (!isCurrentWorkspaceTarget(target)) return stale()
    if (!ownerActive()) return disposed()
    if (isDocumentName(file, true) !== (kind === 'text'))
      return {
        ok: false,
        code: 'unsupported',
        message:
          kind === 'text'
            ? 'Use a supported document extension.'
            : 'Use a non-document attachment extension.',
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
    const commitIfCurrent = async () => {
      if (!isCurrentWorkspaceTarget(target) || !ownerActive()) return false
      await verifyParent(root, file, parent)
      if (!isCurrentWorkspaceTarget(target) || !ownerActive()) return false
      openDocumentConflict = hasOpenDocumentPath(file)
      return !openDocumentConflict
    }
    const commit = await (kind === 'text'
      ? createExclusiveText(file, contents as string, commitIfCurrent)
      : createExclusiveBytes(file, contents as Uint8Array, commitIfCurrent))
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

/** Exclusive text creation retains the existing 2 MiB document limit. */
export async function createWorkspaceText(
  target: WorkspaceTarget,
  path: unknown,
  markdown: unknown,
  isCurrentOwner?: () => boolean,
): Promise<WorkspaceFileResult<WorkspaceTextCreation>> {
  if (typeof markdown !== 'string')
    return { ok: false, code: 'unsupported', message: 'Use UTF-8 text.' }
  try {
    validateMarkdown(markdown)
  } catch (error) {
    const failure = knownFailure(error)
    if (failure) return failure
    throw error
  }
  return createWorkspaceFile(target, path, markdown, 'text', isCurrentOwner)
}

/** Exclusive attachment creation copies caller bytes before awaiting disk IO. */
export async function createWorkspaceBinary(
  target: WorkspaceTarget,
  path: unknown,
  bytes: unknown,
  isCurrentOwner?: () => boolean,
): Promise<WorkspaceFileResult<WorkspaceBinaryCreation>> {
  if (!(bytes instanceof Uint8Array))
    return { ok: false, code: 'unsupported', message: 'Use binary bytes.' }
  if (bytes.byteLength > MAX_BINARY_BYTES)
    return {
      ok: false,
      code: 'limit-exceeded',
      message: 'This attachment exceeds the 16 MiB limit.',
    }
  return createWorkspaceFile(
    target,
    path,
    Uint8Array.from(bytes),
    'binary',
    isCurrentOwner,
  )
}

const pendingUpdates = new Map<string, Promise<void>>()

async function serializeMutation<T>(
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
    return await serializeMutation(canonical, async () => {
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

function sameInode(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

async function syncDirectories(...paths: string[]): Promise<boolean> {
  if (process.platform === 'win32') return false
  try {
    for (const path of new Set(paths.map(dirname))) {
      const directory = await open(path, 'r')
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    }
    return true
  } catch (error) {
    console.error('workspace file directory sync failed:', error)
    return false
  }
}

function validVersion(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

/** Closed-file move. An exclusive hard link prevents destination overwrite. */
export async function renameWorkspaceFile(
  target: WorkspaceTarget,
  sourcePath: unknown,
  destinationPath: unknown,
  expectedVersion: unknown,
  isCurrentOwner?: () => boolean,
): Promise<WorkspaceFileResult<WorkspaceFileRename>> {
  const ownerActive = () => isCurrentOwner?.() ?? true
  const root = workspaceRoot()
  if (!root || !isCurrentWorkspaceTarget(target)) return stale()
  if (!ownerActive()) return disposed()
  if (!validVersion(expectedVersion))
    return {
      ok: false,
      code: 'unsupported',
      message: 'Read this file before moving it.',
    }
  try {
    const source = await resolveWorkspaceEntry(root, sourcePath)
    const destination = await resolveWorkspaceEntry(root, destinationPath, true)
    if (source === destination)
      return {
        ok: false,
        code: 'conflict',
        message: 'Choose a different destination.',
      }
    if (!isCurrentWorkspaceTarget(target)) return stale()
    if (!ownerActive()) return disposed()
    const sourceCanonical = await realpath(source)
    if (!inside(root, sourceCanonical))
      throw mutationError('EACCES', 'This path is outside the workspace.')
    return await serializeMutation(sourceCanonical, async () => {
      const ensureActive = () => {
        if (!isCurrentWorkspaceTarget(target))
          throw mutationError('EWORKSPACE', 'This workspace is no longer open.')
        if (!ownerActive())
          throw mutationError('EOWNER', 'This addon is no longer active.')
      }
      ensureActive()
      const original = await readScopedBytes(root, source, MAX_BINARY_BYTES)
      ensureActive()
      if (original.version !== expectedVersion)
        throw mutationError('EVERSION', 'This file changed on disk.')
      if (
        hasOpenDocumentPath(source) ||
        hasOpenDocumentPath(original.canonical) ||
        hasOpenDocumentPath(destination)
      )
        throw mutationError('EOPEN', 'This document is open.')
      const sourceParent = await parentIdentity(root, source)
      const destinationParent = await parentIdentity(root, destination)
      ensureActive()
      await verifyParent(root, source, sourceParent)
      await verifyParent(root, destination, destinationParent)
      const latest = await readScopedBytes(root, source, MAX_BINARY_BYTES)
      ensureActive()
      if (latest.version !== expectedVersion)
        throw mutationError('EVERSION', 'This file changed on disk.')
      if (
        hasOpenDocumentPath(source) ||
        hasOpenDocumentPath(latest.canonical) ||
        hasOpenDocumentPath(destination)
      )
        throw mutationError('EOPEN', 'This document is open.')
      // link is exclusive on supported filesystems. Once it succeeds, both
      // names may exist; a later failure must never erase the new entry.
      // ponytail: path-based unlink can race an external source replacement;
      // native inode-conditional file operations are needed to close that gap.
      await link(source, destination)
      let sourceRemoved = false
      let scopeVerifiedAfterCommit = false
      try {
        ensureActive()
        await verifyParent(root, source, sourceParent)
        await verifyParent(root, destination, destinationParent)
        const [currentSource, currentDestination] = await Promise.all([
          readScopedBytes(root, source, MAX_BINARY_BYTES),
          lstat(destination, { bigint: true }),
        ])
        if (
          !sameInode(currentSource.info, original.info) ||
          !sameInode(currentDestination, original.info) ||
          createHash('sha256').update(currentSource.bytes).digest('hex') !==
            createHash('sha256').update(original.bytes).digest('hex') ||
          hasOpenDocumentPath(source) ||
          hasOpenDocumentPath(destination)
        )
          throw mutationError('ESTALE', 'This workspace file changed.')
        ensureActive()
        await unlink(source)
        sourceRemoved = true
      } catch (error) {
        // The destination has committed. Keep both names on any uncertainty.
        console.error(
          'workspace source retained after move:',
          error instanceof Error ? error.message : error,
        )
      }
      try {
        await verifyParent(root, destination, destinationParent)
        const currentDestination = await lstat(destination, { bigint: true })
        scopeVerifiedAfterCommit = sameInode(currentDestination, original.info)
      } catch (error) {
        console.error('workspace destination changed after move:', error)
      }
      const directorySynced = scopeVerifiedAfterCommit
        ? await syncDirectories(source, destination)
        : false
      const oldPath = relative(root, original.canonical).split(sep).join('/')
      const newPath = relative(root, destination).split(sep).join('/')
      let indexed = false
      if (scopeVerifiedAfterCommit && isCurrentWorkspaceTarget(target)) {
        try {
          indexed = (await refreshWorkspace([oldPath, newPath])) !== null
        } catch (error) {
          console.error('workspace refresh after move failed:', error)
        }
      }
      let ownerActiveAfterCommit = false
      try {
        ownerActiveAfterCommit = ownerActive()
      } catch (error) {
        console.error('workspace owner check after move failed:', error)
      }
      return {
        ok: true,
        value: {
          target,
          path: oldPath,
          destinationPath: newPath,
          previousVersion: expectedVersion,
          persisted: true,
          sourceRemoved,
          indexed,
          directorySynced,
          atomicVisibility: false,
          scopeVerifiedAfterCommit,
          ownerActiveAfterCommit,
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

/** Trash a closed regular file only after verifying its disk version. */
export async function trashWorkspaceFile(
  target: WorkspaceTarget,
  path: unknown,
  expectedVersion: unknown,
  trashItem: (file: string) => Promise<void>,
  isCurrentOwner?: () => boolean,
): Promise<WorkspaceFileResult<WorkspaceFileTrash>> {
  const ownerActive = () => isCurrentOwner?.() ?? true
  const root = workspaceRoot()
  if (!root || !isCurrentWorkspaceTarget(target)) return stale()
  if (!ownerActive()) return disposed()
  if (!validVersion(expectedVersion))
    return {
      ok: false,
      code: 'unsupported',
      message: 'Read this file before trashing it.',
    }
  try {
    const file = await resolveWorkspaceEntry(root, path)
    if (!isCurrentWorkspaceTarget(target)) return stale()
    if (!ownerActive()) return disposed()
    const canonical = await realpath(file)
    if (!inside(root, canonical))
      throw mutationError('EACCES', 'This path is outside the workspace.')
    return await serializeMutation(canonical, async () => {
      const original = await readScopedBytes(root, file, MAX_BINARY_BYTES)
      if (original.version !== expectedVersion)
        throw mutationError('EVERSION', 'This file changed on disk.')
      if (hasOpenDocumentPath(file) || hasOpenDocumentPath(original.canonical))
        throw mutationError('EOPEN', 'This document is open.')
      const parent = await parentIdentity(root, file)
      if (!isCurrentWorkspaceTarget(target)) return stale()
      if (!ownerActive()) return disposed()
      await verifyParent(root, file, parent)
      const latest = await readScopedBytes(root, file, MAX_BINARY_BYTES)
      if (latest.version !== expectedVersion)
        throw mutationError('EVERSION', 'This file changed on disk.')
      if (hasOpenDocumentPath(file) || hasOpenDocumentPath(latest.canonical))
        throw mutationError('EOPEN', 'This document is open.')
      if (!isCurrentWorkspaceTarget(target)) return stale()
      if (!ownerActive()) return disposed()
      // ponytail: the OS trash API accepts a path, so an external replacement
      // between this check and trash needs native identity-bound IO to exclude.
      await trashItem(file)
      const changedPath = relative(root, original.canonical)
        .split(sep)
        .join('/')
      let scopeVerifiedAfterCommit = false
      let indexed = false
      try {
        await verifyParent(root, file, parent)
        scopeVerifiedAfterCommit = true
      } catch (error) {
        console.error('workspace parent changed after trash:', error)
      }
      if (scopeVerifiedAfterCommit && isCurrentWorkspaceTarget(target)) {
        try {
          indexed = (await refreshWorkspace([changedPath])) !== null
        } catch (error) {
          console.error('workspace refresh after trash failed:', error)
        }
      }
      let ownerActiveAfterCommit = false
      try {
        ownerActiveAfterCommit = ownerActive()
      } catch (error) {
        console.error('workspace owner check after trash failed:', error)
      }
      return {
        ok: true,
        value: {
          target,
          path: changedPath,
          previousVersion: expectedVersion,
          persisted: true,
          indexed,
          scopeVerifiedAfterCommit,
          ownerActiveAfterCommit,
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
