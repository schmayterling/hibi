import { randomUUID } from 'node:crypto'
import { link, open, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

export interface ExclusiveCreateCommit {
  readonly directorySynced: boolean
  readonly atomicVisibility: boolean
}

/** Stage and sync bytes before an exclusive commit. False means scope went stale. */
export async function createExclusiveText(
  path: string,
  text: string,
  current: () => boolean,
): Promise<ExclusiveCreateCommit | false> {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${randomUUID()}.tmp`,
  )
  const staged = await open(temporary, 'wx', 0o600)
  try {
    try {
      await staged.writeFile(text, 'utf8')
      await staged.sync()
    } finally {
      await staged.close()
    }
    if (!current()) return false
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
      if (!current()) return false
      atomicVisibility = false
      // Some filesystems reject hard links. 'wx' still reserves the target
      // exclusively, though a crash can expose an incomplete fallback file.
      const destination = await open(path, 'wx', 0o600)
      try {
        await destination.writeFile(text, 'utf8')
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
