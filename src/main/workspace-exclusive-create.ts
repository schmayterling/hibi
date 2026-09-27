import { randomUUID } from 'node:crypto'
import { link, open, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export interface ExclusiveCreateCommit {
  readonly directorySynced: boolean
  readonly atomicVisibility: boolean
}

/** Stage and sync bytes before an exclusive commit. False means scope went stale. */
async function createExclusiveFile(
  path: string,
  contents: string | Uint8Array,
  current: () => boolean | Promise<boolean>,
): Promise<ExclusiveCreateCommit | false> {
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`)
  const staged = await open(temporary, 'wx', 0o600)
  try {
    try {
      await staged.writeFile(contents)
      await staged.sync()
    } finally {
      await staged.close()
    }
    if (!(await current())) return false
    let atomicVisibility = true
    try {
      await link(temporary, path)
    } catch (error) {
      if (
        !['ENOTSUP', 'EOPNOTSUPP', 'EPERM'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        )
      )
        throw error
      if (!(await current())) return false
      atomicVisibility = false
      // Some filesystems reject hard links. 'wx' still reserves the target
      // exclusively, though a crash can expose an incomplete fallback file.
      const destination = await open(path, 'wx', 0o600)
      try {
        await destination.writeFile(contents)
        await destination.sync()
      } catch (failure) {
        await destination.close().catch(() => {})
        await unlink(path).catch(() => {})
        throw failure
      }
      await destination
        .close()
        .catch((error: unknown) =>
          console.error('workspace created file close failed:', error),
        )
    }
    let directorySynced = false
    if (process.platform !== 'win32') {
      try {
        const directory = await open(dirname(path), 'r')
        try {
          await directory.sync()
          directorySynced = true
        } finally {
          await directory.close()
        }
      } catch (error) {
        // The file is already committed. Report weaker durability, not failure.
        console.error('workspace created file directory sync failed:', error)
      }
    }
    return { directorySynced, atomicVisibility }
  } finally {
    await unlink(temporary).catch((error: unknown) =>
      console.error('workspace create temporary cleanup failed:', error),
    )
  }
}

export function createExclusiveText(
  path: string,
  text: string,
  current: () => boolean | Promise<boolean>,
): Promise<ExclusiveCreateCommit | false> {
  return createExclusiveFile(path, text, current)
}

export function createExclusiveBytes(
  path: string,
  bytes: Uint8Array,
  current: () => boolean | Promise<boolean>,
): Promise<ExclusiveCreateCommit | false> {
  return createExclusiveFile(path, bytes, current)
}
