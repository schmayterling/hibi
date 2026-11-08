import { lstat, mkdir, realpath, rm } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { type BrowserWindow, dialog, shell } from 'electron'
import { runFileDialog } from './file-operation-dialog'
import { moveEntry } from './workspace-entry-transfer'
import { obsidianSettings } from './workspace-obsidian'

/** Returns false only when permanent deletion was declined. */
export async function trashWorkspaceEntry(
  window: BrowserWindow,
  root: string,
  source: string,
) {
  const settings = await obsidianSettings(root)
  if (!settings || settings.trashOption === 'system') {
    await shell.trashItem(source)
    return true
  }
  if (settings.trashOption === 'none') {
    const choice = await runFileDialog(() =>
      dialog.showMessageBox(window, {
        type: 'warning',
        message: `Permanently delete ${basename(source)}?`,
        detail: 'This vault uses permanent deletion. This cannot be undone.',
        buttons: ['Delete permanently', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
      }),
    )
    if (choice.response !== 0) return false
    await rm(source, { recursive: true })
    return true
  }
  const directory = join(root, '.trash')
  await mkdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error
  })
  const check = async () => {
    const info = await lstat(directory)
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (await realpath(directory)) !== directory
    )
      throw new Error(
        'The vault trash must be a regular folder, not a symbolic link.',
      )
    return true
  }
  await check()
  const info = await lstat(source)
  const extension = info.isDirectory() ? '' : extname(source)
  const stem = basename(source, extension)
  for (let index = 1; index < 10000; index++) {
    const destination = join(
      directory,
      `${stem}${index > 1 ? ` ${index}` : ''}${extension}`,
    )
    try {
      const result = await moveEntry(
        source,
        destination,
        info.isDirectory(),
        check,
      )
      if (!result.sourceRemoved)
        throw new Error(
          'The file was copied to trash, but its original could not be removed. Check both files.',
        )
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  throw new Error('Choose a different name before moving this file to trash.')
}
