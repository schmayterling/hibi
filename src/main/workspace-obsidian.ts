import { createHash } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { isPathInside, validateWorkspaceName } from './workspace-paths.ts'

export async function obsidianDataPath(root: string, data: string) {
  const identity = createHash('sha256')
    .update(await realpath(root))
    .digest('hex')
  return join(data, 'obsidian-vaults', identity)
}

async function jsonFile(path: string): Promise<Record<string, unknown> | null> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return null
  })
  if (!info) return null
  if (!info.isFile() || info.isSymbolicLink() || info.size > 65536)
    throw new TypeError()
  const value = JSON.parse(
    (await readFile(path, 'utf8')).replace(/^\uFEFF/, ''),
  )
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError()
  return value
}

/** The override is instance-local in Obsidian; never guess between profiles. */
export async function obsidianConfiguration(root: string) {
  const standard = await lstat(join(root, '.obsidian')).catch(() => null)
  if (standard?.isDirectory() && !standard.isSymbolicLink())
    return { directory: '.obsidian', folders: ['.obsidian'], notice: '' }
  const folders: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (
      !entry.name.startsWith('.') ||
      !entry.isDirectory() ||
      ['.hibi', '.trash', '.git'].includes(entry.name)
    )
      continue
    for (const name of ['app.json', 'appearance.json']) {
      try {
        if (await jsonFile(join(root, entry.name, name))) {
          folders.push(entry.name)
          break
        }
      } catch {
        // Invalid unrelated dotfolders are not evidence of an Obsidian vault.
      }
    }
  }
  folders.sort()
  if (!folders.length) return null
  return {
    directory: folders.length === 1 ? folders[0]! : null,
    folders,
    notice:
      folders.length > 1
        ? `Multiple Obsidian configuration folders found (${folders.join(', ')}). Hibi uses Obsidian defaults.`
        : '',
  }
}

export async function obsidianSettings(root: string) {
  const config = await obsidianConfiguration(root)
  if (!config) return null
  let saved: Record<string, unknown> = {}
  let notice = config.notice
  if (config.directory) {
    try {
      saved = (await jsonFile(join(root, config.directory, 'app.json'))) ?? {}
    } catch {
      notice = `Could not read ${config.directory}/app.json. Hibi uses Obsidian defaults, including system trash.`
    }
  }
  return {
    ...config,
    notice,
    attachmentFolderPath:
      typeof saved.attachmentFolderPath === 'string'
        ? saved.attachmentFolderPath
        : '',
    newFileLocation:
      saved.newFileLocation === 'current' || saved.newFileLocation === 'folder'
        ? saved.newFileLocation
        : 'root',
    newFileFolderPath:
      typeof saved.newFileFolderPath === 'string'
        ? saved.newFileFolderPath
        : '',
    useMarkdownLinks: saved.useMarkdownLinks === true,
    newLinkFormat:
      saved.newLinkFormat === 'relative' || saved.newLinkFormat === 'absolute'
        ? saved.newLinkFormat
        : 'shortest',
    alwaysUpdateLinks: saved.alwaysUpdateLinks !== false,
    trashOption:
      saved.trashOption === 'local' || saved.trashOption === 'none'
        ? saved.trashOption
        : 'system',
  } as const
}

async function vaultDirectory(root: string, folder: string, create: boolean) {
  if (
    isAbsolute(folder) ||
    folder.includes('\\') ||
    folder.split('/').includes('..')
  )
    throw new Error('Choose a folder inside this vault.')
  const parts = folder.split('/').filter((part) => part && part !== '.')
  for (const part of parts) validateWorkspaceName(part)
  let path = root
  for (const part of parts) {
    path = join(path, part)
    if (create)
      await mkdir(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error
      })
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return null
    })
    if (!info && !create) continue
    if (!info?.isDirectory() || info.isSymbolicLink())
      throw new Error(
        'Choose a regular folder inside this vault, not a symbolic link.',
      )
  }
  return path
}

export async function obsidianAttachmentDirectory(
  root: string,
  note: string,
  create = true,
) {
  if (!isPathInside(root, note)) return null
  const settings = await obsidianSettings(root)
  if (!settings) return null
  const folder = settings.attachmentFolderPath
  const relativeFolder = folder.startsWith('./')
    ? [relative(root, dirname(note)).split(sep).join('/'), folder.slice(2)]
        .filter(Boolean)
        .join('/')
    : folder
  return vaultDirectory(root, relativeFolder, create)
}

export async function obsidianNewNotePath(
  root: string,
  origin: string | null,
  name: string,
  create = false,
) {
  const settings = await obsidianSettings(root)
  if (!settings) return null
  const folder =
    settings.newFileLocation === 'folder'
      ? settings.newFileFolderPath
      : settings.newFileLocation === 'current' &&
          origin &&
          isPathInside(root, origin)
        ? relative(root, dirname(origin)).split(sep).join('/')
        : ''
  return join(await vaultDirectory(root, folder, create), name)
}

export async function assertObsidianContentPath(root: string, file: string) {
  if (!isPathInside(root, file)) return
  const first = relative(root, file).split(sep)[0] ?? ''
  if (!first.startsWith('.')) return
  let protectedFolder = first === '.obsidian'
  const config = await obsidianConfiguration(root)
  if (config) {
    protectedFolder ||= config.folders.includes(first)
    for (const name of ['app.json', 'appearance.json']) {
      try {
        protectedFolder ||= !!(await jsonFile(join(root, first, name)))
      } catch {
        /* Ignore unrelated malformed files. */
      }
    }
  }
  if (protectedFolder)
    throw new Error('Obsidian configuration is read-only in Hibi.')
}

const notices = new Map<string, string>()
export async function obsidianVault(root: string) {
  const settings = await obsidianSettings(root)
  if (!settings) return undefined
  if (settings.notice && notices.get(root) !== settings.notice) {
    notices.set(root, settings.notice)
    const { BrowserWindow } = await import('electron')
    for (const window of BrowserWindow.getAllWindows())
      window.webContents.send('document:notice', settings.notice)
  }
  let externalAddons = false
  if (settings.directory) {
    const path = join(root, settings.directory, 'community-plugins.json')
    const info = await lstat(path).catch(() => null)
    if (info?.isFile() && !info.isSymbolicLink()) {
      try {
        const enabled: unknown =
          info.size > 65536 ? [true] : JSON.parse(await readFile(path, 'utf8'))
        externalAddons = Array.isArray(enabled) && enabled.length > 0
      } catch {
        // A malformed plugin list grants no permission to run vault code.
      }
    }
  }
  return { externalAddons }
}
