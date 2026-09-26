import { type BigIntStats, constants } from 'node:fs'
import {
  cp,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  unlink,
} from 'node:fs/promises'
import { join } from 'node:path'

const noFollowDirectory =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
const symbolicLinkCopyError =
  'Symbolic links cannot be copied. Copy the original file or folder instead.'

function sameInode(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function partialCopyError(error: unknown): Error & { code: string } {
  return Object.assign(
    new Error(
      'Destination was created, but copying did not finish. Review it before retrying.',
      { cause: error },
    ),
    { code: 'EPARTIALCOPY' },
  )
}

async function copyPinnedFile(
  source: string,
  destination: string,
  original: BigIntStats,
): Promise<void> {
  const sourceHandle = await open(
    source,
    constants.O_RDONLY |
      (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
  )
  try {
    const [opened, current] = await Promise.all([
      sourceHandle.stat({ bigint: true }),
      lstat(source, { bigint: true }),
    ])
    if (
      !opened.isFile() ||
      !sameInode(opened, original) ||
      current.isSymbolicLink() ||
      !sameInode(current, original)
    )
      throw new Error('The source file changed. Review it before copying.')
    const destinationHandle = await open(
      destination,
      'wx',
      Number(opened.mode & 0o777n),
    )
    try {
      try {
        const chunk = Buffer.allocUnsafe(64 * 1024)
        let copiedBytes = 0n
        for (;;) {
          const { bytesRead } = await sourceHandle.read(
            chunk,
            0,
            chunk.length,
            null,
          )
          if (!bytesRead) break
          let written = 0
          while (written < bytesRead) {
            const result = await destinationHandle.write(
              chunk,
              written,
              bytesRead - written,
            )
            written += result.bytesWritten
          }
          copiedBytes += BigInt(bytesRead)
        }
        const finished = await sourceHandle.stat({ bigint: true })
        if (
          copiedBytes !== opened.size ||
          !sameInode(finished, opened) ||
          finished.size !== opened.size ||
          finished.mtimeNs !== opened.mtimeNs ||
          finished.ctimeNs !== opened.ctimeNs
        )
          throw new Error('The source file changed while copying.')
        await destinationHandle.chmod(Number(opened.mode & 0o7777n))
      } finally {
        await destinationHandle.close()
      }
    } catch (error) {
      // The destination may contain incomplete bytes. A pathname unlink could
      // remove someone else's replacement, so leave it for explicit review.
      throw partialCopyError(error)
    }
    // This detects ordinary concurrent writes, but the handle does not make
    // its bytes an immutable snapshot after the final check.
  } finally {
    await sourceHandle
      .close()
      .catch((error: unknown) =>
        console.error('workspace copy source close failed:', error),
      )
  }
}

/** Claim the destination exclusively after the caller rechecks its workspace. */
export async function copyEntry(
  source: string,
  destination: string,
  folder: boolean,
  beforeCreate: () => boolean | Promise<boolean>,
  listFolder: (path: string) => Promise<string[]> = readdir,
): Promise<void> {
  const original = await lstat(source, { bigint: true })
  if (original.isSymbolicLink()) throw new Error(symbolicLinkCopyError)
  if (!(await beforeCreate()))
    throw new Error('The workspace changed. Review it before copying.')
  if (folder) {
    if (!original.isDirectory()) throw new Error('Choose a folder to copy.')
    const currentSource = await lstat(source, { bigint: true })
    if (currentSource.isSymbolicLink()) throw new Error(symbolicLinkCopyError)
    if (!currentSource.isDirectory() || !sameInode(currentSource, original))
      throw new Error('The source folder changed. Review it before copying.')
    const sourceHandle =
      process.platform === 'win32'
        ? null
        : await open(source, noFollowDirectory)
    let destinationCreated = false
    try {
      const sourceInode = sourceHandle
        ? await sourceHandle.stat({ bigint: true })
        : original
      if (!sourceInode.isDirectory() || !sameInode(sourceInode, original))
        throw new Error('The source folder changed. Review it before copying.')
      await mkdir(destination)
      destinationCreated = true
      // A later external swap can still replace this reservation. Never clean
      // the destination on failure because it may then belong to someone else.
      const destinationHandle =
        process.platform === 'win32'
          ? null
          : await open(destination, noFollowDirectory)
      try {
        const reserved = destinationHandle
          ? await destinationHandle.stat({ bigint: true })
          : await lstat(destination, { bigint: true })
        // ponytail: path-based cp can still race a swap after this check;
        // closing that gap needs native directory-handle-relative copying.
        const checkRoots = async () => {
          const [from, to] = await Promise.all([
            lstat(source, { bigint: true }),
            lstat(destination, { bigint: true }),
          ])
          if (from.isSymbolicLink()) throw new Error(symbolicLinkCopyError)
          if (!from.isDirectory() || !sameInode(from, sourceInode))
            throw new Error(
              'The source folder changed. Review it before copying.',
            )
          if (!to.isDirectory() || !sameInode(to, reserved))
            throw new Error(
              'The destination folder changed. Review it before copying.',
            )
        }
        await checkRoots()
        for (const name of await listFolder(source)) {
          await checkRoots()
          await cp(join(source, name), join(destination, name), {
            recursive: true,
            force: false,
            errorOnExist: true,
            mode: constants.COPYFILE_EXCL,
            filter: async (path) => {
              await checkRoots()
              if ((await lstat(path)).isSymbolicLink())
                throw new Error(symbolicLinkCopyError)
              return true
            },
          })
        }
      } finally {
        await destinationHandle?.close()
      }
    } catch (error) {
      if (destinationCreated) throw partialCopyError(error)
      throw error
    } finally {
      if (sourceHandle)
        await sourceHandle
          .close()
          .catch((error: unknown) =>
            console.error('workspace copy source close failed:', error),
          )
    }
  } else {
    if (!original.isFile()) throw new Error('Choose a regular file to copy.')
    await copyPinnedFile(source, destination, original)
  }
}

/** False means destination was created but source remains; never remove it as rollback. */
export async function moveEntry(
  source: string,
  destination: string,
  folder: boolean,
  beforeRemove: () => boolean | Promise<boolean>,
  linkFile: typeof link = link,
): Promise<{ sourceRemoved: boolean }> {
  if (folder) {
    const original = await lstat(source, { bigint: true })
    if (!original.isDirectory()) throw new Error('Choose a folder to move.')
    const sourceHandle =
      process.platform === 'win32'
        ? null
        : await open(source, noFollowDirectory)
    try {
      const pinned = sourceHandle
        ? await sourceHandle.stat({ bigint: true })
        : original
      if (!pinned.isDirectory() || !sameInode(pinned, original))
        throw new Error('The source folder changed. Review it before moving.')
      if (!(await beforeRemove()))
        throw new Error(
          'The workspace folder changed. Review it before moving.',
        )
      const currentSource = await lstat(source, { bigint: true })
      if (!currentSource.isDirectory() || !sameInode(currentSource, pinned))
        throw new Error('The source folder changed. Review it before moving.')
      if (process.platform === 'win32') {
        // Windows cannot use the POSIX directory reservation below. This
        // absence check is best effort until a portable no-replace rename exists.
        try {
          await lstat(destination)
          throw Object.assign(new Error('The destination already exists.'), {
            code: 'EEXIST',
          })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        await rename(source, destination)
        return { sourceRemoved: true }
      }
      await mkdir(destination)
      // Pin the reservation so its inode cannot be reused before comparison.
      const reservation = await open(destination, noFollowDirectory)
      try {
        const reserved = await reservation.stat({ bigint: true })
        if (!(await beforeRemove()))
          throw new Error(
            'The workspace folder changed. Review it before moving.',
          )
        const [from, to] = await Promise.all([
          lstat(source, { bigint: true }),
          lstat(destination, { bigint: true }),
        ])
        if (!from.isDirectory() || !sameInode(from, pinned))
          throw new Error('The source folder changed. Review it before moving.')
        if (!to.isDirectory() || !sameInode(to, reserved))
          throw new Error(
            'The destination folder changed. Review it before moving.',
          )
        // ponytail: node has no portable no-replace directory rename; a swap
        // after this check can still replace a competing empty folder.
        // Failed moves retain the reservation because cleanup could erase a swap.
        await rename(source, destination)
        return { sourceRemoved: true }
      } finally {
        await reservation.close()
      }
    } finally {
      await sourceHandle?.close()
    }
  }
  const original = await lstat(source, { bigint: true })
  if (!original.isFile()) throw new Error('Choose a regular file to move.')
  if (!(await beforeRemove()))
    throw new Error('The workspace changed. Review it before moving.')
  const beforeCreate = await lstat(source, { bigint: true })
  if (
    !beforeCreate.isFile() ||
    !sameInode(beforeCreate, original) ||
    beforeCreate.size !== original.size ||
    beforeCreate.mtimeNs !== original.mtimeNs ||
    beforeCreate.ctimeNs !== original.ctimeNs
  )
    throw new Error('The source file changed. Review it before moving.')
  let linked = true
  try {
    await linkFile(source, destination)
  } catch (error) {
    if (
      !['ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EPERM'].includes(
        (error as NodeJS.ErrnoException).code ?? '',
      )
    )
      throw error
    linked = false
    await copyPinnedFile(source, destination, original)
  }
  // A path swap after closing the copied destination can still race this stat.
  const reserved = await lstat(destination, { bigint: true }).catch(() => null)
  if (!reserved) return { sourceRemoved: false }
  try {
    if (!(await beforeRemove())) return { sourceRemoved: false }
    const [current, created] = await Promise.all([
      lstat(source, { bigint: true }),
      lstat(destination, { bigint: true }),
    ])
    if (
      !sameInode(current, original) ||
      !created.isFile() ||
      !sameInode(created, reserved) ||
      current.size !== original.size ||
      current.mtimeNs !== original.mtimeNs ||
      (linked
        ? !sameInode(created, original)
        : current.ctimeNs !== original.ctimeNs ||
          created.size !== original.size)
    )
      return { sourceRemoved: false }
    // ponytail: path-based unlink still has a source replacement race;
    // native inode-conditional IO is required for a cross-process guarantee.
    await unlink(source)
    return { sourceRemoved: true }
  } catch {
    return { sourceRemoved: false }
  }
}
