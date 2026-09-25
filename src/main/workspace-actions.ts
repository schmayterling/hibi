import { lstat, mkdir } from 'node:fs/promises'
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
import { copyEntry, moveEntry } from './workspace-entry-transfer'
import { resolveWorkspaceEntry, validateWorkspaceName } from './workspace-paths'

export { validateWorkspaceName } from './workspace-paths'

const missing = (error: NodeJS.ErrnoException) => {
  if (error.code !== 'ENOENT') throw error
  return null
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
    const parent = await resolveWorkspaceEntry(base, path, false, true)
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
    const source = await resolveWorkspaceEntry(base, path, Boolean(draft))
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
      } else resultPath = await resolveWorkspaceEntry(base, destination, true)
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
        await copyEntry(source, resultPath, folder, async () => {
          await resolveWorkspaceEntry(base, path)
          await resolveWorkspaceEntry(
            base,
            relative(base, resultPath).split(sep).join('/'),
            true,
          )
          return !getOpenDocuments().some((draft) => draft.file === resultPath)
        })
      } else {
        const moved = await moveEntry(source, resultPath, folder, async () => {
          await resolveWorkspaceEntry(base, path)
          await resolveWorkspaceEntry(
            base,
            relative(base, resultPath).split(sep).join('/'),
          )
          return !getOpenDocuments().some((draft) => draft.file === resultPath)
        })
        if (!moved.sourceRemoved) {
          try {
            await refreshWorkspace([
              relative(base, source).split(sep).join('/'),
              relative(base, resultPath).split(sep).join('/'),
            ])
          } catch (error) {
            console.error('workspace refresh after partial move failed:', error)
          }
          throw new Error(
            'Destination was created, but the original could not be removed. Both files may exist.',
          )
        }
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
