import { randomUUID } from 'node:crypto'
import { open, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Stage replacement bytes before checking the caller's commit precondition. */
export async function replaceExistingText(
  path: string,
  text: string,
  mode: number,
  beforeCommit: () => Promise<void>,
): Promise<{ atomicVisibility: true; directorySynced: boolean }> {
  const directoryPath = dirname(path)
  const temporary = join(directoryPath, `.${randomUUID()}.tmp`)
  const staged = await open(temporary, 'wx', 0o600)
  let committed = false
  try {
    try {
      await staged.writeFile(text, 'utf8')
      await staged.chmod(mode & 0o7777)
      await staged.sync()
    } finally {
      await staged.close()
    }
    await beforeCommit()
    // Node rename has no expected-inode condition for an external writer.
    await rename(temporary, path)
    committed = true

    let directorySynced = false
    if (process.platform !== 'win32') {
      try {
        const directory = await open(directoryPath, 'r')
        try {
          await directory.sync()
          directorySynced = true
        } finally {
          await directory.close()
        }
      } catch (error) {
        console.error('workspace updated file directory sync failed:', error)
      }
    }
    return { atomicVisibility: true, directorySynced }
  } finally {
    if (!committed)
      await unlink(temporary).catch((error: unknown) =>
        console.error('workspace update temporary cleanup failed:', error),
      )
  }
}
