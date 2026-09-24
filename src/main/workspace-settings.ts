import {
  cp,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import { app, type BrowserWindow, dialog } from 'electron'
import type {
  WorkspacePreferences,
  WorkspaceSettings,
  WorkspaceSettingsAction,
} from '../shared/workspace-settings'
import {
  getDocument,
  getDocumentPath,
  hasUnsavedDocuments,
  loadDocument,
  relocateDocument,
} from './document'
import {
  getWorkspace,
  loadWorkspace,
  refreshWorkspace,
  resolveWorkspaceFile,
  workspaceRoot,
} from './workspace'
import {
  validateManifest,
  WORKSPACE_IGNORE,
  WORKSPACE_MANIFEST,
  workspaceMetadata,
  writeWorkspaceText,
} from './workspace-metadata'

const defaults: WorkspacePreferences = {
  enabled: false,
  showAllFiles: false,
  path: null,
  startup: 'empty',
  startupFolder: null,
}
const location = () => join(app.getPath('userData'), 'workspace-settings.json')
async function preferences(): Promise<WorkspacePreferences> {
  try {
    const value = JSON.parse(
      await readFile(location(), 'utf8'),
    ) as WorkspacePreferences
    if (
      typeof value.enabled !== 'boolean' ||
      (value.showAllFiles !== undefined &&
        typeof value.showAllFiles !== 'boolean') ||
      !['empty', 'managed', 'folder'].includes(value.startup) ||
      ![value.path, value.startupFolder].every(
        (path) =>
          path === null ||
          (typeof path === 'string' &&
            isAbsolute(path) &&
            !path.includes('\0')),
      )
    )
      throw new Error('Invalid workspace settings.')
    return { ...defaults, ...value }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      console.error('Could not read workspace settings:', error)
    return { ...defaults }
  }
}
export async function showAllWorkspaceFiles() {
  return (await preferences()).showAllFiles
}
async function savePreferences(value: WorkspacePreferences) {
  await writeFile(`${location()}.tmp`, JSON.stringify(value), { mode: 0o600 })
  await rename(`${location()}.tmp`, location())
}
export async function getWorkspaceSettings(): Promise<WorkspaceSettings> {
  const currentPath = workspaceRoot()
  const metadata = currentPath
    ? await workspaceMetadata(currentPath)
    : { manifest: null, manifestRevision: null, ignore: '' }
  return {
    ...(await preferences()),
    defaultPath: join(app.getPath('documents'), 'hibi'),
    currentPath,
    ...metadata,
  }
}
async function ensureManifest(path: string) {
  const metadata = await workspaceMetadata(path)
  if (metadata.manifest) return
  await writeWorkspaceText(
    path,
    WORKSPACE_MANIFEST,
    JSON.stringify(
      {
        version: 1,
        name: basename(path),
        description: '',
        icon: 'folder',
        defaultFile: '',
      },
      null,
      2,
    ) + '\n',
    true,
  )
}
async function chooseFolder(window: BrowserWindow, title: string) {
  const result = await dialog.showOpenDialog(window, {
    title,
    properties: ['openDirectory', 'createDirectory'],
  })
  return result.canceled || !result.filePaths[0]
    ? null
    : realpath(result.filePaths[0])
}
export async function updateWorkspaceSettings(
  window: BrowserWindow,
  input: unknown,
) {
  const value = input as WorkspaceSettingsAction | null
  if (!value || typeof value.action !== 'string')
    throw new Error('Choose a workspace action.')
  const prefs = await preferences()
  if (value.action === 'enable') {
    if (typeof value.enabled !== 'boolean')
      throw new Error('Choose whether to enable your Hibi workspace.')
    if (value.enabled) {
      const path = prefs.path ?? join(app.getPath('documents'), 'hibi')
      await mkdir(path, { recursive: true })
      prefs.path = await realpath(path)
      await ensureManifest(prefs.path)
    }
    prefs.enabled = value.enabled
  } else if (value.action === 'show-all-files') {
    if (typeof value.enabled !== 'boolean')
      throw new Error('Choose whether to show all workspace files.')
    prefs.showAllFiles = value.enabled
  } else if (value.action === 'choose') {
    const selected = await chooseFolder(window, 'Choose Hibi workspace')
    if (selected) {
      await ensureManifest(selected)
      prefs.path = selected
      prefs.enabled = true
    }
  } else if (value.action === 'open') {
    if (!prefs.enabled || !prefs.path)
      throw new Error('Enable your Hibi workspace first.')
    await loadWorkspace(prefs.path)
  } else if (value.action === 'startup') {
    if (!['empty', 'managed', 'folder'].includes(value.startup))
      throw new Error('Choose a startup option.')
    if (value.startup === 'managed' && (!prefs.enabled || !prefs.path))
      throw new Error('Enable your Hibi workspace first.')
    if (value.startup === 'folder') {
      const selected = await chooseFolder(window, 'Choose startup folder')
      if (!selected) return getWorkspaceSettings()
      prefs.startupFolder = selected
    }
    prefs.startup = value.startup
  } else if (value.action === 'create-manifest') {
    const root = workspaceRoot()
    if (!root) throw new Error('Open a folder first.')
    await ensureManifest(root)
    await refreshWorkspace([WORKSPACE_MANIFEST])
  } else if (value.action === 'save-manifest') {
    const root = workspaceRoot()
    if (!root) throw new Error('Open a folder first.')
    const current = await workspaceMetadata(root)
    if (!current.manifest || current.manifestRevision !== value.revision)
      throw new Error(
        'Workspace settings changed on disk. Reopen this page before saving.',
      )
    const manifest = validateManifest(value.manifest)
    if (typeof value.ignore !== 'string' || value.ignore.length > 65536)
      throw new Error('Ignore rules must be smaller than 64 KiB.')
    if (manifest.defaultFile)
      await resolveWorkspaceFile(root, manifest.defaultFile)
    await writeWorkspaceText(root, WORKSPACE_IGNORE, value.ignore)
    await writeWorkspaceText(
      root,
      WORKSPACE_MANIFEST,
      JSON.stringify(manifest, null, 2) + '\n',
    )
    await refreshWorkspace([WORKSPACE_IGNORE, WORKSPACE_MANIFEST])
  } else if (value.action === 'relocate') {
    if (!prefs.enabled || !prefs.path)
      throw new Error('Enable your Hibi workspace first.')
    if (hasUnsavedDocuments())
      throw new Error(
        'Save your open documents before relocating the workspace.',
      )
    const parent = await chooseFolder(window, 'Move Hibi workspace into folder')
    if (!parent) return getWorkspaceSettings()
    const from = await realpath(prefs.path),
      to = join(parent, basename(from))
    const child = relative(from, to)
    if (
      !child ||
      (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`))
    )
      throw new Error('Choose a folder outside the current workspace.')
    if (
      await lstat(to).then(
        () => true,
        (error) => {
          if (error.code === 'ENOENT') return false
          throw error
        },
      )
    )
      throw new Error(
        'A folder with this name already exists at the destination.',
      )
    try {
      await rename(from, to)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
      // Across disks retain the original; removing a concurrently edited tree would risk data loss.
      await mkdir(to)
      try {
        await cp(from, to, {
          recursive: true,
          force: false,
          errorOnExist: true,
          verbatimSymlinks: true,
        })
      } catch (error) {
        await rm(to, { recursive: true, force: true })
        throw error
      }
      await dialog.showMessageBox(window, {
        type: 'info',
        message: 'Workspace copied to the new location.',
        detail:
          'The original folder was kept because the destination is on another disk.',
        buttons: ['OK'],
      })
    }
    relocateDocument(from, to)
    if (workspaceRoot() === from) await loadWorkspace(to)
    if (prefs.startupFolder === from) prefs.startupFolder = to
    prefs.path = to
  } else throw new Error('Unknown workspace action.')
  await savePreferences(prefs)
  if (value.action === 'show-all-files') await refreshWorkspace()
  return getWorkspaceSettings()
}

let startupOpened = false
export async function startupWorkspacePending() {
  if (startupOpened) return false
  const prefs = await preferences()
  return Boolean(
    prefs.startup === 'managed'
      ? prefs.enabled && prefs.path
      : prefs.startup === 'folder' && prefs.startupFolder,
  )
}
export async function openStartupWorkspace(
  window: BrowserWindow,
  hasExternalFiles: boolean,
) {
  if (startupOpened) return
  startupOpened = true
  const prefs = await preferences()
  const path =
    prefs.startup === 'managed'
      ? prefs.enabled
        ? prefs.path
        : null
      : prefs.startup === 'folder'
        ? prefs.startupFolder
        : null
  if (
    !path ||
    workspaceRoot() ||
    getDocumentPath() ||
    getDocument().dirty ||
    hasExternalFiles
  )
    return
  await loadWorkspace(path)
  const file = getWorkspace()?.manifest?.defaultFile
  if (file) await loadDocument(window, await resolveWorkspaceFile(path, file))
}
