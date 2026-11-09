import { randomUUID } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { moveEntry } from './workspace-entry-transfer.ts'

export async function isCaseOnlyRename(source: string, destination: string) {
  if (
    source === destination ||
    dirname(source) !== dirname(destination) ||
    basename(source).normalize('NFC').toLowerCase() !==
      basename(destination).normalize('NFC').toLowerCase()
  )
    return false
  const existing = await lstat(destination).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return null
    },
  )
  return (
    !!existing &&
    !existing.isSymbolicLink() &&
    (await realpath(destination)) === (await realpath(source))
  )
}

/** Two exclusive moves preserve case on insensitive volumes without replacing another entry. */
export async function renameCaseOnly(source: string, destination: string) {
  const folder = (await lstat(source)).isDirectory()
  const temporary = join(dirname(source), '.rename-' + randomUUID())
  const first = await moveEntry(source, temporary, folder, () => true)
  if (!first.sourceRemoved)
    throw new Error(
      'The original could not be removed. Check both files before retrying.',
    )
  try {
    const moved = await moveEntry(temporary, destination, folder, () => true)
    if (!moved.sourceRemoved)
      throw new Error(
        'The temporary file could not be removed. Check both files before retrying.',
      )
  } catch (error) {
    try {
      await moveEntry(temporary, source, folder, () => true)
    } catch (restoreError) {
      throw new Error(
        'The rename could not finish or restore its original name. Recover the note from ' +
          temporary,
        { cause: restoreError },
      )
    }
    throw error
  }
}
