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
import type {
  ImportEntry,
  Importer,
  ImportFile,
  ImportRequest,
  ImportResult,
  ImportStream,
} from '../shared/imports'
import { convertImport, getImporters } from './addons'
import { runFileDialog } from './file-operation-dialog'
import {
  copyImportFile,
  readImportFile,
  readImportFolder,
  readImportZip,
  validateImportFiles,
  validateImportPaths,
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
  signal: AbortSignal,
): Promise<ImportResult | null> {
  signal.throwIfAborted()
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
  const selected = await runFileDialog(() =>
    dialog.showOpenDialog(window, {
      title: `Import from ${importer.name}`,
      properties: [request.source === 'folder' ? 'openDirectory' : 'openFile'],
      ...(request.source === 'zip'
        ? { filters: [{ name: 'ZIP export', extensions: ['zip'] }] }
        : {}),
    }),
  )
  signal.throwIfAborted()
  if (selected.canceled || !selected.filePaths[0]) return null
  const source = await realpath(selected.filePaths[0])
  if (request.source === 'folder' && isPathInside(source, root))
    throw new Error(
      'Choose a source folder that does not contain the destination workspace.',
    )
  const original =
    request.source === 'folder'
      ? await readImportFolder(source, signal)
      : await readImportZip(source, signal)
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
    const written: { path: string }[] = []
    const seen = new Set<string>()
    const stream: ImportStream = {
      signal,
      paths: original.files.map((file) => file.path),
      read: async (index) => {
        const file = original.files[index]
        if (!file) throw new Error('The import contains an unsafe file path.')
        signal.throwIfAborted()
        return 'source' in file ? readImportFile(file, signal) : file.data
      },
      write: async (entry: ImportEntry) => {
        await validateImportPaths([entry], signal)
        const key = entry.path.normalize('NFC').toLowerCase()
        if (seen.has(key))
          throw new Error(
            `The import contains duplicate file names: ${entry.path}`,
          )
        seen.add(key)
        const target = join(stage, entry.path)
        await mkdir(dirname(target), { recursive: true })
        if ('data' in entry) {
          const file = entry as ImportFile
          await validateImportFiles([file], signal)
          await writeFile(target, file.data, { flag: 'wx', signal })
        } else {
          const file =
            Number.isSafeInteger(entry.original) && entry.original !== undefined
              ? original.files[entry.original]
              : undefined
          if (!file) throw new Error('The import contains an unsafe file path.')
          if ('source' in file) await copyImportFile(file, target, signal)
          else await writeFile(target, file.data, { flag: 'wx', signal })
        }
        written.push({ path: entry.path })
      },
    }
    const converted =
      request.id === 'folder'
        ? { warnings: [] }
        : await convertImport(request.id, [], stream)
    if (request.id === 'folder')
      for (let index = 0; index < original.files.length; index++)
        await stream.write({
          path: stream.paths[index] as string,
          original: index,
        })
    await validateImportPaths(written, signal)
    if (!written.length) throw new Error('No files were found in this export.')
    if (workspaceRoot() !== root || request.workspaceId !== workspaceId())
      throw new Error('The workspace changed. Start the import again.')
    // Reserve a fresh container atomically. Existing files are never overwritten.
    for (let suffix = 1; ; suffix++) {
      signal.throwIfAborted()
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
    signal.throwIfAborted()
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
      files: written.length,
      warnings,
    }
  } catch (error) {
    await rm(stage, { recursive: true, force: true })
    if (destination) await rmdir(destination).catch(() => {})
    throw error
  }
}
