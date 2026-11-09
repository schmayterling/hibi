import { randomUUID } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { lstat, open, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { retryRename } from './atomic-rename.ts'

/** Stage and sync bytes before any member of a grouped operation is committed. */
export async function stageExistingText(
  path: string,
  text: string,
  mode: number,
  temporary = join(dirname(path), `.${randomUUID()}.tmp`),
) {
  const staged = await open(temporary, 'wx', 0o600)
  let committed = false
  let closed = false
  let stagedIdentity: BigIntStats | null = null
  try {
    stagedIdentity = await staged.stat({ bigint: true })
    await staged.writeFile(text, 'utf8')
    await staged.chmod(mode & 0o7777)
    await staged.sync()
    const ready = await staged.stat({ bigint: true })
    if (process.platform === 'win32') {
      await staged.close()
      closed = true
    }
    const discard = async (currentTemporary = temporary) => {
      if (!closed) {
        await staged.close()
        closed = true
      }
      if (committed || !stagedIdentity) return
      const current = await lstat(currentTemporary, { bigint: true }).catch(
        () => null,
      )
      if (
        current?.dev === stagedIdentity.dev &&
        current.ino === stagedIdentity.ino
      )
        await unlink(currentTemporary)
    }
    return {
      temporary,
      discard,
      async commit(
        destination: string,
        beforeCommit: () => Promise<void>,
        currentTemporary = temporary,
      ) {
        const checkCommit = async () => {
          await beforeCommit()
          const current = await lstat(currentTemporary, { bigint: true })
          if (
            current.dev !== ready.dev ||
            current.ino !== ready.ino ||
            current.size !== ready.size ||
            current.mtimeNs !== ready.mtimeNs ||
            current.ctimeNs !== ready.ctimeNs
          )
            throw new Error(
              'The staged file changed. Review it before updating.',
            )
          if (!closed) {
            await staged.close()
            closed = true
          }
        }
        await checkCommit()
        // Node rename has neither an expected-inode condition for the disk file
        // nor a handle-relative source. Both pathnames can change after checks.
        await retryRename(
          () => rename(currentTemporary, destination),
          checkCommit,
        )
        committed = true

        let directorySynced = false
        if (process.platform !== 'win32') {
          try {
            const directory = await open(dirname(destination), 'r')
            try {
              await directory.sync()
              directorySynced = true
            } finally {
              await directory.close()
            }
          } catch (error) {
            console.error(
              'workspace updated file directory sync failed:',
              error,
            )
          }
        }
        return { atomicVisibility: true as const, directorySynced }
      },
    }
  } catch (error) {
    try {
      if (!closed) {
        await staged.close()
        closed = true
      }
    } finally {
      if (stagedIdentity) {
        const current = await lstat(temporary, { bigint: true }).catch(
          () => null,
        )
        if (
          current?.dev === stagedIdentity.dev &&
          current.ino === stagedIdentity.ino
        )
          await unlink(temporary)
      }
    }
    throw error
  }
}

/** Stage bytes before a best-effort disk-version check and atomic rename. */
export async function replaceExistingText(
  path: string,
  text: string,
  mode: number,
  beforeCommit: () => Promise<void>,
): Promise<{ atomicVisibility: true; directorySynced: boolean }> {
  const staged = await stageExistingText(path, text, mode)
  try {
    return await staged.commit(path, beforeCommit)
  } finally {
    await staged.discard()
  }
}
