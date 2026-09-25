import { type BigIntStats, constants } from 'node:fs'
import {
  copyFile,
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
    try {
      const sourceInode = sourceHandle
        ? await sourceHandle.stat({ bigint: true })
        : original
      if (!sourceInode.isDirectory() || !sameInode(sourceInode, original))
        throw new Error('The source folder changed. Review it before copying.')
      await mkdir(destination)
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
    } finally {
      await sourceHandle?.close()
    }
  } else {
    if (!original.isFile()) throw new Error('Choose a regular file to copy.')
    await copyFile(source, destination, constants.COPYFILE_EXCL)
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
    if (process.platform === 'win32') {
      await rename(source, destination)
      return { sourceRemoved: true }
    }
    await mkdir(destination)
    // Pin the opened folder so its inode cannot be reused before the identity
    // check on filesystems that recycle directory inodes quickly.
    const reservation = await open(destination, noFollowDirectory)
    try {
      const reserved = await reservation.stat({ bigint: true })
      if (!(await beforeRemove()))
        throw new Error(
          'The workspace folder changed. Review it before moving.',
        )
      const current = await lstat(destination, { bigint: true })
      if (!current.isDirectory() || !sameInode(current, reserved))
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
  }
  const original = await lstat(source, { bigint: true })
  if (!original.isFile()) throw new Error('Choose a regular file to move.')
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
    await copyFile(source, destination, constants.COPYFILE_EXCL)
  }
  // ponytail: copyFile cannot return a destination handle, so an external
  // replacement before this first stat can still evade this identity check.
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
