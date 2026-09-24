import { constants } from 'node:fs'
import {
  copyFile,
  cp,
  link,
  lstat,
  mkdir,
  rename,
  unlink,
} from 'node:fs/promises'
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  sep,
} from 'node:path'
import { type BrowserWindow, shell } from 'electron'
import type { WorkspaceActionResult } from '../shared/workspace'
import {
  closeDeletedDocuments,
  confirmDiscardAll,
  getDocument,
  getOpenDocuments,
  newPendingDocument,
  relocateDocument,
  renameDocument,
  selectDocumentTab,
} from './document'
import { isDocumentName } from './document-types'
import {
  getWorkspace,
  notifyWorkspaceContent,
  refreshWorkspace,
  workspaceRoot,
} from './workspace'

const missing = (error: NodeJS.ErrnoException) => {
  if (error.code !== 'ENOENT') throw error
  return null
}
export function validateWorkspaceName(name: unknown): asserts name is string {
  if (
    typeof name !== 'string' ||
    !name ||
    name.startsWith('.') ||
    name === 'node_modules' ||
    /[\\/<>:"|?*]|\p{Cc}/u.test(name) ||
    /[. ]$/.test(name) ||
    Buffer.byteLength(name) > 255 ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
  )
    throw new Error(
      'Choose a file or folder name without slashes or reserved characters.',
    )
}
async function resolveEntry(
  base: string,
  value: unknown,
  allowMissing = false,
  allowRoot = false,
): Promise<string> {
  if (allowRoot && value === '') return base
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 4096 ||
    isAbsolute(value)
  )
    throw new Error('Choose a file or folder inside this workspace.')
  const parts = value.split('/')
  let path = base
  for (const [index, part] of parts.entries()) {
    validateWorkspaceName(part)
    path = join(path, part)
    const stat = await lstat(path).catch(missing)
    if (!stat && allowMissing && index === parts.length - 1) return path
    if (
      !stat ||
      stat.isSymbolicLink() ||
      (index < parts.length - 1 && !stat.isDirectory())
    )
      throw new Error(
        'This path is missing or contains a symbolic link. Choose the original file or folder.',
      )
  }
  return path
}
function contains(parent: string, child: string | null) {
  if (!child) return false
  const path = relative(parent, child)
  return (
    !path ||
    (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
  )
}
async function unique(parent: string, name: string) {
  const extension = extname(name),
    stem = extension ? name.slice(0, -extension.length) : name
  for (let index = 0; index < 10000; index++) {
    const candidate = join(
      parent,
      `${stem}${index ? ` ${index + 1}` : ''}${extension}`,
    )
    if (
      !(await lstat(candidate).catch(missing)) &&
      !getOpenDocuments().some((draft) => draft.file === candidate)
    )
      return candidate
  }
  throw new Error('Choose a different name.')
}
async function moveEntry(source: string, destination: string, folder: boolean) {
  if (folder) {
    // Windows refuses to replace even an empty directory, so rename itself
    // reserves the destination there without overwriting an existing folder.
    if (process.platform === 'win32') {
      await rename(source, destination)
      return
    }
    // Reserve the destination first: never replace a pre-existing directory.
    await mkdir(destination)
    try {
      await rename(source, destination)
    } catch (error) {
      await import('node:fs/promises')
        .then(({ rmdir }) => rmdir(destination))
        .catch(() => {})
      throw error
    }
  } else {
    try {
      await link(source, destination)
    } catch (error) {
      if (
        !['ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EPERM'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        )
      )
        throw error
      await copyFile(source, destination, constants.COPYFILE_EXCL)
    }
    try {
      await unlink(source)
    } catch (error) {
      await unlink(destination)
      throw error
    }
  }
}
export async function workspaceAction(
  window: BrowserWindow,
  input: unknown,
): Promise<WorkspaceActionResult | null> {
  const base = workspaceRoot()
  if (!base) throw new Error('Open a workspace first.')
  if (!input || typeof input !== 'object')
    throw new Error('Hibi could not read this file operation. Try again.')
  const { action, path, destination } = input as Record<string, unknown>
  if (
    ![
      'new-file',
      'new-folder',
      'rename',
      'copy',
      'move',
      'duplicate',
      'delete',
    ].includes(String(action))
  )
    throw new Error('Hibi does not support this file operation.')
  let resultPath: string
  let sourcePath: string | null = null
  let treeChanged = false
  if (action === 'new-file' || action === 'new-folder') {
    const parent = await resolveEntry(base, path, false, true)
    if (!(await lstat(parent)).isDirectory())
      throw new Error('Choose a folder for the new item.')
    resultPath = await unique(
      parent,
      action === 'new-file'
        ? `untitled${extname(getDocument().name) || '.md'}`
        : 'untitled folder',
    )
    if (action === 'new-folder') {
      await mkdir(resultPath)
      treeChanged = true
    } else if (!(await newPendingDocument(window, resultPath))) return null
  } else {
    const draft =
      typeof path === 'string' &&
      getOpenDocuments().find((draft) => draft.pendingPath === join(base, path))
    const source = await resolveEntry(base, path, Boolean(draft))
    sourcePath = source
    if (draft && draft.tabId !== getDocument().tabId)
      await selectDocumentTab(window, draft.tabId)
    const folder = draft ? false : (await lstat(source)).isDirectory()
    if (!folder && !isDocumentName(source, true))
      throw new Error('Choose a supported document.')
    if (action === 'delete') {
      if (!(await confirmDiscardAll(window, source))) return null
      if (await lstat(source).catch(missing)) {
        await shell.trashItem(source)
        treeChanged = true
      }
      closeDeletedDocuments(window, source)
      resultPath = source
    } else {
      if (action === 'rename') {
        validateWorkspaceName(destination)
        let name = destination
        if (!folder && !extname(name)) name += extname(source)
        resultPath = join(dirname(source), name)
      } else if (action === 'duplicate') {
        const extension = folder ? '' : extname(source)
        const name = basename(source, extension)
        resultPath = await unique(dirname(source), `${name} copy${extension}`)
      } else resultPath = await resolveEntry(base, destination, true)
      if (!folder && !isDocumentName(resultPath, true))
        throw new Error('Use a supported file extension.')
      if (source === resultPath)
        return {
          workspace: getWorkspace(),
          document: getDocument(),
          path: relative(base, source).split(sep).join('/'),
        }
      if (contains(source, resultPath))
        throw new Error(
          'A folder cannot be placed inside itself. Choose another location.',
        )
      if (getOpenDocuments().some((draft) => draft.file === resultPath))
        throw new Error(
          'A document is open at that location. Choose another name or location.',
        )
      if (await lstat(resultPath).catch(missing))
        throw new Error(
          'A file or folder exists at that location. Choose another name or location.',
        )
      if (draft) {
        if (action === 'rename') await renameDocument(basename(resultPath))
        else if (action === 'move') relocateDocument(source, resultPath)
        else throw new Error('Save this draft before copying it.')
      } else if (action === 'copy' || action === 'duplicate') {
        await cp(source, resultPath, {
          recursive: folder,
          force: false,
          errorOnExist: true,
          filter: async (path) => {
            if ((await lstat(path)).isSymbolicLink())
              throw new Error(
                'Symbolic links cannot be copied. Copy the original file or folder instead.',
              )
            return true
          },
        })
      } else {
        await moveEntry(source, resultPath, folder)
        relocateDocument(source, resultPath)
      }
      treeChanged = !draft
    }
  }
  const paths = [sourcePath, resultPath]
    .filter((path): path is string => path !== null)
    .map((path) => relative(base, path).split(sep).join('/'))
  return {
    workspace: treeChanged
      ? await refreshWorkspace(paths)
      : await notifyWorkspaceContent(paths),
    document: getDocument(),
    path: relative(base, resultPath).split(sep).join('/'),
  }
}
