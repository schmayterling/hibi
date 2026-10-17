import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import { type BrowserWindow, dialog } from 'electron'
import type { Importer, ImportRequest, ImportResult } from '../shared/imports'
import { convertImport, getImporters } from './addons'
import {
  readImportFolder,
  readImportZip,
  validateImportFiles,
} from './import-files'
import { refreshWorkspace, workspaceId, workspaceRoot } from './workspace'
import { workspaceMetadata } from './workspace-metadata'
import { isPathInside } from './workspace-paths'

export function listImporters(): Importer[] {
  return [
    {
      id: 'folder',
      name: 'Folder',
      instructions: '',
      sources: ['folder'],
    },
    ...getImporters(),
  ]
}
export async function importIntoWorkspace(
  window: BrowserWindow,
  input: unknown,
): Promise<ImportResult | null> {
  const request = input as ImportRequest | null
  const importer = listImporters().find((item) => item.id === request?.id)
  const root = workspaceRoot()
  if (!request || !importer || !importer.sources.includes(request.source))
    throw new Error('Choose an available importer.')
  if (
    !root ||
    request.workspaceId !== workspaceId() ||
    !(await workspaceMetadata(root)).manifest
  )
    throw new Error(
      'Open a Hibi workspace before importing. You can create its manifest in Settings → Workspace.',
    )
  const selected = await dialog.showOpenDialog(window, {
    title: `Import from ${importer.name}`,
    properties: [request.source === 'folder' ? 'openDirectory' : 'openFile'],
    ...(request.source === 'zip'
      ? { filters: [{ name: 'ZIP export', extensions: ['zip'] }] }
      : {}),
  })
  if (selected.canceled || !selected.filePaths[0]) return null
  const source = await realpath(selected.filePaths[0])
  if (request.source === 'folder' && isPathInside(source, root))
    throw new Error(
      'Choose a source folder that does not contain the destination workspace.',
    )
  const original =
    request.source === 'folder'
      ? await readImportFolder(source)
      : await readImportZip(source)
  const converted =
    request.id === 'folder'
      ? original
      : await convertImport(request.id, original.files)
  validateImportFiles(converted.files)
  if (!converted.files.length)
    throw new Error('No files were found in this export.')
  if (workspaceRoot() !== root || request.workspaceId !== workspaceId())
    throw new Error('The workspace changed. Start the import again.')
  const stage = await mkdtemp(join(root, '.hibi-import-'))
  const name =
    basename(source)
      .replace(/\.zip$/i, '')
      .replace(/[\\:*?"<>|]|\p{Cc}/gu, '-')
      .replace(/^\.+/, '')
      .replace(/[. ]+$/, '') || 'Import'
  let destination: string | undefined
  try {
    for (const file of converted.files) {
      const target = join(stage, file.path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, file.data, { flag: 'wx' })
    }
    // Reserve a fresh container atomically. Existing files are never overwritten.
    for (let suffix = 1; ; suffix++) {
      const candidate = join(root, suffix === 1 ? name : `${name} ${suffix}`)
      try {
        await mkdir(candidate)
        destination = candidate
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
    // The reserved folder contains one staged tree, published in a single rename.
    await rename(stage, join(destination, 'Imported files'))
    const warnings = [
      ...new Set([...original.warnings, ...(converted.warnings ?? [])]),
    ]
    await refreshWorkspace().catch(() =>
      warnings.push(
        'Files were imported, but the workspace list could not refresh. Reopen the workspace to view them.',
      ),
    )
    return {
      folder: relative(root, destination).split(sep).join('/'),
      files: converted.files.length,
      warnings,
    }
  } catch (error) {
    await rm(stage, { recursive: true, force: true })
    if (destination) await rmdir(destination).catch(() => {})
    throw error
  }
}
